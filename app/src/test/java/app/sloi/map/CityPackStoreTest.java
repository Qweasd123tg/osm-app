package app.sloi.map;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import java.io.File;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.Collections;
import java.util.Map;

import org.junit.Test;
import org.locationtech.jts.geom.Envelope;
import org.locationtech.jts.geom.Geometry;
import org.locationtech.jts.io.WKBWriter;

/** Pure helper coverage: Android SQLite and HTTPS are intentionally not needed by these tests. */
public final class CityPackStoreTest {
    @Test public void geoPackageXyEnvelopeAndWkbOffsetRespectLittleEndianHeader() throws Exception {
        byte[] wkb = new WKBWriter().write(OnDeviceSceneEngine.GF.createPoint(new org.locationtech.jts.geom.Coordinate(30.36, 59.93)));
        byte[] blob = new byte[40 + wkb.length];
        blob[0] = 'G'; blob[1] = 'P'; blob[2] = 0; blob[3] = 3; // little endian, XY envelope
        ByteBuffer b = ByteBuffer.wrap(blob).order(ByteOrder.LITTLE_ENDIAN);
        b.putInt(4, 4326); b.putDouble(8, 30.0); b.putDouble(16, 31.0); b.putDouble(24, 59.0); b.putDouble(32, 60.0);
        System.arraycopy(wkb, 0, blob, 40, wkb.length);
        Envelope envelope = CityPackStore.geoPackageEnvelope(blob);
        assertEquals(30.0, envelope.getMinX(), 0); assertEquals(31.0, envelope.getMaxX(), 0);
        assertEquals(59.0, envelope.getMinY(), 0); assertEquals(60.0, envelope.getMaxY(), 0);
        assertEquals(40, CityPackStore.geoPackageWkbOffset(blob));
        Geometry geometry = CityPackStore.readGeoPackageGeometry(blob, new org.locationtech.jts.io.WKBReader());
        assertEquals("Point", geometry.getGeometryType());
        assertEquals(30.36, geometry.getCoordinate().x, 1e-9);
    }

    @Test public void envelopeIsAbsentForStandardHeaderAndMalformedHeadersAreRejected() {
        byte[] noEnvelope = new byte[12]; noEnvelope[0] = 'G'; noEnvelope[1] = 'P'; noEnvelope[2] = 0; noEnvelope[3] = 1;
        assertNull(CityPackStore.geoPackageEnvelope(noEnvelope));
        assertNull(CityPackStore.geoPackageEnvelope(new byte[] {'N', 'O'}));
        assertNull(CityPackStore.geoPackageEnvelope(new byte[] {'G', 'P', 0, 9, 0, 0, 0, 0}));
    }

    @Test public void hstoreParsesBuildingHeightsAndEscapedValues() {
        Map<String, String> tags = CityPackStore.parseHstore(
            "\"building\"=>\"apartments\", \"height\"=>\"12.5\", \"building:levels\"=>\"4\", \"min_height\"=>\"1" + '\\' + "\"2\", \"building:part\"=>\"yes\"");
        assertEquals("apartments", tags.get("building"));
        assertEquals("12.5", tags.get("height"));
        assertEquals("4", tags.get("building:levels"));
        assertEquals("1\"2", tags.get("min_height"));
        assertEquals("yes", tags.get("building:part"));
    }

    @Test public void boundsHelpersRejectInvalidAndRequireFullCoverage() {
        CityPackStore.Bbox city = CityPackStore.PETERSBURG_BOUNDS;
        assertTrue(city.covers(new CityPackStore.Bbox(59.90, 30.20, 60.00, 30.50)));
        assertFalse(city.covers(new CityPackStore.Bbox(59.70, 30.20, 60.00, 30.50)));
        try { new CityPackStore.Bbox(2, 1, 1, 2); org.junit.Assert.fail("invalid bbox"); }
        catch (IllegalArgumentException expected) { assertTrue(expected.getMessage().contains("Invalid")); }
    }

    @Test public void viewportBoundsMayPartlyOverlapTheInstalledPack() {
        CityPackStore.Bbox city = CityPackStore.PETERSBURG_BOUNDS;
        assertTrue(city.intersects(new CityPackStore.Bbox(59.70, 30.20, 59.90, 30.50)));
        assertFalse(city.intersects(new CityPackStore.Bbox(59.70, 29.50, 59.79, 30.00)));
    }

    @Test public void packRevisionIsPartOfSelectionAndChangesWithAnUpdatedPack() {
        CityPackStore.PackSelection oldPack = new CityPackStore.PackSelection(
            "saint-petersburg", "Санкт-Петербург", CityPackStore.PETERSBURG_BOUNDS, "old-date-100-1", Collections.emptyList());
        CityPackStore.PackSelection updatedPack = new CityPackStore.PackSelection(
            "saint-petersburg", "Санкт-Петербург", CityPackStore.PETERSBURG_BOUNDS, "new-date-200-2", Collections.emptyList());
        assertFalse(oldPack.revision.equals(updatedPack.revision));
        assertEquals("new-date-200-2", updatedPack.revision);
    }

    @Test public void stagingCleanupKeepsReadyGeoPackageButRemovesInterruptedJournalFiles() {
        assertFalse(CityPackStore.isStagingJunkName("saint-petersburg.gpkg.ready"));
        assertTrue(CityPackStore.isStagingJunkName("saint-petersburg.zip.part"));
        assertTrue(CityPackStore.isStagingJunkName("saint-petersburg.gpkg.tmp-wal"));
        assertTrue(CityPackStore.isStagingJunkName("saint-petersburg.gpkg.tmp-shm"));
    }

    @Test public void metadataWriterUsesRealNewlinesAndReaderAcceptsTheNewFormat() throws Exception {
        File directory = Files.createTempDirectory("sloi-meta-").toFile();
        File metadata = new File(directory, "saint-petersburg.meta");
        try {
            CityPackStore.writeMeta(metadata, new CityPackStore.PackMeta(
                261398528L, "1785360802740", "MD5 + ZIP CRC + GeoPackage EPSG/schema"));

            String stored = new String(Files.readAllBytes(metadata.toPath()), StandardCharsets.UTF_8);
            assertEquals("261398528\n1785360802740\nMD5 + ZIP CRC + GeoPackage EPSG/schema", stored);
            assertFalse(stored.contains("\\n"));

            CityPackStore.PackMeta parsed = CityPackStore.readMeta(metadata);
            assertEquals(261398528L, parsed.installedBytes);
            assertEquals("1785360802740", parsed.date);
            assertEquals("MD5 + ZIP CRC + GeoPackage EPSG/schema", parsed.validation);
        } finally {
            metadata.delete();
            directory.delete();
        }
    }

    @Test public void metadataReaderAcceptsOnlyTheExactLegacyLiteralBackslashNFormat() throws Exception {
        File directory = Files.createTempDirectory("sloi-legacy-meta-").toFile();
        File metadata = new File(directory, "saint-petersburg.meta");
        try {
            Files.write(metadata.toPath(),
                "261398528\\n1785360802740\\nMD5 + ZIP CRC + GeoPackage EPSG/schema".getBytes(StandardCharsets.UTF_8));

            CityPackStore.PackMeta parsed = CityPackStore.readMeta(metadata);
            assertEquals(261398528L, parsed.installedBytes);
            assertEquals("1785360802740", parsed.date);
            assertEquals("MD5 + ZIP CRC + GeoPackage EPSG/schema", parsed.validation);

            Files.write(metadata.toPath(), "261398528\\n1785360802740".getBytes(StandardCharsets.UTF_8));
            assertNull(CityPackStore.readMeta(metadata));
        } finally {
            metadata.delete();
            directory.delete();
        }
    }

    @Test public void packCatalogExposesInstalledRevisionAndNullWhenAbsent() throws Exception {
        File root = Files.createTempDirectory("sloi-catalog-").toFile();
        try {
            CityPackStore store = new CityPackStore(root);
            assertTrue(store.listPacksJson(false).contains("\"revision\":null"));
            File packs = new File(root, "city-packs");
            File pack = new File(packs, "saint-petersburg.gpkg");
            Files.write(pack.toPath(), new byte[] {1, 2, 3});
            pack.setLastModified(1_234L);
            CityPackStore.writeMeta(new File(packs, "saint-petersburg.meta"),
                new CityPackStore.PackMeta(3, "pack-date", "test"));
            assertTrue(store.listPacksJson(false).contains(
                "\"revision\":\"pack-date-3-" + pack.lastModified() + "\""));
        } finally {
            File packs = new File(root, "city-packs");
            new File(packs, "saint-petersburg.gpkg").delete();
            new File(packs, "saint-petersburg.meta").delete();
            new File(packs, "staging").delete();
            packs.delete(); root.delete();
        }
    }
}
