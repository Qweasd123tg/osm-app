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

/** Geometry helpers and serialized native/WebView boundary contracts. */
public final class OnDeviceSceneEngineTest {
    @Test public void serializedRegionContainsBothCoordinatesOfBothCorners() throws Exception {
        OnDeviceSceneEngine.Bbox box = new OnDeviceSceneEngine.Bbox(59.8, 30.2, 59.9, 30.4);
        org.json.JSONObject region = new org.json.JSONObject(box.mapRegion("test", "Район", 59.85, 30.3).toString());
        org.json.JSONArray bounds = region.getJSONArray("bounds");
        assertEquals(2, bounds.length());
        assertEquals(2, bounds.getJSONArray(0).length());
        assertEquals(2, bounds.getJSONArray(1).length());
        assertEquals(30.2, bounds.getJSONArray(0).getDouble(0), 0);
        assertEquals(59.8, bounds.getJSONArray(0).getDouble(1), 0);
        assertEquals(30.4, bounds.getJSONArray(1).getDouble(0), 0);
        assertEquals(59.9, bounds.getJSONArray(1).getDouble(1), 0);
    }

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

    private static OnDeviceSceneEngine.Bbox displayBounds() {
        return new OnDeviceSceneEngine.Bbox(59.925, 30.35, 59.937, 30.37);
    }

    @Test public void cacheAndSceneIdentityUseEveryViewportEdge() {
        OnDeviceSceneEngine.Bbox bounds = displayBounds();
        String raw = OnDeviceSceneEngine.cacheKey(bounds);
        String first = OnDeviceSceneEngine.sceneIdFor(bounds, "2026-07-29", 180, 900, "city-pack:spb", "v1");
        for (OnDeviceSceneEngine.Bbox changed : Arrays.asList(
                new OnDeviceSceneEngine.Bbox(59.92500001, 30.35, 59.937, 30.37),
                new OnDeviceSceneEngine.Bbox(59.925, 30.35000001, 59.937, 30.37),
                new OnDeviceSceneEngine.Bbox(59.925, 30.35, 59.93700001, 30.37),
                new OnDeviceSceneEngine.Bbox(59.925, 30.35, 59.937, 30.37000001))) {
            assertFalse(raw.equals(OnDeviceSceneEngine.cacheKey(changed)));
            assertFalse(first.equals(OnDeviceSceneEngine.sceneIdFor(changed, "2026-07-29", 180, 900, "city-pack:spb", "v1")));
        }
        String updatedPack = OnDeviceSceneEngine.sceneIdFor(bounds, "2026-07-29", 180, 900, "city-pack:spb", "v2");
        assertFalse(first.equals(updatedPack));
        OnDeviceSceneEngine.Bbox widerWithSameCenter = new OnDeviceSceneEngine.Bbox(59.925, 30.34, 59.937, 30.38);
        assertFalse(first.equals(OnDeviceSceneEngine.sceneIdFor(widerWithSameCenter, "2026-07-29", 180, 900, "city-pack:spb", "v1")));
    }

    @Test public void sceneIdentitySeparatesEffectiveSolarDateAndTimezone() {
        String first = OnDeviceSceneEngine.sceneIdFor(displayBounds(), "2026-07-29", 180, 900, "city-pack:spb", "v1");
        String nextDate = OnDeviceSceneEngine.sceneIdFor(displayBounds(), "2026-07-30", 180, 900, "city-pack:spb", "v1");
        String differentTimezone = OnDeviceSceneEngine.sceneIdFor(displayBounds(), "2026-07-29", 240, 900, "city-pack:spb", "v1");
        assertFalse(first.equals(nextDate));
        assertFalse(first.equals(differentTimezone));
    }

    @Test public void solarFramesUseTheRequestedLocalDateAndOffset() {
        OnDeviceSceneEngine.SceneRequest request = new OnDeviceSceneEngine.SceneRequest(
            "request", displayBounds(), "2026-12-31", -210, 30, "place");
        assertEquals("2026-12-31T00:30-03:30", request.at(30).toString());
    }

    @Test public void sceneRequestUsesFullViewportAndDerivesItsCenter() {
        OnDeviceSceneEngine.SceneRequest request = OnDeviceSceneEngine.SceneRequest.fromJson(
            "{\"requestId\":\"viewport\",\"displayBounds\":[[30.35,59.925],[30.37,59.937]],"
                + "\"localDate\":\"2026-07-29\",\"timezoneOffsetMinutes\":180,\"selectedMinutes\":900}");
        assertEquals(59.931, request.latitude, 1e-10);
        assertEquals(30.36, request.longitude, 1e-10);
        assertEquals(30.35, request.displayBounds.west, 0);
        assertEquals(59.937, request.displayBounds.north, 0);
        request.validate();
    }

    @Test public void sceneRequestRejectsOldRadiusAndMalformedCornerArrays() {
        for (String input : Arrays.asList(
                "{\"latitude\":59.9,\"longitude\":30.3,\"radiusM\":450}",
                "{\"displayBounds\":[[30.3,59.9],[30.4]]}",
                "{\"displayBounds\":[[30.3,59.9],[30.4,60.0],[30.5,60.1]]}")) {
            try {
                OnDeviceSceneEngine.SceneRequest.fromJson(input);
                throw new AssertionError("Legacy or malformed request was accepted");
            } catch (IllegalArgumentException expected) {
                assertTrue(expected.getMessage().contains("displayBounds"));
            }
        }
    }

    @Test public void sceneRequestRejectsInvalidOrOversizedViewportWithoutCropping() {
        for (OnDeviceSceneEngine.Bbox bounds : Arrays.asList(
                new OnDeviceSceneEngine.Bbox(Double.NaN, 30, 60, 31),
                new OnDeviceSceneEngine.Bbox(59, 30, Double.POSITIVE_INFINITY, 31),
                new OnDeviceSceneEngine.Bbox(59, Double.NEGATIVE_INFINITY, 60, 31),
                new OnDeviceSceneEngine.Bbox(59, 30, 60, Double.NaN),
                new OnDeviceSceneEngine.Bbox(-86, 30, -84, 31),
                new OnDeviceSceneEngine.Bbox(84, 30, 86, 31),
                new OnDeviceSceneEngine.Bbox(59, -181, 60, -179),
                new OnDeviceSceneEngine.Bbox(59, 179, 60, 181),
                new OnDeviceSceneEngine.Bbox(59, 179, 60, -179),
                new OnDeviceSceneEngine.Bbox(60, 30, 59, 31),
                new OnDeviceSceneEngine.Bbox(59, 30, 59, 31),
                new OnDeviceSceneEngine.Bbox(0, 0, .001, .06),
                new OnDeviceSceneEngine.Bbox(0, 0, .06, .001),
                new OnDeviceSceneEngine.Bbox(0, 0, .04, .04))) {
            try {
                new OnDeviceSceneEngine.SceneRequest("test", bounds, "2026-07-29", 180, 900, "").validate();
                throw new AssertionError("Invalid or oversized viewport was accepted");
            } catch (IllegalArgumentException expected) {
                assertTrue(expected.getMessage().contains("displayBounds") || expected.getMessage().contains("Приблизьте"));
            }
        }
        // More than the old test radius is allowed when the entire viewport fits the budget.
        new OnDeviceSceneEngine.SceneRequest("wide", new OnDeviceSceneEngine.Bbox(0, 0, .02, .04),
            "2026-07-29", 180, 900, "").validate();
    }

    @Test public void cachedSceneCoversFullViewportBeyondOldRadiusWithoutWindNetwork() throws Exception {
        File root = Files.createTempDirectory("sloi-viewport-scene").toFile();
        File cache = new File(root, "raw"), generated = new File(root, "generated");
        OnDeviceSceneEngine engine = new OnDeviceSceneEngine(cache, generated);
        OnDeviceSceneEngine.Bbox bounds = new OnDeviceSceneEngine.Bbox(59.9, 30.3, 59.92, 30.35);
        org.json.JSONArray elements = new org.json.JSONArray();
        // Both footprints lie over one kilometre from the centre. A legacy 450m
        // scene would omit them even though they are visible in this viewport.
        for (int building = 0; building < 2; building++) {
            double west = building == 0 ? 30.302 : 30.346;
            long first = building * 10 + 1;
            org.json.JSONArray nodeIds = new org.json.JSONArray();
            double[][] coordinates = {{west, 59.905}, {west + .001, 59.905},
                {west + .001, 59.906}, {west, 59.906}};
            for (int node = 0; node < coordinates.length; node++) {
                elements.put(new org.json.JSONObject().put("type", "node").put("id", first + node)
                    .put("lon", coordinates[node][0]).put("lat", coordinates[node][1]));
                nodeIds.put(first + node);
            }
            nodeIds.put(first);
            elements.put(new org.json.JSONObject().put("type", "way").put("id", building + 100)
                .put("nodes", nodeIds).put("tags", new org.json.JSONObject().put("building", "yes").put("height", "12")));
        }
        org.json.JSONObject raw = new org.json.JSONObject().put("cacheVersion", 1)
            .put("queryBounds", bounds.expand(OnDeviceSceneEngine.MAX_SHADOW_M).json()).put("elements", elements);
        Files.write(new File(cache, "osm-v1-" + OnDeviceSceneEngine.cacheKey(bounds) + ".json").toPath(),
            raw.toString().getBytes(StandardCharsets.UTF_8));
        OnDeviceSceneEngine.SceneBuildResult result = engine.buildScene(new OnDeviceSceneEngine.SceneRequest(
            "viewport", bounds, "2026-07-17", 180, 900, "Видимая область"), null);
        org.json.JSONObject bundle = new org.json.JSONObject(new String(
            Files.readAllBytes(new File(generated, result.file).toPath()), StandardCharsets.UTF_8));
        assertTrue(result.cacheHit);
        assertEquals(2, bundle.getJSONObject("buildings").getJSONArray("features").length());
        org.json.JSONArray actualBounds = bundle.getJSONObject("region").getJSONArray("bounds");
        assertEquals(bounds.west, actualBounds.getJSONArray(0).getDouble(0), 0);
        assertEquals(bounds.south, actualBounds.getJSONArray(0).getDouble(1), 0);
        assertEquals(bounds.east, actualBounds.getJSONArray(1).getDouble(0), 0);
        assertEquals(bounds.north, actualBounds.getJSONArray(1).getDouble(1), 0);
        assertFalse(bundle.getJSONObject("layers").has("wind"));
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

    @Test public void frameTextCacheEvictsByRetainedBytesAndAccessOrder() {
        String response = "x".repeat(100);
        long entryBytes = OnDeviceSceneEngine.FrameTextCache.entryBytes("a", response);
        OnDeviceSceneEngine.FrameTextCache cache = new OnDeviceSceneEngine.FrameTextCache(entryBytes * 2, 8);
        cache.put("a", response);
        cache.put("b", response);
        assertEquals(response, cache.get("a")); // a is now more recent than b.
        cache.put("c", response);
        assertEquals(null, cache.get("b"));
        assertEquals(response, cache.get("a"));
        assertEquals(response, cache.get("c"));
        assertEquals(2, cache.size());
        assertEquals(entryBytes * 2, cache.retainedBytes());
    }

    @Test public void oversizedFrameIsDiskOnlyWithoutEvictingOtherScenes() {
        OnDeviceSceneEngine.FrameTextCache cache = new OnDeviceSceneEngine.FrameTextCache(1024, 8);
        cache.put("scene-a:1", "old frame");
        cache.put("scene-b:1", "other scene");
        cache.put("scene-a:1", "x".repeat(1024));
        assertEquals(null, cache.get("scene-a:1"));
        assertEquals("other scene", cache.get("scene-b:1"));
        assertEquals(1, cache.size());
        assertEquals(OnDeviceSceneEngine.FrameTextCache.entryBytes("scene-b:1", "other scene"), cache.retainedBytes());
    }

    @Test public void frameCacheReplacementPreservesResponseAndClearsAccounting() {
        OnDeviceSceneEngine.FrameTextCache cache = new OnDeviceSceneEngine.FrameTextCache(1024, 1);
        String response = "{sceneId:scene-a,frameIndex:1,geometry:original}";
        cache.put("scene-a:1", response);
        assertTrue("cache must return the same response without reparsing or altering geometry", response == cache.get("scene-a:1"));
        cache.put("scene-a:1", "replacement");
        assertEquals(OnDeviceSceneEngine.FrameTextCache.entryBytes("scene-a:1", "replacement"), cache.retainedBytes());
        cache.put("scene-b:1", "other scene");
        assertEquals(null, cache.get("scene-a:1"));
        assertEquals("other scene", cache.get("scene-b:1"));
        cache.clear();
        assertEquals(0, cache.size());
        assertEquals(0, cache.retainedBytes());
    }

    @Test public void shadowSweepObservesCancellationRaisedInsideFootprintTraversal() {
        Polygon footprint = rectangle(0, 0, 10, 10);
        Polygon interrupting = new Polygon((org.locationtech.jts.geom.LinearRing) footprint.getExteriorRing(),
                null, OnDeviceSceneEngine.GF) {
            @Override public org.locationtech.jts.geom.LinearRing getExteriorRing() {
                Thread.currentThread().interrupt();
                return super.getExteriorRing();
            }
        };
        try {
            OnDeviceSceneEngine.sweep(interrupting, new Coordinate(0, 10), new Coordinate(0, 0));
            org.junit.Assert.fail("cancelled sweep must stop before returning obsolete geometry");
        } catch (OnDeviceSceneEngine.CancelledException expected) {
            assertTrue(Thread.currentThread().isInterrupted());
        } finally {
            Thread.interrupted();
        }
    }

    private static Polygon rectangle(double x0, double y0, double x1, double y1) {
        return OnDeviceSceneEngine.GF.createPolygon(new Coordinate[] {
            new Coordinate(x0,y0),new Coordinate(x1,y0),new Coordinate(x1,y1),
            new Coordinate(x0,y1),new Coordinate(x0,y0)
        });
    }
}
