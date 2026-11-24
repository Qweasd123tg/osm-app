package app.sloi.map;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URI;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.StandardCopyOption;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;
import java.util.UUID;
import java.util.zip.GZIPInputStream;

/** One immutable, complete vector-map area. A failed replacement never removes the ready area. */
final class OfflineBasemapStore {
    static final int MAX_TILES = 3000;
    static final long MAX_BYTES = 50_000_000L;
    static final int MAX_ZOOM = 14;
    static final String ORIGIN = "https://appassets.androidplatform.net";
    static final String HOST = "tiles.openfreemap.org";
    static final String METADATA_URL = "https://" + HOST + "/planet";
    static final List<String> FONTS = Collections.unmodifiableList(Arrays.asList(
        "Noto Sans Regular", "Noto Sans Bold", "Noto Sans Italic"));
    static final List<String> RANGES = Collections.unmodifiableList(Arrays.asList(
        "0-255", "256-511", "1024-1279", "1280-1535", "8192-8447"));
    private static final String TOO_LARGE = "Область слишком большая. Выберите меньшую область карты (до 3000 тайлов и 50 МБ).";
    private static final int MAX_RESOURCE_BYTES = 4 * 1024 * 1024;
    interface ConnectionFactory { HttpURLConnection open(URL url) throws IOException; }
    interface Progress { void update(String phase, long current, long total); }
    private final File root;
    private final ConnectionFactory connections;
    private final long byteLimit;
    private HttpURLConnection activeConnection;
    private long generation;
    private volatile Snapshot active;

    OfflineBasemapStore(File filesDir) {
        this(new File(filesDir, "offline-basemap"), url -> (HttpURLConnection) url.openConnection(), MAX_BYTES);
    }

    OfflineBasemapStore(File root, ConnectionFactory connections, long byteLimit) {
        this.root = root;
        this.connections = connections;
        this.byteLimit = Math.min(MAX_BYTES, Math.max(1, byteLimit));
        if (!root.isDirectory() && !root.mkdirs()) throw new IllegalArgumentException("Cannot create offline basemap directory");
        active = readActive();
        // Previous process may have been killed during transfer or after publishing
        // a complete directory but before switching the small atomic pointer.
        for (File file : children(root)) {
            if (file.isDirectory() && (file.getName().startsWith("staging-")
                || (file.getName().matches("p-[a-f0-9]{32}") && (active == null || !file.getName().equals(active.id))))) deleteTree(file);
        }
    }

    File directory() { return root; }

    synchronized void cancel() {
        generation++;
        if (activeConnection != null) { activeConnection.disconnect(); activeConnection = null; }
    }

    JSONObject record() {
        Snapshot snapshot = active;
        if (snapshot == null) return null;
        try { return new JSONObject(snapshot.record.toString()); }
        catch (JSONException error) { throw new IllegalStateException(error); }
    }

    JSONObject download(Request request, Progress listener) throws IOException {
        request.validate();
        final List<Tile> tiles = tiles(request.bounds);
        final long operation;
        synchronized (this) { operation = generation; }
        check(operation);
        String id = "p-" + UUID.randomUUID().toString().replace("-", "");
        File staging = new File(root, "staging-" + id), installed = new File(root, id);
        if (!staging.mkdirs()) throw new IOException("Не удалось создать каталог карты");
        Budget budget = new Budget(byteLimit);
        Throttle progress = new Throttle(listener);
        boolean committed = false;
        try {
            progress.send("metadata", 0, 0, true);
            byte[] metadataBytes = fetch(METADATA_URL, operation, budget, 1024 * 1024, false,
                () -> progress.send("download", budget.bytes, 0, false));
            JSONObject metadata;
            String template;
            try {
                metadata = new JSONObject(new String(metadataBytes, StandardCharsets.UTF_8));
                JSONArray templates = metadata.getJSONArray("tiles");
                if (templates.length() != 1 || metadata.getInt("maxzoom") < MAX_ZOOM || metadata.optInt("minzoom", 0) != 0)
                    throw new IOException("Источник не содержит нужные масштабы карты");
                template = templates.getString(0);
                validateTemplate(template);
            } catch (JSONException error) { throw new IOException("Источник вернул повреждённое описание карты", error); }
            write(new File(staging, "source.json"), metadataBytes);
            for (String font : FONTS) for (String range : RANGES) {
                check(operation);
                String encoded = URLEncoder.encode(font, "UTF-8").replace("+", "%20");
                byte[] bytes = fetch("https://" + HOST + "/fonts/" + encoded + "/" + range + ".pbf",
                    operation, budget, 1024 * 1024, true,
                    () -> progress.send("download", budget.bytes, 0, false));
                if (bytes.length == 0) throw new IOException("Источник вернул пустой шрифт");
                write(new File(staging, fontPath(font, range)), bytes);
                progress.send("download", budget.bytes, 0, false);
            }
            for (Tile tile : tiles) {
                check(operation);
                String url = template.replace("{z}", Integer.toString(tile.z))
                    .replace("{x}", Integer.toString(tile.x)).replace("{y}", Integer.toString(tile.y));
                byte[] bytes = fetch(url, operation, budget, MAX_RESOURCE_BYTES, true,
                    () -> progress.send("download", budget.bytes, 0, false));
                write(new File(staging, tile.path()), bytes);
                progress.send("download", budget.bytes, 0, false);
            }
            check(operation);
            String localPrefix = ORIGIN + "/basemap/" + id + "/";
            JSONObject tileJson = new JSONObject();
            JSONObject record = new JSONObject();
            try {
                tileJson.put("tilejson", "3.0.0").put("name", request.name).put("minzoom", 0).put("maxzoom", MAX_ZOOM)
                    .put("scheme", "xyz").put("tiles", new JSONArray().put(localPrefix + "tiles/{z}/{x}/{y}.pbf"))
                    .put("bounds", new JSONArray().put(request.bounds.west).put(request.bounds.south).put(request.bounds.east).put(request.bounds.north))
                    .put("attribution", metadata.optString("attribution", "© OpenMapTiles © OpenStreetMap contributors"));
                if (metadata.optJSONArray("vector_layers") != null) tileJson.put("vector_layers", metadata.getJSONArray("vector_layers"));
                byte[] localJsonBytes = tileJson.toString().getBytes(StandardCharsets.UTF_8);
                budget.add(localJsonBytes.length);
                write(new File(staging, "tilejson.json"), localJsonBytes);
                record.put("id", id).put("name", request.name).put("bounds", request.bounds.json())
                    .put("tileCount", tiles.size()).put("bytes", budget.bytes).put("revision", template)
                    .put("tileJsonUrl", localPrefix + "tilejson.json").put("status", "installed")
                    .put("maxZoom", MAX_ZOOM).put("fontCoverage", "latin-cyrillic");
                // Include the generated manifest in the size budget as well.
                byte[] manifest = record.toString().getBytes(StandardCharsets.UTF_8);
                long total = budget.bytes + manifest.length;
                record.put("bytes", total);
                manifest = record.toString().getBytes(StandardCharsets.UTF_8);
                record.put("bytes", budget.bytes + manifest.length);
                manifest = record.toString().getBytes(StandardCharsets.UTF_8);
                budget.add(manifest.length);
                write(new File(staging, "manifest.json"), manifest);
                progress.send("install", budget.bytes, budget.bytes, true);
                synchronized (this) {
                    check(operation);
                    if (!staging.renameTo(installed)) throw new IOException("Не удалось сохранить карту");
                    File pointer = new File(root, "active.tmp");
                    write(pointer, new JSONObject().put("id", id).toString().getBytes(StandardCharsets.UTF_8));
                    Files.move(pointer.toPath(), new File(root, "active.json").toPath(),
                        StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
                    Snapshot previous = active;
                    active = new Snapshot(id, record);
                    committed = true;
                    // The WebView still uses the previous immutable URL until its
                    // changed callback runs. Keep that package through the source
                    // handover; older packages can no longer be referenced by UI.
                    for (File file : children(root)) {
                        if (file.isDirectory() && file.getName().matches("p-[a-f0-9]{32}")
                            && !file.getName().equals(id)
                            && (previous == null || !file.getName().equals(previous.id))) deleteTree(file);
                    }
                }
                progress.send("ready", budget.bytes, budget.bytes, true);
                return record();
            } catch (JSONException error) { throw new IOException("Не удалось сохранить описание карты", error); }
        } finally {
            if (!committed) { deleteTree(staging); deleteTree(installed); }
        }
    }

    synchronized void delete() throws IOException {
        cancel();
        File pointer = new File(root, "active.json");
        if (pointer.exists() && !pointer.delete()) throw new IOException("Не удалось удалить карту");
        active = null;
        for (File file : children(root)) {
            if (file.isDirectory() && file.getName().matches("p-[a-f0-9]{32}")) deleteTree(file);
        }
    }

    /** Returns only known font blocks from the complete package; missing blocks use normal HTTPS. */
    File cachedFont(String url) {
        Snapshot snapshot = active;
        if (snapshot == null) return null;
        try {
            URI uri = new URI(url);
            if (!trusted(uri) || uri.getRawQuery() != null || uri.getRawFragment() != null) return null;
            String[] parts = uri.getPath().split("/", -1);
            if (parts.length != 4 || !"fonts".equals(parts[1]) || !FONTS.contains(parts[2])) return null;
            String filename = parts[3];
            if (!filename.endsWith(".pbf")) return null;
            String range = filename.substring(0, filename.length() - 4);
            if (!RANGES.contains(range)) return null;
            File file = new File(new File(root, snapshot.id), fontPath(parts[2], range));
            return file.isFile() ? file : null;
        } catch (Exception error) { return null; }
    }

    private byte[] fetch(String url, long operation, Budget budget, int resourceLimit,
            boolean protobuf, Tick tick) throws IOException {
        validateUrl(url);
        check(operation);
        HttpURLConnection connection = connections.open(new URL(url));
        connection.setConnectTimeout(10_000);
        connection.setReadTimeout(15_000);
        connection.setInstanceFollowRedirects(false);
        connection.setRequestProperty("User-Agent", "Sloi/" + BuildConfig.VERSION_NAME + " (+https://github.com/Qweasd123tg/osm-app)");
        connection.setRequestProperty("Accept", protobuf ? "application/x-protobuf, application/vnd.mapbox-vector-tile, application/octet-stream" : "application/json");
        connection.setRequestProperty("Accept-Encoding", "identity");
        try {
            synchronized (this) { check(operation); activeConnection = connection; }
            int status = connection.getResponseCode();
            check(operation);
            if (status == 204 && protobuf) return new byte[0]; // Empty protobuf is a valid empty vector tile.
            if (status != 200) throw new IOException(status == 429
                ? "Источник карты занят. Повторите позже." : "Не удалось скачать карту: HTTP " + status);
            String type = connection.getContentType();
            if (protobuf && type != null && (type.toLowerCase(java.util.Locale.ROOT).contains("text/")
                || type.toLowerCase(java.util.Locale.ROOT).contains("json"))) throw new IOException("Источник вернул текст вместо данных карты");
            long expected = connection.getContentLengthLong();
            if (expected > resourceLimit) throw new IOException("Ресурс карты слишком большой");
            if (expected > budget.remaining()) throw new IOException(TOO_LARGE);
            try (InputStream raw = connection.getInputStream();
                 InputStream input = "gzip".equalsIgnoreCase(connection.getContentEncoding()) ? new GZIPInputStream(raw) : raw;
                 ByteArrayOutputStream output = new ByteArrayOutputStream()) {
                byte[] buffer = new byte[8192];
                for (int count; (count = input.read(buffer)) != -1;) {
                    check(operation);
                    if (output.size() + count > resourceLimit) throw new IOException("Ресурс карты слишком большой");
                    budget.add(count);
                    output.write(buffer, 0, count);
                    tick.run();
                }
                byte[] bytes = output.toByteArray();
                if (expected >= 0 && connection.getContentEncoding() == null && bytes.length != expected)
                    throw new IOException("Загрузка карты оборвалась");
                if (protobuf && !validProtobuf(bytes)) throw new IOException("Источник вернул повреждённые данные карты");
                return bytes;
            }
        } finally {
            synchronized (this) { if (activeConnection == connection) activeConnection = null; }
            connection.disconnect();
        }
    }

    private synchronized void check(long operation) throws IOException {
        if (operation != generation || Thread.currentThread().isInterrupted()) throw new IOException("Загрузка карты отменена");
    }

    private Snapshot readActive() {
        try {
            File pointer = new File(root, "active.json");
            if (!pointer.isFile() || pointer.length() > 1024) return null;
            String id = new JSONObject(readSmall(pointer)).getString("id");
            if (!id.matches("p-[a-f0-9]{32}")) return null;
            File directory = new File(root, id), manifest = new File(directory, "manifest.json");
            if (!manifest.isFile() || manifest.length() > 1024 * 1024) return null;
            JSONObject record = new JSONObject(readSmall(manifest));
            Bounds bounds = Bounds.parse(record.getJSONArray("bounds"));
            List<Tile> tiles = tiles(bounds);
            if (!id.equals(record.getString("id")) || !"installed".equals(record.getString("status"))
                || record.getInt("tileCount") != tiles.size() || record.getLong("bytes") > MAX_BYTES
                || !new File(directory, "tilejson.json").isFile()) return null;
            for (Tile tile : tiles) if (!new File(directory, tile.path()).isFile()) return null;
            for (String font : FONTS) for (String range : RANGES)
                if (!new File(directory, fontPath(font, range)).isFile()) return null;
            return new Snapshot(id, record);
        } catch (Exception error) { return null; }
    }

    static void validateTemplate(String template) throws IOException {
        if (template == null || !template.matches("https://tiles\\.openfreemap\\.org/planet/[A-Za-z0-9_-]+/\\{z\\}/\\{x\\}/\\{y\\}\\.pbf"))
            throw new IOException("Источник карты содержит недопустимый адрес тайлов");
        validateUrl(template.replace("{z}", "0").replace("{x}", "0").replace("{y}", "0"));
    }

    private static void validateUrl(String url) throws IOException {
        try {
            URI uri = new URI(url);
            if (!trusted(uri) || uri.getRawQuery() != null || uri.getRawFragment() != null || uri.getPath().contains("..")) throw new IOException("Недопустимый адрес карты");
        } catch (java.net.URISyntaxException error) { throw new IOException("Недопустимый адрес карты", error); }
    }

    private static boolean trusted(URI uri) {
        return "https".equals(uri.getScheme()) && HOST.equals(uri.getHost())
            && (uri.getPort() == -1 || uri.getPort() == 443) && uri.getUserInfo() == null;
    }

    static List<Tile> tiles(Bounds bounds) throws IOException {
        bounds.validate();
        ArrayList<Tile> result = new ArrayList<>();
        for (int z = 0; z <= MAX_ZOOM; z++) {
            int width = 1 << z;
            int minX = Math.max(0, Math.min(width - 1, (int) Math.floor((bounds.west + 180) / 360 * width)));
            int maxX = Math.max(0, Math.min(width - 1, (int) Math.floor((bounds.east + 180) / 360 * width)));
            int minY = latitudeY(bounds.north, z), maxY = latitudeY(bounds.south, z);
            long count = (long) (maxX - minX + 1) * (maxY - minY + 1);
            if (result.size() + count > MAX_TILES) throw new IOException(TOO_LARGE);
            for (int x = minX; x <= maxX; x++) for (int y = minY; y <= maxY; y++) result.add(new Tile(z, x, y));
        }
        return result;
    }

    private static int latitudeY(double latitude, int z) {
        double rad = Math.toRadians(latitude);
        double y = (1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2 * (1 << z);
        return Math.max(0, Math.min((1 << z) - 1, (int) Math.floor(y)));
    }

    static boolean validProtobuf(byte[] bytes) {
        // Reject truncated / textual error bodies without parsing whole MVT layers.
        int[] at = {0};
        try {
            while (at[0] < bytes.length) {
                long key = varint(bytes, at);
                if (key < 0 || (key >>> 3) == 0 || (key >>> 3) > 0x1fffffffL) return false;
                switch ((int) (key & 7)) {
                    case 0: varint(bytes, at); break;
                    case 1: at[0] += 8; break;
                    case 2:
                        long count = varint(bytes, at);
                        if (count < 0 || count > bytes.length - at[0]) return false;
                        at[0] += (int) count; break;
                    case 5: at[0] += 4; break;
                    default: return false;
                }
                if (at[0] > bytes.length) return false;
            }
            return true;
        } catch (IllegalArgumentException error) { return false; }
    }

    private static long varint(byte[] bytes, int[] at) {
        long result = 0;
        for (int shift = 0; shift < 64; shift += 7) {
            if (at[0] >= bytes.length) throw new IllegalArgumentException("truncated varint");
            int value = bytes[at[0]++] & 255;
            if (shift == 63 && value > 1) throw new IllegalArgumentException("overflow varint");
            result |= (long) (value & 127) << shift;
            if ((value & 128) == 0) return result;
        }
        throw new IllegalArgumentException("overflow varint");
    }

    private static String fontPath(String font, String range) { return "fonts/" + font.replace(' ', '_') + "/" + range + ".pbf"; }
    private static String readSmall(File file) throws IOException { return new String(Files.readAllBytes(file.toPath()), StandardCharsets.UTF_8); }
    private static void write(File file, byte[] bytes) throws IOException {
        File parent = file.getParentFile();
        if (!parent.isDirectory() && !parent.mkdirs()) throw new IOException("Не удалось сохранить карту");
        try (FileOutputStream output = new FileOutputStream(file)) { output.write(bytes); output.getFD().sync(); }
    }
    private static File[] children(File directory) { File[] files = directory.listFiles(); return files == null ? new File[0] : files; }
    private static void deleteTree(File file) { if (file.isDirectory()) for (File child : children(file)) deleteTree(child); file.delete(); }
    private interface Tick { void run(); }
    private static final class Snapshot {
        final String id; final JSONObject record;
        Snapshot(String id, JSONObject record) { this.id = id; this.record = record; }
    }
    private static final class Budget {
        final long limit; long bytes;
        Budget(long limit) { this.limit = limit; }
        long remaining() { return limit - bytes; }
        void add(long count) throws IOException { if (count < 0 || count > remaining()) throw new IOException(TOO_LARGE); bytes += count; }
    }
    private static final class Throttle {
        final Progress listener; long last; String phase;
        Throttle(Progress listener) { this.listener = listener; }
        void send(String phase, long current, long total, boolean force) {
            long now = System.nanoTime();
            if (listener != null && (force || !phase.equals(this.phase) || now - last >= 150_000_000L)) {
                last = now; this.phase = phase; listener.update(phase, current, total);
            }
        }
    }
    static final class Tile {
        final int z, x, y;
        Tile(int z, int x, int y) { this.z = z; this.x = x; this.y = y; }
        String path() { return "tiles/" + z + "/" + x + "/" + y + ".pbf"; }
    }
    static final class Bounds {
        final double west, south, east, north;
        Bounds(double west, double south, double east, double north) { this.west = west; this.south = south; this.east = east; this.north = north; }
        static Bounds parse(JSONArray value) throws JSONException, IOException {
            if (value.length() != 2 || value.getJSONArray(0).length() != 2 || value.getJSONArray(1).length() != 2) throw new IOException("Некорректная область карты");
            JSONArray sw = value.getJSONArray(0), ne = value.getJSONArray(1);
            for (Object coordinate : new Object[]{sw.get(0), sw.get(1), ne.get(0), ne.get(1)})
                if (!(coordinate instanceof Number)) throw new IOException("Некорректная область карты");
            Bounds bounds = new Bounds(sw.getDouble(0), sw.getDouble(1), ne.getDouble(0), ne.getDouble(1));
            bounds.validate(); return bounds;
        }
        void validate() throws IOException {
            if (!Double.isFinite(west) || !Double.isFinite(south) || !Double.isFinite(east) || !Double.isFinite(north)
                || west < -180 || east > 180 || south < -85.05112878 || north > 85.05112878 || west >= east || south >= north)
                throw new IOException("Некорректная область карты");
        }
        JSONArray json() throws JSONException { return new JSONArray().put(new JSONArray().put(west).put(south)).put(new JSONArray().put(east).put(north)); }
    }
    static final class Request {
        final String requestId, name; final Bounds bounds;
        Request(String requestId, String name, Bounds bounds) { this.requestId = requestId; this.name = name; this.bounds = bounds; }
        static Request parse(String text) throws IOException {
            if (text == null || text.length() > 16 * 1024) throw new IOException("Некорректный запрос карты");
            try {
                JSONObject json = new JSONObject(text);
                Request request = new Request(json.getString("requestId"), json.optString("name", "Область карты"), Bounds.parse(json.getJSONArray("bounds")));
                request.validate(); return request;
            } catch (JSONException error) { throw new IOException("Некорректный запрос карты", error); }
        }
        void validate() throws IOException {
            if (requestId == null || requestId.length() > 120 || requestId.isEmpty() || name == null || name.length() > 120 || bounds == null)
                throw new IOException("Некорректный запрос карты");
            bounds.validate();
        }
    }
}
