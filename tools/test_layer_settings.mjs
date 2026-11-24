import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = fs.readFileSync(path.join(root, "app/src/main/assets/layer-settings.js"), "utf8");
const context = { window: {} };
vm.createContext(context);
new vm.Script(source, { filename: "layer-settings.js" }).runInContext(context);
const settings = context.window.SloiLayerSettings;

const globalContext = {};
vm.createContext(globalContext);
new vm.Script(source, { filename: "layer-settings.js" }).runInContext(globalContext);
assert.ok(globalContext.SloiLayerSettings);

assert.ok(settings);
assert.deepEqual(
  Array.from(settings.registry, (layer) => layer.id),
  ["shadows", "buildings", "wind", "sun"],
);
assert.deepEqual(
  Array.from(settings.registry, (layer) => layer.defaultOpacity),
  [0.38, 0.65, 0.85, 0.9],
);
assert.equal(settings.registry.find((layer) => layer.id === "sun").defaultEnabled, false);

const legacy = settings.normalizeState(
  { mode: "2d", basemap: "dark", shadows: false, shadowOpacity: 0.5, frame: 7 },
  { defaultFrame: 3, frameCount: 12 },
);
assert.equal(legacy.mode, "2d");
assert.equal(legacy.basemap, "dark");
assert.equal(legacy.shadows, false);
assert.equal(legacy.buildingOpacity, 0.65);
assert.equal(legacy.windOpacity, 0.85);
assert.equal(legacy.sun, false);
assert.equal(legacy.sunOpacity, 0.9);
assert.equal(legacy.frame, 7);
assert.deepEqual(Array.from(legacy.layerOrder), ["shadows", "buildings", "wind", "sun"]);

const maliciousCustomLayers = JSON.parse('{"__proto__":{"enabled":true},"constructor":{"enabled":true}}');
Object.assign(maliciousCustomLayers, {
  "custom-parks": { enabled: true, opacity: 9, data: { forbidden: true } },
  "custom-water": { enabled: "yes", opacity: NaN },
  "custom-empty": null,
  "custom-UPPER": { enabled: true, opacity: 0.5 },
});
const corrupt = settings.normalizeState(
  {
    mode: "sideways",
    basemap: null,
    shadows: "yes",
    shadowOpacity: Infinity,
    buildingOpacity: -5,
    windOpacity: 7,
    sunOpacity: -Infinity,
    frame: NaN,
    customLayers: maliciousCustomLayers,
    layerOrder: ["custom-parks", "wind", "bogus", "wind", 42, "shadows"],
  },
  { defaultFrame: 99, frameCount: 4 },
);
assert.deepEqual(JSON.parse(JSON.stringify(corrupt)), {
  mode: "3d",
  basemap: "light",
  confidence: false,
  frame: 3,
  customLayers: {
    "custom-parks": { enabled: true, opacity: 1 },
    "custom-water": { enabled: false, opacity: 0.7 },
    "custom-empty": { enabled: false, opacity: 0.7 },
  },
  layerOrder: ["custom-parks", "wind", "shadows", "buildings", "sun", "custom-water", "custom-empty"],
  shadows: true,
  shadowOpacity: 0.38,
  buildings: true,
  buildingOpacity: 0.1,
  wind: true,
  windOpacity: 1,
  sun: false,
  sunOpacity: 0.9,
});
assert.equal({}.enabled, undefined);
assert.equal(settings.normalizeState(null, { frameCount: 0 }).frame, 0);

const state = settings.normalizeState(
  {
    mode: "2d",
    basemap: "dark",
    shadows: false,
    buildings: true,
    confidence: true,
    wind: false,
    shadowOpacity: 0.25,
    buildingOpacity: 0.7,
    windOpacity: 0.4,
    sun: true,
    sunOpacity: 0.6,
    frame: 2,
    customLayers: {
      "custom-parks": { enabled: true, opacity: 0.45, data: { forbidden: true } },
    },
    layerOrder: ["custom-parks", "wind", "buildings", "shadows", "sun"],
  },
  { defaultFrame: 0, frameCount: 3 },
);
const config = settings.capturePreset(state, "15:00");
assert.equal(config.version, 1);
assert.equal(config.timeLabel, "15:00");
assert.equal("frame" in config, false);
assert.equal("data" in config.customLayers["custom-parks"], false);
const restored = settings.applyPreset(
  { id: "afternoon", name: "После обеда", config },
  { defaultFrame: 0, frameCount: 3, frameLabels: ["09:00", { label: "12:00" }, "15:00"] },
);
assert.deepEqual(JSON.parse(JSON.stringify(restored)), JSON.parse(JSON.stringify(state)));

const missingTime = settings.applyPreset(config, {
  defaultFrame: 1,
  frameCount: 3,
  frameLabels: ["09:00", "12:00", "18:00"],
});
assert.equal(missingTime.frame, 1);
const future = settings.applyPreset({ version: 2, mode: "2d", timeLabel: "15:00" }, {
  defaultFrame: 2,
  frameCount: 3,
  frameLabels: ["09:00", "12:00", "15:00"],
});
assert.equal(future.mode, "3d");
assert.equal(future.frame, 2);

const oldPreset = settings.applyPreset({
  version: 1,
  mode: "2d",
  shadows: false,
  buildings: true,
  confidence: false,
  wind: false,
  shadowOpacity: 0.2,
  buildingOpacity: 0.8,
  windOpacity: 0.5,
  layerOrder: ["wind", "shadows", "buildings"],
  timeLabel: "12:00",
}, { defaultFrame: 0, frameCount: 2, frameLabels: ["09:00", "12:00"] });
assert.equal(oldPreset.sun, false);
assert.equal(oldPreset.sunOpacity, 0.9);
assert.deepEqual(JSON.parse(JSON.stringify(oldPreset.customLayers)), {});
assert.deepEqual(Array.from(oldPreset.layerOrder), ["wind", "shadows", "buildings", "sun"]);

const tooManyCustom = {};
for (let index = 0; index < 8; index += 1) {
  tooManyCustom[`custom-layer-${index}`] = { enabled: index % 2 === 0, opacity: index / 10 };
}
const boundedCustom = settings.normalizeState({ customLayers: tooManyCustom }, { frameCount: 1 });
assert.equal(Object.keys(boundedCustom.customLayers).length, 5);
assert.equal(boundedCustom.customLayers["custom-layer-0"].opacity, 0.1);
assert.equal(boundedCustom.customLayers["custom-layer-4"].opacity, 0.4);

const candidates = Array.from({ length: 24 }, (_, index) => ({
  id: `preset_${index}`,
  name: `  Preset ${index} ${"x".repeat(60)}  `,
  config,
}));
candidates.splice(1, 0,
  { id: "preset_0", name: "duplicate", config },
  { id: "bad id", name: "invalid id", config },
  { id: "future", name: "future", config: { version: 9 } },
  { id: "bad_time", name: "bad time", config: { ...config, timeLabel: "29:99" } },
  { id: "blank", name: "   ", config },
);
const presets = settings.normalizePresets(candidates);
assert.equal(presets.length, 20);
assert.equal(new Set(Array.from(presets, (preset) => preset.id)).size, 20);
assert.ok(presets.every((preset) => preset.name.length <= 48));
assert.ok(presets.every((preset) => preset.config.version === 1));
assert.deepEqual(Array.from(settings.normalizePresets(null)), []);

console.log("Layer settings OK");
