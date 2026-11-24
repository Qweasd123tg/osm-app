package app.sloi.map;

import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.database.sqlite.SQLiteStatement;

import org.json.JSONArray;
import org.json.JSONObject;
import org.locationtech.jts.geom.Coordinate;
import org.locationtech.jts.geom.Geometry;
import org.locationtech.jts.io.WKBReader;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.StandardCopyOption;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** Immutable search indexes derived entirely from installed OSM GeoPackages. */
final class OfflinePlaceStore {
    private static final int SCHEMA = 3;
    private static final int MAX_ROWS = 1_000_000;
    private static final int MAX_GEOMETRY_BYTES = 4 * 1024 * 1024;
    private static final int MAX_TAG_BYTES = 128 * 1024;
    private static final long MAX_INDEX_BYTES = 300L * 1024 * 1024;
    private static final String[] TABLES = {"points", "lines", "multipolygons", "other_relations"};
    private static final Pattern WORD = Pattern.compile("[\\p{L}\\p{N}]+(?:/[\\p{L}\\p{N}]+)*");
    private static final Pattern CORPUS = Pattern.compile("(\\d+[\\p{L}]?)\\s*(?:корпус|корп[.]?|к[.]?)\\s*(\\d+[\\p{L}]?)(?![\\p{L}\\p{N}])");
    private static final Pattern FRACTION = Pattern.compile("(\\d+[\\p{L}]?)\\s*/\\s*(\\d+[\\p{L}]?)");
    private static final Pattern JOINED_STREET_HOUSE = Pattern.compile("(\\p{L}{3,})(?=\\d)");
    private final File directory;
    private final Object buildLock = new Object();
    private volatile Map<String, Record> active;
    private Map<String, String> allowedSources;
    private volatile String indexingId;
    private volatile String lastError;
    private long generation;

    interface Progress { void update(String phase, long current, long total); }

    static final class Source {
        final String id, name, revision;
        final File file;
        final CityPackStore.Bbox bounds;
        final long bytes, modified;
        Source(String id, String name, File file, String revision, CityPackStore.Bbox bounds) {
            if (id == null || !id.matches("[a-z0-9][a-z0-9-]{0,63}") || name == null || revision == null
                || revision.length() > 1000 || file == null || bounds == null) throw new IllegalArgumentException("Invalid offline search source");
            this.id = id; this.name = name; this.file = file; this.revision = revision; this.bounds = bounds;
            bytes = file.length(); modified = file.lastModified();
        }
        boolean unchanged() { return file.isFile() && bytes > 0 && file.length() == bytes && file.lastModified() == modified; }
        String filename() { return id + "-" + digest(SCHEMA + "\n" + revision).substring(0, 24) + ".sqlite"; }
    }

    OfflinePlaceStore(File filesDir) {
        directory = new File(filesDir, "offline-places");
        if (!directory.isDirectory() && !directory.mkdirs()) throw new IllegalArgumentException("Cannot create offline search directory");
        active = Collections.unmodifiableMap(readRecords());
        // Completed files without a pointer and interrupted transactions are never searched.
        Set<String> keep = new LinkedHashSet<>();
        for (Record record : active.values()) keep.add(record.filename);
        for (File file : children(directory)) if (file.getName().contains(".tmp")
            || (file.getName().endsWith(".sqlite") && !keep.contains(file.getName()))) deleteDatabaseFiles(file);
    }

    synchronized void cancel() { generation++; }
    void close() { cancel(); }

    /** Drop deleted cities immediately. A replacement retains its last complete index. */
    synchronized void retainSources(List<Source> sources) throws IOException {
        Set<String> ids = new LinkedHashSet<>();
        Map<String, String> allowed = new LinkedHashMap<>();
        for (Source source : sources) { ids.add(source.id); allowed.put(source.id, source.revision); }
        if (!allowed.equals(allowedSources)) generation++;
        allowedSources = allowed;
        if (sources.isEmpty()) lastError = null;
        Map<String, Record> next = new LinkedHashMap<>(active);
        for (String id : new ArrayList<>(next.keySet())) if (!ids.contains(id)) {
            File pointer = new File(directory, id + ".json");
            if (pointer.exists() && !pointer.delete()) throw new IOException("Не удалось удалить индекс адресов");
            next.remove(id);
        }
        active = Collections.unmodifiableMap(next);
        // SQLite readers already opened on an immutable file retain their own handle.
        for (File file : children(directory)) if (file.getName().endsWith(".sqlite")
            && ids.stream().noneMatch(id -> file.getName().startsWith(id + "-"))) deleteDatabaseFiles(file);
    }

    void ensureIndex(Source source, Progress listener) throws IOException {
        synchronized (buildLock) { ensureIndexSerial(source, listener); }
    }

    private void ensureIndexSerial(Source source, Progress listener) throws IOException {
        Record existing = active.get(source.id);
        if (existing != null && existing.revision.equals(source.revision) && existing.filename.equals(source.filename())
            && new File(directory, existing.filename).isFile()) return;
        final long operation;
        synchronized (this) {
            operation = generation;
            if (allowedSources != null && !source.revision.equals(allowedSources.get(source.id)))
                throw new IOException("Пакет города больше не установлен");
        }
        check(operation);
        if (!source.unchanged()) throw new IOException("Пакет города изменился до построения поиска");
        File temporary = new File(directory, source.filename() + ".tmp-" + java.util.UUID.randomUUID()), installed = new File(directory, source.filename());
        deleteDatabaseFiles(temporary);
        indexingId = source.id; lastError = null;
        boolean committed = false;
        try {
            Record built = build(source, temporary, operation, listener);
            check(operation);
            if (!source.unchanged()) throw new IOException("Пакет города изменился при построении поиска");
            if (temporary.length() <= 0 || temporary.length() > MAX_INDEX_BYTES) throw new IOException("Индекс адресов слишком большой");
            built.bytes = temporary.length();
            synchronized (this) {
                check(operation);
                if (!source.unchanged()) throw new IOException("Пакет города изменился при сохранении поиска");
                Files.move(temporary.toPath(), installed.toPath(), StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
                writePointer(source.id, built.json());
                Map<String, Record> next = new LinkedHashMap<>(active); next.put(source.id, built);
                active = Collections.unmodifiableMap(next); committed = true;
            }
            // Keep prior revisions through this process so an in-flight reader never
            // opens a disappearing filename. Constructor removes them on next launch.
            if (listener != null) listener.update("ready", built.rows, built.rows);
        } catch (Exception error) {
            lastError = error.getMessage();
            if (error instanceof IOException) throw (IOException) error;
            throw new IOException("Не удалось подготовить адреса на устройстве", error);
        } finally {
            indexingId = null;
            deleteDatabaseFiles(temporary);
            if (!committed && !isActiveFilename(installed.getName())) deleteDatabaseFiles(installed);
        }
    }

    /** null = no ready city index; [] = ready local data with no match. Bias only ranks. */
    String search(String query, int limit, double latitude, double longitude) throws IOException {
        List<Record> records = new ArrayList<>(active.values());
        if (records.isEmpty()) return null;
        List<String> tokens = tokens(query);
        if (tokens.isEmpty()) return "[]";
        limit = Math.max(1, Math.min(6, limit));
        List<Hit> hits = new ArrayList<>();
        for (Record record : records) {
            SQLiteDatabase db = null; Cursor cursor = null;
            try {
                db = SQLiteDatabase.openDatabase(new File(directory, record.filename).getPath(), null, SQLiteDatabase.OPEN_READONLY);
                boolean numeric = !houseQuery(query).isEmpty();
                String houseQuery = houseQuery(query);
                double biasLat = Double.isFinite(latitude) && Math.abs(latitude) <= 85 ? latitude : (record.bounds.south + record.bounds.north) / 2;
                double biasLon = Double.isFinite(longitude) && Math.abs(longitude) <= 180 ? longitude : (record.bounds.west + record.bounds.east) / 2;
                double lonScale = Math.cos(Math.toRadians(biasLat));
                String distance = "((p.lat-?)*(p.lat-?)+(p.lon-?)*(p.lon-?)*" + (lonScale * lonScale) + ")";
                String kindRank = numeric ? "p.kind" : "CASE p.kind WHEN 1 THEN 0 WHEN 2 THEN 1 ELSE 2 END";
                List<String> arguments = new ArrayList<>();
                arguments.add(String.valueOf(biasLat)); arguments.add(String.valueOf(biasLat));
                arguments.add(String.valueOf(biasLon)); arguments.add(String.valueOf(biasLon));
                String filter, from;
                if (record.fts) { from = "places_fts JOIN places p ON p.id=places_fts.rowid"; filter = "places_fts MATCH ?"; arguments.add(ftsQuery(tokens)); }
                else {
                    from = "places p"; List<String> filters = new ArrayList<>();
                    for (String token : tokens) { filters.add("p.search LIKE ?"); arguments.add("% " + token + "%"); }
                    filter = String.join(" AND ", filters);
                }
                // MIN chooses the nearest representative among duplicate street
                // segments/point+polygon addresses; only bounded result rows escape SQLite.
                String sql = "SELECT p.name,p.display,p.lat,p.lon,p.kind,MIN(" + distance + ") AS d,p.name_norm,p.house_norm"
                    + " FROM " + from + " WHERE " + filter + " GROUP BY p.identity"
                    + " ORDER BY " + (numeric ? "CASE WHEN p.house_norm=? THEN 0 ELSE 1 END," : "")
                    + "CASE WHEN p.name_norm=? THEN 0 ELSE 1 END," + kindRank + ",d LIMIT " + limit;
                if (numeric) arguments.add(houseQuery);
                arguments.add(normalize(query));
                cursor = db.rawQuery(sql, arguments.toArray(new String[0]));
                while (cursor.moveToNext()) hits.add(new Hit(cursor.getString(0), cursor.getString(1), cursor.getDouble(2), cursor.getDouble(3),
                    cursor.getInt(4), cursor.getDouble(5), cursor.getString(6).equals(normalize(query)),
                    !houseQuery.isEmpty() && cursor.getString(7).equals(houseQuery)));
            } catch (Exception error) {
                throw new IOException("Локальный поиск недоступен. Обновите пакет города.", error);
            } finally { if (cursor != null) cursor.close(); if (db != null) db.close(); }
        }
        final boolean numeric = !houseQuery(query).isEmpty();
        hits.sort(Comparator.comparingInt((Hit hit) -> hit.exactHouse ? 0 : 1).thenComparingInt(hit -> hit.exact ? 0 : 1)
            .thenComparingInt(hit -> numeric ? hit.kind : hit.kind == 1 ? 0 : hit.kind == 2 ? 1 : 2).thenComparingDouble(hit -> hit.distance));
        JSONArray result = new JSONArray(); Set<String> seen = new LinkedHashSet<>();
        try {
            for (Hit hit : hits) {
                if (!seen.add(normalize(hit.display))) continue;
                result.put(new JSONObject().put("name", hit.name).put("display_name", hit.display)
                    .put("latitude", hit.lat).put("longitude", hit.lon).put("source", "offline"));
                if (result.length() == limit) break;
            }
        } catch (Exception error) { throw new IOException("Не удалось прочитать адреса", error); }
        return result.toString();
    }

    /** A label near a picked coordinate, never a replacement for that coordinate. */
    JSONObject nearest(double latitude, double longitude) throws IOException {
        validatePoint(latitude, longitude);
        NearestHit best = null;
        final double latitudeSpan = 250 / 111320d;
        final double longitudeScale = Math.max(.08, Math.cos(Math.toRadians(latitude)));
        final double longitudeSpan = latitudeSpan / longitudeScale;
        for (Record record : new ArrayList<>(active.values())) {
            if (latitude < record.bounds.south - latitudeSpan || latitude > record.bounds.north + latitudeSpan
                || longitude < record.bounds.west - longitudeSpan || longitude > record.bounds.east + longitudeSpan) continue;
            if (Thread.currentThread().isInterrupted()) throw new IOException("Определение места отменено");
            // Existing immutable schema-3 indexes remain usable. A bounded box
            // scans their local table without rewriting the city or rebuilding FTS.
            final String metric = "((lat-?)*(lat-?)+(lon-?)*(lon-?)*" + longitudeScale * longitudeScale + ")";
            final String sql = "SELECT name,display,lat,lon,kind," + metric + " AS d FROM places"
                + " WHERE lat BETWEEN ? AND ? AND lon BETWEEN ? AND ?"
                + " AND (kind<>0 OR " + metric + "<=?)"
                + " ORDER BY CASE WHEN kind=0 THEN 0 ELSE 1 END,d LIMIT 24";
            String[] arguments = {String.valueOf(latitude), String.valueOf(latitude), String.valueOf(longitude), String.valueOf(longitude),
                String.valueOf(latitude-latitudeSpan), String.valueOf(latitude+latitudeSpan),
                String.valueOf(longitude-longitudeSpan), String.valueOf(longitude+longitudeSpan),
                String.valueOf(latitude), String.valueOf(latitude), String.valueOf(longitude), String.valueOf(longitude),
                String.valueOf(Math.pow(150 / 111320d, 2))};
            try (SQLiteDatabase db = SQLiteDatabase.openDatabase(new File(directory, record.filename).getPath(), null, SQLiteDatabase.OPEN_READONLY);
                 Cursor cursor = db.rawQuery(sql, arguments)) {
                while (cursor.moveToNext()) {
                    if (Thread.currentThread().isInterrupted()) throw new IOException("Определение места отменено");
                    NearestHit candidate = nearestHit(cursor.getString(0), cursor.getString(1), cursor.getInt(4),
                        latitude, longitude, cursor.getDouble(2), cursor.getDouble(3));
                    if (candidate != null && (best == null || candidate.compareTo(best) < 0)) best = candidate;
                }
            } catch (IOException error) { throw error; }
            catch (Exception error) { throw new IOException("Не удалось определить ближайшее место", error); }
        }
        if (best == null) return null;
        try {
            return new JSONObject().put("name", best.name).put("display_name", best.display)
                .put("distance", Math.round(best.distance)).put("source", "offline");
        } catch (Exception error) { throw new IOException("Не удалось прочитать ближайшее место", error); }
    }

    static void validatePoint(double latitude, double longitude) {
        if (!Double.isFinite(latitude) || !Double.isFinite(longitude) || Math.abs(latitude) > 85 || Math.abs(longitude) > 180)
            throw new IllegalArgumentException("Некорректная точка карты");
    }

    static NearestHit nearestHit(String name, String display, int kind, double latitude, double longitude, double candidateLat, double candidateLon) {
        if (name == null || name.trim().isEmpty() || display == null || !Double.isFinite(candidateLat) || !Double.isFinite(candidateLon)) return null;
        double y = Math.toRadians(candidateLat - latitude), x = Math.toRadians(candidateLon - longitude);
        double a = Math.pow(Math.sin(y / 2), 2) + Math.cos(Math.toRadians(latitude)) * Math.cos(Math.toRadians(candidateLat)) * Math.pow(Math.sin(x / 2), 2);
        double metres = 6371008.8 * 2 * Math.asin(Math.min(1, Math.sqrt(a)));
        if (metres > 250 || (kind == 0 && metres > 150)) return null;
        return new NearestHit(name, display, kind, metres);
    }

    static final class NearestHit implements Comparable<NearestHit> {
        final String name, display;
        final int kind;
        final double distance;
        NearestHit(String name, String display, int kind, double distance) { this.name=name;this.display=display;this.kind=kind;this.distance=distance; }
        @Override public int compareTo(NearestHit other) {
            int rank = Integer.compare(kind == 0 ? 0 : 1, other.kind == 0 ? 0 : 1);
            return rank != 0 ? rank : Double.compare(distance, other.distance);
        }
    }

    JSONObject statusJson() {
        try {
            JSONArray packs = new JSONArray(); long rows = 0, addresses = 0;
            for (Record record : active.values()) { packs.put(record.json()); rows += record.rows; addresses += record.addresses; }
            return new JSONObject().put("packs", packs).put("rows", rows).put("addresses", addresses)
                .put("ready", packs.length() > 0).put("revision", signature()).put("signature", signature()).put("indexing", indexingId == null ? JSONObject.NULL : indexingId)
                .put("error", lastError == null ? JSONObject.NULL : lastError);
        } catch (Exception error) { throw new IllegalStateException(error); }
    }

    String signature() {
        List<String> parts = new ArrayList<>();
        for (Record record : active.values()) parts.add(record.id + ":" + record.revision + ":" + record.filename);
        Collections.sort(parts); return digest(String.join("\n", parts));
    }

    private Record build(Source source, File target, long operation, Progress listener) throws Exception {
        SQLiteDatabase input = null, output = null; SQLiteStatement insert = null, ftsInsert = null;
        try {
            input = SQLiteDatabase.openDatabase(source.file.getPath(), null, SQLiteDatabase.OPEN_READONLY);
            List<String> tables = new ArrayList<>(); long total = 0;
            for (String table : TABLES) {
                try (Cursor schema = input.rawQuery("SELECT srs_id FROM gpkg_geometry_columns WHERE table_name=? AND column_name='geom'", new String[]{table})) {
                    if (!schema.moveToFirst()) continue;
                    if (schema.getInt(0) != 4326) throw new IOException("Пакет адресов должен использовать WGS84");
                }
                tables.add(table);
                try (Cursor count = input.rawQuery("SELECT COUNT(*) FROM " + table + " WHERE " + candidates(table), null)) {
                    if (count.moveToFirst()) total += count.getLong(0);
                }
            }
            if (total > MAX_ROWS) throw new IOException("В пакете слишком много адресных объектов");
            if (listener != null) listener.update("addresses", 0, total);
            output = SQLiteDatabase.openOrCreateDatabase(target, null);
            output.disableWriteAheadLogging();
            try (Cursor journal = output.rawQuery("PRAGMA journal_mode=DELETE", null)) { journal.moveToFirst(); }
            output.execSQL("PRAGMA synchronous=FULL");
            output.execSQL("CREATE TABLE places(id INTEGER PRIMARY KEY,name TEXT NOT NULL,display TEXT NOT NULL,search TEXT NOT NULL,name_norm TEXT NOT NULL,identity TEXT NOT NULL,kind INTEGER NOT NULL,lat REAL NOT NULL,lon REAL NOT NULL,house_norm TEXT NOT NULL)");
            boolean fts = true;
            try { output.execSQL("CREATE VIRTUAL TABLE places_fts USING fts4(search,tokenize=unicode61)"); }
            catch (RuntimeException unsupported) { fts = false; }
            insert = output.compileStatement("INSERT INTO places(name,display,search,name_norm,identity,kind,lat,lon,house_norm) VALUES(?,?,?,?,?,?,?,?,?)");
            if (fts) ftsInsert = output.compileStatement("INSERT INTO places_fts(rowid,search) VALUES(?,?)");
            long scanned = 0, indexed = 0, addresses = 0, streets = 0, places = 0, skipped = 0;
            WKBReader reader = new WKBReader();
            output.beginTransaction();
            try {
                for (String table : tables) {
                    String highway = "lines".equals(table) && hasColumn(input, table, "highway") ? "highway" : "NULL";
                    String sql = "SELECT substr(name,1,200),CASE WHEN length(other_tags)<=" + MAX_TAG_BYTES + " THEN other_tags ELSE NULL END,"
                        + "CASE WHEN length(geom)<=" + MAX_GEOMETRY_BYTES + " THEN geom ELSE NULL END," + highway
                        + " FROM " + table + " WHERE " + candidates(table);
                    try (Cursor cursor = input.rawQuery(sql, null)) {
                        while (cursor.moveToNext()) {
                            check(operation); scanned++;
                            String name = cursor.isNull(0) ? "" : cursor.getString(0), tags = cursor.isNull(1) ? "" : cursor.getString(1);
                            byte[] geometry = cursor.isNull(2) ? null : cursor.getBlob(2);
                            Entry entry = null;
                            if (tags.length() <= MAX_TAG_BYTES && geometry != null && geometry.length <= MAX_GEOMETRY_BYTES) {
                                try { entry = entry(source, name, tags, cursor.isNull(3) ? "" : cursor.getString(3), geometry, reader); }
                                catch (Exception malformed) { /* A malformed individual OSM object cannot poison the entire city. */ }
                            }
                            if (entry == null) skipped++;
                            else {
                                insert.clearBindings(); insert.bindString(1, entry.name); insert.bindString(2, entry.display);
                                insert.bindString(3, entry.search); insert.bindString(4, normalize(entry.name)); insert.bindString(5, entry.identity);
                                insert.bindLong(6, entry.kind); insert.bindDouble(7, entry.lat); insert.bindDouble(8, entry.lon);
                                insert.bindString(9, entry.house);
                                long rowid = insert.executeInsert();
                                if (ftsInsert != null) { ftsInsert.clearBindings(); ftsInsert.bindLong(1, rowid); ftsInsert.bindString(2, entry.search); ftsInsert.executeInsert(); }
                                indexed++; if (entry.kind == 0) addresses++; else if (entry.kind == 1) streets++; else places++;
                            }
                            if (scanned % 1000 == 0) {
                                if (target.length() > MAX_INDEX_BYTES) throw new IOException("Индекс адресов слишком большой");
                                if (listener != null) listener.update("addresses", scanned, total);
                            }
                        }
                    }
                }
                check(operation);
                output.setTransactionSuccessful();
            } finally { output.endTransaction(); }
            output.execSQL("CREATE INDEX places_identity ON places(identity)");
            Record record = new Record(source.id, source.name, source.revision, source.filename(), source.bounds,
                indexed, addresses, streets, places, skipped, 0, fts);
            output.execSQL("CREATE TABLE metadata(json TEXT NOT NULL)");
            output.execSQL("INSERT INTO metadata(json) VALUES(?)", new Object[]{record.json().toString()});
            if (listener != null) listener.update("addresses", total, total);
            return record;
        } finally {
            if (insert != null) insert.close(); if (ftsInsert != null) ftsInsert.close();
            if (output != null) output.close(); if (input != null) input.close();
        }
    }

    private static boolean hasColumn(SQLiteDatabase database, String table, String name) {
        // Table names come only from TABLES; optional OGR columns vary by export.
        try (Cursor columns = database.rawQuery("PRAGMA table_info(" + table + ")", null)) {
            while (columns.moveToNext()) if (name.equalsIgnoreCase(columns.getString(1))) return true;
        }
        return false;
    }

    private static String candidates(String table) {
        String address = "instr(other_tags,'\"addr:housenumber\"')>0";
        return "other_relations".equals(table) ? address : "((name IS NOT NULL AND length(trim(name))>0) OR " + address + ")";
    }

    static Entry entry(Source source, String givenName, String hstore, String highway, byte[] blob, WKBReader reader) throws Exception {
        Map<String, String> tags = CityPackStore.parseHstore(hstore);
        String name = text(tags.get("name:ru"), 200); if (name.isEmpty()) name = text(givenName, 200);
        String street = text(tags.get("addr:street"), 200); if (street.isEmpty()) street = text(tags.get("addr:place"), 200);
        String house = text(tags.get("addr:housenumber"), 80), city = text(tags.get("addr:city"), 200);
        if (city.isEmpty()) city = source.name;
        String address = (street + (house.isEmpty() ? "" : " " + house)).trim();
        Geometry geometry = CityPackStore.readGeoPackageGeometry(blob, reader);
        if (geometry == null || geometry.isEmpty()) return null;
        String road = text(highway, 80); if (road.isEmpty()) road = text(tags.get("highway"), 80);
        int kind = !house.isEmpty() ? 0 : geometry.getDimension() == 1 && !road.isEmpty() ? 1 : 2;
        String title = kind == 0 ? (!street.isEmpty() ? address : !name.isEmpty() ? name + " " + house : "Дом " + house) : name;
        if (title.isEmpty()) return null;
        Coordinate point = geometry.getInteriorPoint().getCoordinate();
        if (point == null || !contains(source.bounds, point.y, point.x)) return null;
        LinkedHashSet<String> display = new LinkedHashSet<>(); display.add(title);
        if (!name.isEmpty() && !normalize(name).equals(normalize(title))) display.add(name);
        if (!address.isEmpty() && !normalize(address).equals(normalize(title))) display.add(address);
        display.add(city);
        String detail = String.join(", ", display);
        String search = detail + " " + text(givenName, 200);
        for (String key : new String[]{"alt_name", "old_name", "short_name", "official_name", "addr:full", "addr:postcode"}) search += " " + text(tags.get(key), 256);
        String identity = kind + "|" + normalize(kind == 0 ? address : title) + "|" + normalize(city);
        if (kind == 0 && street.isEmpty()) identity += "|" + Math.round(point.x * 10000) + ":" + Math.round(point.y * 10000);
        return new Entry(title, detail, " " + normalize(search) + " ", identity, kind, point.y, point.x, normalize(house));
    }

    static String normalize(String value) {
        if (value == null) return "";
        String lower = value.toLowerCase(Locale.ROOT).replace('ё', 'е');
        // The index and query must use identical house tokens: OSM commonly stores
        // "12 к1" while people type "12к1" or "12 корпус 1". Preserve fractions
        // as a complete house for exact ranking; FTS safely splits their slash.
        lower = CORPUS.matcher(lower).replaceAll("$1к$2");
        lower = FRACTION.matcher(lower).replaceAll("$1/$2");
        lower = JOINED_STREET_HOUSE.matcher(lower).replaceAll("$1 ");
        List<String> parts = new ArrayList<>(); Matcher matcher = WORD.matcher(lower);
        while (matcher.find()) parts.add(matcher.group());
        return String.join(" ", parts);
    }

    static List<String> tokens(String query) {
        String cleaned = normalize(text(query, 160));
        if (cleaned.isEmpty()) return Collections.emptyList();
        LinkedHashSet<String> result = new LinkedHashSet<>();
        for (String token : cleaned.split(" ")) { result.add(token.length() > 64 ? token.substring(0, 64) : token); if (result.size() == 12) break; }
        return new ArrayList<>(result);
    }

    static String ftsQuery(List<String> tokens) {
        List<String> parts = new ArrayList<>();
        for (String token : tokens) {
            // unicode61 splits a house fraction at '/'. Keep those components
            // adjacent in a phrase; independent AND terms would also match 12/2
            // because its first component 12 itself satisfies the prefix 1*.
            parts.add(token.contains("/") ? "\"" + token.replace('/', ' ') + "*\"" : token + "*");
        }
        // Android FTS4 may omit SQLITE_ENABLE_FTS3_PARENTHESIS. Its legacy
        // parser treats uppercase AND as a searchable word, yielding no hits.
        // Whitespace means AND in both legacy and enhanced FTS3/4 syntax.
        return String.join(" ", parts);
    }

    static String houseQuery(String query) {
        String normalized = normalize(text(query, 160));
        // Do not deduplicate before finding the house: "1-я Советская 1" needs
        // the final 1 even though its first occurrence is the street ordinal.
        return houseQuery(java.util.Arrays.asList(normalized.split(" ")));
    }

    static String houseQuery(List<String> tokens) {
        for (int index = tokens.size() - 1; index >= 0; index--) {
            String token = tokens.get(index);
            if (token.isEmpty() || !Character.isDigit(token.codePointAt(0))) continue;
            if (index + 1 < tokens.size() && tokens.get(index + 1).matches("я|й|ая|ый|ой|е|го|год|года")) continue;
            return token;
        }
        return "";
    }

    private synchronized void check(long operation) throws IOException {
        if (operation != generation || Thread.currentThread().isInterrupted()) throw new IOException("Подготовка адресов отменена");
    }
    private boolean isActiveFilename(String filename) { for (Record record : active.values()) if (record.filename.equals(filename)) return true; return false; }
    private Map<String, Record> readRecords() {
        Map<String, Record> records = new LinkedHashMap<>();
        for (File pointer : children(directory)) if (pointer.getName().endsWith(".json") && pointer.length() <= 65536) {
            try {
                Record record = Record.parse(new JSONObject(new String(Files.readAllBytes(pointer.toPath()), StandardCharsets.UTF_8)));
                File file = new File(directory, record.filename);
                if (file.isFile() && file.length() > 0 && file.length() <= MAX_INDEX_BYTES) records.put(record.id, record);
            } catch (Exception ignored) { /* No partial/invalid index is advertised as ready. */ }
        }
        return records;
    }
    private void writePointer(String id, JSONObject value) throws IOException {
        File temporary = new File(directory, id + ".json.tmp");
        try (FileOutputStream output = new FileOutputStream(temporary)) { output.write(value.toString().getBytes(StandardCharsets.UTF_8)); output.getFD().sync(); }
        Files.move(temporary.toPath(), new File(directory, id + ".json").toPath(), StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
    }
    static boolean contains(CityPackStore.Bbox bounds, double lat, double lon) {
        return Double.isFinite(lat) && Double.isFinite(lon) && lat >= bounds.south && lat <= bounds.north && lon >= bounds.west && lon <= bounds.east;
    }
    private static String text(String value, int max) { if (value == null) return ""; String clean = value.trim().replaceAll("\\s+", " "); return clean.length() > max ? clean.substring(0, max) : clean; }
    private static File[] children(File directory) { File[] files = directory.listFiles(); return files == null ? new File[0] : files; }
    private static void deleteDatabaseFiles(File file) { file.delete(); new File(file.getPath() + "-journal").delete(); new File(file.getPath() + "-wal").delete(); new File(file.getPath() + "-shm").delete(); }
    private static String digest(String value) {
        try { byte[] bytes = MessageDigest.getInstance("SHA-256").digest(value.getBytes(StandardCharsets.UTF_8)); StringBuilder out = new StringBuilder(); for (byte b : bytes) out.append(String.format(Locale.ROOT, "%02x", b & 255)); return out.toString(); }
        catch (Exception error) { throw new IllegalStateException(error); }
    }

    static final class Entry {
        final String name, display, search, identity, house; final int kind; final double lat, lon;
        Entry(String name, String display, String search, String identity, int kind, double lat, double lon, String house) { this.name=name;this.display=display;this.search=search;this.identity=identity;this.kind=kind;this.lat=lat;this.lon=lon;this.house=house; }
    }
    private static final class Hit {
        final String name, display; final double lat, lon, distance; final int kind; final boolean exact, exactHouse;
        Hit(String name,String display,double lat,double lon,int kind,double distance,boolean exact,boolean exactHouse) { this.name=name;this.display=display;this.lat=lat;this.lon=lon;this.kind=kind;this.distance=distance;this.exact=exact;this.exactHouse=exactHouse; }
    }
    static final class Record {
        final String id, name, revision, filename; final CityPackStore.Bbox bounds; final long rows, addresses, streets, places, skipped; final boolean fts; long bytes;
        Record(String id,String name,String revision,String filename,CityPackStore.Bbox bounds,long rows,long addresses,long streets,long places,long skipped,long bytes,boolean fts) {
            this.id=id;this.name=name;this.revision=revision;this.filename=filename;this.bounds=bounds;this.rows=rows;this.addresses=addresses;this.streets=streets;this.places=places;this.skipped=skipped;this.bytes=bytes;this.fts=fts;
        }
        JSONObject json() throws Exception { return new JSONObject().put("schema",SCHEMA).put("id",id).put("name",name).put("revision",revision).put("filename",filename)
            .put("bounds",new JSONArray().put(bounds.west).put(bounds.south).put(bounds.east).put(bounds.north))
            .put("rows",rows).put("addresses",addresses).put("streets",streets).put("places",places).put("skipped",skipped).put("bytes",bytes).put("fts",fts).put("status","ready"); }
        static Record parse(JSONObject json) throws Exception {
            String id=json.getString("id"),filename=json.getString("filename"),revision=json.getString("revision"); JSONArray b=json.getJSONArray("bounds");
            if(json.getInt("schema")!=SCHEMA||!id.matches("[a-z0-9][a-z0-9-]{0,63}")||!filename.matches(java.util.regex.Pattern.quote(id)+"-[a-f0-9]{24}\\.sqlite")||b.length()!=4)throw new IOException("Invalid search manifest");
            CityPackStore.Bbox bounds=new CityPackStore.Bbox(b.getDouble(1),b.getDouble(0),b.getDouble(3),b.getDouble(2));
            long rows=json.getLong("rows"),addresses=json.getLong("addresses"),streets=json.getLong("streets"),places=json.getLong("places"),skipped=json.getLong("skipped"),bytes=json.getLong("bytes");
            if(rows<0||rows>MAX_ROWS||addresses<0||streets<0||places<0||addresses+streets+places!=rows||skipped<0||bytes<0||bytes>MAX_INDEX_BYTES
                ||bounds.south< -85||bounds.north>85||bounds.west< -180||bounds.east>180)throw new IOException("Invalid search manifest counts");
            return new Record(id,json.getString("name"),revision,filename,bounds,rows,addresses,streets,places,skipped,bytes,json.getBoolean("fts"));
        }
    }
}
