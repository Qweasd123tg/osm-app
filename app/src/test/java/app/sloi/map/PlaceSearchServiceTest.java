package app.sloi.map;

import org.json.JSONArray;
import org.junit.Test;
import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.ArrayList;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import java.util.concurrent.atomic.AtomicInteger;
import static org.junit.Assert.*;

public class PlaceSearchServiceTest {
    private static final String FEATURE = "{\"type\":\"Feature\",\"geometry\":{\"type\":\"Point\",\"coordinates\":[30.3,59.9]},\"properties\":{\"name\":\"Невский\",\"street\":\"Невский проспект\",\"housenumber\":\"1\",\"city\":\"Петербург\",\"country\":\"Россия\"}}";
    private static final String PAYLOAD = "{\"features\":[" + FEATURE + "]}";

    @Test public void readyLocalAddressesNeverOpenNetworkAndOverrideOldPhotonCache() throws Exception {
        AtomicInteger requests = new AtomicInteger();
        AtomicReference<String> local = new AtomicReference<>(null);
        PlaceSearchService service = new PlaceSearchService(url -> {
            requests.incrementAndGet(); return new FakeConnection(url, PAYLOAD);
        }, (query, limit, lat, lon) -> local.get(), () -> true);
        try {
            service.search("Невский", 6, 59.9, 30.3, 15);
            assertEquals(1, requests.get());
            String offline = "[{\"name\":\"Невский проспект 12\",\"latitude\":59.9,\"longitude\":30.3}]";
            local.set(offline);
            assertEquals(offline, service.search("Невский", 6, 59.9, 30.3, 15));
            assertEquals(1, requests.get());
        } finally { service.close(); }
    }

    @Test public void emptyLocalIndexAnswersOfflineWhileOnlineMissCanFindOtherCities() throws Exception {
        AtomicInteger requests = new AtomicInteger();
        java.util.concurrent.atomic.AtomicBoolean online = new java.util.concurrent.atomic.AtomicBoolean(false);
        AtomicReference<String> local = new AtomicReference<>("[]");
        PlaceSearchService service = new PlaceSearchService(url -> {
            requests.incrementAndGet(); return new FakeConnection(url, PAYLOAD);
        }, (query, limit, lat, lon) -> local.get(), online::get);
        try {
            assertEquals("[]", service.search("Неизвестный адрес", 6, 59.9, 30.3, 15));
            local.set(null);
            assertThrows(IOException.class, () -> service.search("Москва", 6, 59.9, 30.3, 15));
            assertEquals(0, requests.get());
            local.set("[]"); online.set(true);
            assertTrue(new JSONArray(service.search("Москва", 6, 59.9, 30.3, 15)).length() > 0);
            assertEquals(1, requests.get());
        } finally { service.close(); }
    }

    @Test public void normalizesAddressAndSkipsInvalidCoordinatesAndDuplicates() throws Exception {
        String invalid = FEATURE.replace("[30.3,59.9]", "[null,59.9]");
        JSONArray places = new JSONArray(PlaceSearchService.normalize("{\"features\":[" + FEATURE + "," + FEATURE + "," + invalid + "]}", 6));
        assertEquals(1, places.length());
        assertEquals("Невский, Невский проспект 1, Петербург, Россия", places.getJSONObject(0).getString("display_name"));
        assertEquals(30.3, places.getJSONObject(0).getDouble("longitude"), .00001);
        assertEquals(59.9, places.getJSONObject(0).getDouble("latitude"), .00001);
        assertThrows(IOException.class, () -> PlaceSearchService.normalize("{\"items\":[]}", 6));
    }

    @Test public void boundedCacheReusesQueriesButRespectsViewBiasAndEvictsOldest() throws Exception {
        ArrayList<URL> requests = new ArrayList<>();
        PlaceSearchService service = new PlaceSearchService(url -> { requests.add(url); return new FakeConnection(url, PAYLOAD); });
        String first = service.search("  Невский   проспект ", 100, 59.9, 30.3, 15);
        assertEquals(first, service.search("Невский проспект", 100, 59.9, 30.3, 15));
        assertEquals(1, requests.size());
        assertTrue(requests.get(0).toString().contains("limit=6"));
        assertTrue(requests.get(0).toString().contains("&lat=59.9&lon=30.3&zoom=15"));
        assertFalse(requests.get(0).toString().contains("zoom=15.0"));
        service.search("Невский проспект", 6, 59.8, 30.3, 15);
        assertEquals(2, requests.size());
        for (int index = 0; index < 32; index++) service.search("Улица " + index, 6, Double.NaN, Double.NaN, 12);
        service.search("Невский проспект", 6, 59.9, 30.3, 15);
        assertEquals(35, requests.size());
        assertThrows(IllegalArgumentException.class, () -> service.search("a", 6, 0, 0, 12));
    }

    @Test public void photonUrlUsesIntegerZoomForFractionalCameraAndApiBounds() throws Exception {
        ArrayList<URL> requests = new ArrayList<>();
        PlaceSearchService service = new PlaceSearchService(url -> { requests.add(url); return new FakeConnection(url, PAYLOAD); });
        double[] cameras = {15.0, 14.781, 19, 100, -10, 0, Double.NaN, Double.POSITIVE_INFINITY};
        int[] expected = {15, 15, 18, 18, 0, 0, 12, 12};
        for (int index = 0; index < cameras.length; index++) {
            service.search("Московская " + index, 6, 59.9, 30.32, cameras[index]);
            String query = requests.get(index).getQuery();
            assertTrue(query.endsWith("&zoom=" + expected[index]));
            assertTrue(query.contains("&lat=59.9&lon=30.32"));
        }
    }

    @Test public void cancelDisconnectsInFlightSocketAndDoesNotCacheItsResult() throws Exception {
        CountDownLatch reading = new CountDownLatch(1), disconnected = new CountDownLatch(1);
        AtomicReference<Throwable> error = new AtomicReference<>();
        PlaceSearchService service = new PlaceSearchService(url -> new FakeConnection(url, PAYLOAD) {
            @Override public InputStream getInputStream() {
                return new InputStream() {
                    @Override public int read() throws IOException {
                        reading.countDown();
                        try { if (!disconnected.await(2, TimeUnit.SECONDS)) throw new IOException("cancel did not disconnect"); }
                        catch (InterruptedException exception) { Thread.currentThread().interrupt(); }
                        throw new IOException("disconnected");
                    }
                };
            }
            @Override public void disconnect() { disconnected.countDown(); }
        });
        Thread worker = new Thread(() -> { try { service.search("Невский", 6, 59.9, 30.3, 15); } catch (Throwable exception) { error.set(exception); } });
        worker.start(); assertTrue(reading.await(2, TimeUnit.SECONDS)); service.cancel(); worker.join(2000);
        assertFalse(worker.isAlive()); assertTrue(error.get() instanceof IOException);
        service.close();
    }

    @Test public void latestQueryStartsBeforeCancelledReadAndDisconnectReturn() throws Exception {
        CountDownLatch reading = new CountDownLatch(1), closing = new CountDownLatch(1);
        CountDownLatch releaseRead = new CountDownLatch(1), releaseClose = new CountDownLatch(1);
        AtomicInteger requests = new AtomicInteger();
        PlaceSearchService service = new PlaceSearchService(url -> {
            if (requests.incrementAndGet() != 1) return new FakeConnection(url, PAYLOAD);
            return new FakeConnection(url, PAYLOAD) {
                @Override public InputStream getInputStream() {
                    return new InputStream() {
                        @Override public int read() throws IOException {
                            reading.countDown(); awaitIgnoringInterrupt(releaseRead);
                            throw new IOException("old read finally returned");
                        }
                    };
                }
                @Override public void disconnect() { closing.countDown(); awaitIgnoringInterrupt(releaseClose); }
            };
        });
        ExecutorService workers = PlaceSearchService.newSearchExecutor();
        ExecutorService bridge = Executors.newSingleThreadExecutor();
        try {
            Future<?> previous = workers.submit(() -> {
                try { service.search("Медленный", 6, 59.9, 30.3, 15); }
                catch (IOException expected) { /* Cancelled request must never delay the next query. */ }
            });
            assertTrue(reading.await(2, TimeUnit.SECONDS));
            // Model the actual synchronous JS bridge cancellation. Android's
            // disconnect may itself wait for that old read; keep both stuck.
            bridge.submit(service::cancel).get(500, TimeUnit.MILLISECONDS);
            previous.cancel(true);
            assertTrue(closing.await(2, TimeUnit.SECONDS));
            Future<String> next = workers.submit(() -> service.search("Невский", 6, 59.9, 30.3, 15));
            assertEquals("Невский", new JSONArray(next.get(1, TimeUnit.SECONDS)).getJSONObject(0).getString("name"));
            assertEquals(1, releaseRead.getCount());
            assertEquals(1, releaseClose.getCount());
            assertEquals(2, requests.get());
            assertEquals(2, ((ThreadPoolExecutor) workers).getMaximumPoolSize());
            assertEquals(1, ((ThreadPoolExecutor) workers).getQueue().remainingCapacity());
        } finally {
            releaseRead.countDown(); releaseClose.countDown(); service.close();
            bridge.shutdownNow(); workers.shutdownNow();
            assertTrue(workers.awaitTermination(2, TimeUnit.SECONDS));
            assertTrue(bridge.awaitTermination(2, TimeUnit.SECONDS));
        }
    }

    @Test public void pendingQueueKeepsOnlyLatestCancelledSearch() throws Exception {
        ExecutorService workers = PlaceSearchService.newSearchExecutor();
        CountDownLatch occupied = new CountDownLatch(2), release = new CountDownLatch(1);
        AtomicInteger completed = new AtomicInteger();
        try {
            for (int index = 0; index < 2; index++) workers.submit(() -> { occupied.countDown(); awaitIgnoringInterrupt(release); });
            assertTrue(occupied.await(2, TimeUnit.SECONDS));
            Future<?> pending = null;
            for (int index = 1; index <= 20; index++) {
                if (pending != null) pending.cancel(true);
                final int value = index;
                pending = workers.submit(() -> completed.set(value));
                assertEquals(1, ((ThreadPoolExecutor) workers).getQueue().size());
            }
            release.countDown(); pending.get(1, TimeUnit.SECONDS);
            assertEquals(20, completed.get());
        } finally {
            release.countDown(); workers.shutdownNow();
            assertTrue(workers.awaitTermination(2, TimeUnit.SECONDS));
        }
    }

    private static void awaitIgnoringInterrupt(CountDownLatch latch) {
        boolean interrupted = false;
        while (true) {
            try { latch.await(); break; }
            catch (InterruptedException error) { interrupted = true; }
        }
        if (interrupted) Thread.currentThread().interrupt();
    }

    private static class FakeConnection extends HttpURLConnection {
        final byte[] content;
        FakeConnection(URL url, String text) { super(url); content = text.getBytes(java.nio.charset.StandardCharsets.UTF_8); }
        @Override public int getResponseCode() {
            // Match Photon's actual Integer parser; accepting every mock URL
            // previously hid HTTP 400 for an otherwise valid camera value15.0.
            for (String parameter : getURL().getQuery().split("&")) if (parameter.startsWith("zoom=")) {
                try { Integer.parseInt(parameter.substring(5)); }
                catch (NumberFormatException error) { return 400; }
            }
            return 200;
        }
        @Override public long getContentLengthLong() { return content.length; }
        @Override public InputStream getInputStream() { return new ByteArrayInputStream(content); }
        @Override public void disconnect() {}
        @Override public boolean usingProxy() { return false; }
        @Override public void connect() {}
    }
}
