import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const context = { window: {} };
vm.createContext(context);
new vm.Script(fs.readFileSync(new URL("../app/src/main/assets/map-camera.js", import.meta.url), "utf8"), {
  filename: "map-camera.js",
}).runInContext(context);
const camera = context.window.SloiMapCamera;
const plain = (value) => JSON.parse(JSON.stringify(value));
const selected = { center: [37.6173, 55.7558], zoom: 14.5, bearing: -27, pitch: 43 };
const mapFor = (value) => ({
  getCenter: () => ({ lng: value.center[0], lat: value.center[1] }),
  getZoom: () => value.zoom,
  getBearing: () => value.bearing,
  getPitch: () => value.pitch,
});
const records = new Map();
const storage = {
  getItem: (key) => records.get(key) ?? null,
  setItem: (key, value) => records.set(key, value),
};

assert.deepEqual(plain(camera.defaultCamera), { center: [0, 20], zoom: 2, bearing: 0, pitch: 0 });
assert.ok(Object.isFrozen(camera));
assert.ok(Object.isFrozen(camera.defaultCamera));
assert.ok(Object.isFrozen(camera.defaultCamera.center));
assert.equal(camera.load(storage), null);
assert.equal(camera.save(storage, mapFor(selected)), true);
assert.ok(records.has("sloi-map-camera"));
assert.deepEqual(plain(camera.load(storage)), selected);

const normalized = camera.normalize(selected);
normalized.center[0] = -100;
assert.equal(selected.center[0], 37.6173);
assert.equal(camera.normalize(selected).center[0], 37.6173);
const loaded = camera.load(storage);
loaded.center[1] = 0;
assert.equal(camera.load(storage).center[1], 55.7558);

for (const value of [
  null, undefined, [], "camera", {}, { latitude: 55, longitude: 37, zoom: 12 },
  { ...selected, center: null }, { ...selected, center: [37] },
  { ...selected, center: [37, 55, 0] }, { ...selected, center: ["37", 55] },
  { ...selected, center: [181, 55] }, { ...selected, center: [37, 86] },
  { ...selected, center: [-181, 55] }, { ...selected, center: [37, -86] },
  { ...selected, center: [Infinity, 55] }, { ...selected, center: [37, NaN] },
  { ...selected, zoom: "14" }, { ...selected, zoom: NaN },
  { ...selected, zoom: 0 }, { ...selected, zoom: 20 },
  { ...selected, bearing: 181 }, { ...selected, bearing: -181 },
  { ...selected, bearing: Infinity }, { ...selected, bearing: "0" },
  { ...selected, pitch: -1 }, { ...selected, pitch: 61 },
  { ...selected, pitch: undefined }, { ...selected, pitch: false },
]) assert.equal(camera.normalize(value), null);

for (const raw of ["{", "null", "[]", '"old"', '{"center":[37,55],"zoom":14}',
  '{"center":[37,55],"zoom":1e999,"bearing":0,"pitch":0}']) {
  records.set("sloi-map-camera", raw);
  assert.equal(camera.load(storage), null);
}

assert.deepEqual(plain(camera.normalize({ center: [-180, -85.051129], zoom: 1, bearing: -180, pitch: 0 })),
  { center: [-180, -85.051129], zoom: 1, bearing: -180, pitch: 0 });
assert.deepEqual(plain(camera.normalize({ center: [180, 85.051129], zoom: 19, bearing: 180, pitch: 60 })),
  { center: [180, 85.051129], zoom: 19, bearing: 180, pitch: 60 });

assert.equal(camera.save(storage, mapFor({ ...selected, zoom: 25, pitch: 75 })), true);
assert.deepEqual(plain(camera.load(storage)), { ...selected, zoom: 19, pitch: 60 });
assert.equal(camera.save(storage, mapFor({ ...selected, center: [397.5, 55.75] })), true);
assert.deepEqual(plain(camera.load(storage)), { ...selected, center: [37.5, 55.75] });
assert.equal(camera.save(storage, mapFor({ ...selected, center: [-757.5, 55.75] })), true);
assert.deepEqual(plain(camera.load(storage)), { ...selected, center: [-37.5, 55.75] });
const previous = records.get("sloi-map-camera");
assert.equal(camera.save(storage, mapFor({ ...selected, center: [NaN, 55] })), false);
assert.equal(camera.save(storage, mapFor({ ...selected, zoom: "14" })), false);
assert.equal(records.get("sloi-map-camera"), previous);

const blocked = {
  getItem() { throw new Error("blocked"); },
  setItem() { throw new Error("quota"); },
};
assert.equal(camera.load(blocked), null);
assert.equal(camera.save(blocked, mapFor(selected)), false);
assert.equal(camera.load(null), null);
assert.equal(camera.save(null, mapFor(selected)), false);
assert.equal(camera.save(storage, { getCenter() { throw new Error("map removed"); } }), false);
assert.equal(camera.normalize({ get center() { throw new Error("invalid record"); } }), null);

for (const latitude of [0, 59.9, 80]) {
  const boundary = Math.log2(camera.scaleMeters(latitude, 0) / 500);
  assert.ok(Math.abs(camera.scaleMeters(latitude, boundary) - 500) < 1e-8);
  for (const pitch of [0, 18, 45, 60]) {
    const controller = camera.createPitchController(pitch);
    for (let zoom = 1; zoom <= 19; zoom += .25) {
      assert.equal(controller.update({ center: { lat: latitude }, zoom, pitch }).pitch, pitch,
        "Zoom must never flatten or tilt the camera, including the 500m detail threshold");
    }
  }
}
// Selected pitch stays exactly the same in overview and at street level.
const angle = camera.createPitchController(45);
const view = (zoom, pitch) => ({ center: { lat: 59.9, lng: 30.32 }, zoom, pitch });
assert.equal(angle.update(view(15, 45)).pitch, 45);
assert.equal(angle.update(view(12, 45)).pitch, 45);
assert.equal(angle.update(view(15, 45)).pitch, 45);
assert.equal(angle.intent, 45);
assert.equal(angle.update(view(15, 23)).pitch, 23);
assert.equal(angle.intent, 23);
angle.select(0);
assert.equal(angle.update(view(15, 0)).pitch, 0);

// A flat map accepts a pitch input instead of permanently clamping 2D gestures.
const flat = camera.createPitchController();
assert.equal(flat.update(view(15, 18)).pitch, 18);
assert.equal(flat.intent, 18);

console.log("Map camera OK: persistence, storage failures, zoom-invariant pitch and tilt from 2D");
