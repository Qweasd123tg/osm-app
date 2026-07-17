import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const assets = path.join(root, "app", "src", "main", "assets");
const htmlPath = path.join(assets, "index.html");
const dataPath = path.join(assets, "map-data.js");
const html = fs.readFileSync(htmlPath, "utf8");
const dataSource = fs.readFileSync(dataPath, "utf8");

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
]) {
  if (!fs.existsSync(path.join(assets, relative))) {
    throw new Error(`Missing asset: ${relative}`);
  }
}

console.log(
  `Assets OK: ${data.buildings.features.length} buildings, ` +
    `${data.shadeFrames.length} shadow frames, ${ids.length} unique ids`,
);
