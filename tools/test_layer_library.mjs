import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = fs.readFileSync(path.join(root, "app/src/main/assets/layer-library.js"), "utf8");
const runtimeSource = fs.readFileSync(path.join(root, "app/src/main/assets/layer-runtime.js"), "utf8");
const runtime = {
  validateGeoJson(data) {
    if (!data || data.type !== "FeatureCollection" || !Array.isArray(data.features)) {
      throw new Error("ожидается FeatureCollection");
    }
    return { data, bounds: null, featureCount: data.features.length };
  },
};
const context = { window: { SloiLayerRuntime: runtime } };
vm.createContext(context);
new vm.Script(source, { filename: "layer-library.js" }).runInContext(context);
const libraryApi = context.window.SloiLayerLibrary;

assert.ok(libraryApi);
assert.deepEqual(JSON.parse(JSON.stringify(libraryApi.limits)), {
  maxEntries: 5,
  maxEntryBytes: 2 * 1024 * 1024,
  maxTotalBytes: 8 * 1024 * 1024,
});

const geoJson = {
  type: "FeatureCollection",
  features: [{
    type: "Feature",
    properties: { name: "Сквер", script: "alert('never executed')" },
    geometry: { type: "Point", coordinates: [30.3, 59.9] },
  }],
};
const normalized = libraryApi.normalizeEntry({
  id: "custom-green-spaces",
  name: "  Зелёные места  ",
  color: "#AABBCC",
  data: geoJson,
});
assert.equal(normalized.id, "custom-green-spaces");
assert.equal(normalized.name, "Зелёные места");
assert.equal(normalized.color, "#aabbcc");
assert.equal(normalized.data.features.length, 1);
assert.equal(normalized.featureCount, 1);
assert.equal(normalized.bounds, null);
assert.notEqual(normalized.data, geoJson);

assert.throws(
  () => libraryApi.normalizeEntry({ id: "../bad", name: "x", color: "#abcdef", data: geoJson }),
  /идентификатор/,
);
assert.throws(
  () => libraryApi.normalizeEntry({ id: "custom-x", name: " ", color: "#abcdef", data: geoJson }),
  /название/,
);
assert.throws(
  () => libraryApi.normalizeEntry({ id: "custom-x", name: "x", color: "red", data: geoJson }),
  /#rrggbb/,
);
assert.throws(
  () => libraryApi.normalizeEntry({
    id: "custom-x",
    name: "x",
    color: "#abcdef",
    data: { type: "Feature", geometry: null },
  }),
  /FeatureCollection/,
);
assert.throws(
  () => libraryApi.normalizeEntry({
    id: "custom-big",
    name: "x",
    color: "#abcdef",
    data: { type: "FeatureCollection", features: [], padding: "x".repeat(2 * 1024 * 1024) },
  }),
  /2 МиБ/,
);

const malicious = JSON.parse('{"type":"FeatureCollection","features":[],"__proto__":{"polluted":true}}');
const safe = libraryApi.normalizeEntry({
  id: "custom-safe",
  name: "safe",
  color: "#010203",
  data: malicious,
});
assert.equal({}.polluted, undefined);
assert.equal(typeof safe.data, "object");

const browserContext = { window: {} };
vm.createContext(browserContext);
new vm.Script(runtimeSource, { filename: "layer-runtime.js" }).runInContext(browserContext);
new vm.Script(source, { filename: "layer-library.js" }).runInContext(browserContext);
const runtimeValidated = new vm.Script(`window.SloiLayerLibrary.normalizeEntry({
  id: "custom-runtime",
  name: "Runtime",
  color: "#123456",
  data: {
    type: "FeatureCollection",
    features: [{
      type: "Feature",
      properties: { name: "Точка", nested: { discarded: true } },
      geometry: { type: "Point", coordinates: [30.3, 59.9] }
    }]
  }
})`).runInContext(browserContext);
assert.equal(runtimeValidated.data.features[0].properties.name, "Точка");
assert.equal(runtimeValidated.data.features[0].properties.nested, undefined);
assert.equal(runtimeValidated.featureCount, 1);
assert.deepEqual(JSON.parse(JSON.stringify(runtimeValidated.bounds)), [[30.3, 59.9], [30.3, 59.9]]);

const noDatabase = new libraryApi.Library({ indexedDB: {} });
await assert.rejects(noDatabase.load(), /IndexedDB недоступна/);

function fakeDatabase(initialRecord) {
  let record = initialRecord;
  return {
    get record() { return record; },
    transaction() {
      const transaction = {
        error: null,
        abort() { queueMicrotask(() => transaction.onabort?.()); },
        objectStore() {
          return {
            get(id) {
              const request = {};
              queueMicrotask(() => {
                request.result = record && record.id === id ? record : undefined;
                request.onsuccess?.();
              });
              return request;
            },
            put(value) {
              const request = {};
              queueMicrotask(() => {
                record = value;
                request.onsuccess?.();
                transaction.oncomplete?.();
              });
              return request;
            },
          };
        },
      };
      return transaction;
    },
  };
}

let validationCalls = 0;
const instrumentedRuntime = {
  validateGeoJson() {
    validationCalls += 1;
    throw new Error("updateColor must not validate geometry");
  },
};
const colorDatabase = fakeDatabase(normalized);
const colorLibrary = new libraryApi.Library({ runtime: instrumentedRuntime });
colorLibrary.database = colorDatabase;
const recolored = await colorLibrary.updateColor("custom-green-spaces", " #FEDCBA ");
assert.equal(recolored.color, "#fedcba");
assert.equal(colorDatabase.record.color, "#fedcba");
assert.equal(recolored.data, normalized.data);
assert.equal(validationCalls, 0);
await assert.rejects(colorLibrary.updateColor("bad-id", "#abcdef"), /идентификатор/);
await assert.rejects(colorLibrary.updateColor("custom-green-spaces", "blue"), /#rrggbb/);
const missingLibrary = new libraryApi.Library({ runtime: instrumentedRuntime });
missingLibrary.database = fakeDatabase(null);
await assert.rejects(missingLibrary.updateColor("custom-missing", "#abcdef"), /не найден/);
assert.equal(validationCalls, 0);

console.log("Layer library OK");
