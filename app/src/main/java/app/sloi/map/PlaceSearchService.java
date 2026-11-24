package app.sloi.map;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.Locale;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.function.BooleanSupplier;

/** Search-as-you-type uses Photon, independently of geometry work and its sockets. */
final class PlaceSearchService {
    private static final int MAX_RESPONSE_BYTES = 512 * 1024;
    private static final long CACHE_TTL_NANOS = 5L * 60 * 1_000_000_000;
    private final LinkedHashMap<String, Cached> cache = new LinkedHashMap<>(32, .75f, true);
    interface ConnectionFactory { HttpURLConnection open(URL url) throws IOException; }
    interface LocalSearch { String search(String query, int limit, double latitude, double longitude) throws IOException; }
    private final ConnectionFactory connections;
    private final LocalSearch localSearch;
    private final BooleanSupplier networkAvailable;
    private final ThreadPoolExecutor disconnectExecutor = new ThreadPoolExecutor(2, 2, 10, TimeUnit.SECONDS,
        new ArrayBlockingQueue<>(4), runnable -> {
            Thread thread = new Thread(runnable, "sloi-search-disconnect");
            thread.setDaemon(true);
            return thread;
        }, new ThreadPoolExecutor.DiscardPolicy());
    private HttpURLConnection active;
    private long generation;

    PlaceSearchService() { this(url -> (HttpURLConnection) url.openConnection()); }
    PlaceSearchService(ConnectionFactory connections) {
        this(connections, null, () -> true);
    }
    PlaceSearchService(LocalSearch localSearch, BooleanSupplier networkAvailable) {
        this(url -> (HttpURLConnection) url.openConnection(), localSearch, networkAvailable);
    }
    PlaceSearchService(ConnectionFactory connections, LocalSearch localSearch, BooleanSupplier networkAvailable) {
        this.connections = connections;
        this.localSearch = localSearch;
        this.networkAvailable = networkAvailable;
        disconnectExecutor.allowCoreThreadTimeOut(true);
    }

    static ExecutorService newSearchExecutor() {
        // One cancelled DNS/TLS/read may take time to return on Android. A new
        // query can start on the other worker; only the latest pending job fits.
        return new ThreadPoolExecutor(2, 2, 0, TimeUnit.SECONDS, new ArrayBlockingQueue<>(1),
            runnable -> new Thread(runnable, "sloi-place-search"), new ThreadPoolExecutor.DiscardOldestPolicy());
    }

    void cancel() {
        final HttpURLConnection previous;
        synchronized (this) {
            generation++;
            previous = active;
            active = null;
        }
        disconnectAsync(previous);
    }

    void close() {
        cancel();
        disconnectExecutor.shutdown();
    }

    private void disconnectAsync(HttpURLConnection connection) {
        // disconnect() itself can block behind an Android socket read. Never
        // execute it under the service/task lock or on the JS bridge thread.
        // Saturation leaves at most two timed-out worker reads to finish; their
        // streams still close in finally, without an unbounded cleanup queue.
        if (connection != null) disconnectExecutor.execute(() -> {
            try { connection.disconnect(); } catch (RuntimeException ignored) { /* Timed-out/closed socket. */ }
        });
    }

    String search(String query, int limit, double latitude, double longitude, double zoom) throws IOException {
        String q = query == null ? "" : query.trim().replaceAll("\\s+", " ");
        if (q.length() < 2 || q.length() > 160) throw new IllegalArgumentException("Введите от 2 до 160 символов");
        limit = Math.max(1, Math.min(6, limit));
        String local = null;
        IOException localError = null;
        final long localGeneration;
        synchronized (this) { localGeneration = generation; }
        if (localSearch != null) {
            try {
                local = localSearch.search(q, limit, latitude, longitude);
                synchronized (this) { checkCurrent(localGeneration); }
                if (local != null && new JSONArray(local).length() > 0) return local;
            } catch (org.json.JSONException error) {
                localError = new IOException("Не удалось прочитать адреса на устройстве", error);
            } catch (IOException error) { localError = error; }
        }
        synchronized (this) { checkCurrent(localGeneration); }
        if (!networkAvailable.getAsBoolean()) {
            if (localError != null) throw localError;
            if (local != null) return local;
            throw new IOException("Скачайте данные города для поиска без сети");
        }
        String url = "https://photon.komoot.io/api/?q=" + URLEncoder.encode(q, "UTF-8") + "&limit=" + limit;
        if (Double.isFinite(latitude) && Double.isFinite(longitude) && Math.abs(latitude) <= 85 && Math.abs(longitude) <= 180) {
            // Photon parses an Integer, even "15.0" is HTTP 400. Its bias
            // implementation uses zoom 0..18, independently of map maxZoom.
            int biasZoom = (int) Math.round(Math.max(0, Math.min(18, Double.isFinite(zoom) ? zoom : 12)));
            url += "&lat=" + latitude + "&lon=" + longitude + "&zoom=" + biasZoom;
        }
        final String key = url;
        final long current;
        synchronized (this) {
            current = generation;
            Cached found = cache.get(key);
            if (found != null && System.nanoTime() - found.at < CACHE_TTL_NANOS) return found.payload;
            cache.remove(key);
        }
        HttpURLConnection connection = connections.open(new URL(url));
        connection.setConnectTimeout(5000);
        connection.setReadTimeout(7000);
        connection.setInstanceFollowRedirects(false);
        connection.setRequestProperty("Accept", "application/json");
        connection.setRequestProperty("Accept-Language", "ru,en;q=0.7");
        connection.setRequestProperty("User-Agent", "Sloi/" + BuildConfig.VERSION_NAME + " (+https://github.com/Qweasd123tg/osm-app)");
        boolean fullyRead = false;
        try {
            synchronized (this) { checkCurrent(current); active = connection; }
            int status = connection.getResponseCode();
            synchronized (this) { checkCurrent(current); }
            if (status != 200) throw new IOException(status == 429 ? "Поиск занят. Повторите чуть позже." : "Поиск недоступен: HTTP " + status);
            if (connection.getContentLengthLong() > MAX_RESPONSE_BYTES) throw new IOException("Ответ поиска слишком большой");
            String text;
            try (InputStream input = connection.getInputStream(); ByteArrayOutputStream output = new ByteArrayOutputStream()) {
                byte[] bytes = new byte[8192];
                while (true) {
                    synchronized (this) { checkCurrent(current); }
                    int count = input.read(bytes);
                    if (count == -1) break;
                    synchronized (this) { checkCurrent(current); }
                    if (output.size() + count > MAX_RESPONSE_BYTES) throw new IOException("Ответ поиска слишком большой");
                    output.write(bytes, 0, count);
                }
                text = new String(output.toByteArray(), StandardCharsets.UTF_8);
                fullyRead = true;
            }
            String payload = normalize(text, limit);
            synchronized (this) {
                checkCurrent(current);
                cache.put(key, new Cached(payload));
                while (cache.size() > 32) cache.remove(cache.keySet().iterator().next());
            }
            return payload;
        } finally {
            final boolean owned;
            synchronized (this) { owned = active == connection; if (owned) active = null; }
            // Fully consumed responses keep the platform's persistent HTTPS
            // connection available for the next keystroke; close failed reads
            // asynchronously, so they cannot hold up a newer search.
            if (!fullyRead && owned) disconnectAsync(connection);
        }
    }

    private void checkCurrent(long current) throws IOException {
        if (current != generation || Thread.currentThread().isInterrupted()) throw new IOException("Поиск отменён");
    }

    static String normalize(String text, int limit) throws IOException {
        try {
            JSONArray features = new JSONObject(text).getJSONArray("features"), result = new JSONArray();
            LinkedHashSet<String> seen = new LinkedHashSet<>();
            for (int index = 0; index < features.length() && result.length() < Math.max(1, Math.min(6, limit)); index++) {
                JSONObject feature = features.optJSONObject(index);
                if (feature == null) continue;
                JSONObject geometry = feature.optJSONObject("geometry"), properties = feature.optJSONObject("properties");
                if (geometry == null || properties == null || !"Point".equals(geometry.optString("type"))) continue;
                JSONArray coordinate = geometry.optJSONArray("coordinates");
                if (coordinate == null || coordinate.length() != 2 || !(coordinate.opt(0) instanceof Number) || !(coordinate.opt(1) instanceof Number)) continue;
                double lon = coordinate.getDouble(0), lat = coordinate.getDouble(1);
                if (!Double.isFinite(lon) || !Double.isFinite(lat) || Math.abs(lon) > 180 || Math.abs(lat) > 85) continue;
                LinkedHashSet<String> parts = new LinkedHashSet<>();
                String street = string(properties, "street"), house = string(properties, "housenumber");
                String address = (street + (house.isEmpty() ? "" : " " + house)).trim();
                String title = string(properties, "name");
                if (title.isEmpty()) title = address;
                if (title.isEmpty()) title = string(properties, "city");
                if (title.isEmpty()) continue;
                parts.add(title);
                if (!address.isEmpty() && !address.equals(title)) parts.add(address);
                for (String name : new String[]{"district", "city", "state", "country"}) {
                    String value = string(properties, name); if (!value.isEmpty()) parts.add(value);
                }
                String display = String.join(", ", parts);
                String identity = display.toLowerCase(Locale.ROOT) + "|" + lon + "|" + lat;
                if (!seen.add(identity)) continue;
                JSONObject place = new JSONObject();
                place.put("name", title); place.put("display_name", display);
                place.put("latitude", lat); place.put("longitude", lon);
                result.put(place);
            }
            return result.toString();
        } catch (org.json.JSONException error) { throw new IOException("Поиск вернул повреждённые данные", error); }
    }

    private static String string(JSONObject object, String name) {
        Object value = object.opt(name);
        return value instanceof String ? ((String) value).trim() : "";
    }

    private static final class Cached {
        final String payload; final long at = System.nanoTime();
        Cached(String payload) { this.payload = payload; }
    }
}
