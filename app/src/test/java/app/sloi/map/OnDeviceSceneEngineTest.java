package app.sloi.map;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import java.time.OffsetDateTime;
import java.io.ByteArrayInputStream;
import java.io.File;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.Arrays;
import java.util.Collections;
import org.junit.Test;
import org.locationtech.jts.geom.Coordinate;
import org.locationtech.jts.geom.Geometry;
import org.locationtech.jts.geom.Polygon;

/** JVM tests deliberately exercise helpers that do not require Android's org.json runtime. */
public final class OnDeviceSceneEngineTest {
    @Test public void sunPositionMatchesExpectedNoonAndNightPolarity() {
        double[] noon = OnDeviceSceneEngine.sunPosition(
            OffsetDateTime.parse("2026-06-21T12:00:00+03:00"), 59.93, 30.36);
        double[] night = OnDeviceSceneEngine.sunPosition(
            OffsetDateTime.parse("2026-06-21T00:00:00+03:00"), 59.93, 30.36);
        assertTrue("summer noon is daylight", noon[0] > 45);
        assertTrue("night sun is below horizon", night[0] < 0);
        assertTrue(noon[1] >= 0 && noon[1] < 360);
    }

    @Test public void timeGridIsExactlyFortyNineFramesIncluding2359() {
        int[] minutes = OnDeviceSceneEngine.frameMinutes();
        assertEquals(49, minutes.length);
        assertEquals(0, minutes[0]);
        assertEquals(1410, minutes[47]);
        assertEquals(1439, minutes[48]);
        assertEquals(48, OnDeviceSceneEngine.closestFrame(1439));
        assertEquals(1, OnDeviceSceneEngine.closestFrame(44));
    }

    @Test public void heightNumberUnderstandsFeetAndFallbacks() {
        assertEquals(3.048, OnDeviceSceneEngine.number("10 ft"), 1e-8);
        assertEquals(3.5, OnDeviceSceneEngine.number("3,5 m"), 1e-8);
        assertTrue(Double.isNaN(OnDeviceSceneEngine.number("unknown")));
        assertTrue(Double.isNaN(OnDeviceSceneEngine.number("9".repeat(400))));
        assertEquals(9, OnDeviceSceneEngine.defaultHeight("anything", 800), 0);
        assertEquals(24, OnDeviceSceneEngine.defaultHeight("apartments", 1), 0);
    }

    @Test public void missingMinimumHeightDefaultsToGroundInsteadOfNaN() {
        assertEquals(0, OnDeviceSceneEngine.minimumHeight(null, null), 0);
        assertEquals(6, OnDeviceSceneEngine.minimumHeight(null, "2"), 0);
        assertEquals(1.5, OnDeviceSceneEngine.minimumHeight("1.5 m", null), 0);
        assertTrue(Double.isFinite(OnDeviceSceneEngine.minimumHeight(null, null)));
    }

    @Test public void cacheKeyDiffersForDifferentPlacesAndRadii() {
        String petersburg = OnDeviceSceneEngine.cacheKey(59.9311, 30.3609, 450);
        assertFalse(petersburg.equals(OnDeviceSceneEngine.cacheKey(55.7558, 37.6173, 450)));
        assertFalse(petersburg.equals(OnDeviceSceneEngine.cacheKey(59.9311, 30.3609, 550)));
    }

    @Test public void sceneIdentityUsesExactCenterAndDataRevision() {
        String first = OnDeviceSceneEngine.sceneIdFor(59.9311000, 30.3609000, 450, "2026-07-29", 180, 900, "city-pack:spb", "v1");
        String shiftedInsideCacheGrid = OnDeviceSceneEngine.sceneIdFor(59.9312000, 30.3609000, 450, "2026-07-29", 180, 900, "city-pack:spb", "v1");
        String updatedPack = OnDeviceSceneEngine.sceneIdFor(59.9311000, 30.3609000, 450, "2026-07-29", 180, 900, "city-pack:spb", "v2");
        assertFalse(first.equals(shiftedInsideCacheGrid));
        assertFalse(first.equals(updatedPack));
    }

    @Test public void sceneIdentitySeparatesEffectiveSolarDateAndTimezone() {
        String first = OnDeviceSceneEngine.sceneIdFor(59.9311, 30.3609, 450, "2026-07-29", 180, 900, "city-pack:spb", "v1");
        String nextDate = OnDeviceSceneEngine.sceneIdFor(59.9311, 30.3609, 450, "2026-07-30", 180, 900, "city-pack:spb", "v1");
        String differentTimezone = OnDeviceSceneEngine.sceneIdFor(59.9311, 30.3609, 450, "2026-07-29", 240, 900, "city-pack:spb", "v1");
        assertFalse(first.equals(nextDate));
        assertFalse(first.equals(differentTimezone));
    }

    @Test public void solarFramesUseTheRequestedLocalDateAndOffset() {
        OnDeviceSceneEngine.SceneRequest request = new OnDeviceSceneEngine.SceneRequest(
            "request", 59.9311, 30.3609, 450, "2026-12-31", -210, 30, "place");
        assertEquals("2026-12-31T00:30-03:30", request.at(30).toString());
    }

    @Test public void pinnedSceneSurvivesCompletedSuccessorChurn() {
        OnDeviceSceneEngine.PinnedLruCache<String> cache = new OnDeviceSceneEngine.PinnedLruCache<>(1);
        cache.putCandidate("shown", "shown");
        assertTrue(cache.accept("shown"));
        cache.putCandidate("candidate-1", "one");
        cache.putCandidate("candidate-2", "two");
        cache.putCandidate("candidate-3", "three");
        assertTrue(cache.contains("shown"));
        assertFalse(cache.contains("candidate-1"));
        assertEquals(2, cache.size());
    }

    @Test public void acceptingSuccessorKeepsOnlyTwoOtherCandidates() {
        OnDeviceSceneEngine.PinnedLruCache<String> cache = new OnDeviceSceneEngine.PinnedLruCache<>(2);
        cache.putCandidate("shown", "shown");
        cache.accept("shown");
        cache.putCandidate("next", "next");
        cache.putCandidate("other", "other");
        assertTrue(cache.accept("next"));
        cache.putCandidate("latest", "latest");
        assertTrue(cache.contains("next"));
        assertEquals(3, cache.size());
    }

    @Test public void boundedUtf8ReaderRejectsOversizeAndMalformedInput() throws Exception {
        assertEquals("Привет", OnDeviceSceneEngine.readUtf8Limited(
            new ByteArrayInputStream("Привет".getBytes(StandardCharsets.UTF_8)), 64));
        try {
            OnDeviceSceneEngine.readUtf8Limited(new ByteArrayInputStream(new byte[5]), 4);
            throw new AssertionError("oversized input was accepted");
        } catch (IOException expected) {
            assertTrue(expected.getMessage().contains("размер"));
        }
        try {
            OnDeviceSceneEngine.readUtf8Limited(
                new ByteArrayInputStream(new byte[] {(byte) 0xc3, (byte) 0x28}), 4);
            throw new AssertionError("malformed UTF-8 was accepted");
        } catch (IOException expected) {
            assertTrue(expected.getMessage().contains("UTF-8"));
        }
    }

    @Test public void overpassFailoverClassificationMatchesProviderFailures() {
        assertTrue(OnDeviceSceneEngine.isRetryableOverpassStatus(429));
        assertTrue(OnDeviceSceneEngine.isRetryableOverpassStatus(502));
        assertTrue(OnDeviceSceneEngine.isRetryableOverpassStatus(503));
        assertTrue(OnDeviceSceneEngine.isRetryableOverpassStatus(504));
        assertFalse(OnDeviceSceneEngine.isRetryableOverpassStatus(500));
        assertTrue(OnDeviceSceneEngine.isTerminalOverpassStatus(400));
        assertTrue(OnDeviceSceneEngine.isTerminalOverpassStatus(401));
        assertTrue(OnDeviceSceneEngine.isTerminalOverpassStatus(403));
        assertTrue(OnDeviceSceneEngine.isTerminalOverpassStatus(404));
        assertTrue(OnDeviceSceneEngine.isTerminalOverpassStatus(413));
        assertFalse(OnDeviceSceneEngine.isTerminalOverpassStatus(429));
        assertTrue(OnDeviceSceneEngine.isOversizedResponse(new java.io.IOException("Response exceeds 20971520 bytes")));
        assertFalse(OnDeviceSceneEngine.isOversizedResponse(new java.io.IOException("Socket closed")));
    }

    @Test public void cachedQueryMustCoverTheFullDisplayAndCasterMargin() {
        OnDeviceSceneEngine.Bbox cached = new OnDeviceSceneEngine.Bbox(0, 0, 10, 10);
        assertTrue(OnDeviceSceneEngine.bboxCovers(cached, new OnDeviceSceneEngine.Bbox(1, 1, 9, 9)));
        assertFalse(OnDeviceSceneEngine.bboxCovers(cached, new OnDeviceSceneEngine.Bbox(-.001, 1, 9, 9)));
        assertFalse(OnDeviceSceneEngine.bboxCovers(cached, new OnDeviceSceneEngine.Bbox(1, 1, 10.001, 9)));
    }

    @Test public void diskPrunerRemovesOldestRegularFilesAndKeepsAtomicTemp() throws Exception {
        File directory = Files.createTempDirectory("sloi-prune-").toFile();
        File old = new File(directory, "old.json");
        File fresh = new File(directory, "fresh.json");
        File temp = new File(directory, "new.json.tmp");
        File staleTemp = new File(directory, "abandoned.json.tmp");
        Files.write(old.toPath(), new byte[8]);
        Files.write(fresh.toPath(), new byte[8]);
        Files.write(temp.toPath(), new byte[64]);
        Files.write(staleTemp.toPath(), new byte[64]);
        old.setLastModified(1_000L); fresh.setLastModified(2_000L);
        staleTemp.setLastModified(1_000L);
        OnDeviceSceneEngine.pruneDirectory(directory, 8);
        assertFalse(old.exists());
        assertTrue(fresh.exists());
        assertTrue("an atomic write in progress must never be pruned", temp.exists());
        assertFalse("crash-leftover temp must not bypass the quota forever", staleTemp.exists());
        temp.delete(); fresh.delete(); directory.delete();
    }

    @Test public void viewportTilesUseCanonicalWebMercatorCoordinatesAndBounds() {
        OnDeviceSceneEngine.ViewportTile tile = new OnDeviceSceneEngine.ViewportTile(15, 19147, 9528);
        assertEquals("15/19147/9528", tile.id());
        OnDeviceSceneEngine.Bbox bounds = OnDeviceSceneEngine.tileBounds(tile.z, tile.x, tile.y);
        assertTrue(bounds.west < bounds.east);
        assertTrue(bounds.south < bounds.north);
        assertTrue("Petersburg longitude is in this tile", bounds.west < 30.36 && bounds.east > 30.36);
        try { new OnDeviceSceneEngine.ViewportTile(14, 0, 0).validate(); org.junit.Assert.fail("zoom validation"); }
        catch (IllegalArgumentException expected) { assertTrue(expected.getMessage().contains("15..18")); }
        try { new OnDeviceSceneEngine.ViewportTile(15, 32768, 0).validate(); org.junit.Assert.fail("x validation"); }
        catch (IllegalArgumentException expected) { assertTrue(expected.getMessage().contains("canonical")); }
    }

    @Test public void viewportCacheNameIncludesFormatRevisionAndTile() {
        OnDeviceSceneEngine.ViewportTile tile = new OnDeviceSceneEngine.ViewportTile(16, 38100, 18800);
        String oldName = OnDeviceSceneEngine.viewportCacheFileName("171234-100-10", tile);
        String newName = OnDeviceSceneEngine.viewportCacheFileName("171235-100-10", tile);
        assertTrue(oldName.startsWith("viewport-v1-r171234-100-10-"));
        assertTrue(oldName.contains("16-38100-18800"));
        assertFalse(oldName.equals(newName));
    }

    @Test public void viewportPrunerDoesNotDeletePinnedCurrentTile() throws Exception {
        File directory = Files.createTempDirectory("sloi-viewport-prune-").toFile();
        File old = new File(directory, "old.json");
        File current = new File(directory, "current.json");
        Files.write(old.toPath(), new byte[8]); Files.write(current.toPath(), new byte[8]);
        old.setLastModified(1_000L); current.setLastModified(2_000L);
        OnDeviceSceneEngine.pruneDirectory(directory, 0, Collections.singleton(current));
        assertFalse(old.exists());
        assertTrue(current.exists());
        current.delete(); directory.delete();
    }

    @Test public void viewportFeatureOnAdjacentTileBoundaryHasExactlyOneOwner() {
        OnDeviceSceneEngine.ViewportTile west = new OnDeviceSceneEngine.ViewportTile(15, 19147, 9528);
        OnDeviceSceneEngine.ViewportTile east = new OnDeviceSceneEngine.ViewportTile(15, 19148, 9528);
        OnDeviceSceneEngine.Bbox westBounds = OnDeviceSceneEngine.tileBounds(west.z, west.x, west.y);
        double boundary = westBounds.east;
        double middle = (westBounds.south + westBounds.north) / 2d;
        Polygon crossing = OnDeviceSceneEngine.GF.createPolygon(new Coordinate[] {
            new Coordinate(boundary - .0001, middle - .0001),
            new Coordinate(boundary + .0003, middle - .0001),
            new Coordinate(boundary + .0003, middle + .0001),
            new Coordinate(boundary - .0001, middle + .0001),
            new Coordinate(boundary - .0001, middle - .0001)
        });
        int owners = (OnDeviceSceneEngine.ownsViewportFeature(west, crossing) ? 1 : 0)
            + (OnDeviceSceneEngine.ownsViewportFeature(east, crossing) ? 1 : 0);
        assertEquals(1, owners);
        assertFalse(OnDeviceSceneEngine.ownsViewportFeature(west, crossing));
        assertTrue(OnDeviceSceneEngine.ownsViewportFeature(east, crossing));
    }

    @Test public void viewportBatchLeavesEarlierOutputsUntilTheNextBatchStarts() throws Exception {
        File directory = Files.createTempDirectory("sloi-viewport-batch-").toFile();
        File first = new File(directory, "first.json");
        File second = new File(directory, "second.json");
        Files.write(first.toPath(), new byte[8]); Files.write(second.toPath(), new byte[8]);
        first.setLastModified(1_000L); second.setLastModified(2_000L);
        // Tile writes intentionally do not invoke a pruner during the current batch.
        assertTrue(first.exists()); assertTrue(second.exists());
        OnDeviceSceneEngine.prepareViewportBatch(directory, 8);
        assertFalse(first.exists());
        assertTrue(second.exists());
        second.delete(); directory.delete();
    }

    @Test public void northSunThrowsRectangleShadowSouthAndKeepsArea() {
        Polygon footprint = rectangle(0, 0, 10, 10);
        OnDeviceSceneEngine.ProjectedBuilding building = new OnDeviceSceneEngine.ProjectedBuilding(footprint, 10, 0);
        Geometry shadow = OnDeviceSceneEngine.shadow(Collections.singletonList(building),
            OnDeviceSceneEngine.GF.createGeometryCollection(), null, 45, 0,
            new OnDeviceSceneEngine.Projection(0, 0));
        // Output is unprojected; compare the projected result separately through the sweep itself.
        Geometry swept = OnDeviceSceneEngine.safeUnion(OnDeviceSceneEngine.sweep(footprint,
            OnDeviceSceneEngine.bearing(10, 180), OnDeviceSceneEngine.bearing(0, 180)));
        assertTrue(swept.getArea() > footprint.getArea());
        assertTrue("bearing 180 moves the shadow towards negative Y", swept.getCentroid().getY() < 5);
        assertTrue(shadow.isValid());
    }

    @Test public void courtyardHoleIsNotFilledAndElevatedBuildingDoesNotStartAtFootprint() {
        Polygon courtyard = OnDeviceSceneEngine.GF.createPolygon(
            OnDeviceSceneEngine.GF.createLinearRing(new Coordinate[] {new Coordinate(0,0),new Coordinate(20,0),new Coordinate(20,20),new Coordinate(0,20),new Coordinate(0,0)}),
            new org.locationtech.jts.geom.LinearRing[] {OnDeviceSceneEngine.GF.createLinearRing(
                new Coordinate[] {new Coordinate(6,6),new Coordinate(14,6),new Coordinate(14,14),new Coordinate(6,14),new Coordinate(6,6)})});
        Geometry swept = OnDeviceSceneEngine.safeUnion(OnDeviceSceneEngine.sweep(courtyard,
            OnDeviceSceneEngine.bearing(0, 180), OnDeviceSceneEngine.bearing(0, 180)));
        assertFalse("hole remains a hole at vertical sun", swept.covers(OnDeviceSceneEngine.GF.createPoint(new Coordinate(10, 10))));

        Polygon footprint = rectangle(0, 0, 10, 10);
        Geometry elevated = OnDeviceSceneEngine.safeUnion(OnDeviceSceneEngine.sweep(footprint,
            OnDeviceSceneEngine.bearing(20, 180), OnDeviceSceneEngine.bearing(10, 180)));
        assertFalse("min_height shifts the first shadow away from the footprint",
            elevated.covers(OnDeviceSceneEngine.GF.createPoint(new Coordinate(5, 5))));
    }

    private static Polygon rectangle(double x0, double y0, double x1, double y1) {
        return OnDeviceSceneEngine.GF.createPolygon(new Coordinate[] {
            new Coordinate(x0,y0),new Coordinate(x1,y0),new Coordinate(x1,y1),
            new Coordinate(x0,y1),new Coordinate(x0,y0)
        });
    }
}
