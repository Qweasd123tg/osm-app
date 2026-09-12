(function (root) {
  "use strict";

  const registry = Object.freeze([
    Object.freeze({
      id: "shadows",
      title: "Тени",
      source: "Локальный расчёт",
      dataType: "time-geojson",
      opacityKey: "shadowOpacity",
      defaultOpacity: 0.38,
      defaultEnabled: true,
      min: 0.1,
      max: 0.75,
    }),
    Object.freeze({
      id: "buildings",
      title: "Здания",
      source: "OpenStreetMap",
      dataType: "geojson",
      opacityKey: "buildingOpacity",
      defaultOpacity: 0.96,
      defaultEnabled: true,
      min: 0.1,
      max: 1,
    }),
    Object.freeze({
      id: "wind",
      title: "Ветер",
      source: "Open-Meteo",
      dataType: "geojson",
      opacityKey: "windOpacity",
      defaultOpacity: 0.85,
      defaultEnabled: true,
      min: 0.1,
      max: 1,
    }),
    Object.freeze({
      id: "sun",
      title: "Солнце",
      source: "Положение солнца",
      dataType: "time-geojson",
      opacityKey: "sunOpacity",
      defaultOpacity: 0.9,
      defaultEnabled: false,
      min: 0.1,
      max: 1,
    }),
  ]);

  const defaultLayerOrder = Object.freeze(registry.map((layer) => layer.id));
  const layerIds = new Set(defaultLayerOrder);
  const customIdPattern = /^custom-[a-z0-9-]{1,60}$/;

  function finiteInteger(value, fallback) {
    return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value)
      ? value
      : fallback;
  }

  function clamp(value, min, max, fallback) {
    return typeof value === "number" && Number.isFinite(value)
      ? Math.max(min, Math.min(max, value))
      : fallback;
  }

  function normalizeCustomLayers(value) {
    const result = {};
    if (!value || typeof value !== "object" || Array.isArray(value)) return result;
    for (const id of Object.keys(value)) {
      if (Object.keys(result).length >= 5) break;
      if (!customIdPattern.test(id)) continue;
      const candidate = value[id];
      const layer = candidate && typeof candidate === "object" && !Array.isArray(candidate)
        ? candidate
        : {};
      result[id] = {
        enabled: typeof layer.enabled === "boolean" ? layer.enabled : false,
        opacity: clamp(layer.opacity, 0.1, 1, 0.7),
      };
    }
    return result;
  }

  function normalizeLayerOrder(value, customLayers) {
    const order = [];
    const customIds = new Set(Object.keys(customLayers));
    if (Array.isArray(value)) {
      for (const id of value) {
        if (typeof id === "string"
          && (layerIds.has(id) || customIds.has(id))
          && !order.includes(id)) {
          order.push(id);
        }
      }
    }
    for (const id of defaultLayerOrder) {
      if (!order.includes(id)) order.push(id);
    }
    for (const id of customIds) {
      if (!order.includes(id)) order.push(id);
    }
    return order;
  }

  function normalizeState(input, options) {
    const value = input && typeof input === "object" && !Array.isArray(input) ? input : {};
    const settings = options && typeof options === "object" ? options : {};
    const frameCount = Math.max(1, finiteInteger(settings.frameCount, 1));
    const defaultFrame = clamp(
      finiteInteger(settings.defaultFrame, 0),
      0,
      frameCount - 1,
      0,
    );

    const customLayers = normalizeCustomLayers(value.customLayers);
    const normalized = {
      mode: value.mode === "2d" ? "2d" : "3d",
      basemap: value.basemap === "dark" ? "dark" : "light",
      confidence: typeof value.confidence === "boolean" ? value.confidence : false,
      frame: clamp(finiteInteger(value.frame, defaultFrame), 0, frameCount - 1, defaultFrame),
      customLayers,
      layerOrder: normalizeLayerOrder(value.layerOrder, customLayers),
    };
    for (const layer of registry) {
      normalized[layer.id] = typeof value[layer.id] === "boolean"
        ? value[layer.id]
        : layer.defaultEnabled;
      normalized[layer.opacityKey] = clamp(
        value[layer.opacityKey],
        layer.min,
        layer.max,
        layer.defaultOpacity,
      );
    }
    return normalized;
  }

  function normalizeTimeLabel(value) {
    if (typeof value !== "string") return "";
    const label = value.trim();
    const match = /^(\d{2}):(\d{2})$/.exec(label);
    if (!match || Number(match[1]) > 23 || Number(match[2]) > 59) return "";
    return label;
  }

  function capturePreset(state, frameLabel) {
    const normalized = normalizeState(state, {
      defaultFrame: finiteInteger(state && state.frame, 0),
      frameCount: Math.max(1, finiteInteger(state && state.frame, 0) + 1),
    });
    const { frame: _frame, ...configuration } = normalized;
    return { version: 1, ...configuration, timeLabel: normalizeTimeLabel(frameLabel) };
  }

  function configFromPreset(preset) {
    if (!preset || typeof preset !== "object" || Array.isArray(preset)) return null;
    const config = preset.config && typeof preset.config === "object" ? preset.config : preset;
    return config && config.version === 1 ? config : null;
  }

  function labelAt(value) {
    if (typeof value === "string") return value;
    return value && typeof value.label === "string" ? value.label : "";
  }

  function applyPreset(preset, options) {
    const settings = options && typeof options === "object" ? options : {};
    const labels = Array.isArray(settings.frameLabels) ? settings.frameLabels : [];
    const frameCount = Math.max(1, finiteInteger(settings.frameCount, labels.length || 1));
    const defaultFrame = clamp(
      finiteInteger(settings.defaultFrame, 0),
      0,
      frameCount - 1,
      0,
    );
    const config = configFromPreset(preset);
    if (!config) return normalizeState(null, { defaultFrame, frameCount });

    const timeLabel = normalizeTimeLabel(config.timeLabel);
    const matchedFrame = timeLabel
      ? labels.findIndex((label) => labelAt(label) === timeLabel)
      : -1;
    return normalizeState(
      { ...config, frame: matchedFrame >= 0 ? matchedFrame : defaultFrame },
      { defaultFrame, frameCount },
    );
  }

  function normalizePresetConfig(value) {
    if (!value || typeof value !== "object" || Array.isArray(value) || value.version !== 1) {
      return null;
    }
    if (!normalizeTimeLabel(value.timeLabel)) return null;
    return capturePreset(value, value.timeLabel);
  }

  function normalizePresets(input) {
    if (!Array.isArray(input)) return [];
    const result = [];
    const ids = new Set();
    for (const item of input) {
      if (result.length >= 20) break;
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      const id = typeof item.id === "string" ? item.id.trim() : "";
      const name = typeof item.name === "string" ? item.name.trim().slice(0, 48) : "";
      const config = normalizePresetConfig(item.config);
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(id) || ids.has(id) || !name || !config) continue;
      ids.add(id);
      result.push({ id, name, config });
    }
    return result;
  }

  root.SloiLayerSettings = Object.freeze({
    registry,
    normalizeState,
    capturePreset,
    applyPreset,
    normalizePresets,
  });
})(typeof window !== "undefined" ? window : globalThis);
