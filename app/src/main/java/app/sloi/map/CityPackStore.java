package app.sloi.map;

import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.database.sqlite.SQLiteStatement;

import org.locationtech.jts.geom.Envelope;
import org.locationtech.jts.geom.Geometry;
import org.locationtech.jts.io.WKBReader;

import java.io.BufferedInputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.URL;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.zip.ZipEntry;
import java.util.zip.ZipFile;

import javax.net.ssl.HttpsURLConnection;

/**
 * Small, deliberately UI-free store for BBBike GeoPackage city extracts.  All data is retained
 * locally; the only network operations are an explicit metadata refresh and a requested download.
 */
final class CityPackStore {
    private static final String ID = "saint-petersburg";
    private static final String NAME = "Санкт-Петербург";
    private static final String ZIP_URL = "https://download.bbbike.org/osm/bbbike/SanktPetersburg/SanktPetersburg.osm.geopackage.zip";
    private static final String CHECKSUM_URL = "https://download.bbbike.org/osm/bbbike/SanktPetersburg/CHECKSUM.txt";
    private static final long KNOWN_DOWNLOAD_BYTES = 96_097_314L;
    private static final long KNOWN_INSTALLED_BYTES = 248_946_688L;
    private static final long MAX_DOWNLOAD_BYTES = 180L * 1024L * 1024L;
    private static final long MAX_UNCOMPRESSED_BYTES = 512L * 1024L * 1024L;
    private static final int MAX_QUERY_ROWS = 5_000;
    private static final long MAX_QUERY_GEOMETRY_BYTES = 20L * 1024L * 1024L;
    private static final int MAX_VIEWPORT_QUERY_ROWS = 1_500;
    private static final long MAX_VIEWPORT_GEOMETRY_BYTES = 4L * 1024L * 1024L;
    private static final int MAX_VIEWPORT_COORDINATES = 250_000;
    private static final String SOURCE = "BBBike OpenStreetMap extract";
    private static final String LICENSE = "Open Database License (ODbL)";

    private final File packsDir;
    private final File stagingDir;
    private final Set<HttpsURLConnection> activeConnections = Collections.synchronizedSet(new HashSet<HttpsURLConnection>());
    /** Guards only installed-pack visibility; downloads and index construction must not block it. */
    private final Object ioLock = new Object();
    private long installGeneration;
    private volatile boolean downloadInProgress;

    CityPackStore(File root) {
        if (root == null) throw new IllegalArgumentException("root is required");
        this.packsDir = requireDirectory(new File(root, "city-packs"));
        this.stagingDir = requireDirectory(new File(packsDir, "staging"));
        cleanupPartFiles(stagingDir);
    }

    interface ProgressListener { void onProgress(String phase, long current, long total); }

    /** Returns a stable one-pack catalog. refreshRemote performs a lightweight live BBBike HEAD. */
    String listPacksJson(boolean refreshRemote) {
        RemoteInfo info = refreshRemote ? headRemote() : new RemoteInfo(KNOWN_DOWNLOAD_BYTES, null, false);
        File installed = installedFile(ID);
        File metadata = metadataFile(ID);
        PackMeta local = readMeta(metadata);
        String status = installed.isFile() && local != null ? "installed" : "not_installed";
        long downloadBytes = info.length > 0 ? info.length : KNOWN_DOWNLOAD_BYTES;
        long installedBytes = installed.isFile() ? installed.length() : 0L;
        String updatedAt = local != null && local.date != null ? local.date : info.lastModified;
        String revision = "installed".equals(status) ? revision(installed, local) : null;
        return "{\"packs\":[{\"id\":\"" + ID + "\",\"name\":\"" + NAME + "\",\"bounds\":{\"south\":59.796,\"west\":30.042,\"north\":60.071,\"east\":30.63},"
            + "\"status\":\"" + status + "\",\"downloadBytes\":" + downloadBytes + ",\"installedBytes\":" + installedBytes
            + ",\"expectedInstalledBytes\":" + KNOWN_INSTALLED_BYTES + ",\"date\":" + jsonString(updatedAt) + ",\"updatedAt\":" + jsonString(updatedAt)
            + ",\"revision\":" + jsonString(revision)
            + ",\"source\":\"" + SOURCE + "\",\"license\":\"" + LICENSE + "\",\"url\":\"" + ZIP_URL
            + "\",\"remoteChecked\":" + info.checked + "}]}";
    }

    /** Downloads, validates and atomically installs a pack. Invoke from a worker thread. */
    void download(String id, ProgressListener listener) throws IOException {
        requireId(id); final long generation; synchronized (ioLock) { generation = installGeneration; }
        downloadInProgress = true;
        File zipPart = new File(stagingDir, ID + ".zip.part");
        File gpkgTmp = new File(stagingDir, ID + ".gpkg.tmp");
        File ready = readyFile(ID);
        try {
            cleanupPartFiles(stagingDir); progress(listener, "metadata", 0, 1);
            try {
                RemoteInfo remote = null;
                if (ready.isFile()) {
                    try {
                        validateGeoPackage(ready);
                        progress(listener, "metadata", 1, 1);
                    } catch (IOException invalidReady) {
                        deleteQuietly(ready);
                        deleteSqliteSidecars(ready);
                    }
                }
                if (!ready.isFile()) {
                    remote = headRemote();
                    long expected = remote.length > 0 ? remote.length : KNOWN_DOWNLOAD_BYTES;
                    if (expected <= 0 || expected > MAX_DOWNLOAD_BYTES) throw new IOException("BBBike archive exceeds the on-device safety limit");
                    String expectedMd5 = fetchChecksum();
                    if (expectedMd5 == null) throw new IOException("BBBike CHECKSUM.txt is unavailable; refusing an unverified city pack");
                    progress(listener, "metadata", 1, 1);
                    deleteQuietly(zipPart); deleteQuietly(gpkgTmp);
                    downloadArchive(zipPart, expected, listener);
                    if (!expectedMd5.equalsIgnoreCase(md5(zipPart))) throw new IOException("BBBike CHECKSUM.txt MD5 mismatch");
                    progress(listener, "extract", 0, KNOWN_INSTALLED_BYTES);
                    extractGeoPackage(zipPart, gpkgTmp, listener);
                    validateGeoPackage(gpkgTmp);
                    atomicReplace(gpkgTmp, ready);
                }
            progress(listener, "index", 0, 1);
            buildIndex(ready);
            progress(listener, "index", 1, 1);
            checkCancelled();
            synchronized (ioLock) {
                if (generation != installGeneration) throw new IOException("Install was cancelled by deletion");
                File finalFile = installedFile(ID);
                atomicReplace(ready, finalFile);
                String updatedAt = remote == null ? String.valueOf(finalFile.lastModified()) : remote.lastModified;
                writeMeta(metadataFile(ID), new PackMeta(finalFile.length(), updatedAt, "MD5 + ZIP CRC + GeoPackage EPSG/schema"));
            }
            progress(listener, "ready", 1, 1);
            } catch (IOException | RuntimeException e) {
                deleteQuietly(gpkgTmp);
                throw e;
            } finally { deleteQuietly(zipPart); deleteQuietly(gpkgTmp); deleteSqliteSidecars(gpkgTmp); }
        } finally { downloadInProgress = false; }
    }

    /** Immediately breaks blocked HTTPS reads as well as allowing an interrupted worker to exit. */
    void cancelActiveRequests() {
        synchronized (ioLock) { installGeneration++; }
        HttpsURLConnection[] snapshot;
        synchronized (activeConnections) { snapshot = activeConnections.toArray(new HttpsURLConnection[0]); }
        for (HttpsURLConnection connection : snapshot) connection.disconnect();
    }

    void delete(String id) {
        requireId(id);
        cancelActiveRequests();
        synchronized (ioLock) {
            installGeneration++;
            deleteQuietly(installedFile(id)); deleteQuietly(metadataFile(id));
            if (!downloadInProgress) { cleanupPartFiles(stagingDir); deleteQuietly(readyFile(id)); deleteSqliteSidecars(readyFile(id)); }
        }
    }

    /** null means no installed city pack fully covers the requested box. Database handles never escape. */
    PackSelection loadBuildings(double south, double west, double north, double east) throws IOException {
        synchronized (ioLock) {
        Bbox request = new Bbox(south, west, north, east);
        File file = installedFile(ID); PackMeta meta = readMeta(metadataFile(ID));
        if (!file.isFile() || meta == null || !PETERSBURG_BOUNDS.covers(request)) return null;
        SQLiteDatabase db = null; Cursor cursor = null;
        List<PackedFeature> result = new ArrayList<PackedFeature>();
        try {
            db = SQLiteDatabase.openDatabase(file.getPath(), null, SQLiteDatabase.OPEN_READONLY);
            Schema schema = schema(db);
            String nameExpression = schema.nameColumn == null ? "NULL" : "m." + qi(schema.nameColumn);
            String tagsExpression = schema.tagsColumn == null ? "NULL" : "m." + qi(schema.tagsColumn);
            String buildingExpression = schema.buildingColumn == null ? "NULL" : "m." + qi(schema.buildingColumn);
            String q = "SELECT m." + qi(schema.idColumn) + ",m." + qi(schema.geometryColumn) + "," + nameExpression + "," + tagsExpression + "," + buildingExpression
                + " FROM sloi_city_rtree r JOIN sloi_city_features f ON f.index_id=r.id JOIN " + qi(schema.table) + " m ON m." + qi(schema.idColumn) + "=f.feature_id"
                + " WHERE r.maxx>=? AND r.minx<=? AND r.maxy>=? AND r.miny<=? LIMIT " + (MAX_QUERY_ROWS + 1);
            cursor = db.rawQuery(q, new String[] {String.valueOf(west), String.valueOf(east), String.valueOf(south), String.valueOf(north)});
            WKBReader reader = new WKBReader(); long bytes = 0; int rows = 0;
            while (cursor.moveToNext()) {
                if (++rows > MAX_QUERY_ROWS) throw new IOException("City-pack scene exceeds the 5000-building safety limit");
                byte[] gpkg = cursor.isNull(1) ? null : cursor.getBlob(1);
                if (gpkg == null) continue;
                if (gpkg.length > MAX_QUERY_GEOMETRY_BYTES || bytes + gpkg.length > MAX_QUERY_GEOMETRY_BYTES) throw new IOException("City-pack scene geometry exceeds the 20 MiB safety limit");
                Geometry geometry = readGeoPackageGeometry(gpkg, reader);
                if (geometry == null || geometry.isEmpty()) continue;
                bytes += gpkg.length;
                String name = cursor.isNull(2) ? null : cursor.getString(2);
                Map<String, String> tags = parseHstore(cursor.isNull(3) ? null : cursor.getString(3));
                if (!cursor.isNull(4) && cursor.getString(4).length() > 0) tags.put("building", cursor.getString(4));
                if (name == null || name.length() == 0) name = tags.get("name");
                result.add(new PackedFeature(cursor.getLong(0), geometry, tags, name, SOURCE));
            }
            String revision = revision(file, meta);
            return new PackSelection(ID, NAME, PETERSBURG_BOUNDS, revision, result);
        } catch (Exception e) {
            if (e instanceof IOException) throw (IOException) e;
            throw new IOException("Cannot read installed city pack", e);
        } finally { if (cursor != null) cursor.close(); if (db != null) db.close(); }
        }
    }

    /**
     * Reads one Web Mercator tile worth of local buildings.  Unlike scene loading, a tile may
     * partly lie outside the city-pack envelope: an installed pack then simply yields no rows.
     * A missing pack is deliberately reported as null so the bridge can distinguish it from an
     * empty, valid tile.
     */
    ViewportSelection loadViewportBuildings(double south, double west, double north, double east)
        throws IOException {
        Bbox request = new Bbox(south, west, north, east);
        synchronized (ioLock) {
            File file = installedFile(ID);
            PackMeta meta = readMeta(metadataFile(ID));
            if (!file.isFile() || meta == null) return null;
            String revision = revision(file, meta);
            if (!PETERSBURG_BOUNDS.intersects(request)) {
                return new ViewportSelection(ID, revision, Collections.<PackedFeature>emptyList());
            }

            SQLiteDatabase db = null;
            Cursor cursor = null;
            List<PackedFeature> result = new ArrayList<PackedFeature>();
            try {
                db = SQLiteDatabase.openDatabase(file.getPath(), null, SQLiteDatabase.OPEN_READONLY);
                Schema schema = schema(db);
                String nameExpression = schema.nameColumn == null ? "NULL" : "m." + qi(schema.nameColumn);
                String tagsExpression = schema.tagsColumn == null ? "NULL" : "m." + qi(schema.tagsColumn);
                String buildingExpression = schema.buildingColumn == null ? "NULL" : "m." + qi(schema.buildingColumn);
                String q = "SELECT m." + qi(schema.idColumn) + ",m." + qi(schema.geometryColumn) + ","
                    + nameExpression + "," + tagsExpression + "," + buildingExpression
                    + " FROM sloi_city_rtree r JOIN sloi_city_features f ON f.index_id=r.id JOIN "
                    + qi(schema.table) + " m ON m." + qi(schema.idColumn) + "=f.feature_id"
                    + " WHERE r.maxx>=? AND r.minx<=? AND r.maxy>=? AND r.miny<=?"
                    + " ORDER BY m." + qi(schema.idColumn) + " ASC LIMIT " + (MAX_VIEWPORT_QUERY_ROWS + 1);
                cursor = db.rawQuery(q, new String[] {
                    String.valueOf(west), String.valueOf(east), String.valueOf(south), String.valueOf(north)
                });
                WKBReader reader = new WKBReader();
                long bytes = 0;
                int rows = 0;
                int coordinates = 0;
                while (cursor.moveToNext()) {
                    checkCancelled();
                    if (++rows > MAX_VIEWPORT_QUERY_ROWS) throw new ViewportTooDenseException("Tile contains more than 1500 buildings");
                    byte[] gpkg = cursor.isNull(1) ? null : cursor.getBlob(1);
                    if (gpkg == null) continue;
                    if (gpkg.length > MAX_VIEWPORT_GEOMETRY_BYTES || bytes + gpkg.length > MAX_VIEWPORT_GEOMETRY_BYTES) {
                        throw new ViewportTooDenseException("Tile geometry exceeds the 4 MiB safety limit");
                    }
                    bytes += gpkg.length;
                    checkCancelled();
                    Geometry geometry = readGeoPackageGeometry(gpkg, reader);
                    checkCancelled();
                    if (geometry == null || geometry.isEmpty()) continue;
                    int nextCoordinates = coordinates + geometry.getNumPoints();
                    if (nextCoordinates > MAX_VIEWPORT_COORDINATES) {
                        throw new ViewportTooDenseException("Tile coordinate budget is exceeded");
                    }
                    coordinates = nextCoordinates;
                    String name = cursor.isNull(2) ? null : cursor.getString(2);
                    Map<String, String> tags = parseHstore(cursor.isNull(3) ? null : cursor.getString(3));
                    if (!cursor.isNull(4) && cursor.getString(4).length() > 0) tags.put("building", cursor.getString(4));
                    if (name == null || name.length() == 0) name = tags.get("name");
                    result.add(new PackedFeature(cursor.getLong(0), geometry, tags, name, SOURCE));
                }
                return new ViewportSelection(ID, revision, result);
            } catch (Exception e) {
                if (e instanceof IOException) throw (IOException) e;
                throw new IOException("Cannot read installed city pack", e);
            } finally {
                if (cursor != null) cursor.close();
                if (db != null) db.close();
            }
        }
    }

    /** Cheap installed-pack identity used to validate a tile-cache entry before opening SQLite. */
    String installedViewportRevision() {
        synchronized (ioLock) {
            File file = installedFile(ID);
            PackMeta meta = readMeta(metadataFile(ID));
            return file.isFile() && meta != null ? revision(file, meta) : null;
        }
    }

    static final class PackedFeature {
        final long featureId; final Geometry geometry; final Map<String, String> tags; final String name; final String source;
        PackedFeature(long featureId, Geometry geometry, Map<String, String> tags, String name, String source) {
            this.featureId = featureId; this.geometry = geometry; this.tags = Collections.unmodifiableMap(new LinkedHashMap<String, String>(tags)); this.name = name; this.source = source;
        }
    }
    static final class PackSelection {
        final String id; final String name; final Bbox bounds; final String revision; final List<PackedFeature> features;
        PackSelection(String id, String name, Bbox bounds, String revision, List<PackedFeature> features) { this.id=id; this.name=name; this.bounds=bounds; this.revision=revision; this.features=Collections.unmodifiableList(features); }
    }
    static final class ViewportSelection {
        final String id; final String revision; final List<PackedFeature> features;
        ViewportSelection(String id, String revision, List<PackedFeature> features) {
            this.id = id; this.revision = revision;
            this.features = Collections.unmodifiableList(new ArrayList<PackedFeature>(features));
        }
    }
    static final class ViewportTooDenseException extends IOException {
        ViewportTooDenseException(String message) { super(message); }
    }
    static final class Bbox {
        final double south, west, north, east;
        Bbox(double south, double west, double north, double east) {
            if (!Double.isFinite(south) || !Double.isFinite(west) || !Double.isFinite(north) || !Double.isFinite(east) || south > north || west > east) throw new IllegalArgumentException("Invalid bounding box");
            this.south=south; this.west=west; this.north=north; this.east=east;
        }
        boolean covers(Bbox other) { return south <= other.south && west <= other.west && north >= other.north && east >= other.east; }
        boolean intersects(Bbox other) { return south <= other.north && north >= other.south && west <= other.east && east >= other.west; }
    }

    static final Bbox PETERSBURG_BOUNDS = new Bbox(59.796, 30.042, 60.071, 30.630);

    /** Parses the GeoPackage binary header and returns its optional XY envelope. */
    static Envelope geoPackageEnvelope(byte[] value) {
        if (value == null || value.length < 8 || value[0] != 'G' || value[1] != 'P') return null;
        int flags = value[3] & 0xff, type = (flags >> 1) & 7;
        if (type == 0) return null;
        int doubles = type == 1 ? 4 : (type == 2 || type == 3 ? 6 : type == 4 ? 8 : -1);
        if (doubles < 0 || value.length < 8 + doubles * 8) return null;
        ByteBuffer data = ByteBuffer.wrap(value).order((flags & 1) == 1 ? ByteOrder.LITTLE_ENDIAN : ByteOrder.BIG_ENDIAN);
        double minX=data.getDouble(8), maxX=data.getDouble(16), minY=data.getDouble(24), maxY=data.getDouble(32);
        if (!Double.isFinite(minX)||!Double.isFinite(maxX)||!Double.isFinite(minY)||!Double.isFinite(maxY)||minX>maxX||minY>maxY) return null;
        return new Envelope(minX,maxX,minY,maxY);
    }

    static int geoPackageWkbOffset(byte[] value) throws IOException {
        if (value == null || value.length < 8 || value[0] != 'G' || value[1] != 'P' || value[2] != 0) throw new IOException("Invalid GeoPackage geometry header");
        int type = ((value[3] & 0xff) >> 1) & 7;
        int doubles = type == 0 ? 0 : type == 1 ? 4 : (type == 2 || type == 3 ? 6 : type == 4 ? 8 : -1);
        int offset = 8 + doubles * 8;
        if (doubles < 0 || offset >= value.length) throw new IOException("Invalid GeoPackage geometry envelope");
        return offset;
    }

    static Geometry readGeoPackageGeometry(byte[] value, WKBReader reader) throws Exception {
        int offset = geoPackageWkbOffset(value); byte[] wkb = new byte[value.length-offset]; System.arraycopy(value,offset,wkb,0,wkb.length); return reader.read(wkb);
    }

    /** Handles PostgreSQL hstore quoting and backslash escapes without interpreting arbitrary SQL. */
    static Map<String, String> parseHstore(String text) {
        Map<String,String> out = new LinkedHashMap<String,String>(); if (text == null) return out;
        int[] i={0}; while (true) { skipWsComma(text,i); if (i[0]>=text.length()) break; String key=readHstoreToken(text,i); skipWs(text,i); if (i[0]+1>=text.length()||text.charAt(i[0])!='='||text.charAt(i[0]+1)!='>') break; i[0]+=2; skipWs(text,i); String value=readHstoreToken(text,i); if (key != null && value != null) out.put(key,value); skipWsComma(text,i); }
        return out;
    }

    private void downloadArchive(File target, long expected, ProgressListener listener) throws IOException {
        HttpsURLConnection c = open(ZIP_URL, "application/zip");
        try (InputStream input = new BufferedInputStream(c.getInputStream()); FileOutputStream output = new FileOutputStream(target)) {
            int status=c.getResponseCode(); if (status < 200 || status >= 300) throw new IOException("BBBike returned HTTP " + status);
            long declared=c.getContentLengthLong(); if (declared > MAX_DOWNLOAD_BYTES) throw new IOException("BBBike archive is too large");
            byte[] buffer=new byte[32*1024]; long done=0; int n;
            while ((n=input.read(buffer))!=-1) { checkCancelled(); done+=n; if(done>MAX_DOWNLOAD_BYTES || (declared>0&&done>declared)) throw new IOException("BBBike archive exceeds the safety limit"); output.write(buffer,0,n); progress(listener,"download",done,declared>0?declared:expected); }
            if (declared>0 && done!=declared) throw new IOException("Incomplete BBBike archive");
        } finally { close(c); }
    }

    private void extractGeoPackage(File zip, File target, ProgressListener listener) throws IOException {
        try (ZipFile archive = new ZipFile(zip)) {
            ZipEntry selected=null; java.util.Enumeration<? extends ZipEntry> entries=archive.entries();
            while(entries.hasMoreElements()) { ZipEntry e=entries.nextElement(); String n=e.getName(); if(n.startsWith("/")||n.contains("..")||n.indexOf('\\')>=0) throw new IOException("Unsafe ZIP entry"); if(!e.isDirectory()&&n.toLowerCase(Locale.US).endsWith(".gpkg")) { if(selected!=null) throw new IOException("Archive contains more than one GeoPackage"); selected=e; } }
            if(selected==null || selected.getSize()<1 || selected.getSize()>MAX_UNCOMPRESSED_BYTES) throw new IOException("Archive has no safe GeoPackage entry");
            try(InputStream input=new BufferedInputStream(archive.getInputStream(selected)); FileOutputStream output=new FileOutputStream(target)) { byte[] b=new byte[32*1024]; long done=0; int n; while((n=input.read(b))!=-1) { checkCancelled(); done+=n; if(done>MAX_UNCOMPRESSED_BYTES) throw new IOException("GeoPackage exceeds the safety limit"); output.write(b,0,n); progress(listener,"extract",done,selected.getSize()); } if(done!=selected.getSize()) throw new IOException("GeoPackage extraction truncated"); }
        }
    }

    private void validateGeoPackage(File file) throws IOException {
        SQLiteDatabase db=null; Cursor cursor=null;
        try {
            db=SQLiteDatabase.openDatabase(file.getPath(),null,SQLiteDatabase.OPEN_READONLY);
            if(!hasTable(db,"gpkg_contents")||!hasTable(db,"gpkg_spatial_ref_sys")||!hasTable(db,"gpkg_geometry_columns")||!hasTable(db,"multipolygons")) throw new IOException("Downloaded file is not a BBBike GeoPackage with multipolygons");
            Schema s=schema(db);
            cursor=db.rawQuery("SELECT srs_id FROM gpkg_geometry_columns WHERE table_name=? AND column_name=?",new String[]{s.table,s.geometryColumn});
            if(!cursor.moveToFirst()||cursor.getInt(0)!=4326) throw new IOException("City pack multipolygons must use EPSG:4326");
        } finally { if(cursor!=null)cursor.close(); if(db!=null) db.close(); }
    }

    private void buildIndex(File file) throws IOException {
        SQLiteDatabase db=null; Cursor c=null; SQLiteStatement features=null, rtree=null;
        try {
            db=SQLiteDatabase.openDatabase(file.getPath(),null,SQLiteDatabase.OPEN_READWRITE); Schema s=schema(db);
            checkpointAndDisableWal(db);
            db.beginTransaction();
            try {
                db.execSQL("DROP TABLE IF EXISTS sloi_city_features"); db.execSQL("DROP TABLE IF EXISTS sloi_city_rtree");
                db.execSQL("CREATE TABLE sloi_city_features (index_id INTEGER PRIMARY KEY, feature_id INTEGER NOT NULL)");
                try { db.execSQL("CREATE VIRTUAL TABLE sloi_city_rtree USING rtree(id,minx,maxx,miny,maxy)"); }
                catch (RuntimeException rtreeUnavailable) {
                    if (!isMissingRtree(rtreeUnavailable)) throw rtreeUnavailable;
                    db.execSQL("CREATE TABLE sloi_city_rtree (id INTEGER PRIMARY KEY,minx REAL NOT NULL,maxx REAL NOT NULL,miny REAL NOT NULL,maxy REAL NOT NULL)");
                    db.execSQL("CREATE INDEX sloi_city_bbox_bounds ON sloi_city_rtree(minx,maxx,miny,maxy)");
                }
                features=db.compileStatement("INSERT INTO sloi_city_features(index_id,feature_id) VALUES(?,?)");
                rtree=db.compileStatement("INSERT INTO sloi_city_rtree(id,minx,maxx,miny,maxy) VALUES(?,?,?,?,?)");
                String building = s.buildingColumn == null ? "NULL" : qi(s.buildingColumn);
                String tags = s.tagsColumn == null ? "NULL" : qi(s.tagsColumn);
                String where = s.buildingColumn == null
                    ? tags + " LIKE '%\"building\"=>%' OR " + tags + " LIKE '%\"building:part\"=>%'"
                    : "(" + building + " IS NOT NULL AND " + building + "<>'' ) OR " + tags + " LIKE '%\"building:part\"=>%'";
                c=db.rawQuery("SELECT " + qi(s.idColumn) + "," + qi(s.geometryColumn) + " FROM " + qi(s.table) + " WHERE " + where,null);
                long index=1; while(c.moveToNext()) {
                    checkCancelled();
                    byte[] g=c.isNull(1)?null:c.getBlob(1); Envelope e=geoPackageEnvelope(g); if(e==null) continue;
                    features.clearBindings(); features.bindLong(1,index); features.bindLong(2,c.getLong(0)); features.executeInsert();
                    rtree.clearBindings(); rtree.bindLong(1,index); rtree.bindDouble(2,e.getMinX()); rtree.bindDouble(3,e.getMaxX()); rtree.bindDouble(4,e.getMinY()); rtree.bindDouble(5,e.getMaxY()); rtree.executeInsert(); index++;
                }
                db.setTransactionSuccessful();
            } finally {
                if(c!=null){c.close();c=null;} if(features!=null){features.close();features=null;} if(rtree!=null){rtree.close();rtree=null;} db.endTransaction();
            }
            checkpointAndDisableWal(db);
        } catch(Exception e) { if(e instanceof IOException) throw (IOException)e; throw new IOException("Could not build local building index: " + sqliteCause(e),e); }
        finally { if(c!=null)c.close(); if(features!=null)features.close(); if(rtree!=null)rtree.close(); if(db!=null){try{checkpointAndDisableWal(db);}catch(Exception ignored){} db.close();} }
    }

    private RemoteInfo headRemote() { HttpsURLConnection c=null; try { c=open(ZIP_URL,"application/zip"); c.setRequestMethod("HEAD"); int status=c.getResponseCode(); if(status>=200&&status<300) { long l=c.getContentLengthLong(); return new RemoteInfo(l>0&&l<=MAX_DOWNLOAD_BYTES?l:KNOWN_DOWNLOAD_BYTES,c.getHeaderField("Last-Modified"),true); } } catch(Exception ignored) {} finally { if(c!=null)close(c); } return new RemoteInfo(KNOWN_DOWNLOAD_BYTES,null,false); }
    private String fetchChecksum() { HttpsURLConnection c=null; try { c=open(CHECKSUM_URL,"text/plain"); if(c.getResponseCode()<200||c.getResponseCode()>=300)return null; String body=readSmall(c.getInputStream(),128*1024); String needle="SanktPetersburg.osm.geopackage.zip"; for(String line:body.split("\\r?\\n"))if(line.contains(needle)){String[] p=line.trim().split("\\s+"); if(p.length>0&&p[0].matches("[a-fA-F0-9]{32}"))return p[0];} }catch(Exception ignored){}finally{if(c!=null)close(c);}return null; }
    private HttpsURLConnection open(String address,String accept) throws IOException { checkCancelled(); HttpsURLConnection c=(HttpsURLConnection)new URL(address).openConnection(); activeConnections.add(c); c.setConnectTimeout(15000);c.setReadTimeout(30000);c.setUseCaches(false);c.setRequestProperty("User-Agent","SloiMap/0.4");c.setRequestProperty("Accept",accept);c.setRequestProperty("Connection","close");return c; }
    private void close(HttpsURLConnection c){activeConnections.remove(c);c.disconnect();}
    private static void checkCancelled() throws IOException { if(Thread.currentThread().isInterrupted())throw new IOException("Cancelled"); }
    private static String md5(File file)throws IOException { try(InputStream in=new FileInputStream(file)){MessageDigest d=MessageDigest.getInstance("MD5");byte[]b=new byte[32768];for(int n;(n=in.read(b))>=0;){checkCancelled();d.update(b,0,n);}StringBuilder out=new StringBuilder();for(byte v:d.digest())out.append(String.format(Locale.US,"%02x",v&255));return out.toString();}catch(Exception e){throw new IOException("Cannot hash archive",e);} }
    private static String readSmall(InputStream in,int max)throws IOException {try(InputStream input=in){byte[]b=new byte[4096];StringBuilder out=new StringBuilder();for(int n;(n=input.read(b))>=0;){if(out.length()+n>max)throw new IOException("Response too large");out.append(new String(b,0,n,java.nio.charset.StandardCharsets.UTF_8));}return out.toString();}}
    private static void checkpointAndDisableWal(SQLiteDatabase db) {
        Cursor checkpoint = null, journal = null;
        try { checkpoint=db.rawQuery("PRAGMA wal_checkpoint(TRUNCATE)", null); checkpoint.moveToFirst(); }
        finally { if(checkpoint!=null)checkpoint.close(); }
        try { journal=db.rawQuery("PRAGMA journal_mode=DELETE", null); if(!journal.moveToFirst() || !"delete".equalsIgnoreCase(journal.getString(0))) throw new IllegalStateException("SQLite refused journal_mode=DELETE"); }
        finally { if(journal!=null)journal.close(); }
    }
    private static boolean isMissingRtree(Throwable error) { String message=sqliteCause(error).toLowerCase(Locale.US); return message.contains("no such module") && message.contains("rtree"); }
    private static String sqliteCause(Throwable error) { String message=error.getMessage(); return error.getClass().getSimpleName() + (message == null || message.length()==0 ? "" : ": " + message); }
    private static void progress(ProgressListener l,String phase,long current,long total){if(l!=null)l.onProgress(phase,current,total);}
    private static String revision(File file, PackMeta meta) { return (meta.date == null ? "unknown" : meta.date) + "-" + file.length() + "-" + file.lastModified(); }
    private static File requireDirectory(File d){if(!d.isDirectory()&&!d.mkdirs())throw new IllegalStateException("Cannot create "+d);return d;}
    private File installedFile(String id){return new File(packsDir,id+".gpkg");} private File metadataFile(String id){return new File(packsDir,id+".meta");} private File readyFile(String id){return new File(stagingDir,id+".gpkg.ready");}
    private static void deleteQuietly(File f){if(f!=null&&f.exists())f.delete();}
    static boolean isStagingJunkName(String name){return name.endsWith(".part")||name.endsWith(".tmp")||name.endsWith(".part-wal")||name.endsWith(".part-shm")||name.endsWith(".part-journal")||name.endsWith(".tmp-wal")||name.endsWith(".tmp-shm")||name.endsWith(".tmp-journal");}
    private static void cleanupPartFiles(File d){File[]fs=d.listFiles();if(fs!=null)for(File f:fs)if(isStagingJunkName(f.getName()))deleteQuietly(f);}
    private static void deleteSqliteSidecars(File f){deleteQuietly(new File(f.getPath()+"-wal"));deleteQuietly(new File(f.getPath()+"-shm"));deleteQuietly(new File(f.getPath()+"-journal"));}
    private static void atomicReplace(File from,File to)throws IOException{deleteSqliteSidecars(from);deleteSqliteSidecars(to);File old=new File(to.getParentFile(),to.getName()+".old");deleteQuietly(old);deleteSqliteSidecars(old);if(to.exists()&&!to.renameTo(old))throw new IOException("Cannot replace old city pack");if(!from.renameTo(to)){if(old.exists())old.renameTo(to);throw new IOException("Cannot atomically install city pack");}deleteQuietly(old);deleteSqliteSidecars(old);}
    private static void requireId(String id){if(!ID.equals(id))throw new IllegalArgumentException("Unknown city pack: "+id);}
    private static boolean hasTable(SQLiteDatabase db,String name){Cursor c=db.rawQuery("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?",new String[]{name});try{return c.moveToFirst();}finally{c.close();}}
    private static String qi(String s){if(s==null)throw new IllegalArgumentException("Missing column");return "\""+s.replace("\"","\"\"")+"\"";}
    private static final class Schema { String table="multipolygons",idColumn,geometryColumn,nameColumn,tagsColumn,buildingColumn; }
    private static Schema schema(SQLiteDatabase db)throws IOException {Schema s=new Schema();Cursor c=db.rawQuery("PRAGMA table_info(multipolygons)",null);try{while(c.moveToNext()){String n=c.getString(1);String l=n.toLowerCase(Locale.US);if(s.idColumn==null&&(l.equals("ogc_fid")||l.equals("id")||l.equals("fid")))s.idColumn=n;if(s.geometryColumn==null&&(l.equals("geom")||l.equals("geometry")))s.geometryColumn=n;if(s.nameColumn==null&&l.equals("name"))s.nameColumn=n;if(s.tagsColumn==null&&l.equals("other_tags"))s.tagsColumn=n;if(s.buildingColumn==null&&l.equals("building"))s.buildingColumn=n;}}finally{c.close();}if(s.idColumn==null)s.idColumn="rowid";if(s.geometryColumn==null)throw new IOException("multipolygons geometry column not found");return s;}
    private static String jsonString(String s){return s==null?"null":"\""+s.replace("\\","\\\\").replace("\"","\\\"")+"\"";}
    static void writeMeta(File f,PackMeta m)throws IOException {File t=new File(f.getParentFile(),f.getName()+".tmp");try(FileOutputStream o=new FileOutputStream(t)){o.write((m.installedBytes+"\n"+(m.date==null?"":m.date)+"\n"+m.validation).getBytes(java.nio.charset.StandardCharsets.UTF_8));}atomicReplace(t,f);}
    static PackMeta readMeta(File f){if(!f.isFile())return null;try{String content=readSmall(new FileInputStream(f),4096);String[]p=content.split("\n",-1);if(p.length!=3&&content.indexOf('\n')<0&&content.indexOf('\r')<0)p=content.split("\\\\n",-1);if(p.length!=3)return null;return new PackMeta(Long.parseLong(p[0].trim()),p[1].length()>0?p[1]:null,p[2]);}catch(Exception e){return null;}}
    private static void skipWs(String s,int[]i){while(i[0]<s.length()&&Character.isWhitespace(s.charAt(i[0])))i[0]++;} private static void skipWsComma(String s,int[]i){skipWs(s,i);if(i[0]<s.length()&&s.charAt(i[0])==',')i[0]++;skipWs(s,i);}
    private static String readHstoreToken(String s,int[]i){if(i[0]>=s.length())return null;if(s.charAt(i[0])!='\"'){int st=i[0];while(i[0]<s.length()&&s.charAt(i[0])!=','&&!Character.isWhitespace(s.charAt(i[0]))&&!(i[0]+1<s.length()&&s.charAt(i[0])=='='&&s.charAt(i[0]+1)=='>'))i[0]++;return s.substring(st,i[0]);}i[0]++;StringBuilder o=new StringBuilder();while(i[0]<s.length()){char c=s.charAt(i[0]++);if(c=='\"')return o.toString();if(c=='\\'&&i[0]<s.length())o.append(s.charAt(i[0]++));else o.append(c);}return null;}
    private static final class RemoteInfo {final long length;final String lastModified;final boolean checked;RemoteInfo(long l,String d,boolean c){length=l;lastModified=d;checked=c;}}
    static final class PackMeta {final long installedBytes;final String date,validation;PackMeta(long b,String d,String v){installedBytes=b;date=d;validation=v;}}
}
