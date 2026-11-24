package app.sloi.map;

import static org.junit.Assert.*;

import org.json.JSONObject;
import org.junit.Test;
import org.locationtech.jts.geom.Coordinate;
import org.locationtech.jts.geom.Geometry;
import org.locationtech.jts.io.WKBReader;
import org.locationtech.jts.io.WKBWriter;

import java.io.File;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.Arrays;
import java.util.Collections;

/** SQLite execution is exercised separately in the installed Android APK. */
public final class OfflinePlaceStoreTest {
    @Test public void nearestLabelPrefersNearbyHouseButNeverAHouseFartherThan150Metres() {
        double lat=59.93,lon=30.36;
        OfflinePlaceStore.NearestHit house=OfflinePlaceStore.nearestHit("Невский 12","Невский проспект 12",0,lat,lon,lat+100/111320d,lon);
        OfflinePlaceStore.NearestHit place=OfflinePlaceStore.nearestHit("Парк","Парк",2,lat,lon,lat+20/111320d,lon);
        assertNotNull(house);assertNotNull(place);assertTrue(house.compareTo(place)<0);
        assertEquals(100,house.distance,1);
        assertNull(OfflinePlaceStore.nearestHit("Дальний дом","Дальний дом",0,lat,lon,lat+160/111320d,lon));
        assertNull(OfflinePlaceStore.nearestHit("Дальний парк","Дальний парк",2,lat,lon,lat+260/111320d,lon));
        assertNull(OfflinePlaceStore.nearestHit("","Пустое имя",1,lat,lon,lat,lon));
        assertNull(OfflinePlaceStore.nearestHit("Некорректная точка","Точка",1,lat,lon,Double.NaN,lon));
    }

    @Test public void nearestLabelUsesRealDistanceAtPetersburgLatitudeAndReturnsNoCoordinates() throws Exception {
        double lat=60,lon=30;
        OfflinePlaceStore.NearestHit street=OfflinePlaceStore.nearestHit("Улица","Улица",1,lat,lon,lat,lon+200/(111320d*.5));
        OfflinePlaceStore.NearestHit place=OfflinePlaceStore.nearestHit("Парк","Парк",2,lat,lon,lat+80/111320d,lon);
        assertNotNull(street);assertEquals(200,street.distance,1);assertTrue(place.compareTo(street)<0);
        File root=Files.createTempDirectory("offline-nearest-empty").toFile();
        try { assertNull(new OfflinePlaceStore(root).nearest(lat,lon)); }
        finally { remove(root); }
        for(double[] invalid:new double[][]{{Double.NaN,30},{60,Double.POSITIVE_INFINITY},{86,30},{60,181}}) {
            try { OfflinePlaceStore.validatePoint(invalid[0],invalid[1]);fail("invalid map coordinate"); }
            catch(IllegalArgumentException expected) {}
        }
    }

    @Test public void queryNormalizationHandlesCyrillicHouseNumbersAndCannotInjectMatchOperators() {
        assertEquals("елочная улица 12а", OfflinePlaceStore.normalize("  ЁЛОЧНАЯ, улица № 12А "));
        assertEquals(Arrays.asList("невский", "12а"), OfflinePlaceStore.tokens("Невский Невский, 12А"));
        assertEquals(Arrays.asList("невский", "12а"), OfflinePlaceStore.tokens("Невский12А"));
        assertEquals("12а", OfflinePlaceStore.houseQuery(OfflinePlaceStore.tokens("Невский 12А")));
        assertEquals("", OfflinePlaceStore.houseQuery(OfflinePlaceStore.tokens("Невский проспект")));
        assertEquals("невский* or* 12*", OfflinePlaceStore.ftsQuery(OfflinePlaceStore.tokens("Невский*\" OR '12' --")));
        assertTrue(OfflinePlaceStore.tokens(" *** -- ").isEmpty());
        assertEquals(12, OfflinePlaceStore.tokens("а б в г д е ж з и к л м н о п р с").size());
    }

    @Test public void ftsUsesImplicitConjunctionForAndroidLegacyAndEnhancedParsers() {
        assertEquals("невский* 12*",OfflinePlaceStore.ftsQuery(OfflinePlaceStore.tokens("Невский 12")));
        assertEquals("1* я* советская* 12к1*",OfflinePlaceStore.ftsQuery(OfflinePlaceStore.tokens("1-я Советская 12 к1")));
        // Search operators supplied by the user remain lowercase prefix words;
        // no optional FTS3 enhanced-parser syntax is introduced by the builder.
        assertEquals("and* or* not* near* 12*",OfflinePlaceStore.ftsQuery(OfflinePlaceStore.tokens("AND OR NOT NEAR 12")));
    }

    @Test public void corpusHouseSpellingMatchesTheIndexedFullNumber() throws Exception {
        OfflinePlaceStore.Source source = source(new File("unused"), "r1");
        byte[] point = gpkg(OnDeviceSceneEngine.GF.createPoint(new Coordinate(30.36,59.93)),false);
        OfflinePlaceStore.Entry entry = OfflinePlaceStore.entry(source,"",
            "\"addr:street\"=>\"проспект Сизова\",\"addr:housenumber\"=>\"12 к1\"","",point,new WKBReader());
        assertEquals("12к1",entry.house);
        for (String spelling : Arrays.asList("12к1","12 к1","12корпус1","12 корпус1","12 корпус 1","12 корп. 1")) {
            assertEquals("12к1",OfflinePlaceStore.normalize(spelling));
            assertEquals("12к1",OfflinePlaceStore.houseQuery("Сизова" + spelling));
            assertEquals("сизова* 12к1*",OfflinePlaceStore.ftsQuery(OfflinePlaceStore.tokens("Сизова" + spelling)));
            for (String token : OfflinePlaceStore.tokens("Сизова" + spelling)) assertTrue(entry.search.contains(token));
        }
        assertNotEquals(entry.house,OfflinePlaceStore.houseQuery("Сизова 12к2"));
    }

    @Test public void houseRankUsesFullFractionAndSkipsTheStreetOrdinal() {
        assertEquals("12",OfflinePlaceStore.houseQuery("1-я Советская 12"));
        assertEquals("12",OfflinePlaceStore.houseQuery(OfflinePlaceStore.tokens("1-я Советская 12")));
        assertEquals("1",OfflinePlaceStore.houseQuery("1-я Советская 1"));
        assertEquals("",OfflinePlaceStore.houseQuery("1-я Советская"));
        assertEquals("12к1",OfflinePlaceStore.houseQuery("1-я Советская 12 корпус 1"));
        assertEquals("12/1",OfflinePlaceStore.houseQuery("1-я Советская 12 / 1"));
        assertEquals("12/1",OfflinePlaceStore.normalize("12 / 1"));
        assertEquals("советская* \"12 1*\"",OfflinePlaceStore.ftsQuery(OfflinePlaceStore.tokens("Советская 12/1")));
        assertNotEquals(OfflinePlaceStore.houseQuery("Советская 12/1"),OfflinePlaceStore.houseQuery("Советская 12/2"));
    }

    @Test public void schemaChangeInvalidatesOldHouseTokensForRebuild() throws Exception {
        OfflinePlaceStore.Source source = source(new File("unused"), "r1");
        JSONObject old = record(source).json();
        assertEquals(3,old.getInt("schema"));
        old.put("schema",2);
        try { OfflinePlaceStore.Record.parse(old);fail("old house token schema must rebuild"); }
        catch(java.io.IOException expected) {}
    }

    @Test public void roadCanUseHstoreWithoutAnOptionalHighwayColumn() throws Exception {
        Geometry line = OnDeviceSceneEngine.GF.createLineString(new Coordinate[]{new Coordinate(30.3,59.91),new Coordinate(30.4,59.94)});
        OfflinePlaceStore.Source source = source(new File("unused"), "r1");
        OfflinePlaceStore.Entry road = OfflinePlaceStore.entry(source,"Садовая улица","\"highway\"=>\"residential\"","",gpkg(line,true),new WKBReader());
        assertNotNull(road);assertEquals(1,road.kind);
        OfflinePlaceStore.Entry stop = OfflinePlaceStore.entry(source,"Остановка","\"highway\"=>\"bus_stop\"","",
            gpkg(OnDeviceSceneEngine.GF.createPoint(new Coordinate(30.36,59.93)),false),new WKBReader());
        assertEquals(2,stop.kind);
    }

    @Test public void addressPointWithoutEnvelopeUsesItsRealWkbAndHstoreAddress() throws Exception {
        OfflinePlaceStore.Source source = source(new File("not-opened.gpkg"), "r1");
        byte[] blob = gpkg(OnDeviceSceneEngine.GF.createPoint(new Coordinate(30.36, 59.93)), false);
        byte[] original = blob.clone();
        OfflinePlaceStore.Entry entry = OfflinePlaceStore.entry(source, "Кофейня", 
            "\"addr:street\"=>\"Невский проспект\",\"addr:housenumber\"=>\"12А\",\"addr:city\"=>\"Санкт-Петербург\"", "", blob, new WKBReader());
        assertNotNull(entry); assertEquals(0, entry.kind);
        assertEquals("Невский проспект 12А", entry.name);
        assertEquals("12а", entry.house);
        assertTrue(entry.display.contains("Кофейня"));
        assertTrue(entry.search.contains("невский проспект 12а"));
        assertEquals(30.36, entry.lon, 1e-9); assertEquals(59.93, entry.lat, 1e-9);
        assertArrayEquals(original, blob);
    }

    @Test public void streetRepresentativeLiesOnLineAndRussianAliasesAreSearchable() throws Exception {
        Geometry line = OnDeviceSceneEngine.GF.createLineString(new Coordinate[]{
            new Coordinate(30.30, 59.91), new Coordinate(30.35, 59.93), new Coordinate(30.4, 59.94)});
        OfflinePlaceStore.Entry entry = OfflinePlaceStore.entry(source(new File("unused"), "r1"), "Nevsky prospect",
            "\"name:ru\"=>\"Невский проспект\",\"old_name\"=>\"Проспект 25 Октября\"", "primary", gpkg(line, true), new WKBReader());
        assertEquals(1, entry.kind); assertEquals("Невский проспект", entry.name);
        assertTrue(entry.search.contains("nevsky prospect")); assertTrue(entry.search.contains("25 октября"));
        assertTrue(line.covers(OnDeviceSceneEngine.GF.createPoint(new Coordinate(entry.lon, entry.lat))));
    }

    @Test public void polygonAddressHasInteriorPointAndOutsideCompleteWaysAreExcluded() throws Exception {
        Geometry polygon = OnDeviceSceneEngine.GF.createPolygon(new Coordinate[]{new Coordinate(30.3,59.90),
            new Coordinate(30.4,59.90),new Coordinate(30.4,59.95),new Coordinate(30.3,59.95),new Coordinate(30.3,59.90)});
        OfflinePlaceStore.Entry entry = OfflinePlaceStore.entry(source(new File("unused"), "r1"), "",
            "\"addr:street\"=>\"Садовая улица\",\"addr:housenumber\"=>\"8\"", "", gpkg(polygon,true), new WKBReader());
        assertEquals(0, entry.kind);
        assertTrue(polygon.contains(OnDeviceSceneEngine.GF.createPoint(new Coordinate(entry.lon, entry.lat))));
        assertNull(OfflinePlaceStore.entry(source(new File("unused"), "r1"), "Далёкое место", "", "",
            gpkg(OnDeviceSceneEngine.GF.createPoint(new Coordinate(32.3,60)),false), new WKBReader()));
    }

    @Test public void missingStreetDoesNotInventOneOrMergeUnrelatedHouses() throws Exception {
        OfflinePlaceStore.Source source = source(new File("unused"), "r1");
        String tags = "\"addr:housenumber\"=>\"10\"";
        OfflinePlaceStore.Entry first = OfflinePlaceStore.entry(source,"",tags,"",gpkg(OnDeviceSceneEngine.GF.createPoint(new Coordinate(30.31,59.91)),false),new WKBReader());
        OfflinePlaceStore.Entry second = OfflinePlaceStore.entry(source,"",tags,"",gpkg(OnDeviceSceneEngine.GF.createPoint(new Coordinate(30.4,59.95)),false),new WKBReader());
        assertEquals("Дом 10", first.name); assertNotEquals(first.identity, second.identity);
        assertFalse(first.display.contains("улица"));
    }

    @Test public void repeatedStreetSegmentsAndPointPolygonAddressesShareDedupIdentity() throws Exception {
        OfflinePlaceStore.Source source = source(new File("unused"), "r1");
        String tags = "\"addr:street\"=>\"Садовая\",\"addr:housenumber\"=>\"10\"";
        OfflinePlaceStore.Entry first = OfflinePlaceStore.entry(source,"",tags,"",gpkg(OnDeviceSceneEngine.GF.createPoint(new Coordinate(30.31,59.91)),false),new WKBReader());
        OfflinePlaceStore.Entry second = OfflinePlaceStore.entry(source,"Магазин",tags,"",gpkg(OnDeviceSceneEngine.GF.createPoint(new Coordinate(30.3101,59.9101)),false),new WKBReader());
        assertEquals(first.identity, second.identity);
    }

    @Test public void sourceSnapshotsAndFilenamesChangeWithRevisionWithoutWritingTheCity() throws Exception {
        File root=Files.createTempDirectory("offline-place-source").toFile();
        try {
            File city=new File(root,"city.gpkg");Files.write(city.toPath(),new byte[]{1,2,3});long modified=city.lastModified();
            OfflinePlaceStore.Source old=source(city,"r1"), updated=source(city,"r2");
            assertTrue(old.unchanged());assertNotEquals(old.filename(),updated.filename());
            assertEquals(modified,city.lastModified());
            Files.write(city.toPath(),new byte[]{1,2,3,4});assertFalse(old.unchanged());
        } finally { remove(root); }
    }

    @Test public void completeManifestSurvivesRestartAndDeletedCityDisappearsImmediately() throws Exception {
        File root=Files.createTempDirectory("offline-place-manifest").toFile();
        try {
            File city=new File(root,"city.gpkg");Files.write(city.toPath(),new byte[]{1,2,3});
            OfflinePlaceStore.Source source=source(city,"r1");publishFixture(root,source);
            OfflinePlaceStore store=new OfflinePlaceStore(root);
            assertTrue(store.statusJson().getBoolean("ready"));assertEquals(5,store.statusJson().getLong("rows"));
            assertEquals(3,store.statusJson().getLong("addresses"));
            assertEquals(store.signature(),store.statusJson().getString("revision"));
            assertEquals(store.signature(),new OfflinePlaceStore(root).signature());
            store.retainSources(Collections.emptyList());
            assertFalse(store.statusJson().getBoolean("ready"));assertEquals(0,store.statusJson().getLong("rows"));
            assertNull(store.search("Невский",6,59.93,30.36));
            assertFalse(new File(root,"offline-places/saint-petersburg.json").exists());
            assertFalse(new File(root,"offline-places/"+source.filename()).exists());
        } finally { remove(root); }
    }

    @Test public void failedOrInterruptedReplacementLeavesPreviousReadyPointerAndFile() throws Exception {
        File root=Files.createTempDirectory("offline-place-replace").toFile();
        try {
            File city=new File(root,"city.gpkg");Files.write(city.toPath(),new byte[]{1,2,3});
            OfflinePlaceStore.Source previous=source(city,"r1");publishFixture(root,previous);
            OfflinePlaceStore store=new OfflinePlaceStore(root);String signature=store.signature();
            OfflinePlaceStore.Source stale=source(city,"r2");Files.write(city.toPath(),new byte[]{1,2,3,4});
            store.retainSources(Collections.singletonList(stale));
            try { store.ensureIndex(stale,null);fail("stale source must be rejected"); }
            catch(java.io.IOException expected){assertTrue(expected.getMessage().contains("изменился"));}
            assertEquals(signature,store.signature());assertEquals("r1",store.statusJson().getJSONArray("packs").getJSONObject(0).getString("revision"));
            OfflinePlaceStore.Source fresh=source(city,"r3");store.retainSources(Collections.singletonList(fresh));Thread.currentThread().interrupt();
            try { store.ensureIndex(fresh,null);fail("interrupted task must stop before SQLite"); }
            catch(java.io.IOException expected){assertTrue(expected.getMessage().contains("отменена"));}
            finally { Thread.interrupted(); }
            assertEquals(signature,store.signature());assertTrue(new File(root,"offline-places/"+previous.filename()).isFile());
            assertEquals(signature,new OfflinePlaceStore(root).signature());
        } finally { Thread.interrupted();remove(root); }
    }

    @Test public void malformedManifestDoesNotExposeForeignOrIncompleteFiles() throws Exception {
        File root=Files.createTempDirectory("offline-place-invalid").toFile();
        try {
            File directory=new File(root,"offline-places");assertTrue(directory.mkdirs());
            File city=new File(root,"city.gpkg");Files.write(city.toPath(),new byte[]{1});
            OfflinePlaceStore.Source source=source(city,"r1");
            JSONObject record=record(source).json();record.put("filename","../city.gpkg");
            Files.write(new File(directory,"saint-petersburg.json").toPath(),record.toString().getBytes(StandardCharsets.UTF_8));
            Files.write(new File(directory,"interrupted.sqlite.tmp").toPath(),new byte[]{1});
            OfflinePlaceStore store=new OfflinePlaceStore(root);
            assertFalse(store.statusJson().getBoolean("ready"));assertTrue(city.exists());
            assertFalse(new File(directory,"interrupted.sqlite.tmp").exists());
            record=record(source).json();record.put("rows",100);
            try { OfflinePlaceStore.Record.parse(record);fail("inconsistent counts"); }catch(java.io.IOException expected){}
        } finally { remove(root); }
    }

    @Test public void cityStoreExposesReadOnlySnapshotsWithoutChangingPackRevision() throws Exception {
        File root=Files.createTempDirectory("offline-place-city").toFile();
        try {
            CityPackStore cityStore=new CityPackStore(root);assertTrue(cityStore.installedSearchSources().isEmpty());
            File file=new File(root,"city-packs/saint-petersburg.gpkg");Files.write(file.toPath(),new byte[]{1,2,3});
            CityPackStore.writeMeta(new File(root,"city-packs/saint-petersburg.meta"),new CityPackStore.PackMeta(3,"date","validated"));
            long modified=file.lastModified();String revision=cityStore.installedViewportRevision();
            java.util.List<OfflinePlaceStore.Source> sources=cityStore.installedSearchSources();
            assertEquals(1,sources.size());assertEquals(revision,sources.get(0).revision);assertEquals(file,sources.get(0).file);
            assertEquals(modified,file.lastModified());assertEquals(revision,cityStore.installedViewportRevision());
            try { sources.clear();fail("snapshot list must be immutable"); }catch(UnsupportedOperationException expected){}
        } finally { remove(root); }
    }

    private static OfflinePlaceStore.Source source(File file,String revision) {
        return new OfflinePlaceStore.Source("saint-petersburg","Санкт-Петербург",file,revision,CityPackStore.PETERSBURG_BOUNDS);
    }
    private static byte[] gpkg(Geometry geometry,boolean envelope) {
        byte[] wkb=new WKBWriter().write(geometry);int offset=envelope?40:8;byte[] blob=new byte[offset+wkb.length];
        blob[0]='G';blob[1]='P';blob[2]=0;blob[3]=(byte)(envelope?3:1);
        ByteBuffer buffer=ByteBuffer.wrap(blob).order(ByteOrder.LITTLE_ENDIAN);buffer.putInt(4,4326);
        if(envelope){org.locationtech.jts.geom.Envelope e=geometry.getEnvelopeInternal();buffer.putDouble(8,e.getMinX());buffer.putDouble(16,e.getMaxX());buffer.putDouble(24,e.getMinY());buffer.putDouble(32,e.getMaxY());}
        System.arraycopy(wkb,0,blob,offset,wkb.length);return blob;
    }
    private static OfflinePlaceStore.Record record(OfflinePlaceStore.Source source) {
        return new OfflinePlaceStore.Record(source.id,source.name,source.revision,source.filename(),source.bounds,5,3,1,1,0,3,true);
    }
    private static void publishFixture(File root,OfflinePlaceStore.Source source)throws Exception {
        File directory=new File(root,"offline-places");assertTrue(directory.isDirectory()||directory.mkdirs());
        Files.write(new File(directory,source.filename()).toPath(),new byte[]{1,2,3});
        Files.write(new File(directory,source.id+".json").toPath(),record(source).json().toString().getBytes(StandardCharsets.UTF_8));
    }
    private static void remove(File file){if(file.isDirectory()){File[] list=file.listFiles();if(list!=null)for(File child:list)remove(child);}file.delete();}
}
