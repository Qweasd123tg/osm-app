(function (root) {
  "use strict";

  const storageKey = "sloi-map-camera";
  const defaultCamera = Object.freeze({
    center: Object.freeze([0, 20]),
    zoom: 2,
    bearing: 0,
    pitch: 0,
  });

  function within(value, min, max) {
    return typeof value === "number" && Number.isFinite(value)
      && value >= min && value <= max;
  }

  function normalize(input) {
    try {
      if (!input || typeof input !== "object" || Array.isArray(input)) return null;
      const { center, zoom, bearing, pitch } = input;
      if (!Array.isArray(center) || center.length !== 2
        || !within(center[0], -180, 180) || !within(center[1], -85.051129, 85.051129)
        || !within(zoom, 1, 19) || !within(bearing, -180, 180)
        || !within(pitch, 0, 60)) return null;
      return { center: [center[0], center[1]], zoom, bearing, pitch };
    } catch (_) {
      return null;
    }
  }

  function load(storage) {
    try {
      return normalize(JSON.parse(storage.getItem(storageKey)));
    } catch (_) {
      return null;
    }
  }

  function clamp(value, min, max) {
    return typeof value === "number" && Number.isFinite(value)
      ? Math.max(min, Math.min(max, value))
      : value;
  }

  function save(storage, map) {
    try {
      const center = map.getCenter();
      const longitude = typeof center.lng === "number" && Number.isFinite(center.lng)
        && !within(center.lng, -180, 180)
        ? ((center.lng + 180) % 360 + 360) % 360 - 180
        : center.lng;
      const camera = normalize({
        center: [longitude, center.lat],
        zoom: clamp(map.getZoom(), 1, 19),
        bearing: map.getBearing(),
        pitch: clamp(map.getPitch(), 0, 60),
      });
      if (!camera) return false;
      storage.setItem(storageKey, JSON.stringify(camera));
      return true;
    } catch (_) {
      return false;
    }
  }

  // Ground distance across the fixed 100 CSS-pixel scale, independent of DPR.
  function scaleMeters(latitude, zoom) {
    return Math.cos(Math.max(-85, Math.min(85, latitude)) * Math.PI / 180) * 40075016.68557849 / (512 * 2 ** zoom) * 100;
  }

  function createPitchController(initialPitch = 0) {
    let intent = Math.max(0, Math.min(60, Number(initialPitch) || 0));
    return {
      get intent() { return intent; },
      select(pitch) { intent = Math.max(0, Math.min(60, Number(pitch) || 0)); },
      update(next) {
        // Zoom and location never alter pitch. Only explicit camera/pitch input does.
        intent = Math.max(0, Math.min(60, Number(next.pitch) || 0));
        return { pitch: intent };
      },
    };
  }

  root.SloiMapCamera = Object.freeze({ defaultCamera, normalize, load, save, scaleMeters, createPitchController });
})(typeof window !== "undefined" ? window : globalThis);
