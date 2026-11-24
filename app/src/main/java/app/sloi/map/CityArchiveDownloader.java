package app.sloi.map;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** Bounded range transfers; an incomplete range is discarded before retrying. */
final class CityArchiveDownloader {
    static final int CHUNK_BYTES = 1024 * 1024;
    static final int MAX_ATTEMPTS = 3;
    private static final Pattern CONTENT_RANGE = Pattern.compile("bytes ([0-9]+)-([0-9]+)/([0-9]+)");

    interface Connections {
        HttpURLConnection open() throws IOException;
        void close(HttpURLConnection connection);
    }
    interface Progress { void update(long current, long total); }
    private static final class InvalidResponse extends IOException {
        InvalidResponse(String message) { super(message); }
    }

    static void download(File target, long expected, long maximum, Connections connections,
                         Progress progress) throws IOException {
        if (expected < 1 || expected > maximum) throw new IOException("Invalid city archive size");
        checkCancelled();
        progress.update(0, expected);
        long offset = 0;
        String validator = null;
        try (FileOutputStream output = new FileOutputStream(target)) {
            while (offset < expected) {
                long end = Math.min(expected - 1, offset + CHUNK_BYTES - 1);
                boolean completed = false;
                IOException failure = null;
                for (int attempt = 0; attempt < MAX_ATTEMPTS && !completed; attempt++) {
                    checkCancelled();
                    if (offset == 0) {
                        output.getChannel().truncate(0);
                        output.getChannel().position(0);
                    }
                    HttpURLConnection connection = null;
                    boolean committingChunk = false;
                    try {
                        connection = connections.open();
                        connection.setReadTimeout(10_000);
                        connection.setRequestProperty("Range", "bytes=" + offset + "-" + end);
                        connection.setRequestProperty("Accept-Encoding", "identity");
                        if (validator != null) connection.setRequestProperty("If-Range", validator);
                        int status = connection.getResponseCode();
                        if (status == 200) {
                            if (offset != 0) throw new InvalidResponse("Server ignored a resumed archive range");
                            long length = connection.getContentLengthLong();
                            if (length > maximum || (length >= 0 && length != expected))
                                throw new InvalidResponse("City archive size changed; refresh the catalogue");
                            // A server without range support is allowed only at offset zero.
                            // Stage the whole attempt on disk; overwrite it before any retry.
                            output.getChannel().truncate(0);
                            output.getChannel().position(0);
                            try (InputStream input = connection.getInputStream()) {
                                long done = copyFull(input, output, expected, maximum, progress);
                                progress.update(done, done);
                            }
                            return;
                        }
                        if (status != 206) {
                            if (status == 429)
                                throw new InvalidResponse("BBBike rate limit (HTTP 429); retry the city download later");
                            if (status == 408 || status >= 500)
                                throw new IOException("BBBike returned HTTP " + status);
                            throw new InvalidResponse("BBBike returned HTTP " + status);
                        }
                        long[] range = parseRange(connection.getHeaderField("Content-Range"));
                        if (range[0] != offset || range[1] != end || range[2] != expected || range[2] > maximum)
                            throw new InvalidResponse("BBBike returned an inconsistent archive range");
                        long length = connection.getContentLengthLong();
                        int required = (int) (end - offset + 1);
                        if (length >= 0 && length != required)
                            throw new InvalidResponse("BBBike returned an inconsistent range length");
                        String revision = connection.getHeaderField("ETag");
                        if (revision == null) revision = connection.getHeaderField("Last-Modified");
                        if (validator != null && revision != null && !validator.equals(revision))
                            throw new InvalidResponse("City archive changed during download");
                        byte[] chunk;
                        try (InputStream input = connection.getInputStream()) {
                            chunk = readChunk(input, required, offset, expected, progress);
                        }
                        checkCancelled();
                        committingChunk = true;
                        output.write(chunk);
                        offset += chunk.length;
                        if (validator == null) validator = revision;
                        progress.update(offset, expected);
                        completed = true;
                    } catch (InvalidResponse error) {
                        throw error;
                    } catch (IOException error) {
                        checkCancelled();
                        if (committingChunk) throw error;
                        failure = error;
                    } finally {
                        if (connection != null) connections.close(connection);
                    }
                }
                if (!completed) throw new IOException("City archive transfer stalled or failed after "
                    + MAX_ATTEMPTS + " attempts at " + offset + " bytes; check the network and retry", failure);
            }
        }
    }

    private static long[] parseRange(String header) throws IOException {
        Matcher match = CONTENT_RANGE.matcher(header == null ? "" : header.trim());
        if (!match.matches()) throw new InvalidResponse("BBBike did not provide a valid Content-Range");
        try {
            long start = Long.parseLong(match.group(1)), end = Long.parseLong(match.group(2)), total = Long.parseLong(match.group(3));
            if (start < 0 || end < start || total <= end) throw new NumberFormatException();
            return new long[] {start, end, total};
        } catch (NumberFormatException error) { throw new InvalidResponse("Invalid archive range bounds"); }
    }

    private static byte[] readChunk(InputStream input, int required, long offset, long total,
                                    Progress progress) throws IOException {
        ByteArrayOutputStream output = new ByteArrayOutputStream(required);
        byte[] buffer = new byte[32768];
        for (int count; (count = input.read(buffer)) != -1;) {
            checkCancelled();
            if (count > required - output.size()) throw new InvalidResponse("Archive range exceeds declared bounds");
            output.write(buffer, 0, count);
            progress.update(offset + output.size(), total);
        }
        if (output.size() != required) throw new IOException("Incomplete city archive range");
        return output.toByteArray();
    }

    private static long copyFull(InputStream input, FileOutputStream output, long expected,
                                 long maximum, Progress progress) throws IOException {
        byte[] buffer = new byte[32768];
        long done = 0;
        for (int count; (count = input.read(buffer)) != -1;) {
            checkCancelled();
            if (count > maximum - done || count > expected - done)
                throw new InvalidResponse("City archive exceeds declared size");
            output.write(buffer, 0, count);
            done += count;
            progress.update(done, expected);
        }
        if (done != expected) throw new IOException("Incomplete city archive");
        return done;
    }

    private static void checkCancelled() throws IOException {
        if (Thread.currentThread().isInterrupted()) throw new IOException("City archive download cancelled");
    }
}
