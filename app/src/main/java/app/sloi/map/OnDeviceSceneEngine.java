package app.sloi.map;

import org.json.JSONArray;
import org.json.JSONObject;
import org.locationtech.jts.geom.Coordinate;
import org.locationtech.jts.geom.Envelope;
import org.locationtech.jts.geom.Geometry;
import org.locationtech.jts.geom.GeometryCollection;
import org.locationtech.jts.geom.GeometryFactory;
import org.locationtech.jts.geom.LinearRing;
import org.locationtech.jts.geom.LineString;
import org.locationtech.jts.geom.MultiPolygon;
import org.locationtech.jts.geom.Polygon;
import org.locationtech.jts.geom.util.GeometryFixer;
import org.locationtech.jts.operation.polygonize.Polygonizer;
import org.locationtech.jts.operation.union.UnaryUnionOp;
import org.locationtech.jts.simplify.TopologyPreservingSimplifier;

import java.io.BufferedInputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.nio.charset.CodingErrorAction;
import java.security.MessageDigest;
import java.time.LocalDate;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collection;
import java.util.Collections;
import java.util.Comparator;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import javax.net.ssl.HttpsURLConnection;

/** Offline-first OSM building and shadow calculator.  It deliberately has no Android UI dependency. */
public final class OnDeviceSceneEngine {
    static final GeometryFactory GF = new GeometryFactory();
    static final double EARTH_RADIUS_M = 6378137d;
    static final double MAX_SHADOW_M = 350d;
    private static final int CACHE_VERSION = 1;
    private static final int SCENE_ID_VERSION = 2;
    private static final int MAX_RESPONSE_BYTES = 20 * 1024 * 1024;
    private static final long RAW_CACHE_BYTES = 64L * 1024 * 1024;
    private static final long GENERATED_CACHE_BYTES = 24L * 1024 * 1024;
    private static final int VIEWPORT_FORMAT_VERSION = 1;
    private static final int MAX_VIEWPORT_RESPONSE_BYTES = 4 * 1024 * 1024;
    private static final long VIEWPORT_CACHE_BYTES = 96L * 1024 * 1024;
    private static final long STALE_TEMP_MS = 60L * 60L * 1000L;
    private static final double GRID_GUARD_M = 200d;
    private static final String USER_AGENT = "SloiMap/0.4 (+https://github.com/Qweasd123tg/osm-app)";
    private static final String[] OVERPASS = {
        "https://overpass-api.de/api/interpreter",
        "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
        "https://overpass.private.coffee/api/interpreter"
    };
    private static long lastNominatimAt;

    private final File cacheDir;
    private final File generatedDir;
    private final File viewportDir;
    private final CityPackStore cityPackStore;
    private final Set<HttpsURLConnection> activeConnections = Collections.synchronizedSet(new HashSet<>());
    /** Retain only the scene shown by the UI and the latest completed replacement. */
    private final PinnedLruCache<SceneContext> contexts = new PinnedLruCache<>(1);
    private final LinkedHashMap<String, String> frames = new LinkedHashMap<String, String>(8, .75f, true) {
        @Override protected boolean removeEldestEntry(Map.Entry<String, String> eldest) { return size() > 8; }
    };

    public OnDeviceSceneEngine(File cacheDir, File generatedDir) {
        this(cacheDir, generatedDir, new File(generatedDir, "viewport"), null);
    }

    public OnDeviceSceneEngine(File cacheDir, File generatedDir, CityPackStore cityPackStore) {
        this(cacheDir, generatedDir, new File(generatedDir, "viewport"), cityPackStore);
    }

    public OnDeviceSceneEngine(File cacheDir, File generatedDir, File viewportDir, CityPackStore cityPackStore) {
        this.cacheDir = requireDirectory(cacheDir, "cacheDir");
        this.generatedDir = requireDirectory(generatedDir, "generatedDir");
        this.viewportDir = requireDirectory(viewportDir, "viewportDir");
        this.cityPackStore = cityPackStore;
        pruneDirectory(this.cacheDir, RAW_CACHE_BYTES);
        pruneDirectory(this.generatedDir, GENERATED_CACHE_BYTES);
        pruneDirectory(this.viewportDir, VIEWPORT_CACHE_BYTES);
    }

    public SceneBuildResult buildScene(SceneRequest request, ProgressListener listener) throws IOException {
        request.validate(); checkInterrupted(); progress(listener, "cache", 0, 4);
        Bbox display = Bbox.around(request.latitude, request.longitude, request.radiusM);
        String key = cacheKey(request, display);
        Bbox requiredQueryCoverage = display.expand(350);
        CityPackStore.PackSelection pack = cityPackStore == null ? null : cityPackStore.loadBuildings(
            requiredQueryCoverage.south,
            requiredQueryCoverage.west,
            requiredQueryCoverage.north,
            requiredQueryCoverage.east
        );
        boolean cacheHit;
        String dataSource;
        String dataRevision;
        List<Building> buildings;
        if (pack != null) {
            cacheHit = true;
            dataSource = "city-pack:" + pack.id;
            dataRevision = pack.revision;
            progress(listener, "buildings", 2, 4);
            buildings = parseBuildings(pack, request.latitude, request.longitude);
        } else {
            File rawFile = new File(cacheDir, "osm-v" + CACHE_VERSION + "-" + key + ".json");
            JSONObject raw = readJson(rawFile);
            cacheHit = raw != null && raw.optInt("cacheVersion") == CACHE_VERSION
                && rawCacheCovers(raw, requiredQueryCoverage);
            if (!cacheHit) {
                progress(listener, "download", 1, 4);
                Bbox cacheQuery = display.expand(350 + GRID_GUARD_M);
                raw = fetchOverpass(cacheQuery, listener);
                p(raw, "cacheVersion", CACHE_VERSION);
                p(raw, "display", display.json());
                p(raw, "queryBounds", cacheQuery.json());
                writeAtomic(rawFile, raw.toString());
                pruneDirectory(cacheDir, RAW_CACHE_BYTES);
            }
            dataSource = "on-device-openstreetmap-overpass";
            dataRevision = String.valueOf(rawFile.lastModified());
            checkInterrupted(); progress(listener, "buildings", 2, 4);
            buildings = parseBuildings(raw, request.latitude, request.longitude);
        }
        if (buildings.isEmpty()) throw new IOException("No valid building footprints were returned for this area");
        Projection projection = new Projection(request.latitude, request.longitude);
        List<ProjectedBuilding> projected = new ArrayList<>();
        List<Geometry> ground = new ArrayList<>();
        for (Building b : buildings) {
            Geometry g = project(b.geometry, projection);
            if (!g.isEmpty()) {
                ProjectedBuilding p = new ProjectedBuilding(g, b.heightM, b.minHeightM);
                projected.add(p); if (p.minHeightM <= .01) ground.add(g);
            }
        }
        Geometry groundUnion = safeUnion(ground);
        Geometry clip = GF.toGeometry(new Envelope(
            projection.x(display.west), projection.x(display.east), projection.y(display.south), projection.y(display.north)));
        WindInfo wind = fetchWind(request.latitude, request.longitude);
        SceneRequest solarRequest = request;
        String sceneId = sceneIdFor(
            request.latitude,
            request.longitude,
            request.radiusM,
            solarRequest.localDate,
            solarRequest.timezoneOffsetMinutes,
            request.selectedMinutes,
            dataSource,
            dataRevision
        );
        List<FrameMeta> metas = frameMetadata(solarRequest, sceneId);
        int initial = closestFrame(request.selectedMinutes);
        SceneContext context = new SceneContext(sceneId, projection, projected, groundUnion, clip, metas, display);
        progress(listener, "initial-shadow", 3, 4);
        if (metas.get(initial).altitude > .5) {
            FramePayload payload = renderFrame(context, initial);
            metas.get(initial).geometry = payload.geometry;
            metas.get(initial).polygonCount = payload.polygonCount;
            metas.get(initial).computed = true;
        } else metas.get(initial).computed = true;
        checkInterrupted(); progress(listener, "wind", 4, 4);
        List<Building> visible = visibleBuildings(buildings, display);
        if (visible.isEmpty()) throw new IOException("No valid building footprints are visible in this area");
        JSONObject bundle = bundle(
            request,
            context,
            visible,
            initial,
            cacheHit,
            dataSource,
            wind == null ? null : wind.layer
        );
        String relative = "bundle-" + sceneId + ".json";
        writeAtomic(new File(generatedDir, relative), bundle.toString());
        checkInterrupted();
        contexts.putCandidate(sceneId, context);
        pruneDirectory(generatedDir, GENERATED_CACHE_BYTES);
        return new SceneBuildResult(sceneId, relative, initial, cacheHit, buildings.size());
    }

    public FrameBuildResult buildFrame(String sceneId, int frameIndex, ProgressListener listener) throws IOException {
        if (sceneId == null || !sceneId.matches("s-[a-f0-9]{16}")) throw new IllegalArgumentException("Invalid sceneId");
        SceneContext context = contexts.get(sceneId);
        if (context == null) throw new IOException("Scene is no longer in memory; rebuild it before calculating another frame");
        if (frameIndex < 0 || frameIndex >= context.frames.size()) throw new IllegalArgumentException("Invalid frame index");
        String relative = "frame-" + sceneId + "-" + frameIndex + ".json";
        File output = new File(generatedDir, relative);
        String existing; synchronized (frames) { existing = frames.get(frameKey(sceneId, frameIndex)); }
        if (existing == null && output.isFile()) existing = readText(output, MAX_RESPONSE_BYTES);
        if (existing != null) {
            if (!output.isFile()) { writeAtomic(output, existing); pruneDirectory(generatedDir, GENERATED_CACHE_BYTES); }
            else output.setLastModified(System.currentTimeMillis());
            return new FrameBuildResult(sceneId, frameIndex, relative, true);
        }
        progress(listener, "shadow", 0, 1); checkInterrupted();
        FrameMeta frame = context.frames.get(frameIndex);
        FramePayload payload = frame.altitude > .5 ? renderFrame(context, frameIndex) : null;
        JSONObject json = new JSONObject(); p(json,"sceneId",sceneId); p(json,"frameIndex",frameIndex);
        p(json,"geometry",payload == null ? JSONObject.NULL : payload.geometry); p(json,"polygon_count",payload == null ? 0 : payload.polygonCount); p(json,"computed",true);
        String text = json.toString(); writeAtomic(output, text);
        pruneDirectory(generatedDir, GENERATED_CACHE_BYTES);
        frame.geometry = payload == null ? null : payload.geometry; frame.polygonCount = payload == null ? 0 : payload.polygonCount; frame.computed = true;
        synchronized (frames) { frames.put(frameKey(sceneId, frameIndex), text); }
        progress(listener, "shadow", 1, 1);
        return new FrameBuildResult(sceneId, frameIndex, relative, false);
    }

    /** Prunes before a new tile batch; batch outputs stay available until the next request. */
    public void prepareViewportBatch() { prepareViewportBatch(viewportDir, VIEWPORT_CACHE_BYTES); }
    static void prepareViewportBatch(File directory, long quotaBytes) { pruneDirectory(directory, quotaBytes); }

    /** Builds only one local building tile. It never accesses scene contexts, shadows, wind, or HTTP. */
    public ViewportTileBuildResult buildViewportTile(ViewportTile tile) throws IOException {
        if (tile == null) throw new IllegalArgumentException("Viewport tile is required");
        tile.validate();
        checkInterrupted();
        if (cityPackStore == null) throw new ViewportException("NOT_INSTALLED", "No installed city pack");
        Bbox bounds = tileBounds(tile.z, tile.x, tile.y);
        String revision = cityPackStore.installedViewportRevision();
        if (revision == null) throw new ViewportException("NOT_INSTALLED", "City pack is not installed");
        File output = new File(viewportDir, viewportCacheFileName(revision, tile));
        JSONObject cached = readJson(output, MAX_VIEWPORT_RESPONSE_BYTES);
        if (isViewportCache(cached, revision, tile)) {
            output.setLastModified(System.currentTimeMillis());
            return new ViewportTileBuildResult(tile.id(), output.getName(), true);
        }
        CityPackStore.ViewportSelection pack = cityPackStore.loadViewportBuildings(
            bounds.south, bounds.west, bounds.north, bounds.east);
        if (pack == null) throw new ViewportException("NOT_INSTALLED", "City pack is not installed");
        // A delete/replace may have happened after the cheap revision check; use its new identity.
        if (!revision.equals(pack.revision)) output = new File(viewportDir, viewportCacheFileName(pack.revision, tile));

        Geometry tileGeometry = GF.toGeometry(new Envelope(bounds.west, bounds.east, bounds.south, bounds.north));
        JSONArray features = new JSONArray();
        int count = 0;
        for (CityPackStore.PackedFeature feature : pack.features) {
            checkInterrupted();
            Geometry geometry = polygonal(feature.geometry);
            if (geometry.isEmpty() || !geometry.intersects(tileGeometry) || !ownsViewportFeature(tile, geometry)) continue;
            JSONObject tags = new JSONObject();
            for (Map.Entry<String, String> entry : feature.tags.entrySet()) p(tags, entry.getKey(), entry.getValue());
            if (feature.name != null && !feature.name.trim().isEmpty() && !tags.has("name")) p(tags, "name", feature.name.trim());
            Height height = height(tags, geometry, (bounds.south + bounds.north) / 2d, (bounds.west + bounds.east) / 2d);
            JSONObject properties = new JSONObject();
            p(properties, "id", String.valueOf(feature.featureId));
            p(properties, "source", "city-pack:" + pack.id);
            p(properties, "osm_source", feature.source);
            p(properties, "height", height.height);
            p(properties, "min_height", height.minHeight);
            p(properties, "height_source", height.source);
            p(properties, "name", feature.name == null ? "" : feature.name);
            p(properties, "kind", feature.tags.containsKey("building:part") ? "part" : "building");
            JSONObject geo = new JSONObject();
            p(geo, "type", "Feature");
            p(geo, "properties", properties);
            p(geo, "geometry", geometryJson(geometry));
            a(features, geo);
            count++;
        }
        JSONObject collection = new JSONObject();
        p(collection, "type", "FeatureCollection");
        p(collection, "features", features);
        JSONObject tileJson = new JSONObject();
        p(tileJson, "id", tile.id()); p(tileJson, "z", tile.z); p(tileJson, "x", tile.x); p(tileJson, "y", tile.y);
        JSONArray corners = new JSONArray();
        JSONArray southwest = new JSONArray(); a(southwest, round(bounds.west)); a(southwest, round(bounds.south));
        JSONArray northeast = new JSONArray(); a(northeast, round(bounds.east)); a(northeast, round(bounds.north));
        a(corners, southwest); a(corners, northeast); p(tileJson, "bounds", corners);
        JSONObject packJson = new JSONObject(); p(packJson, "id", pack.id); p(packJson, "revision", pack.revision);
        JSONObject root = new JSONObject();
        p(root, "schemaVersion", VIEWPORT_FORMAT_VERSION); p(root, "tile", tileJson); p(root, "pack", packJson);
        p(root, "featureCount", count); p(root, "buildings", collection);
        checkInterrupted();
        writeAtomicLimited(output, root.toString(), MAX_VIEWPORT_RESPONSE_BYTES);
        return new ViewportTileBuildResult(tile.id(), output.getName(), false);
    }

    /** Explicit place search only; callers should debounce text input rather than using this as autocomplete. */
    public String searchPlaces(String query, int limit) throws IOException {
        String q = query == null ? "" : query.trim();
        if (q.length() < 2 || q.length() > 160) throw new IllegalArgumentException("Query must contain 2..160 characters");
        limit = Math.max(1, Math.min(10, limit));
        synchronized (OnDeviceSceneEngine.class) {
            long wait = 1000 - (System.currentTimeMillis() - lastNominatimAt);
            if (wait > 0) try { Thread.sleep(wait); } catch (InterruptedException e) { Thread.currentThread().interrupt(); throw new IOException("Interrupted", e); }
            lastNominatimAt = System.currentTimeMillis();
        }
        String url = "https://nominatim.openstreetmap.org/search?format=jsonv2&addressdetails=0&limit=" + limit
            + "&q=" + URLEncoder.encode(q, "UTF-8");
        return httpsGet(url, "GET", null, 15000, 20000);
    }

    public void acceptScene(String sceneId) {
        if (sceneId != null && sceneId.matches("s-[a-f0-9]{16}")) contexts.accept(sceneId);
    }

    public void clearMemory() { contexts.clear(); synchronized (frames) { frames.clear(); } }

    /** Disconnects all in-flight HTTPS requests; safe to call from the UI thread while a worker is blocked. */
    public void cancelActiveRequests() {
        HttpsURLConnection[] snapshot;
        synchronized (activeConnections) { snapshot = activeConnections.toArray(new HttpsURLConnection[0]); }
        for (HttpsURLConnection connection : snapshot) connection.disconnect();
    }

    private JSONObject fetchOverpass(Bbox queryBox, ProgressListener listener) throws IOException {
        String q = String.format(Locale.US, "[out:json][timeout:25];(way[\"building\"](%f,%f,%f,%f);way[\"building:part\"](%f,%f,%f,%f);relation[\"building\"](%f,%f,%f,%f);relation[\"building:part\"](%f,%f,%f,%f););out body;>;out skel qt;",
            queryBox.south, queryBox.west, queryBox.north, queryBox.east, queryBox.south, queryBox.west, queryBox.north, queryBox.east, queryBox.south, queryBox.west, queryBox.north, queryBox.east, queryBox.south, queryBox.west, queryBox.north, queryBox.east);
        IOException failure = null;
        for (String endpoint : OVERPASS) try {
            checkInterrupted();
            String body = "data=" + URLEncoder.encode(q, "UTF-8");
            return new JSONObject(httpsGet(endpoint, "POST", body, 15000, 45000, listener));
        } catch (HttpStatusException error) {
            if (isTerminalOverpassStatus(error.statusCode)) {
                throw new IOException("Overpass rejected this query at " + endpoint + ": " + error.describe(), error);
            }
            if (!isRetryableOverpassStatus(error.statusCode)) {
                throw new IOException("Overpass returned HTTP " + error.statusCode + " at " + endpoint + ": " + error.describe(), error);
            }
            failure = new IOException("Retryable Overpass HTTP " + error.statusCode + " at " + endpoint + ": " + error.describe(), error);
        } catch (IOException error) {
            if (Thread.currentThread().isInterrupted()) throw error;
            if (isOversizedResponse(error)) {
                throw new IOException("OSM response is larger than the on-device safety limit", error);
            }
            failure = new IOException("Overpass transport failure at " + endpoint + ": " + messageOf(error), error);
        } catch (org.json.JSONException error) {
            throw new IOException("Overpass returned invalid JSON at " + endpoint, error);
        }
        throw failure == null ? new IOException("No Overpass endpoint") : failure;
    }

    private WindInfo fetchWind(double latitude, double longitude) {
        try {
            String u = String.format(Locale.US, "https://api.open-meteo.com/v1/forecast?latitude=%.6f&longitude=%.6f&current=wind_speed_10m,wind_direction_10m&wind_speed_unit=ms&timezone=auto", latitude, longitude);
            JSONObject root = new JSONObject(httpsGet(u, "GET", null, 5000, 8000)); JSONObject now = root.optJSONObject("current");
            if (now == null || !Double.isFinite(now.optDouble("wind_speed_10m", Double.NaN))) return null;
            JSONObject out = new JSONObject(); double from = now.optDouble("wind_direction_10m", Double.NaN);
            p(out,"speedMps",now.getDouble("wind_speed_10m")); p(out,"directionFromDeg",from);
            String observed = now.optString("time", "");
            p(out,"directionToDeg",normalize(from + 180)); p(out,"observedAt",observed);
            double offsetSeconds = root.optDouble("utc_offset_seconds", Double.NaN);
            int offsetMinutes = Double.isFinite(offsetSeconds) ? (int) Math.round(offsetSeconds / 60d) : Integer.MIN_VALUE;
            String localDate = observed.length() >= 10 ? observed.substring(0, 10) : null;
            return new WindInfo(out, localDate, offsetMinutes);
        } catch (Exception ignored) { return null; }
    }

    private String httpsGet(String address, String method, String body, int connectTimeoutMs, int readTimeoutMs) throws IOException {
        return httpsGet(address, method, body, connectTimeoutMs, readTimeoutMs, null);
    }

    private String httpsGet(String address, String method, String body, int connectTimeoutMs, int readTimeoutMs, ProgressListener listener) throws IOException {
        checkInterrupted();
        HttpsURLConnection c = (HttpsURLConnection) new URL(address).openConnection();
        activeConnections.add(c);
        try {
            checkInterrupted();
            c.setConnectTimeout(connectTimeoutMs); c.setReadTimeout(readTimeoutMs); c.setUseCaches(false); c.setRequestMethod(method); c.setRequestProperty("User-Agent", USER_AGENT); c.setRequestProperty("Accept", "application/json"); c.setRequestProperty("Connection", "close");
            if (body != null) c.setRequestProperty("Content-Type", "application/x-www-form-urlencoded; charset=UTF-8");
            if (body != null) { byte[] bytes = body.getBytes(StandardCharsets.UTF_8); c.setDoOutput(true); c.setFixedLengthStreamingMode(bytes.length); try (java.io.OutputStream output = c.getOutputStream()) { output.write(bytes); } }
            int status = c.getResponseCode();
            if (status < 200 || status >= 300) {
                java.io.InputStream error = c.getErrorStream();
                String detail = error == null ? "" : readLimited(error, 8192);
                throw new HttpStatusException(status, detail, c.getHeaderField("Retry-After"));
            }
            long length = c.getContentLengthLong();
            int total = length > 0 && length <= Integer.MAX_VALUE ? (int) length : 0;
            return readLimited(c.getInputStream(), MAX_RESPONSE_BYTES, listener, total);
        } finally { activeConnections.remove(c); c.disconnect(); }
    }

    private static List<Building> parseBuildings(JSONObject raw, double centerLat, double centerLon) {
        JSONArray elements = raw.optJSONArray("elements"); if (elements == null) return Collections.emptyList();
        Map<Long, Coordinate> nodes = new HashMap<>(); Map<Long, JSONObject> ways = new HashMap<>(); List<JSONObject> relations = new ArrayList<>();
        for (int i=0;i<elements.length();i++) { JSONObject e=elements.optJSONObject(i); if(e==null)continue; String type=e.optString("type"); long id=e.optLong("id");
            if("node".equals(type)&&e.has("lat")&&e.has("lon")) nodes.put(id,new Coordinate(e.optDouble("lon"),e.optDouble("lat")));
            else if("way".equals(type)) ways.put(id,e); else if("relation".equals(type)) relations.add(e);
        }
        ArrayList<Building> out=new ArrayList<>(); Set<Long> memberWays=new HashSet<>(); Set<String> seen=new HashSet<>();
        for(JSONObject relation:relations) if(isBuilding(relation.optJSONObject("tags"))) {
            JSONArray ms=relation.optJSONArray("members"); if(ms!=null) for(int j=0;j<ms.length();j++){JSONObject m=ms.optJSONObject(j);if(m!=null&&"way".equals(m.optString("type")))memberWays.add(m.optLong("ref"));}
            addBuilding(out,seen,relationGeometry(relation,ways,nodes),relation.optJSONObject("tags"),"relation/"+relation.optLong("id"),centerLat,centerLon);
        }
        for(JSONObject way:ways.values()) if(isBuilding(way.optJSONObject("tags"))&&!memberWays.contains(way.optLong("id"))) addBuilding(out,seen,wayGeometry(way,nodes),way.optJSONObject("tags"),"way/"+way.optLong("id"),centerLat,centerLon);
        return out;
    }

    private static List<Building> parseBuildings(
        CityPackStore.PackSelection pack,
        double centerLat,
        double centerLon
    ) {
        ArrayList<Building> out = new ArrayList<>();
        Set<String> seen = new HashSet<>();
        for (CityPackStore.PackedFeature feature : pack.features) {
            checkInterrupted();
            JSONObject tags = new JSONObject();
            for (Map.Entry<String, String> entry : feature.tags.entrySet()) {
                p(tags, entry.getKey(), entry.getValue());
            }
            if (feature.name != null && !feature.name.trim().isEmpty() && !tags.has("name")) {
                p(tags, "name", feature.name.trim());
            }
            addBuilding(
                out,
                seen,
                feature.geometry,
                tags,
                feature.source,
                centerLat,
                centerLon
            );
        }
        return out;
    }

    private static boolean isBuilding(JSONObject tags) { return tags != null && (tags.has("building") || tags.has("building:part")); }
    private static Geometry wayGeometry(JSONObject way, Map<Long,Coordinate> nodes) { JSONArray ns=way.optJSONArray("nodes"); if(ns==null||ns.length()<4||ns.optLong(0)!=ns.optLong(ns.length()-1))return GF.createPolygon(); Coordinate[] c=new Coordinate[ns.length()];for(int i=0;i<c.length;i++){c[i]=nodes.get(ns.optLong(i));if(c[i]==null)return GF.createPolygon();}return validPolygon(GF.createPolygon(c)); }
    private static Geometry relationGeometry(JSONObject relation, Map<Long,JSONObject> ways, Map<Long,Coordinate> nodes) {
        List<Polygon> outer=memberPolygons(relation,ways,nodes,"", "outer"), inner=memberPolygons(relation,ways,nodes,"inner"); List<Geometry> assembled=new ArrayList<>();
        for(Polygon o:outer){List<LinearRing> holes=new ArrayList<>();for(Polygon h:inner)if(o.covers(h.getInteriorPoint()))holes.add((LinearRing)h.getExteriorRing().copy());assembled.add(validPolygon(GF.createPolygon((LinearRing)o.getExteriorRing().copy(),holes.toArray(new LinearRing[0]))));} return polygonal(safeUnion(assembled));
    }
    private static List<Polygon> memberPolygons(JSONObject relation,Map<Long,JSONObject> ways,Map<Long,Coordinate> nodes,String... roles){Set<String> allowed=new HashSet<>(Arrays.asList(roles));ArrayList<LineString> lines=new ArrayList<>();JSONArray ms=relation.optJSONArray("members");if(ms==null)return Collections.emptyList();for(int i=0;i<ms.length();i++){JSONObject m=ms.optJSONObject(i);if(m==null||!"way".equals(m.optString("type"))||!allowed.contains(m.optString("role")))continue;JSONObject w=ways.get(m.optLong("ref"));JSONArray ns=w==null?null:w.optJSONArray("nodes");if(ns==null||ns.length()<2)continue;Coordinate[] cs=new Coordinate[ns.length()];boolean ok=true;for(int j=0;j<cs.length;j++){cs[j]=nodes.get(ns.optLong(j));if(cs[j]==null)ok=false;}if(ok)lines.add(GF.createLineString(cs));} Polygonizer p=new Polygonizer();p.add(lines);ArrayList<Polygon> answer=new ArrayList<>();for(Object g:p.getPolygons())if(g instanceof Polygon&&g!=null&&!((Polygon)g).isEmpty())answer.add((Polygon)g);return answer;}
    private static void addBuilding(List<Building> out,Set<String> seen,Geometry geometry,JSONObject tags,String source,double lat,double lon){geometry=polygonal(geometry);if(geometry.isEmpty())return;String k=geometry.norm().toText();if(!seen.add(k))return;Height h=height(tags,geometry,lat,lon);out.add(new Building(geometry,h.height,h.minHeight,h.source,tags==null?"":tags.optString("name"),source,tags!=null&&tags.has("building:part")?"part":"building"));}

    static Height height(JSONObject tags, Geometry g, double lat, double lon) { double value=number(tags==null?null:tags.opt("height"));String src="height";if(!(value>0)){value=number(tags==null?null:tags.opt("building:levels"));if(value>0){value=Math.max(3,Math.min(120,value*3));src="levels";}else{String t=tags==null?"":tags.optString("building",tags.optString("building:part", ""));value=defaultHeight(t,project(g,new Projection(lat,lon)).getArea());src="default";}}value=Math.min(value,180);double min=minimumHeight(tags==null?null:tags.opt("min_height"),tags==null?null:tags.opt("building:min_level"));return new Height(value,Math.min(min,Math.max(0,value-.1)),src); }
    static double minimumHeight(Object rawHeight,Object rawLevels){double min=number(rawHeight);if(min>=0)return min;double levels=number(rawLevels);return levels>=0?levels*3:0;}
    static double number(Object value){if(value==null)return Double.NaN;java.util.regex.Matcher m=java.util.regex.Pattern.compile("-?\\d+(?:[.,]\\d+)?").matcher(String.valueOf(value));if(!m.find())return Double.NaN;double n=Double.parseDouble(m.group().replace(',','.'));if(n<0||!Double.isFinite(n))return Double.NaN;String s=String.valueOf(value).toLowerCase(Locale.US);return (s.contains("ft")||s.contains("feet")||s.contains("foot"))?n*.3048:n;}
    static double defaultHeight(String type,double area){if("garage".equals(type)||"garages".equals(type)||"shed".equals(type)||"kiosk".equals(type))return 3;if("house".equals(type))return 8;if("residential".equals(type))return 16;if("apartments".equals(type))return 24;if("commercial".equals(type))return 18;if("office".equals(type))return 22;if("retail".equals(type))return 14;if("church".equals(type))return 28;if("cathedral".equals(type))return 36;return area<80?3:area<250?4:area<700?6:area<1500?9:14;}

    private static List<FrameMeta> frameMetadata(SceneRequest r,String sceneId){ArrayList<FrameMeta>a=new ArrayList<>();int[] minutes=frameMinutes();for(int i=0;i<minutes.length;i++)a.add(frame(r,i,minutes[i]));return a;} static int[] frameMinutes(){int[] values=new int[49];for(int i=0;i<48;i++)values[i]=i*30;values[48]=1439;return values;} private static FrameMeta frame(SceneRequest r,int index,int minutes){OffsetDateTime when=r.at(minutes);double[] sun=sunPosition(when,r.latitude,r.longitude);return new FrameMeta(index,minutes,when.toString(),String.format(Locale.US,"%02d:%02d",minutes/60,minutes%60),sun[0],sun[1]);}
    static double[] sunPosition(OffsetDateTime date,double lat,double lon){double rad=Math.PI/180,julian=date.toInstant().toEpochMilli()/86400000d-.5+2440588,n=julian-2451545,ml=normalize(280.46+.9856474*n),ma=normalize(357.528+.9856003*n)*rad,el=(ml+1.915*Math.sin(ma)+.02*Math.sin(2*ma))*rad,ob=(23.439-.0000004*n)*rad,ra=Math.atan2(Math.cos(ob)*Math.sin(el),Math.cos(el)),dec=Math.asin(Math.sin(ob)*Math.sin(el)),gmst=normalize(280.46061837+360.98564736629*(julian-2451545))*rad,hour=gmst+lon*rad-ra,phi=lat*rad,alt=Math.asin(Math.sin(phi)*Math.sin(dec)+Math.cos(phi)*Math.cos(dec)*Math.cos(hour)),azi=Math.atan2(-Math.sin(hour),Math.tan(dec)*Math.cos(phi)-Math.sin(phi)*Math.cos(hour));return new double[]{Math.toDegrees(alt),normalize(Math.toDegrees(azi))};}
    static double normalize(double d){d%=360;return d<0?d+360:d;} static int closestFrame(int min){return min>=1425?48:(int)Math.round(min/30d);}
    private FramePayload renderFrame(SceneContext c,int index){checkInterrupted();FrameMeta f=c.frames.get(index);Geometry shadow=shadow(c.buildings,c.ground,c.clip,f.altitude,f.azimuth,c.projection);JSONObject geo=geometryJson(shadow);return new FramePayload(geo,polygons(shadow).size());}
    static Geometry shadow(List<ProjectedBuilding> b,Geometry ground,Geometry clip,double altitude,double azimuth,Projection p){if(altitude<=.5)return GF.createGeometryCollection();ArrayList<Geometry> pieces=new ArrayList<>();for(ProjectedBuilding x:b){checkInterrupted();double tangent=Math.tan(Math.toRadians(altitude)),top=Math.min(x.heightM/tangent,MAX_SHADOW_M),base=Math.min(Math.max(0,x.minHeightM)/tangent,top);pieces.addAll(sweep(x.geometry,bearing(top,normalize(azimuth+180)),bearing(base,normalize(azimuth+180))));}Geometry out=safeDifference(safeUnion(pieces),ground);if(clip!=null)out=safeIntersection(out,clip);out=TopologyPreservingSimplifier.simplify(out,.15);ArrayList<Geometry> keep=new ArrayList<>();for(Polygon poly:polygons(out))if(poly.getArea()>=.2)keep.add(poly);return polygonal(unproject(safeUnion(keep),p));}
    static List<Geometry> sweep(Geometry g,Coordinate top,Coordinate base){ArrayList<Geometry> out=new ArrayList<>();for(Polygon p:polygons(g)){Geometry bottom=translated(p,base),upper=translated(p,top);out.add(bottom);out.add(upper);for(int r=-1;r<p.getNumInteriorRing();r++){LineString ring=r<0?p.getExteriorRing():p.getInteriorRingN(r);Coordinate[] cs=ring.getCoordinates();for(int i=1;i<cs.length;i++)out.add(validPolygon(GF.createPolygon(new Coordinate[]{new Coordinate(cs[i-1].x+base.x,cs[i-1].y+base.y),new Coordinate(cs[i].x+base.x,cs[i].y+base.y),new Coordinate(cs[i].x+top.x,cs[i].y+top.y),new Coordinate(cs[i-1].x+top.x,cs[i-1].y+top.y),new Coordinate(cs[i-1].x+base.x,cs[i-1].y+base.y)})));}}return out;}private static Geometry translated(Geometry g,Coordinate delta){Geometry copy=g.copy();copy.apply(new org.locationtech.jts.geom.CoordinateFilter(){@Override public void filter(Coordinate c){c.x+=delta.x;c.y+=delta.y;}});copy.geometryChanged();return copy;}
    static Coordinate bearing(double d,double bearing){double a=Math.toRadians(bearing);return new Coordinate(d*Math.sin(a),d*Math.cos(a));}

    private static JSONObject bundle(SceneRequest r,SceneContext c,List<Building>b,int initial,boolean cacheHit,String dataSource,JSONObject wind){JSONObject root=new JSONObject();p(root,"schemaVersion",1);p(root,"sceneId",c.sceneId);p(root,"cacheHit",cacheHit);JSONObject region=c.display.mapRegion(c.sceneId,r.name,r.latitude,r.longitude);p(root,"region",region);p(root,"buildings",buildingFeatures(b));JSONObject layers=new JSONObject(),shadows=new JSONObject();p(shadows,"initialFrameIndex",initial);p(shadows,"localDate",r.localDate);p(shadows,"timezoneOffsetMinutes",r.timezoneOffsetMinutes);JSONArray fs=new JSONArray();for(FrameMeta f:c.frames)a(fs,f.json());p(shadows,"frames",fs);p(layers,"shadows",shadows);if(wind!=null)p(layers,"wind",wind);p(root,"layers",layers);p(root,"source",dataSource);return root;}
    private static List<Building> visibleBuildings(List<Building> source,Bbox display){Geometry bounds=GF.toGeometry(new Envelope(display.west,display.east,display.south,display.north));ArrayList<Building> visible=new ArrayList<>();for(Building b:source)if(b.geometry.intersects(bounds))visible.add(b);return visible;}private static JSONObject buildingFeatures(List<Building>b){JSONArray fs=new JSONArray();for(Building x:b){JSONObject f=new JSONObject();p(f,"type","Feature");JSONObject properties=new JSONObject();p(properties,"height",x.heightM);p(properties,"min_height",x.minHeightM);p(properties,"height_source",x.heightSource);p(properties,"name",x.name);p(properties,"osm_source",x.source);p(properties,"kind",x.kind);p(f,"properties",properties);p(f,"geometry",geometryJson(x.geometry));a(fs,f);}JSONObject c=new JSONObject();p(c,"type","FeatureCollection");p(c,"features",fs);return c;}
    private static JSONObject emptyGeoJson(){JSONObject o=new JSONObject();p(o,"type","GeometryCollection");p(o,"geometries",new JSONArray());return o;}
    private static JSONObject geometryJson(Geometry g){JSONObject o=new JSONObject();if(g==null||g.isEmpty())return emptyGeoJson();if(g instanceof Polygon){p(o,"type","Polygon");p(o,"coordinates",polygonCoords((Polygon)g));}else if(g instanceof MultiPolygon){p(o,"type","MultiPolygon");JSONArray a=new JSONArray();for(int i=0;i<g.getNumGeometries();i++)a(a,polygonCoords((Polygon)g.getGeometryN(i)));p(o,"coordinates",a);}else{p(o,"type","GeometryCollection");p(o,"geometries",new JSONArray());}return o;}
    private static JSONArray polygonCoords(Polygon p){JSONArray a=new JSONArray();a(a,coords(p.getExteriorRing().getCoordinates()));for(int i=0;i<p.getNumInteriorRing();i++)a(a,coords(p.getInteriorRingN(i).getCoordinates()));return a;}private static JSONArray coords(Coordinate[] cs){JSONArray a=new JSONArray();for(Coordinate c:cs){JSONArray point=new JSONArray();a(point,round(c.x));a(point,round(c.y));a(a,point);}return a;}private static double round(double x){return Math.rint(x*1e7)/1e7;}

    static Geometry validPolygon(Geometry g){try{if(g==null||g.isEmpty())return GF.createPolygon();Geometry fixed=g.isValid()?g:GeometryFixer.fix(g);if(!fixed.isValid())fixed=fixed.buffer(0);return polygonal(fixed);}catch(RuntimeException e){try{return polygonal(g.buffer(0));}catch(RuntimeException ignored){return GF.createPolygon();}}}static Geometry polygonal(Geometry g){if(g==null||g.isEmpty())return GF.createGeometryCollection();List<Polygon>p=polygons(g);return p.isEmpty()?GF.createGeometryCollection():p.size()==1?p.get(0):GF.createMultiPolygon(p.toArray(new Polygon[0]));}static List<Polygon> polygons(Geometry g){ArrayList<Polygon>o=new ArrayList<>();if(g instanceof Polygon){if(g.getArea()>0)o.add((Polygon)g);}else if(g!=null)for(int i=0;i<g.getNumGeometries();i++)o.addAll(polygons(g.getGeometryN(i)));return o;}static Geometry safeUnion(Collection<? extends Geometry> c){if(c==null||c.isEmpty())return GF.createGeometryCollection();try{return validPolygon(UnaryUnionOp.union(c));}catch(RuntimeException e){ArrayList<Geometry>a=new ArrayList<>();for(Geometry g:c)a.add(validPolygon(g));try{return validPolygon(UnaryUnionOp.union(a));}catch(RuntimeException ignored){return GF.createGeometryCollection();}}}static Geometry safeDifference(Geometry a,Geometry b){try{return validPolygon(a.difference(b));}catch(RuntimeException e){return validPolygon(GeometryFixer.fix(a).difference(GeometryFixer.fix(b)));}}static Geometry safeIntersection(Geometry a,Geometry b){try{return validPolygon(a.intersection(b));}catch(RuntimeException e){return validPolygon(GeometryFixer.fix(a).intersection(GeometryFixer.fix(b)));}}
    static Geometry project(Geometry g,Projection p){return transform(g,p,true);}static Geometry unproject(Geometry g,Projection p){return transform(g,p,false);}private static Geometry transform(Geometry g,Projection p,boolean project){Geometry copy=g.copy();copy.apply(new org.locationtech.jts.geom.CoordinateFilter(){@Override public void filter(Coordinate c){double x=c.x,y=c.y;if(project){c.x=p.x(x);c.y=p.y(y);}else{c.x=p.lon(x);c.y=p.lat(y);}}});copy.geometryChanged();return copy;}
    static final class Projection {final double lat,lon,latScale,lonScale;Projection(double lat,double lon){this.lat=lat;this.lon=lon;latScale=Math.PI*EARTH_RADIUS_M/180;lonScale=latScale*Math.max(1e-6,Math.cos(Math.toRadians(lat)));}double x(double lon){return(lon-this.lon)*lonScale;}double y(double lat){return(lat-this.lat)*latScale;}double lon(double x){return lon+x/lonScale;}double lat(double y){return lat+y/latScale;}}
    static boolean rawCacheCovers(JSONObject raw, Bbox required) { JSONObject q=raw==null?null:raw.optJSONObject("queryBounds"); return q!=null&&bboxCovers(new Bbox(q.optDouble("south",Double.NaN),q.optDouble("west",Double.NaN),q.optDouble("north",Double.NaN),q.optDouble("east",Double.NaN)),required); }
    static boolean bboxCovers(Bbox cached, Bbox required) { return Double.isFinite(cached.south)&&Double.isFinite(cached.west)&&Double.isFinite(cached.north)&&Double.isFinite(cached.east)&&cached.south<=required.south&&cached.west<=required.west&&cached.north>=required.north&&cached.east>=required.east; }
    static boolean isRetryableOverpassStatus(int status) { return status == 429 || status == 502 || status == 503 || status == 504; }
    static boolean isTerminalOverpassStatus(int status) { return status == 400 || status == 401 || status == 403 || status == 404 || status == 413; }
    static boolean isOversizedResponse(IOException error) { return error != null && error.getMessage() != null && error.getMessage().startsWith("Response exceeds "); }
    static String readUtf8Limited(java.io.InputStream input, int maxBytes) throws IOException {
        if (input == null) throw new IllegalArgumentException("input is required");
        if (maxBytes < 1) throw new IllegalArgumentException("maxBytes must be positive");
        java.io.ByteArrayOutputStream output = new java.io.ByteArrayOutputStream(Math.min(maxBytes, 8192));
        byte[] buffer = new byte[8192];
        int total = 0;
        for (int count; (count = input.read(buffer)) != -1;) {
            checkInterrupted();
            total += count;
            if (total > maxBytes) throw new IOException("Файл GeoJSON превышает допустимый размер");
            output.write(buffer, 0, count);
        }
        try {
            return StandardCharsets.UTF_8.newDecoder()
                .onMalformedInput(CodingErrorAction.REPORT)
                .onUnmappableCharacter(CodingErrorAction.REPORT)
                .decode(java.nio.ByteBuffer.wrap(output.toByteArray()))
                .toString();
        } catch (java.nio.charset.CharacterCodingException error) {
            throw new IOException("Файл GeoJSON должен быть в кодировке UTF-8", error);
        }
    }
    static void pruneDirectory(File directory, long quotaBytes) { pruneDirectory(directory, quotaBytes, Collections.<File>emptySet()); }
    static void pruneDirectory(File directory, long quotaBytes, Set<File> pinned) { if(directory==null)return;File[] all=directory.listFiles(File::isFile);if(all==null)return;long staleBefore=System.currentTimeMillis()-STALE_TEMP_MS;for(File file:all)if(file.getName().endsWith(".tmp")&&file.lastModified()<staleBefore)file.delete();File[] candidates=directory.listFiles(file -> file.isFile() && !file.getName().endsWith(".tmp"));if(candidates==null)return;long size=0;for(File file:candidates)size+=Math.max(0,file.length());if(size<=quotaBytes)return;Arrays.sort(candidates,Comparator.comparingLong(File::lastModified));for(File file:candidates){if(size<=quotaBytes)break;if(pinned!=null&&pinned.contains(file))continue;long length=Math.max(0,file.length());if(file.delete())size-=length;} }
    private static File requireDirectory(File f,String n){if(f==null)throw new IllegalArgumentException(n+" is required");if(!f.exists()&&!f.mkdirs())throw new IllegalArgumentException("Cannot create "+n);if(!f.isDirectory())throw new IllegalArgumentException(n+" is not a directory");return f;}private static void writeAtomic(File f,String text)throws IOException{File t=new File(f.getParentFile(),f.getName()+".tmp");try(FileOutputStream o=new FileOutputStream(t)){o.write(text.getBytes(StandardCharsets.UTF_8));o.getFD().sync();}if(!t.renameTo(f)){if(!f.delete()||!t.renameTo(f))throw new IOException("Cannot atomically replace "+f);}}private static void writeAtomicLimited(File f,String text,int maxBytes)throws IOException{byte[]bytes=text.getBytes(StandardCharsets.UTF_8);if(bytes.length>maxBytes)throw new ViewportException("TOO_DENSE","Viewport tile JSON exceeds the "+maxBytes+" byte safety limit");File t=new File(f.getParentFile(),f.getName()+".tmp");try(FileOutputStream o=new FileOutputStream(t)){o.write(bytes);o.getFD().sync();}if(!t.renameTo(f)){if(!f.delete()||!t.renameTo(f))throw new IOException("Cannot atomically replace "+f);}}private static JSONObject readJson(File f){return readJson(f,MAX_RESPONSE_BYTES);}private static JSONObject readJson(File f,int max){try{return f.isFile()?new JSONObject(readText(f,max)):null;}catch(Exception e){return null;}}private static String readText(File f,int max)throws IOException{try(FileInputStream i=new FileInputStream(f)){return readLimited(i,max);}}private static String readLimited(java.io.InputStream in,int max)throws IOException{BufferedInputStream b=new BufferedInputStream(in);byte[] buf=new byte[8192];int n,total=0;java.io.ByteArrayOutputStream out=new java.io.ByteArrayOutputStream();while((n=b.read(buf))!=-1){checkInterrupted();total+=n;if(total>max)throw new IOException("Response exceeds "+max+" bytes");out.write(buf,0,n);}return out.toString("UTF-8");}private static String readLimited(java.io.InputStream in,int max,ProgressListener listener,int expectedTotal)throws IOException{BufferedInputStream b=new BufferedInputStream(in);byte[] buf=new byte[8192];int n,total=0,next=0;java.io.ByteArrayOutputStream out=new java.io.ByteArrayOutputStream();progress(listener,"download-bytes",0,expectedTotal);while((n=b.read(buf))!=-1){checkInterrupted();total+=n;if(total>max)throw new IOException("Response exceeds "+max+" bytes");out.write(buf,0,n);if(total>=next){progress(listener,"download-bytes",total,expectedTotal);next=total+256*1024;}}progress(listener,"download-bytes",total,expectedTotal);return out.toString("UTF-8");}private static JSONObject p(JSONObject o,String key,Object value){try{o.put(key,value);return o;}catch(Exception e){throw new IllegalStateException("JSON write failed",e);}}private static JSONArray a(JSONArray array,Object value){try{array.put(value);return array;}catch(Exception e){throw new IllegalStateException("JSON write failed",e);}}static String cacheKey(double latitude,double longitude,int radiusM){long latGrid=(long)Math.floor((latitude+90d)*(Math.PI*EARTH_RADIUS_M/180d)/125d);double lonMeters=(longitude+180d)*(Math.PI*EARTH_RADIUS_M/180d)*Math.max(1e-6,Math.cos(Math.toRadians(latitude)));long lonGrid=(long)Math.floor(lonMeters/125d);return latGrid+"-"+lonGrid+"-"+radiusM;}private static String cacheKey(SceneRequest r,Bbox b){return cacheKey(r.latitude,r.longitude,r.radiusM);}static String sceneIdFor(double latitude,double longitude,int radiusM,String localDate,int utcOffsetMinutes,int selectedMinutes,String source,String revision){return "s-"+shortHash("v"+SCENE_ID_VERSION+"|"+String.format(Locale.US,"%.7f|%.7f|%d|",latitude,longitude,radiusM)+localDate+"|"+utcOffsetMinutes+"|"+selectedMinutes+"|"+source+"|"+revision);}private static String shortHash(String value){try{byte[]d=MessageDigest.getInstance("SHA-256").digest(value.getBytes(StandardCharsets.UTF_8));StringBuilder s=new StringBuilder();for(int i=0;i<8;i++)s.append(String.format(Locale.US,"%02x",d[i]));return s.toString();}catch(Exception e){throw new IllegalStateException(e);}}static boolean ownsViewportFeature(ViewportTile tile,Geometry geometry){if(tile==null||geometry==null||geometry.isEmpty())return false;tile.validate();Geometry representative=geometry.getInteriorPoint();Coordinate point=representative==null?null:representative.getCoordinate();if(point==null||!Double.isFinite(point.x)||!Double.isFinite(point.y))return false;int width=1<<tile.z;double xFraction=(point.x+180d)/360d;double tan=Math.tan(Math.toRadians(point.y));double yFraction=(1d-Math.log(tan+Math.sqrt(tan*tan+1d))/Math.PI)/2d;if(!Double.isFinite(xFraction)||!Double.isFinite(yFraction)||xFraction<0d||xFraction>1d||yFraction<0d||yFraction>1d)return false;int ownerX=Math.min(width-1,(int)Math.floor(xFraction*width));int ownerY=Math.min(width-1,(int)Math.floor(yFraction*width));return tile.x==ownerX&&tile.y==ownerY;}static Bbox tileBounds(int z,int x,int y){ViewportTile tile=new ViewportTile(z,x,y);tile.validate();double n=1L<<z;double west=x/n*360d-180d,east=(x+1d)/n*360d-180d;double north=Math.toDegrees(Math.atan(Math.sinh(Math.PI*(1d-2d*y/n))));double south=Math.toDegrees(Math.atan(Math.sinh(Math.PI*(1d-2d*(y+1d)/n))));return new Bbox(south,west,north,east);}static String viewportCacheFileName(String revision,ViewportTile tile){tile.validate();String safe=(revision==null?"unknown":revision).replaceAll("[^A-Za-z0-9._-]","_");if(safe.length()>96)safe=safe.substring(0,72)+"-"+shortHash(revision);return "viewport-v"+VIEWPORT_FORMAT_VERSION+"-r"+safe+"-"+tile.id().replace('/','-')+".json";}private static boolean isViewportCache(JSONObject root,String revision,ViewportTile tile){if(root==null||root.optInt("schemaVersion",-1)!=VIEWPORT_FORMAT_VERSION)return false;JSONObject cachedTile=root.optJSONObject("tile"),pack=root.optJSONObject("pack");return cachedTile!=null&&pack!=null&&tile.id().equals(cachedTile.optString("id"))&&revision.equals(pack.optString("revision"));}private static String frameKey(String scene,int index){return scene+":"+index;}private static String messageOf(Throwable error){String text=error==null?"":error.getMessage();return text==null||text.trim().isEmpty()?error.getClass().getSimpleName():text;}private static void progress(ProgressListener l,String stage,int now,int total){if(l!=null)l.onProgress(stage,now,total);}private static void checkInterrupted(){if(Thread.currentThread().isInterrupted())throw new CancelledException();}

    public interface ProgressListener { void onProgress(String stage, int current, int total); }
    public static final class ViewportRequest {
        public final String requestId;
        public final List<ViewportTile> tiles;
        private ViewportRequest(String requestId, List<ViewportTile> tiles) { this.requestId=requestId; this.tiles=Collections.unmodifiableList(tiles); }
        public static ViewportRequest fromJson(String json) {
            try {
                JSONObject root=new JSONObject(json); String requestId=root.optString("requestId","");
                if(requestId.trim().isEmpty()||requestId.length()>160)throw new IllegalArgumentException("requestId must be non-empty and at most 160 characters");
                JSONArray input=root.getJSONArray("tiles"); if(input.length()<1||input.length()>96)throw new IllegalArgumentException("Viewport request requires 1..96 tiles");
                LinkedHashMap<String,ViewportTile> unique=new LinkedHashMap<>();
                for(int i=0;i<input.length();i++){JSONObject value=input.getJSONObject(i);ViewportTile tile=new ViewportTile(value.getInt("z"),value.getInt("x"),value.getInt("y"));tile.validate();unique.put(tile.id(),tile);}
                if(unique.isEmpty()||unique.size()>96)throw new IllegalArgumentException("Viewport request requires 1..96 unique tiles");
                return new ViewportRequest(requestId,new ArrayList<ViewportTile>(unique.values()));
            } catch (IllegalArgumentException error) { throw error; }
            catch (Exception error) { throw new IllegalArgumentException("Invalid viewport request JSON",error); }
        }
    }
    public static final class ViewportTile {
        public final int z,x,y;
        public ViewportTile(int z,int x,int y){this.z=z;this.x=x;this.y=y;}
        public void validate(){if(z<15||z>18)throw new IllegalArgumentException("Viewport tile z must be 15..18");int width=1<<z;if(x<0||x>=width||y<0||y>=width)throw new IllegalArgumentException("Viewport tile coordinates are not canonical");}
        public String id(){return z+"/"+x+"/"+y;}
    }
    public static final class ViewportTileBuildResult {
        public final String tileId,file; public final boolean cacheHit;
        ViewportTileBuildResult(String tileId,String file,boolean cacheHit){this.tileId=tileId;this.file=file;this.cacheHit=cacheHit;}
    }
    public static final class ViewportException extends IOException {
        public final String code;
        ViewportException(String code,String message){super(message);this.code=code;}
    }
    public static final class SceneRequest {public final String requestId,name,localDate;public final double latitude,longitude;public final int radiusM,timezoneOffsetMinutes,selectedMinutes;SceneRequest(String id,double lat,double lon,int radius,String date,int offset,int selected,String name){requestId=id;latitude=lat;longitude=lon;radiusM=radius;localDate=date;timezoneOffsetMinutes=offset;selectedMinutes=selected;this.name=name;}public static SceneRequest fromJson(String json){try{JSONObject o=new JSONObject(json);SceneRequest r=new SceneRequest(o.optString("requestId",""),o.getDouble("latitude"),o.getDouble("longitude"),o.getInt("radiusM"),o.getString("localDate"),o.getInt("timezoneOffsetMinutes"),o.getInt("selectedMinutes"),o.optString("name",""));r.validate();return r;}catch(org.json.JSONException e){throw new IllegalArgumentException("Invalid scene request JSON",e);}}void validate(){if(!Double.isFinite(latitude)||!Double.isFinite(longitude)||latitude<-90||latitude>90||longitude<-180||longitude>180)throw new IllegalArgumentException("Invalid coordinates");if(radiusM<150||radiusM>550)throw new IllegalArgumentException("radiusM must be 150..550");if(timezoneOffsetMinutes<-720||timezoneOffsetMinutes>840)throw new IllegalArgumentException("Invalid timezone offset");if(selectedMinutes<0||selectedMinutes>1439)throw new IllegalArgumentException("Invalid selectedMinutes");if(name.length()>120)throw new IllegalArgumentException("name too long");try{LocalDate.parse(localDate);}catch(Exception e){throw new IllegalArgumentException("localDate must be YYYY-MM-DD",e);}}OffsetDateTime at(int minutes){return LocalDate.parse(localDate).atStartOfDay().atOffset(ZoneOffset.ofTotalSeconds(timezoneOffsetMinutes*60)).plusMinutes(minutes);}}
    public static final class SceneBuildResult {public final String sceneId,file;public final int initialFrameIndex,buildingCount;public final boolean cacheHit;SceneBuildResult(String s,String f,int i,boolean h,int n){sceneId=s;file=f;initialFrameIndex=i;cacheHit=h;buildingCount=n;}}
    static final class HttpStatusException extends IOException {final int statusCode;final String body,retryAfter;HttpStatusException(int code,String detail,String retry){super("HTTP "+code);statusCode=code;body=detail==null?"":detail;retryAfter=retry;}String describe(){String compact=body.replaceAll("\\s+"," ").trim();if(compact.length()>512)compact=compact.substring(0,512);return (compact.isEmpty()?"HTTP "+statusCode:compact)+(retryAfter==null||retryAfter.trim().isEmpty()?"":"; Retry-After="+retryAfter.trim());}}
    public static final class FrameBuildResult {public final String sceneId,file;public final int frameIndex;public final boolean cacheHit;FrameBuildResult(String s,int i,String f,boolean h){sceneId=s;frameIndex=i;file=f;cacheHit=h;}}
    static final class PinnedLruCache<V> {
        private final int candidateLimit;
        private final LinkedHashMap<String,V> values = new LinkedHashMap<String,V>(4,.75f,true);
        private String acceptedId;
        PinnedLruCache(int candidateLimit){if(candidateLimit<0)throw new IllegalArgumentException("candidateLimit must be non-negative");this.candidateLimit=candidateLimit;}
        synchronized V get(String id){return values.get(id);}
        synchronized void putCandidate(String id,V value){values.put(id,value);trim();}
        synchronized boolean accept(String id){if(!values.containsKey(id))return false;acceptedId=id;values.get(id);trim();return true;}
        synchronized void clear(){values.clear();acceptedId=null;}
        synchronized int size(){return values.size();}
        synchronized boolean contains(String id){return values.containsKey(id);}
        private void trim(){int allowed=candidateLimit+(acceptedId==null?0:1);while(values.size()>allowed){String victim=null;for(String id:values.keySet())if(!id.equals(acceptedId)){victim=id;break;}if(victim==null)return;values.remove(victim);}}
    }
    static final class Height {final double height,minHeight;final String source;Height(double h,double m,String s){height=h;minHeight=m;source=s;}}static final class Building {final Geometry geometry;final double heightM,minHeightM;final String heightSource,name,source,kind;Building(Geometry g,double h,double m,String hs,String n,String s,String k){geometry=g;heightM=h;minHeightM=m;heightSource=hs;name=n;source=s;kind=k;}}static final class ProjectedBuilding {final Geometry geometry;final double heightM,minHeightM;ProjectedBuilding(Geometry g,double h,double m){geometry=g;heightM=h;minHeightM=m;}}static final class SceneContext {final String sceneId;final Projection projection;final List<ProjectedBuilding>buildings;final Geometry ground,clip;final List<FrameMeta>frames;final Bbox display;SceneContext(String i,Projection p,List<ProjectedBuilding>b,Geometry g,Geometry c,List<FrameMeta>f,Bbox d){sceneId=i;projection=p;buildings=b;ground=g;clip=c;frames=f;display=d;}}static final class FrameMeta {final int index,minutes;final String time,label;final double altitude,azimuth;boolean computed;JSONObject geometry;int polygonCount;FrameMeta(int i,int m,String t,String l,double a,double z){index=i;minutes=m;time=t;label=l;altitude=a;azimuth=z;}JSONObject json(){JSONObject o=new JSONObject();p(o,"time",time);p(o,"label",label);p(o,"altitude",round(altitude));p(o,"azimuth",round(azimuth));p(o,"shadow_bearing",round(normalize(azimuth+180)));p(o,"computed",computed);p(o,"geometry",geometry==null?JSONObject.NULL:geometry);p(o,"polygon_count",polygonCount);return o;}}static final class FramePayload {final JSONObject geometry;final int polygonCount;FramePayload(JSONObject g,int p){geometry=g;polygonCount=p;}}static final class WindInfo {final JSONObject layer;final String localDate;final int utcOffsetMinutes;WindInfo(JSONObject value,String date,int offset){layer=value;localDate=date;utcOffsetMinutes=offset;}}static final class Bbox {final double south,west,north,east;Bbox(double s,double w,double n,double e){south=s;west=w;north=n;east=e;}static Bbox around(double lat,double lon,double r){Projection p=new Projection(lat,lon);return new Bbox(lat-r/p.latScale,lon-r/p.lonScale,lat+r/p.latScale,lon+r/p.lonScale);}Bbox expand(double m){double lat=(south+north)/2;Projection p=new Projection(lat,(west+east)/2);return new Bbox(south-m/p.latScale,west-m/p.lonScale,north+m/p.latScale,east+m/p.lonScale);}JSONObject json(){JSONObject o=new JSONObject();p(o,"south",south);p(o,"west",west);p(o,"north",north);p(o,"east",east);return o;}JSONObject mapRegion(String id,String name,double lat,double lon){JSONObject o=new JSONObject();p(o,"id",id);p(o,"name",name==null||name.trim().isEmpty()?"Выбранный район":name.trim());JSONArray center=new JSONArray();a(center,lon);a(center,lat);p(o,"center",center);JSONArray bounds=new JSONArray();JSONArray sw=new JSONArray();a(sw,west);a(sw,south);JSONArray ne=new JSONArray();a(ne,east);a(bounds,sw);a(bounds,ne);p(o,"bounds",bounds);return o;}}static final class CancelledException extends RuntimeException {CancelledException(){super("Scene calculation cancelled");}}
}
