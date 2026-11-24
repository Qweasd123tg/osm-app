package app.sloi.map;

import static org.junit.Assert.*;

import java.io.ByteArrayInputStream;
import java.io.File;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.zip.ZipEntry;
import java.util.zip.ZipOutputStream;
import java.net.URL;
import java.security.cert.Certificate;
import java.util.Set;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import javax.net.ssl.HttpsURLConnection;

import org.junit.Test;

/** Import transport/publication helpers; actual Android SQLite validation is tested in APK. */
public final class CityPackImportTest {
    @Test public void cancelReturnsWhileAndroidDisconnectIsStillBlocked() throws Exception {
        File root = Files.createTempDirectory("sloi-city-cancel-").toFile();
        CountDownLatch entered = new CountDownLatch(1), release = new CountDownLatch(1);
        ExecutorService caller = Executors.newSingleThreadExecutor();
        CityPackStore store = new CityPackStore(root);
        try {
            HttpsURLConnection blocked = new HttpsURLConnection(new URL("https://example.invalid/pack")) {
                @Override public void disconnect() { entered.countDown(); for (;;) { try { release.await(); return; } catch (InterruptedException ignored) { } } }
                @Override public boolean usingProxy() { return false; }
                @Override public void connect() { }
                @Override public String getCipherSuite() { return "fixture"; }
                @Override public Certificate[] getLocalCertificates() { return null; }
                @Override public Certificate[] getServerCertificates() { return null; }
            };
            // Exercise the actual cancellation boundary with Android's blocking
            // socket behavior, without a real network or a timing-only benchmark.
            java.lang.reflect.Field field = CityPackStore.class.getDeclaredField("activeConnections"); field.setAccessible(true);
            @SuppressWarnings("unchecked") Set<HttpsURLConnection> active = (Set<HttpsURLConnection>) field.get(store);
            active.add(blocked);
            Future<?> cancelled = caller.submit(store::cancelActiveRequests);
            assertTrue(entered.await(1, TimeUnit.SECONDS));
            cancelled.get(500, TimeUnit.MILLISECONDS); // Must finish BEFORE the disconnect latch is released.
            assertEquals(1, release.getCount());
            active.clear();
        } finally { release.countDown(); caller.shutdownNow(); store.close(); remove(root); }
    }

    @Test public void contentMagicDeterminesFormatInsteadOfUntrustedFilename() {
        assertTrue(CityPackStore.isSqliteHeader("SQLite format 3\0".getBytes(StandardCharsets.US_ASCII), 16));
        assertFalse(CityPackStore.isSqliteHeader("SQLite format 2\0".getBytes(StandardCharsets.US_ASCII), 16));
        assertFalse(CityPackStore.isSqliteHeader("SQLite".getBytes(StandardCharsets.US_ASCII), 6));
        assertTrue(CityPackStore.isZipHeader(new byte[]{'P','K',3,4}, 4));
        assertTrue(CityPackStore.isZipHeader(new byte[]{'P','K',5,6}, 4));
        assertFalse(CityPackStore.isZipHeader("<html>".getBytes(StandardCharsets.US_ASCII), 6));
    }

    @Test public void importedStreamsEnforceUnknownAndDeclaredSizesAndReportActualCompletion() throws Exception {
        File root = Files.createTempDirectory("sloi-import-copy-").toFile();
        try {
            File target = new File(root, "copy");
            byte[] data = new byte[65_000]; Arrays.fill(data, (byte) 17);
            List<String> progress = new ArrayList<>();
            assertEquals(data.length, CityPackStore.copyImportedInput(new ByteArrayInputStream(data), target, -1, data.length,
                (phase, current, total) -> progress.add(phase + ":" + current + "/" + total)));
            assertArrayEquals(data, Files.readAllBytes(target.toPath()));
            assertEquals("import-copy:65000/65000", progress.get(progress.size()-1));
            expectIo(() -> CityPackStore.copyImportedInput(new ByteArrayInputStream(data), target, -1, data.length-1, null));
            expectIo(() -> CityPackStore.copyImportedInput(new ByteArrayInputStream(data), target, data.length+1, data.length+2, null));
            expectIo(() -> CityPackStore.copyImportedInput(new ByteArrayInputStream(new byte[0]), target, -1, 100, null));
        } finally { remove(root); }
    }

    @Test public void importCopyHonoursCancellationWithoutReplacingAnInstalledFile() throws Exception {
        File root = Files.createTempDirectory("sloi-import-cancel-").toFile();
        try {
            File original = write(root, "installed", "previous");
            Thread.currentThread().interrupt();
            expectIo(() -> CityPackStore.copyImportedInput(new ByteArrayInputStream(new byte[]{1,2}), new File(root, "stage"), -1, 100, null));
            assertEquals("previous", read(original));
        } finally { Thread.interrupted(); remove(root); }
    }

    @Test public void zipImportExtractsExactlyOneGpkgWithoutChangingItsBytes() throws Exception {
        File root = Files.createTempDirectory("sloi-import-zip-").toFile();
        try {
            File zip = archive(root, new String[]{"README.txt", "city/SanktPetersburg.gpkg"});
            File target = new File(root, "extracted");
            CityPackStore.extractGeoPackage(zip, target, null);
            assertEquals("payload-1", read(target));
            expectIo(() -> CityPackStore.extractGeoPackage(archive(root, new String[]{"one.gpkg", "two.gpkg"}), target, null));
            expectIo(() -> CityPackStore.extractGeoPackage(archive(root, new String[]{"README.txt"}), target, null));
            expectIo(() -> CityPackStore.extractGeoPackage(archive(root, new String[]{"../escape.gpkg"}), target, null));
            expectIo(() -> CityPackStore.extractGeoPackage(archive(root, new String[]{"C:\\escape.gpkg"}), target, null));
        } finally { remove(root); }
    }

    @Test public void zipCrcIsCheckedExplicitlyEvenWhenInflaterAcceptsThePayload() throws Exception {
        File root = Files.createTempDirectory("sloi-import-crc-").toFile();
        try {
            File zip = archive(root, new String[]{"city.gpkg"});
            byte[] bytes = Files.readAllBytes(zip.toPath());
            int central = -1;
            for (int i=0;i<bytes.length-46;i++) if (bytes[i]==0x50 && bytes[i+1]==0x4b && bytes[i+2]==1 && bytes[i+3]==2) { central=i; break; }
            assertTrue(central>=0);
            ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN).putInt(central+16, 0x12345678);
            Files.write(zip.toPath(), bytes);
            try { CityPackStore.extractGeoPackage(zip, new File(root, "out"), null); fail("wrong CRC accepted"); }
            catch (IOException expected) { assertTrue(expected.getMessage().contains("CRC")); }
        } finally { remove(root); }
    }

    @Test public void importRequiresTheCatalogCityCoverage() {
        assertTrue(CityPackStore.importBoundsCoverCity(29.79,59.785,30.67,60.086));
        assertFalse(CityPackStore.importBoundsCoverCity(37,55,38,56));
        assertFalse(CityPackStore.importBoundsCoverCity(30.1,59.9,30.5,60));
        assertFalse(CityPackStore.importBoundsCoverCity(Double.NaN,59,31,61));
    }

    @Test public void successfulPublicationReplacesDataAndMetadataAndLeavesNoBackup() throws Exception {
        File root = Files.createTempDirectory("sloi-import-publish-").toFile();
        try {
            write(root, "saint-petersburg.gpkg", "old-data"); write(root, "saint-petersburg.meta", "old-meta");
            File data = write(root, "data.ready", "new-data"), meta = write(root, "meta.ready", "new-meta");
            CityPackStore.installImportedPair(data, meta, root);
            assertEquals("new-data", read(new File(root,"saint-petersburg.gpkg")));
            assertEquals("new-meta", read(new File(root,"saint-petersburg.meta")));
            assertFalse(new File(root,"saint-petersburg.gpkg.import-old").exists());
            assertFalse(new File(root,"saint-petersburg.import-commit").exists());
        } finally { remove(root); }
    }

    @Test public void publicationFailureRestoresBothPreviousFiles() throws Exception {
        File root = Files.createTempDirectory("sloi-import-rollback-").toFile();
        try {
            File installed = write(root, "saint-petersburg.gpkg", "old-data"), installedMeta = write(root, "saint-petersburg.meta", "old-meta");
            File data = write(root, "data.ready", "new-data"), meta = write(root, "meta.ready", "new-meta");
            File cannotPublish = new File(meta.getPath()) { @Override public boolean renameTo(File destination) { return false; } };
            expectIo(() -> CityPackStore.installImportedPair(data, cannotPublish, root));
            assertEquals("old-data", read(installed)); assertEquals("old-meta", read(installedMeta));
            assertFalse(new File(root,"saint-petersburg.import-commit").exists());
        } finally { remove(root); }
    }

    @Test public void processRecoveryRollsBackAnIncompletePairButKeepsPublishedPair() throws Exception {
        File root = Files.createTempDirectory("sloi-import-recover-").toFile();
        try {
            File installed = write(root, "saint-petersburg.gpkg", "half-new-data"), meta = write(root, "saint-petersburg.meta", "half-new-meta");
            write(root,"saint-petersburg.gpkg.import-old","old-data"); write(root,"saint-petersburg.meta.import-old","old-meta");
            write(root,"saint-petersburg.import-commit","1\n1");
            CityPackStore.recoverImportedPair(root);
            assertEquals("old-data",read(installed)); assertEquals("old-meta",read(meta));
            write(root,"saint-petersburg.gpkg.import-old","stale-data");
            CityPackStore.recoverImportedPair(root); // No journal means the new pair was published.
            assertEquals("old-data",read(installed));
            assertFalse(new File(root,"saint-petersburg.gpkg.import-old").exists());
        } finally { remove(root); }
    }

    @Test public void firstInstallRecoveryRemovesUnpublishedFiles() throws Exception {
        File root = Files.createTempDirectory("sloi-import-first-").toFile();
        try {
            write(root,"saint-petersburg.gpkg","incomplete"); write(root,"saint-petersburg.meta","incomplete");
            write(root,"saint-petersburg.import-commit","0\n0");
            CityPackStore.recoverImportedPair(root);
            assertFalse(new File(root,"saint-petersburg.gpkg").exists());
            assertFalse(new File(root,"saint-petersburg.meta").exists());
        } finally { remove(root); }
    }

    @Test public void importedCatalogDescribesValidationWithoutClaimingServerChecksum() throws Exception {
        File root = Files.createTempDirectory("sloi-import-catalog-").toFile();
        try {
            CityPackStore store = new CityPackStore(root);
            File packs = new File(root,"city-packs"); write(packs,"saint-petersburg.gpkg","data");
            CityPackStore.writeMeta(new File(packs,"saint-petersburg.meta"), new CityPackStore.PackMeta(4,"2026-11-17","Imported ZIP CRC + GeoPackage"));
            String catalog = store.listPacksJson(false);
            assertTrue(catalog.contains("\"imported\":true"));
            assertTrue(catalog.contains("Локальный файл OpenStreetMap"));
            assertFalse(catalog.contains("MD5"));
        } finally { remove(root); }
    }

    interface IoAction { void run() throws Exception; }
    private static void expectIo(IoAction action) throws Exception { try { action.run(); fail("expected IOException"); } catch (IOException expected) { } }
    private static File write(File root,String name,String value) throws IOException { File file=new File(root,name);Files.write(file.toPath(),value.getBytes(StandardCharsets.UTF_8));return file; }
    private static String read(File file) throws IOException { return new String(Files.readAllBytes(file.toPath()),StandardCharsets.UTF_8); }
    private static File archive(File root,String[] names) throws IOException {
        File zip=new File(root,"fixture.zip");
        try(ZipOutputStream out=new ZipOutputStream(Files.newOutputStream(zip.toPath()))) {
            for(int i=0;i<names.length;i++){out.putNextEntry(new ZipEntry(names[i]));out.write(("payload-"+i).getBytes(StandardCharsets.UTF_8));out.closeEntry();}
        }
        return zip;
    }
    private static void remove(File file){if(file.isDirectory()){File[] children=file.listFiles();if(children!=null)for(File child:children)remove(child);}file.delete();}
}
