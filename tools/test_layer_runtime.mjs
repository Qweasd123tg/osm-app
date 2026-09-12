import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = fs.readFileSync(path.join(root, "app/src/main/assets/layer-runtime.js"), "utf8");
const context = { window: {} };
vm.createContext(context);
new vm.Script(source, { filename: "layer-runtime.js" }).runInContext(context);
const { Runtime, validateGeoJson, geoJsonStyle } = context.window.SloiLayerRuntime;

class FakeMap {
  constructor(ids) {
    this.layers = [...ids];
    this.layerObjects = new Map(ids.map((id) => [id, { id, layout: {}, paint: {} }]));
    this.layout = [];
    this.paint = [];
    this.moves = [];
    this.sourceMutations = 0;
    this.camera = { center: [30.31, 59.94], zoom: 15, pitch: 45, bearing: 18 };
  }

  getLayer(id) { return this.layers.includes(id) ? this.layerObjects.get(id) : undefined; }

  getLayoutProperty(id, property) { return this.getLayer(id)?.layout[property]; }

  getPaintProperty(id, property) { return this.getLayer(id)?.paint[property]; }

  getStyle() { return { layers: this.layers.map((id) => ({ id })) }; }

  setLayoutProperty(id, property, value) {
    const layer = this.getLayer(id);
    assert.ok(layer);
    layer.layout[property] = value;
    this.layout.push([id, property, value]);
  }

  setPaintProperty(id, property, value) {
    const layer = this.getLayer(id);
    assert.ok(layer);
    layer.paint[property] = value;
    this.paint.push([id, property, value]);
  }

  moveLayer(id, before) {
    const index = this.layers.indexOf(id);
    if (index < 0) throw new Error("missing layer");
    this.layers.splice(index, 1);
    if (before === undefined) this.layers.push(id);
    else this.layers.splice(this.layers.indexOf(before), 0, id);
    this.moves.push([id, before]);
  }

  addLayer(id, before) {
    this.layerObjects.set(id, { id, layout: {}, paint: {} });
    if (before === undefined) this.layers.push(id);
    else this.layers.splice(this.layers.indexOf(before), 0, id);
  }

  removeLayer(id) {
    this.layers.splice(this.layers.indexOf(id), 1);
    this.layerObjects.delete(id);
  }
}

function descriptor(value) {
  return Object.assign(Object.create(null), value);
}

const map = new FakeMap([
  "background", "shadows", "buildings-flat", "buildings-3d", "wind-line", "selected-location",
]);
const originalCamera = structuredClone(map.camera);
let mode = "3d";
let viewportLayers = ["buildings-flat", "buildings-3d"];
let customApplyCount = 0;
const runtime = new Runtime(map);
runtime.register(descriptor({
  id: "shadows", title: "Тени", sourceLabel: "Локально", dataType: "time-geojson",
  opacityKey: "shadowOpacity",
  mapLayers: () => [{ id: "shadows", opacityProperty: "fill-opacity" }],
}));
runtime.register(descriptor({
  id: "buildings", title: "Здания", sourceLabel: "OSM", dataType: "geojson",
  opacityKey: "buildingOpacity",
  mapLayers: () => viewportLayers.map((id) => ({
    id,
    opacityProperty: id.endsWith("3d") ? "fill-extrusion-opacity" : "fill-opacity",
    visible: () => id.endsWith(mode),
  })),
}));
runtime.register(descriptor({
  id: "wind", title: "Ветер", sourceLabel: "Погода", dataType: "geojson",
  available: () => false,
  mapLayers: () => [{ id: "wind-line", opacityProperty: "line-opacity" }],
  apply: () => { customApplyCount += 1; },
}));

const baseState = {
  shadows: true, shadowOpacity: 0.42,
  buildings: true, buildingOpacity: 0.77,
  wind: true, windOpacity: 0.5,
};
runtime.apply(baseState, ["wind", "shadows"]);
assert.deepEqual(map.camera, originalCamera, "applying layers must not mutate the camera");
assert.deepEqual(map.layers, [
  "background", "wind-line", "shadows", "buildings-flat", "buildings-3d", "selected-location",
]);
assert.deepEqual(map.layout.filter(([id]) => id.startsWith("buildings")), [
  ["buildings-flat", "visibility", "none"],
  ["buildings-3d", "visibility", "visible"],
]);
assert.ok(map.layout.some((entry) => entry[0] === "wind-line" && entry[2] === "none"));
assert.ok(map.paint.some((entry) => entry[0] === "shadows" && entry[2] === 0.42));
assert.ok(map.paint.some((entry) => entry[0] === "buildings-3d" && entry[2] === 0.77));
assert.equal(map.paint.some((entry) => entry[0] === "wind-line"), false);
assert.equal(customApplyCount, 0, "unavailable layer hook must not run");
assert.deepEqual(Array.from(runtime.descriptors(), ({ id, available }) => ({ id, available })), [
  { id: "shadows", available: true },
  { id: "buildings", available: true },
  { id: "wind", available: false },
]);

map.layout.length = 0;
map.paint.length = 0;
map.moves.length = 0;
runtime.apply(baseState, ["wind", "shadows"]);
assert.equal(map.layout.length, 0, "same state must not rewrite visibility");
assert.equal(map.paint.length, 0, "same state must not rewrite paint");
assert.equal(map.moves.length, 0, "same order must not move layers");

runtime.apply({ ...baseState, buildingOpacity: 0.63 }, ["wind", "shadows"]);
assert.equal(map.layout.length, 0, "opacity-only change must not rewrite visibility");
assert.deepEqual(map.paint.map(([id, property]) => [id, property]), [
  ["buildings-flat", "fill-opacity"],
  ["buildings-3d", "fill-extrusion-opacity"],
]);
assert.equal(map.moves.length, 0, "opacity-only change must not reorder layers");
assert.equal(map.sourceMutations, 0, "runtime must not mutate sources");

// mapLayers is evaluated for each pass, so viewport tile groups can change without registration.
map.addLayer("viewport-buildings-flat-a", "selected-location");
viewportLayers = ["viewport-buildings-flat-a"];
mode = "flat-a";
map.layout.length = 0;
map.paint.length = 0;
map.moves.length = 0;
const viewportState = { ...baseState, buildingOpacity: 1 };
runtime.apply(viewportState, ["buildings"], { anchor: "selected-location" });
assert.ok(map.layout.some((entry) => entry[0] === "viewport-buildings-flat-a" && entry[2] === "visible"));
assert.ok(map.paint.some((entry) => entry[0] === "viewport-buildings-flat-a" && entry[2] === 1));
assert.ok(map.moves.length > 0, "a new viewport layer must be placed in runtime order");
assert.equal(map.layers.at(-1), "selected-location");

// A style reload can replace a layer object under the same ID; it still needs fresh settings.
map.removeLayer("viewport-buildings-flat-a");
map.addLayer("viewport-buildings-flat-a", "shadows");
map.layout.length = 0;
map.paint.length = 0;
map.moves.length = 0;
runtime.apply(viewportState, ["buildings"]);
assert.deepEqual(map.layout, [["viewport-buildings-flat-a", "visibility", "visible"]]);
assert.deepEqual(map.paint, [["viewport-buildings-flat-a", "fill-opacity", 1]]);
assert.equal(map.moves.length, 0, "same order after layer recreation must stay untouched");
assert.equal(runtime.unregister("wind"), true);
assert.equal(runtime.unregister("wind"), false);

const brokenRuntime = new Runtime(new FakeMap(["broken", "selected-location"]));
brokenRuntime.register(descriptor({ id: "broken", mapLayers: () => null }));
assert.throws(() => brokenRuntime.apply({ broken: true }), /должен вернуть массив/);
const failingMap = new FakeMap(["failure", "selected-location"]);
failingMap.setLayoutProperty = () => { throw new Error("paint pipeline failed"); };
const failingRuntime = new Runtime(failingMap);
failingRuntime.register(descriptor({ id: "failure", mapLayers: () => [{ id: "failure" }] }));
assert.throws(() => failingRuntime.apply({ failure: true }), /paint pipeline failed/);

const normalized = validateGeoJson(JSON.stringify({
  type: "FeatureCollection",
  features: [
    {
      type: "Feature",
      id: "route-1",
      properties: {
        name: "Набережная",
        score: 0.8,
        active: true,
        nested: { ignored: true },
        constructor: "ignored",
      },
      geometry: { type: "LineString", coordinates: [[30.1, 59.8], [30.5, 60.1]] },
    },
    {
      type: "Feature",
      properties: null,
      geometry: { type: "Point", coordinates: [30.3, 59.9, 120] },
    },
  ],
}));
assert.equal(normalized.featureCount, 2);
assert.deepEqual(Array.from(normalized.bounds, (corner) => Array.from(corner)), [[30.1, 59.8], [30.5, 60.1]]);
assert.equal(normalized.data.features[0].properties.name, "Набережная");
assert.equal("nested" in normalized.data.features[0].properties, false);
assert.equal(Object.hasOwn(normalized.data.features[0].properties, "constructor"), false);
assert.deepEqual(Array.from(normalized.data.features[1].geometry.coordinates), [30.3, 59.9]);

const polygon = validateGeoJson(JSON.stringify({
  type: "Polygon",
  coordinates: [[[30, 60], [31, 60], [31, 61], [30, 60]]],
}));
assert.equal(polygon.featureCount, 1);
assert.equal(polygon.data.features[0].geometry.type, "Polygon");

assert.throws(() => validateGeoJson(JSON.stringify({
  type: "Polygon",
  coordinates: [[[30, 60], [31, 60], [31, 61], [30, 61]]],
})), /не замкнут/);
assert.throws(() => validateGeoJson('{"type":"FeatureCollection","features":[]}'), /не содержит объектов/);
assert.throws(() => validateGeoJson(JSON.stringify({ type: "Point", coordinates: [181, 10] })), /границ/);
assert.throws(() => validateGeoJson(JSON.stringify({ type: "GeometryCollection", geometries: [] })), /не поддерживается/);
assert.throws(() => validateGeoJson(JSON.stringify({
  type: "Feature", properties: {}, geometry: null,
})), /не может быть null/);
const polluted = Object.create({ type: "Point" });
polluted.coordinates = [30, 60];
assert.throws(() => validateGeoJson(polluted), /прототип/);
const accessorGeometry = Object.assign(Object.create(null), { type: "Point" });
accessorGeometry.coordinates = [30, 60];
Object.defineProperty(accessorGeometry.coordinates, "0", { enumerable: true, get: () => 30 });
assert.throws(() => validateGeoJson(accessorGeometry), /вычисляемые поля/);

const denseCoordinates = Array.from({ length: 50001 }, (_, index) => [30, 59 + index / 1000000]);
assert.throws(() => validateGeoJson(JSON.stringify({
  type: "LineString", coordinates: denseCoordinates,
})), /50000 координат/);
assert.throws(() => validateGeoJson(" ".repeat(2 * 1024 * 1024 + 1)), /2 МиБ/);

const style = geoJsonStyle("custom-walk-1", "#2f80ed");
assert.equal(style.sourceId, "custom-walk-1-source");
assert.deepEqual(Array.from(style.layers, (layer) => layer.id), [
  "custom-walk-1-fill", "custom-walk-1-line", "custom-walk-1-point",
]);
assert.equal(style.layers[0].filter[2], "Polygon");
assert.ok(style.layers[1].filter.flat(2).includes("LineString"));
assert.equal(style.bindings[2].extraOpacityProperties[0], "circle-stroke-opacity");
assert.throws(() => geoJsonStyle("streets", "#fff"), /id/);
assert.throws(() => geoJsonStyle("custom-streets", "url(evil)"), /цвет/);
assert.throws(() => geoJsonStyle("custom-streets", "#12345"), /цвет/);
assert.doesNotThrow(() => geoJsonStyle(`custom-${"a".repeat(60)}`, "#fff"));
assert.throws(() => geoJsonStyle(`custom-${"a".repeat(61)}`, "#fff"), /id/);
const boundaryRuntime = new Runtime(new FakeMap([]));
assert.doesNotThrow(() => boundaryRuntime.register(descriptor({
  id: `custom-${"a".repeat(60)}`,
  mapLayers: () => [],
})));

console.log("Layer runtime OK");
