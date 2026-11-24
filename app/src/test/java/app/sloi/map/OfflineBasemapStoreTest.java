package app.sloi.map;

import static org.junit.Assert.*;

import java.io.ByteArrayInputStream;
import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.List;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

public final class OfflineBasemapStoreTest {
    @Rule public TemporaryFolder temporary = new TemporaryFolder();
    private static final byte[] PBF = {0x1a, 0};
    private static final String TEMPLATE = "https://tiles.openfreemap.org/planet/revision_one/{z}/{x}/{y}.pbf";
    private static final OfflineBasemapStore.Bounds SMALL = new OfflineBasemapStore.Bounds(30.30001, 59.90001, 30.30002, 59.90002);

    private static final class Server implements OfflineBasemapStore.ConnectionFactory {
        final List<URL> requests = new ArrayList<>();
        final List<HttpURLConnection> connections = new ArrayList<>();
        String template = TEMPLATE;
        int failAt = -1, status = 200, closed;
        boolean emptyTiles, unknownLength, gzip;
        byte[] tileBytes = PBF;
        Runnable onRead;
        @Override public HttpURLConnection open(URL url) throws IOException {
            int number = requests.size(); requests.add(url);
            byte[] body = url.getPath().equals("/planet")
                ? ("{\"tilejson\":\"3.0.0\",\"minzoom\":0,\"maxzoom\":14,\"tiles\":[\"" + template
                    + "\"],\"vector_layers\":[{\"id\":\"water\",\"fields\":{}}],\"attribution\":\"OpenStreetMap\"}").getBytes(StandardCharsets.UTF_8)
                : url.getPath().startsWith("/fonts/") ? PBF : tileBytes;
            if (gzip) {
                java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream();
                try (java.util.zip.GZIPOutputStream zip = new java.util.zip.GZIPOutputStream(out)) { zip.write(body); }
                body = out.toByteArray();
            }
            final byte[] response = body;
            HttpURLConnection connection = new HttpURLConnection(url) {
                @Override public int getResponseCode() { return number == failAt ? 503 : emptyTiles && url.getPath().startsWith("/planet/") ? 204 : status; }
                @Override public String getContentType() { return url.getPath().equals("/planet") ? "application/json" : "application/x-protobuf"; }
                @Override public long getContentLengthLong() { return unknownLength ? -1 : response.length; }
                @Override public String getContentEncoding() { return gzip ? "gzip" : null; }
                @Override public InputStream getInputStream() {
                    return new ByteArrayInputStream(response) {
                        @Override public synchronized int read(byte[] buffer, int offset, int length) {
                            int result = super.read(buffer, offset, Math.min(length, 128));
                            if (result > 0 && onRead != null) { Runnable action = onRead; onRead = null; action.run(); }
                            return result;
                        }
                    };
                }
                @Override public void disconnect() { closed++; }
                @Override public boolean usingProxy() { return false; }
                @Override public void connect() {}
            };
            connections.add(connection);
            return connection;
        }
    }

    private OfflineBasemapStore store(File directory, Server server) { return new OfflineBasemapStore(directory, server, OfflineBasemapStore.MAX_BYTES); }
    private OfflineBasemapStore.Request request(String id) { return new OfflineBasemapStore.Request(id, "Петербург", SMALL); }
    private static List<File> packages(File root) {
        List<File> result = new ArrayList<>();
        for (File child : root.listFiles()) if (child.isDirectory() && child.getName().startsWith("p-")) result.add(child);
        return result;
    }
    private static void expectIOException(String part, Throwing action) throws Exception {
        try { action.run(); fail("Expected failure: " + part); }
        catch (IOException expected) { assertTrue(expected.getMessage(), expected.getMessage().contains(part)); }
    }
    private interface Throwing { void run() throws Exception; }

    @Test public void installsCompletePinnedPyramidAndRestoresItAfterRestart() throws Exception {
        File root = temporary.newFolder(); Server server = new Server(); OfflineBasemapStore store = store(root, server);
        List<String> phases = new ArrayList<>(); List<Long> progress = new ArrayList<>();
        JSONObject record = store.download(request("one"), (phase, current, total) -> { phases.add(phase); progress.add(current); });
        assertEquals("installed", record.getString("status"));
        assertEquals(15, record.getInt("tileCount"));
        assertEquals(TEMPLATE, record.getString("revision"));
        assertEquals(31, server.requests.size()); // Metadata + 15 glyph blocks + one tile at each zoom.
        assertEquals(server.requests.size(), server.closed);
        File directory = new File(root, record.getString("id"));
        JSONObject local = new JSONObject(new String(Files.readAllBytes(new File(directory, "tilejson.json").toPath()), StandardCharsets.UTF_8));
        assertEquals(14, local.getInt("maxzoom"));
        assertEquals(record.getString("tileJsonUrl").replace("tilejson.json", "tiles/{z}/{x}/{y}.pbf"), local.getJSONArray("tiles").getString(0));
        assertEquals("water", local.getJSONArray("vector_layers").getJSONObject(0).getString("id"));
        for (OfflineBasemapStore.Tile tile : OfflineBasemapStore.tiles(SMALL)) assertArrayEquals(PBF, Files.readAllBytes(new File(directory, tile.path()).toPath()));
        long stored = 0;
        try (java.util.stream.Stream<java.nio.file.Path> files = Files.walk(directory.toPath())) {
            stored = files.filter(Files::isRegularFile).mapToLong(path -> { try { return Files.size(path); } catch (IOException error) { throw new RuntimeException(error); } }).sum();
        }
        assertEquals(stored, record.getLong("bytes"));
        assertEquals("metadata", phases.get(0)); assertEquals("ready", phases.get(phases.size() - 1));
        for (int i = 1; i < progress.size(); i++) assertTrue(progress.get(i) >= progress.get(i - 1));
        for (HttpURLConnection connection : server.connections) {
            assertTrue(connection.getRequestProperty("User-Agent").startsWith("Sloi/"));
            assertFalse(connection.getInstanceFollowRedirects());
            assertEquals(10000, connection.getConnectTimeout()); assertEquals(15000, connection.getReadTimeout());
        }
        assertEquals(record.toString(), store(root, new Server()).record().toString());
        JSONObject copy = store.record(); copy.put("name", "mutated"); assertEquals("Петербург", store.record().getString("name"));
    }

    @Test public void failedReplacementKeepsCompleteExistingPackage() throws Exception {
        File root = temporary.newFolder(); Server server = new Server(); OfflineBasemapStore store = store(root, server);
        JSONObject ready = store.download(request("one"), null);
        server.failAt = server.requests.size() + 20;
        expectIOException("HTTP 503", () -> store.download(request("two"), null));
        assertEquals(ready.toString(), store.record().toString());
        assertEquals(ready.toString(), store(root, new Server()).record().toString());
        assertEquals(1, packages(root).size());
        for (File file : root.listFiles()) assertFalse(file.getName().startsWith("staging-"));
    }

    @Test public void cancelledReplacementKeepsOldPackageAndCanBeRetried() throws Exception {
        File root = temporary.newFolder(); Server server = new Server(); OfflineBasemapStore store = store(root, server);
        JSONObject ready = store.download(request("one"), null);
        server.onRead = store::cancel;
        expectIOException("отменена", () -> store.download(request("two"), null));
        assertEquals(ready.toString(), store.record().toString()); assertEquals(1, packages(root).size());
        JSONObject replacement = store.download(request("three"), null);
        assertNotEquals(ready.getString("id"), replacement.getString("id"));
        assertTrue(new File(root, ready.getString("id") + "/tilejson.json").isFile());
        assertEquals(2, packages(root).size());
        // A WebView may finish requests against the previous immutable URL.
        store.download(request("four"), null); assertEquals(2, packages(root).size());
        store(root, new Server()); assertEquals(1, packages(root).size());
    }

    @Test public void broadAreaIsRejectedBeforeAnyNetworkRequest() throws Exception {
        Server server = new Server(); OfflineBasemapStore store = store(temporary.newFolder(), server);
        expectIOException("3000", () -> store.download(new OfflineBasemapStore.Request("large", "Мир", new OfflineBasemapStore.Bounds(-180, -80, 180, 80)), null));
        assertTrue(server.requests.isEmpty()); assertNull(store.record());
    }

    @Test public void bytesAreBoundedEvenWithoutContentLengthAndOldMapSurvives() throws Exception {
        File root = temporary.newFolder(); Server server = new Server(); OfflineBasemapStore store = store(root, server);
        JSONObject ready = store.download(request("one"), null);
        long limit = 1200;
        OfflineBasemapStore bounded = new OfflineBasemapStore(root, server, limit);
        server.unknownLength = true; server.tileBytes = new byte[8192]; // Unknown length cannot bypass the budget.
        expectIOException("50 МБ", () -> bounded.download(request("two"), null));
        assertEquals(ready.toString(), bounded.record().toString()); assertEquals(1, packages(root).size());
        assertEquals(50_000_000L, OfflineBasemapStore.MAX_BYTES);
    }

    @Test public void validEmpty204TilesAreInstalledAndGlyphsRemainNonempty() throws Exception {
        File root = temporary.newFolder(); Server server = new Server(); server.emptyTiles = true;
        OfflineBasemapStore store = store(root, server); JSONObject record = store.download(request("empty"), null);
        for (OfflineBasemapStore.Tile tile : OfflineBasemapStore.tiles(SMALL)) assertEquals(0, new File(root, record.getString("id") + "/" + tile.path()).length());
        assertNotNull(store(root, new Server()).record());
        assertTrue(store.cachedFont("https://tiles.openfreemap.org/fonts/Noto%20Sans%20Regular/1024-1279.pbf").length() > 0);
    }

    @Test public void glyphLookupOnlyServesKnownHttpsOriginAndBlocksTraversal() throws Exception {
        Server server = new Server(); OfflineBasemapStore store = store(temporary.newFolder(), server);
        store.download(request("one"), null);
        assertNotNull(store.cachedFont("https://tiles.openfreemap.org/fonts/Noto%20Sans%20Bold/0-255.pbf"));
        for (String url : new String[]{
            "http://tiles.openfreemap.org/fonts/Noto%20Sans%20Bold/0-255.pbf",
            "https://evil.test/fonts/Noto%20Sans%20Bold/0-255.pbf",
            "https://tiles.openfreemap.org.evil.test/fonts/Noto%20Sans%20Bold/0-255.pbf",
            "https://tiles.openfreemap.org:444/fonts/Noto%20Sans%20Bold/0-255.pbf",
            "https://tiles.openfreemap.org/fonts/Noto%20Sans%20Bold/0-255.pbf?q=1",
            "https://tiles.openfreemap.org/fonts/../0-255.pbf",
            "https://tiles.openfreemap.org/fonts/Noto%20Sans%20Regular/65536-65791.pbf"}) assertNull(url, store.cachedFont(url));
    }

    @Test public void unsupportedTemplateAndRedirectAreRejectedWithoutFollowing() throws Exception {
        Server server = new Server(); server.template = "https://evil.test/{z}/{x}/{y}.pbf";
        OfflineBasemapStore store = store(temporary.newFolder(), server);
        expectIOException("недопустимый", () -> store.download(request("one"), null)); assertEquals(1, server.requests.size());
        server = new Server(); server.status = 302; final Server redirect = server;
        final OfflineBasemapStore other = store(temporary.newFolder(), server);
        expectIOException("HTTP 302", () -> other.download(request("two"), null)); assertEquals(1, redirect.requests.size());
    }

    @Test public void badProtobufDoesNotPublishPartialPackage() throws Exception {
        Server server = new Server(); server.tileBytes = "<html>blocked</html>".getBytes(StandardCharsets.UTF_8);
        File root = temporary.newFolder(); OfflineBasemapStore store = store(root, server);
        expectIOException("повреждённые", () -> store.download(request("bad"), null)); assertNull(store.record()); assertTrue(packages(root).isEmpty());
        assertFalse(OfflineBasemapStore.validProtobuf(new byte[]{0x1a, 0x05, 1}));
        assertFalse(OfflineBasemapStore.validProtobuf(new byte[]{8, (byte)0x80}));
        assertTrue(OfflineBasemapStore.validProtobuf(new byte[0]));
    }

    @Test public void compressedResourcesUseDecodedByteBudgetAndAreSavedDecoded() throws Exception {
        File root = temporary.newFolder(); Server server = new Server(); server.gzip = true;
        OfflineBasemapStore store = store(root, server); JSONObject record = store.download(request("gzip"), null);
        assertArrayEquals(PBF, Files.readAllBytes(new File(root, record.getString("id") + "/tiles/0/0/0.pbf").toPath()));
    }

    @Test public void deleteRemovesBothCurrentAndPreviousAndCancelsLookup() throws Exception {
        File root = temporary.newFolder(); OfflineBasemapStore store = store(root, new Server());
        store.download(request("one"), null); store.download(request("two"), null); assertEquals(2, packages(root).size());
        store.delete(); assertNull(store.record()); assertTrue(packages(root).isEmpty());
        assertNull(store.cachedFont("https://tiles.openfreemap.org/fonts/Noto%20Sans%20Bold/0-255.pbf"));
        assertNull(store(root, new Server()).record());
    }

    @Test public void startupRejectsMissingTilesAndDiscardsAbandonedStaging() throws Exception {
        File root = temporary.newFolder(); OfflineBasemapStore store = store(root, new Server());
        JSONObject record = store.download(request("one"), null);
        assertTrue(new File(root, "staging-abandoned").mkdirs());
        assertTrue(new File(root, record.getString("id") + "/tiles/0/0/0.pbf").delete());
        assertNull(store(root, new Server()).record());
        assertTrue(packages(root).isEmpty()); assertFalse(new File(root, "staging-abandoned").exists());
    }

    @Test public void requestValidationRejectsInvalidShapeCoordinatesAndIdentifiers() throws Exception {
        OfflineBasemapStore.Request parsed = OfflineBasemapStore.Request.parse("{\"requestId\":\"one\",\"bounds\":[[30.3,59.9],[30.4,60.0]]}");
        assertEquals("Область карты", parsed.name); assertEquals(30.3, parsed.bounds.west, 0);
        for (String json : new String[]{"{}", "{\"requestId\":\"\",\"bounds\":[[0,0],[1,1]]}",
            "{\"requestId\":\"a\",\"bounds\":[[\"0\",0],[1,1]]}",
            "{\"requestId\":\"a\",\"bounds\":[[1,0],[0,1]]}",
            "{\"requestId\":\"a\",\"bounds\":[[0,0],[1,90]]}",
            "{\"requestId\":\"a\",\"bounds\":[[-181,0],[1,1]]}",
            "{\"requestId\":\"a\",\"bounds\":[[0,0],[1,1],[2,2]]}"}) expectIOException("Некоррект", () -> OfflineBasemapStore.Request.parse(json));
        expectIOException("Некоррект", () -> new OfflineBasemapStore.Bounds(Double.NaN, 0, 1, 1).validate());
    }
}
