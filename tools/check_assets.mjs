import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const assets = path.join(root, "app", "src", "main", "assets");
const htmlPath = path.join(assets, "index.html");
const dataPath = path.join(assets, "map-data.js");
const activityPath = path.join(root, "app", "src", "main", "java", "app", "sloi", "map", "MainActivity.java");
const cityPackStorePath = path.join(root, "app", "src", "main", "java", "app", "sloi", "map", "CityPackStore.java");
const manifestPath = path.join(root, "app", "src", "main", "AndroidManifest.xml");
const html = fs.readFileSync(htmlPath, "utf8");
const appSource = fs.readFileSync(path.join(assets, "app.js"), "utf8");
const webSource = html + "\n" + appSource;
const dataSource = fs.readFileSync(dataPath, "utf8");
const activitySource = fs.readFileSync(activityPath, "utf8");
const cityPackStoreSource = fs.readFileSync(cityPackStorePath, "utf8");
const manifestSource = fs.readFileSync(manifestPath, "utf8");

const context = { window: {} };
vm.createContext(context);
new vm.Script(dataSource, { filename: "map-data.js" }).runInContext(context);

const data = context.window.SLOI_MAP_DATA;
if (!data || data.buildings?.type !== "FeatureCollection") {
  throw new Error("Map data does not contain a building FeatureCollection");
}
if (data.buildings.features.length < 100) {
  throw new Error("Map data contains too few buildings");
}
if (!Array.isArray(data.shadeFrames) || data.shadeFrames.length < 24) {
  throw new Error("Map data does not contain a full-day timeline");
}
if (!data.shadeFrames.some((frame) => frame.geometry)) {
  throw new Error("All shadow frames are empty");
}

for (const source of html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)) {
  if (source[1].trim()) {
    new vm.Script(source[1], { filename: "index.html:inline" });
  }
}

const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index);
if (duplicates.length) {
  throw new Error(`Duplicate HTML ids: ${[...new Set(duplicates)].join(", ")}`);
}

for (const relative of [
  "vendor/maplibre-gl.css",
  "vendor/maplibre-gl.js",
  "map-data.js",
  "map-camera.js",
  "map-gestures.js",
  "shadow-viewport.js",
  "basemap.js",
  "basemap-recovery.js",
  "offline-basemap.js",
  "search-controller.js",
  "place-names.js",
  "module-host.js",
  "extension-storage.js",
  "transport-symbols.js",
  "vehicle-markers.js",
  "modules/bundled.js",
  "modules/live-transport.js",
  "modules/metro.js",
  "modules/metro-spb.json",
  "modules/bus-stops.js",
  "modules/bus-stops-spb.json",
  "transport-presets.js",
  "transport-ui.js",
  "transport.css",
  "modules/native-shadows.js",
  "modules/routing.js",
  "routing-ui.js",
  "animated-disclosure.js",
  "layer-settings.js",
  "layer-runtime.js",
  "layer-library.js",
  "app.js",
  "app.css",
]) {
  if (!fs.existsSync(path.join(assets, relative))) {
    throw new Error(`Missing asset: ${relative}`);
  }
  if (relative.endsWith(".js")) {
    new vm.Script(fs.readFileSync(path.join(assets, relative), "utf8"), { filename: relative });
    if (relative !== "map-data.js" && !html.includes(`src="${relative}"`)) {
      throw new Error(`Required runtime script is not loaded by index.html: ${relative}`);
    }
  }
}

for (const marker of [
  'id="place-form"',
  'id="my-location"',
  "AndroidHost",
  "на устройстве",
  'androidHost("requestScene")',
  "window.AndroidHost.searchPlaces(JSON.stringify(",
  "window.SloiSearch.create(",
  "function loadViewportScene(",
  "displayBounds,",
  'id="offline-basemap"',
  'id="city-pack-list"',
  'androidHost("listCityPacks")',
  'androidHost("downloadCityPack")',
  'androidHost("cancelCityPack")',
  'androidHost("deleteCityPack")',
  "onCityPackProgress",
  "onCityPackChanged",
]) {
  if (!webSource.includes(marker)) {
    throw new Error(`Missing on-device map contract marker: ${marker}`);
  }
}

for (const marker of [
  'androidHost("requestViewportBuildings").requestViewportBuildings',
  'androidHost("cancelViewportBuildings").cancelViewportBuildings',
  "onViewportTileReady(requestId, tileId, url)",
  "onViewportTileError(requestId, tileId, code, message)",
  "onViewportBatchComplete(requestId)",
  "onViewportInvalidated()",
  "function desiredViewportTiles(bounds, packBounds, z)",
  "function parseViewportTileId(tileId)",
  "function viewportTileCenterDistance(tile, center)",
  "const viewportMaxTiles = 96",
  'const viewportInsertBeforeLayer = "wind-line"',
  "filter((tile) => !viewport.loaded.has(tile.id))",
  ".sort((left, right) => viewportTileCenterDistance(left, center)",
  "}, viewportInsertBeforeLayer);",
  "revision: typeof record.revision === \"string\" && record.revision ? record.revision : null",
  "Приблизьте карту для 3D-зданий",
  "function readViewportJson(url)",
  'readLocalJson(url, "/viewport/", "viewport-тайлу",',
  'map.on("moveend", scheduleViewportTiles)',
  "elements.dataStatus.textContent = sceneDataStatus",
]) {
  if (!webSource.includes(marker)) {
    throw new Error(`Missing viewport streaming contract marker: ${marker}`);
  }
}

if (!/zoom:\s*Math\.min\(map\.getMaxZoom\(\),\s*Math\.max\(14\.5,\s*camera\.zoom\)\)/.test(webSource)) {
  throw new Error("3D fitRegion no longer preserves the minimum building zoom");
}

if (!/responsePack\.revision !== viewport\.packRevision/.test(webSource)
  || !/viewport\.desired\.has\(expectedTile\.id\)/.test(webSource)) {
  throw new Error("Viewport tile responses are not guarded by revision and desired-set checks");
}

for (const obsolete of [
  'id="api-base"',
  "function apiBase(",
  "/v1/scenes",
  "/v1/jobs/",
  "/v1/places",
  "Адрес сервера движка",
]) {
  if (webSource.includes(obsolete)) {
    throw new Error(`Obsolete backend map contract marker: ${obsolete}`);
  }
}

if (!activitySource.includes("WebViewAssetLoader")
  || !activitySource.includes("https://appassets.androidplatform.net")
  || !activitySource.includes("OnDeviceSceneEngine")
  || !activitySource.includes('new AndroidBridge()')
  || activitySource.includes("setAllowUniversalAccessFromFileURLs(true)")) {
  throw new Error("Android runtime is missing the secure on-device scene bridge");
}

for (const marker of [
  "CityPackStore",
  "void listCityPacks()",
  "void downloadCityPack(String id)",
  "void cancelCityPack(String id)",
  "void deleteCityPack(String id)",
  "onCityPackProgress",
  "onCityPackChanged",
]) {
  if (!activitySource.includes(marker)) {
    throw new Error(`Android bridge is missing city-pack marker: ${marker}`);
  }
}

for (const marker of [
  "SanktPetersburg.osm.geopackage.zip",
  "KNOWN_DOWNLOAD_BYTES = 96_097_314L",
  "KNOWN_INSTALLED_BYTES = 248_946_688L",
  "sloi_city_rtree",
  "SQLiteDatabase",
]) {
  if (!cityPackStoreSource.includes(marker)) {
    throw new Error(`City-pack store is missing required marker: ${marker}`);
  }
}

if (!manifestSource.includes("android.permission.ACCESS_COARSE_LOCATION")
  || !manifestSource.includes("android.permission.ACCESS_FINE_LOCATION")) {
  throw new Error("Android manifest is missing the precise/approximate location choice");
}

console.log(
  `Assets OK: ${data.buildings.features.length} buildings, ` +
    `${data.shadeFrames.length} shadow frames, ${ids.length} unique ids`,
);
