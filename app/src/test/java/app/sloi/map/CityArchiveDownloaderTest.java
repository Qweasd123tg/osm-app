package app.sloi.map;

import static org.junit.Assert.*;

import java.io.ByteArrayInputStream;
import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import org.junit.Test;

public final class CityArchiveDownloaderTest {
    private static byte[] payload(int length) {
        byte[] data = new byte[length];
        for (int i = 0; i < length; i++) data[i] = (byte) (i * 31 + i / 251);
        return data;
    }

    private static class Server implements CityArchiveDownloader.Connections {
        final byte[] data;
        final List<String> ranges = new ArrayList<>();
        final List<Integer> timeouts = new ArrayList<>();
        int opened, closed, forcedStatus;
        boolean full, fullAfterFirst, failFirst, failOnce, failAlways, malformed, oversize, cancel;
        Server(byte[] data) { this.data = data; }
        @Override public HttpURLConnection open() throws IOException {
            int attempt = ++opened;
            return new HttpURLConnection(new URL("https://example.test/city.zip")) {
                long start, end;
                private boolean fullResponse() { return full || (fullAfterFirst && attempt > 1); }
                @Override public int getResponseCode() {
                    String range = getRequestProperty("Range");
                    ranges.add(range);
                    String[] parts = range.substring(6).split("-");
                    start = Long.parseLong(parts[0]); end = Long.parseLong(parts[1]);
                    return forcedStatus != 0 ? forcedStatus : fullResponse() ? 200 : 206;
                }
                @Override public long getContentLengthLong() { return fullResponse() ? data.length : end - start + 1; }
                @Override public String getHeaderField(String name) {
                    if (name.equals("ETag")) return "\"revision-one\"";
                    if (!name.equals("Content-Range")) return null;
                    return "bytes " + (malformed ? start + 1 : start) + "-" + end + "/" + (oversize ? data.length + 1L : data.length);
                }
                @Override public InputStream getInputStream() {
                    byte[] body = fullResponse() ? data : Arrays.copyOfRange(data, (int) start, (int) end + 1);
                    if (cancel || failAlways || (failFirst && attempt == 1) || (failOnce && attempt == 2)) {
                        return new ByteArrayInputStream(body) {
                            int reads;
                            @Override public synchronized int read(byte[] buffer, int offset, int length) {
                                if (reads++ == 1) {
                                    if (cancel) Thread.currentThread().interrupt();
                                    throw new ReadFailure();
                                }
                                return super.read(buffer, offset, Math.min(length, 100));
                            }
                        };
                    }
                    return new ByteArrayInputStream(body);
                }
                @Override public void disconnect() {}
                @Override public boolean usingProxy() { return false; }
                @Override public void connect() {}
            };
        }
        @Override public void close(HttpURLConnection connection) { closed++; timeouts.add(connection.getReadTimeout()); connection.disconnect(); }
    }

    // ByteArrayInputStream cannot declare IOException on its override. Translate
    // it through a separate wrapper below, preserving a real checked read error.
    private static final class ReadFailure extends RuntimeException {}
    private static CityArchiveDownloader.Connections checked(Server server) {
        return new CityArchiveDownloader.Connections() {
            @Override public HttpURLConnection open() throws IOException {
                HttpURLConnection original = server.open();
                return new HttpURLConnection(new URL("https://example.test/city.zip")) {
                    @Override public void setRequestProperty(String k, String v) { original.setRequestProperty(k, v); }
                    @Override public int getResponseCode() throws IOException { return original.getResponseCode(); }
                    @Override public String getHeaderField(String name) { return original.getHeaderField(name); }
                    @Override public long getContentLengthLong() { return original.getContentLengthLong(); }
                    @Override public InputStream getInputStream() throws IOException {
                        InputStream input = original.getInputStream();
                        return new InputStream() {
                            @Override public int read() throws IOException { return input.read(); }
                            @Override public int read(byte[] b, int off, int len) throws IOException {
                                try { return input.read(b, off, len); }
                                catch (ReadFailure error) { throw new IOException("Simulated partial socket failure"); }
                            }
                            @Override public void close() throws IOException { input.close(); }
                        };
                    }
                    @Override public void disconnect() { original.disconnect(); }
                    @Override public boolean usingProxy() { return false; }
                    @Override public void connect() {}
                };
            }
            @Override public void close(HttpURLConnection c) { server.close(c); }
        };
    }

    @Test public void reconstructsArchiveFromValidatedRangesAndClosesEveryConnection() throws Exception {
        Server server = new Server(payload(2 * CityArchiveDownloader.CHUNK_BYTES + 123));
        File target = File.createTempFile("city-range-", ".zip");
        List<Long> progress = new ArrayList<>();
        try {
            CityArchiveDownloader.download(target, server.data.length, server.data.length, checked(server), (current,total) -> progress.add(current));
            assertArrayEquals(server.data, Files.readAllBytes(target.toPath()));
            assertEquals(3, server.opened); assertEquals(server.opened, server.closed);
            assertEquals(Arrays.asList(10000,10000,10000),server.timeouts);
            assertEquals("bytes=0-1048575", server.ranges.get(0));
            assertEquals(Long.valueOf(0), progress.get(0));
            assertEquals(Long.valueOf(server.data.length), progress.get(progress.size()-1));
        } finally { target.delete(); }
    }

    @Test public void retriesPartialSecondRangeWithoutDuplicatingCommittedBytes() throws Exception {
        Server server = new Server(payload(CityArchiveDownloader.CHUNK_BYTES + 123)); server.failOnce = true;
        File target = File.createTempFile("city-range-", ".zip");
        List<Long> updates = new ArrayList<>();
        try {
            CityArchiveDownloader.download(target, server.data.length, server.data.length, checked(server), (a,b) -> updates.add(a));
            assertArrayEquals(server.data, Files.readAllBytes(target.toPath()));
            assertEquals(3, server.opened); assertEquals(server.opened, server.closed);
            assertEquals(server.ranges.get(1), server.ranges.get(2));
            assertTrue("Partial data must be visible before a stalled range is committed",
                updates.contains((long)CityArchiveDownloader.CHUNK_BYTES + 100));
        } finally { target.delete(); }
    }

    @Test public void supportsServerIgnoringRangesOnlyFromOffsetZero() throws Exception {
        Server server = new Server(payload(1000)); server.full = true;
        File target = File.createTempFile("city-range-", ".zip");
        try {
            CityArchiveDownloader.download(target, 1000, 1000, checked(server), (a,b) -> {});
            assertArrayEquals(server.data, Files.readAllBytes(target.toPath()));
            assertEquals(1, server.closed);
        } finally { target.delete(); }
    }

    @Test public void neverAppendsAFullResponseToAnAlreadyCommittedRange() throws Exception {
        Server server = new Server(payload(CityArchiveDownloader.CHUNK_BYTES + 123));
        server.fullAfterFirst = true;
        File target = File.createTempFile("city-range-", ".zip");
        try {
            try { CityArchiveDownloader.download(target,server.data.length,server.data.length,checked(server),(a,b)->{}); fail("resumed full response"); }
            catch (IOException expected) { assertTrue(expected.getMessage().contains("ignored")); }
            assertEquals(2, server.opened); assertEquals(2, server.closed);
            assertArrayEquals(Arrays.copyOfRange(server.data,0,CityArchiveDownloader.CHUNK_BYTES),Files.readAllBytes(target.toPath()));
        } finally { target.delete(); }
    }

    @Test public void fullResponseRetryOverwritesItsPartialBytes() throws Exception {
        Server server = new Server(payload(1000)); server.full = true; server.failFirst = true;
        File target = File.createTempFile("city-range-", ".zip");
        try {
            CityArchiveDownloader.download(target,1000,1000,checked(server),(a,b)->{});
            assertArrayEquals(server.data,Files.readAllBytes(target.toPath()));
            assertEquals(2, server.opened); assertEquals(2, server.closed);
        } finally { target.delete(); }
    }

    @Test public void rejectsRangeMismatchAndChangedOrOversizedArchiveWithoutRetry() throws Exception {
        for (boolean wrongStart : new boolean[] {true, false}) {
            Server server = new Server(payload(1000)); server.malformed = wrongStart; server.oversize = !wrongStart;
            File target = File.createTempFile("city-range-", ".zip");
            try {
                try { CityArchiveDownloader.download(target,1000,1000,checked(server),(a,b)->{}); fail("invalid range"); }
                catch (IOException expected) { assertTrue(expected.getMessage().contains("range")); }
                assertEquals(1, server.opened); assertEquals(1, server.closed); assertEquals(0, target.length());
            } finally { target.delete(); }
        }
    }

    @Test public void rateLimitDoesNotTriggerImmediateRetries() throws Exception {
        Server server = new Server(payload(1000)); server.forcedStatus = 429;
        File target = File.createTempFile("city-range-", ".zip");
        try {
            try { CityArchiveDownloader.download(target,1000,1000,checked(server),(a,b)->{}); fail("rate limited"); }
            catch (IOException expected) { assertTrue(expected.getMessage().contains("429")); }
            assertEquals(1,server.opened); assertEquals(1,server.closed);
        } finally { target.delete(); }
    }

    @Test public void capsRetriesAndDoesNotRetryCancellation() throws Exception {
        for (boolean cancel : new boolean[] {false,true}) {
            Server server = new Server(payload(1000)); server.failAlways = true; server.cancel = cancel;
            File target = File.createTempFile("city-range-", ".zip");
            try {
                try { CityArchiveDownloader.download(target,1000,1000,checked(server),(a,b)->{}); fail("must fail"); }
                catch (IOException expected) { assertEquals(cancel ? 1 : 3, server.opened); }
                assertEquals(server.opened, server.closed); assertEquals(0, target.length());
            } finally { Thread.interrupted(); target.delete(); }
        }
    }
}
