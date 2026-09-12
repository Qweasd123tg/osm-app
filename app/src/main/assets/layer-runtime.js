(function (root) {
  "use strict";

  const MAX_FEATURES = 5000;
  const MAX_COORDINATES = 50000;
  const MAX_JSON_BYTES = 2 * 1024 * 1024;
  const SUPPORTED_GEOMETRIES = new Set([
    "Point",
    "MultiPoint",
    "LineString",
    "MultiLineString",
    "Polygon",
    "MultiPolygon",
  ]);
  const unsafePropertyNames = new Set(["__proto__", "constructor", "prototype"]);

  function plainObject(value, label) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`${label}: ожидался объект`);
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error(`${label}: нестандартный прототип запрещён`);
    }
    return value;
  }

  function ownValue(object, key, label) {
    const descriptor = Object.getOwnPropertyDescriptor(object, key);
    if (!descriptor) return undefined;
    if (typeof descriptor.get === "function" || typeof descriptor.set === "function") {
      throw new Error(`${label}.${key}: вычисляемые поля запрещены`);
    }
    return descriptor.value;
  }

  function safeArrayMap(value, label, callback) {
    const result = [];
    for (let index = 0; index < value.length; index += 1) {
      const item = ownValue(value, String(index), label);
      if (item === undefined && !Object.prototype.hasOwnProperty.call(value, index)) {
        throw new Error(`${label}[${index}]: пропущенное значение`);
      }
      result.push(callback(item, index));
    }
    return result;
  }

  function utf8Bytes(value) {
    let bytes = 0;
    for (let index = 0; index < value.length; index += 1) {
      const code = value.charCodeAt(index);
      if (code < 0x80) bytes += 1;
      else if (code < 0x800) bytes += 2;
      else if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length
        && value.charCodeAt(index + 1) >= 0xdc00 && value.charCodeAt(index + 1) <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else bytes += 3;
    }
    return bytes;
  }

  function safeProperties(value, featureIndex) {
    if (value == null) return {};
    const source = plainObject(value, `Объект ${featureIndex + 1}, properties`);
    const result = {};
    let copied = 0;
    for (const key of Object.keys(source)) {
      if (copied >= 64) break;
      if (!key || key.length > 64 || /[\u0000-\u001f\u007f]/.test(key)
        || unsafePropertyNames.has(key)) continue;
      const item = ownValue(source, key, `Объект ${featureIndex + 1}, properties`);
      let safe;
      if (typeof item === "string") safe = item.slice(0, key === "name" ? 200 : 512);
      else if (typeof item === "boolean") safe = item;
      else if (typeof item === "number" && Number.isFinite(item) && Math.abs(item) <= 1e12) safe = item;
      else continue;
      Object.defineProperty(result, key, {
        value: safe,
        enumerable: true,
        configurable: true,
        writable: true,
      });
      copied += 1;
    }
    return result;
  }

  function normalizePosition(value, counters, bounds, label) {
    if (!Array.isArray(value) || value.length < 2) {
      throw new Error(`${label}: координата должна содержать долготу и широту`);
    }
    const lon = ownValue(value, "0", label);
    const lat = ownValue(value, "1", label);
    if (!Number.isFinite(lon) || lon < -180 || lon > 180
      || !Number.isFinite(lat) || lat < -85 || lat > 85) {
      throw new Error(`${label}: координата вне допустимых границ`);
    }
    counters.coordinates += 1;
    if (counters.coordinates > MAX_COORDINATES) {
      throw new Error(`GeoJSON содержит больше ${MAX_COORDINATES} координат`);
    }
    bounds[0] = Math.min(bounds[0], lon);
    bounds[1] = Math.min(bounds[1], lat);
    bounds[2] = Math.max(bounds[2], lon);
    bounds[3] = Math.max(bounds[3], lat);
    return [lon, lat];
  }

  function normalizeLine(value, counters, bounds, label, minimum) {
    if (!Array.isArray(value) || value.length < minimum) {
      throw new Error(`${label}: недостаточно координат`);
    }
    return safeArrayMap(value, label, (position, index) =>
      normalizePosition(position, counters, bounds, `${label}[${index}]`));
  }

  function normalizeRing(value, counters, bounds, label) {
    const ring = normalizeLine(value, counters, bounds, label, 4);
    const first = ring[0];
    const last = ring[ring.length - 1];
    if (first[0] !== last[0] || first[1] !== last[1]) {
      throw new Error(`${label}: контур полигона не замкнут`);
    }
    return ring;
  }

  function nonEmptyArray(value, label) {
    if (!Array.isArray(value) || value.length === 0) {
      throw new Error(`${label}: пустая геометрия`);
    }
    return value;
  }

  function normalizeGeometry(value, counters, bounds, label) {
    const geometry = plainObject(value, label);
    const type = ownValue(geometry, "type", label);
    const coordinates = ownValue(geometry, "coordinates", label);
    if (!SUPPORTED_GEOMETRIES.has(type)) {
      throw new Error(`${label}: тип геометрии ${String(type)} не поддерживается`);
    }
    let normalized;
    if (type === "Point") {
      normalized = normalizePosition(coordinates, counters, bounds, `${label}.coordinates`);
    } else if (type === "MultiPoint") {
      normalized = safeArrayMap(nonEmptyArray(coordinates, label), `${label}.coordinates`, (point, index) =>
        normalizePosition(point, counters, bounds, `${label}.coordinates[${index}]`));
    } else if (type === "LineString") {
      normalized = normalizeLine(coordinates, counters, bounds, `${label}.coordinates`, 2);
    } else if (type === "MultiLineString") {
      normalized = safeArrayMap(nonEmptyArray(coordinates, label), `${label}.coordinates`, (line, index) =>
        normalizeLine(line, counters, bounds, `${label}.coordinates[${index}]`, 2));
    } else if (type === "Polygon") {
      normalized = safeArrayMap(nonEmptyArray(coordinates, label), `${label}.coordinates`, (ring, index) =>
        normalizeRing(ring, counters, bounds, `${label}.coordinates[${index}]`));
    } else {
      normalized = safeArrayMap(nonEmptyArray(coordinates, label), `${label}.coordinates`, (polygon, polygonIndex) =>
        safeArrayMap(nonEmptyArray(polygon, `${label}.coordinates[${polygonIndex}]`),
          `${label}.coordinates[${polygonIndex}]`, (ring, ringIndex) =>
            normalizeRing(ring, counters, bounds, `${label}.coordinates[${polygonIndex}][${ringIndex}]`)));
    }
    return { type, coordinates: normalized };
  }

  function normalizeFeature(value, featureIndex, counters, bounds) {
    const label = `Объект ${featureIndex + 1}`;
    const feature = plainObject(value, label);
    if (ownValue(feature, "type", label) !== "Feature") {
      throw new Error(`${label}: ожидался Feature`);
    }
    const geometry = ownValue(feature, "geometry", label);
    if (geometry == null) throw new Error(`${label}: geometry не может быть null`);
    const result = {
      type: "Feature",
      properties: safeProperties(ownValue(feature, "properties", label), featureIndex),
      geometry: normalizeGeometry(geometry, counters, bounds, `${label}.geometry`),
    };
    const id = ownValue(feature, "id", label);
    if ((typeof id === "string" && id.length <= 128)
      || (typeof id === "number" && Number.isFinite(id) && Math.abs(id) <= 1e12)) {
      result.id = id;
    }
    return result;
  }

  function validateGeoJson(input) {
    let value = input;
    if (typeof input === "string") {
      if (utf8Bytes(input) > MAX_JSON_BYTES) throw new Error("GeoJSON больше 2 МиБ");
      try {
        value = JSON.parse(input);
      } catch (_error) {
        throw new Error("GeoJSON содержит ошибку синтаксиса");
      }
    }
    const rootObject = plainObject(value, "GeoJSON");
    const type = ownValue(rootObject, "type", "GeoJSON");
    let rawFeatures;
    if (type === "FeatureCollection") {
      rawFeatures = ownValue(rootObject, "features", "GeoJSON");
      if (!Array.isArray(rawFeatures)) throw new Error("GeoJSON.features: ожидался массив");
    } else if (type === "Feature") {
      rawFeatures = [rootObject];
    } else if (SUPPORTED_GEOMETRIES.has(type)) {
      rawFeatures = [{ type: "Feature", properties: {}, geometry: rootObject }];
    } else {
      throw new Error(`GeoJSON: тип ${String(type)} не поддерживается`);
    }
    if (rawFeatures.length === 0) throw new Error("GeoJSON не содержит объектов");
    if (rawFeatures.length > MAX_FEATURES) {
      throw new Error(`GeoJSON содержит больше ${MAX_FEATURES} объектов`);
    }
    const counters = { coordinates: 0 };
    const bounds = [Infinity, Infinity, -Infinity, -Infinity];
    const features = safeArrayMap(rawFeatures, "GeoJSON.features", (feature, index) =>
      normalizeFeature(feature, index, counters, bounds));
    const data = { type: "FeatureCollection", features };
    if (utf8Bytes(JSON.stringify(data)) > MAX_JSON_BYTES) throw new Error("GeoJSON больше 2 МиБ");
    return {
      data,
      bounds: [[bounds[0], bounds[1]], [bounds[2], bounds[3]]],
      featureCount: features.length,
    };
  }

  function normalizeOpacity(value) {
    return typeof value === "number" && Number.isFinite(value)
      ? Math.max(0, Math.min(1, value))
      : 1;
  }

  class Runtime {
    constructor(map) {
      if (!map || typeof map.getLayer !== "function") throw new Error("Runtime: карта не задана");
      this.map = map;
      this.registry = new Map();
      this.appliedProperties = new Map();
    }

    register(input) {
      const descriptor = plainObject(input, "Слой");
      const id = ownValue(descriptor, "id", "Слой");
      if (typeof id !== "string" || !/^[a-z][a-z0-9-]{0,79}$/.test(id)) {
        throw new Error("Слой: некорректный id");
      }
      const mapLayers = ownValue(descriptor, "mapLayers", `Слой ${id}`);
      if (typeof mapLayers !== "function") {
        throw new Error(`Слой ${id}: mapLayers должен быть функцией`);
      }
      if (this.registry.has(id)) throw new Error(`Слой ${id} уже зарегистрирован`);
      const title = ownValue(descriptor, "title", `Слой ${id}`);
      const sourceLabel = ownValue(descriptor, "sourceLabel", `Слой ${id}`);
      const dataType = ownValue(descriptor, "dataType", `Слой ${id}`);
      const opacityKey = ownValue(descriptor, "opacityKey", `Слой ${id}`);
      const available = ownValue(descriptor, "available", `Слой ${id}`);
      const customSettings = ownValue(descriptor, "getSettings", `Слой ${id}`);
      const customApply = ownValue(descriptor, "apply", `Слой ${id}`);
      const normalized = {
        id,
        title: typeof title === "string" ? title : id,
        sourceLabel: typeof sourceLabel === "string" ? sourceLabel : "",
        dataType: typeof dataType === "string" ? dataType : "geojson",
        opacityKey: typeof opacityKey === "string" ? opacityKey : `${id}Opacity`,
        mapLayers,
        available: typeof available === "function" ? available : () => true,
        getSettings: typeof customSettings === "function"
          ? customSettings
          : (state) => ({ enabled: Boolean(state && state[id]), opacity: state && state[normalized.opacityKey] }),
        apply: typeof customApply === "function" ? customApply : null,
      };
      this.registry.set(id, normalized);
      return this;
    }

    unregister(id) {
      return this.registry.delete(id);
    }

    descriptors() {
      return Array.from(this.registry.values(), (descriptor) => Object.freeze({
        id: descriptor.id,
        title: descriptor.title,
        sourceLabel: descriptor.sourceLabel,
        dataType: descriptor.dataType,
        opacityKey: descriptor.opacityKey,
        available: Boolean(descriptor.available()),
      }));
    }

    propertyCache(id, layer) {
      const cached = this.appliedProperties.get(id);
      if (cached && cached.layer === layer) return cached;
      const fresh = { layer, layout: new Map(), paint: new Map() };
      this.appliedProperties.set(id, fresh);
      return fresh;
    }

    setPropertyIfChanged(layer, kind, property, value) {
      const id = layer.id;
      const cache = this.propertyCache(id, layer);
      const getterName = kind === "layout" ? "getLayoutProperty" : "getPaintProperty";
      const setterName = kind === "layout" ? "setLayoutProperty" : "setPaintProperty";
      let current;
      if (typeof this.map[getterName] === "function") {
        try {
          current = this.map[getterName](id, property);
        } catch (error) {
          if (this.map.getLayer(id) !== layer) return;
          throw error;
        }
      } else if (cache[kind].has(property)) {
        current = cache[kind].get(property);
      }
      if (current === value) {
        cache[kind].set(property, value);
        return;
      }
      try {
        this.map[setterName](id, property, value);
        cache[kind].set(property, value);
      } catch (error) {
        if (this.map.getLayer(id) !== layer) {
          this.appliedProperties.delete(id);
          return;
        }
        throw error;
      }
    }

    orderIsCurrent(physicalOrder, anchor) {
      if (typeof this.map.getStyle !== "function") return false;
      const style = this.map.getStyle();
      if (!style || !Array.isArray(style.layers)) return false;
      const wanted = new Set(physicalOrder);
      const actual = style.layers
        .map((layer) => layer && layer.id)
        .filter((id) => wanted.has(id));
      if (actual.length !== physicalOrder.length
        || actual.some((id, index) => id !== physicalOrder[index])) return false;
      const anchorIndex = style.layers.findIndex((layer) => layer && layer.id === anchor);
      if (anchorIndex < 0) return true;
      return physicalOrder.every((id) =>
        style.layers.findIndex((layer) => layer && layer.id === id) < anchorIndex);
    }

    apply(state, order, options) {
      let requestedOrder = order;
      let settings = options;
      if (!Array.isArray(requestedOrder) && requestedOrder && typeof requestedOrder === "object") {
        settings = requestedOrder;
        requestedOrder = null;
      }
      settings = settings && typeof settings === "object" ? settings : {};
      const anchor = typeof settings.anchor === "string" ? settings.anchor : "selected-location";
      const orderedIds = [];
      for (const id of Array.isArray(requestedOrder) ? requestedOrder : []) {
        if (this.registry.has(id) && !orderedIds.includes(id)) orderedIds.push(id);
      }
      for (const id of this.registry.keys()) if (!orderedIds.includes(id)) orderedIds.push(id);

      const physicalOrder = [];
      const physicalIds = new Set();
      for (const id of orderedIds) {
        const descriptor = this.registry.get(id);
        const available = Boolean(descriptor.available());
        const resolved = descriptor.getSettings(state || {}) || {};
        const layerSettings = {
          enabled: available && Boolean(resolved.enabled),
          opacity: normalizeOpacity(resolved.opacity),
        };
        const result = descriptor.mapLayers();
        if (!Array.isArray(result)) {
          throw new Error(`Слой ${id}: mapLayers должен вернуть массив`);
        }
        const bindings = result;
        for (const binding of bindings) {
          if (!binding || typeof binding.id !== "string" || binding.id === anchor) continue;
          const physicalLayer = this.map.getLayer(binding.id);
          if (!physicalLayer) {
            this.appliedProperties.delete(binding.id);
            continue;
          }
          if (!physicalIds.has(binding.id)) {
            physicalIds.add(binding.id);
            physicalOrder.push(binding.id);
          }
          let bindingVisible = true;
          if (typeof binding.visible === "function") {
            bindingVisible = Boolean(binding.visible(state || {}, layerSettings));
          }
          this.setPropertyIfChanged(physicalLayer, "layout", "visibility",
            layerSettings.enabled && bindingVisible ? "visible" : "none");
          if (!available) continue;
          const opacityProperties = [binding.opacityProperty]
            .concat(Array.isArray(binding.extraOpacityProperties) ? binding.extraOpacityProperties : [])
            .filter((property, index, all) => typeof property === "string" && all.indexOf(property) === index);
          for (const property of opacityProperties) {
            this.setPropertyIfChanged(physicalLayer, "paint", property, layerSettings.opacity);
          }
        }
        if (available && descriptor.apply) descriptor.apply(state || {});
      }
      for (const id of this.appliedProperties.keys()) {
        if (!physicalIds.has(id)) this.appliedProperties.delete(id);
      }

      if (!this.orderIsCurrent(physicalOrder, anchor)) {
        const anchorLayer = this.map.getLayer(anchor);
        const before = anchorLayer ? anchor : undefined;
        for (const id of physicalOrder) {
          const physicalLayer = this.map.getLayer(id);
          if (!physicalLayer) continue;
          try {
            this.map.moveLayer(id, before);
          } catch (error) {
            if (this.map.getLayer(id) !== physicalLayer
              || (anchorLayer && this.map.getLayer(anchor) !== anchorLayer)) continue;
            throw error;
          }
        }
      }
      return this;
    }
  }

  function geoJsonStyle(id, color) {
    if (typeof id !== "string" || !/^custom-[a-z0-9-]{1,60}$/.test(id)) {
      throw new Error("Пользовательский слой: некорректный id");
    }
    if (typeof color !== "string" || color.length > 32
      || !/^(#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})|[a-zA-Z]{1,24})$/.test(color)) {
      throw new Error("Пользовательский слой: некорректный цвет");
    }
    const sourceId = `${id}-source`;
    const layers = [
      {
        id: `${id}-fill`, type: "fill", source: sourceId,
        filter: ["==", ["geometry-type"], "Polygon"],
        paint: { "fill-color": color, "fill-opacity": 0.32 },
      },
      {
        id: `${id}-line`, type: "line", source: sourceId,
        filter: ["match", ["geometry-type"], ["LineString", "Polygon"], true, false],
        paint: { "line-color": color, "line-width": 2.5, "line-opacity": 0.9 },
      },
      {
        id: `${id}-point`, type: "circle", source: sourceId,
        filter: ["==", ["geometry-type"], "Point"],
        paint: {
          "circle-color": color, "circle-radius": 5, "circle-opacity": 0.9,
          "circle-stroke-color": "#ffffff", "circle-stroke-width": 1.5,
          "circle-stroke-opacity": 0.9,
        },
      },
    ];
    const bindings = [
      { id: layers[0].id, opacityProperty: "fill-opacity" },
      { id: layers[1].id, opacityProperty: "line-opacity" },
      { id: layers[2].id, opacityProperty: "circle-opacity", extraOpacityProperties: ["circle-stroke-opacity"] },
    ];
    return { sourceId, layers, bindings };
  }

  root.SloiLayerRuntime = Object.freeze({ Runtime, validateGeoJson, geoJsonStyle });
})(typeof window !== "undefined" ? window : globalThis);
