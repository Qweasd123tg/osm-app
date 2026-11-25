(function (root) {
  "use strict";

  const STORAGE_KEY = "sloi-modules-state";
  const limits = Object.freeze({ maxSettingsBytes: 16384, maxSources: 4, maxGeoJsonBytes: 2 * 1024 * 1024, maxPointLabels: 128, maxVehicleImages: 64, moveDebounceMs: 120 });
  const idPattern = /^[a-z][a-z0-9-]{0,47}$/;
  const forbidden = new Set(["__proto__", "constructor", "prototype"]);
  const pointIconTypes = new Set(["bus", "tram", "trolley", "metro", "metro-plain"]);

  function json(value, label, maxBytes) {
    const serialized = JSON.stringify(value, (key, item) => {
      if (forbidden.has(key)) throw new Error(`${label}: запрещённое поле ${key}`);
      if (typeof item === "number" && !Number.isFinite(item)) throw new Error(`${label}: число должно быть конечным`);
      if (typeof item === "function" || typeof item === "undefined" || typeof item === "symbol" || typeof item === "bigint") throw new Error(`${label}: требуются JSON-данные`);
      return item;
    });
    if (typeof serialized !== "string" || new TextEncoder().encode(serialized).length > maxBytes) throw new Error(`${label}: превышен лимит данных`);
    return JSON.parse(serialized);
  }

  function settingsObject(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Настройки должны быть объектом");
    const copy = json(value, "Настройки", limits.maxSettingsBytes);
    for (const item of Object.values(copy)) {
      if (item !== null && !["string", "number", "boolean"].includes(typeof item)) throw new Error("Настройки поддерживают строки, числа, флаги и null");
    }
    return copy;
  }

  function normalizeManifest(input) {
    if (!input || typeof input !== "object" || !idPattern.test(input.id) || input.apiVersion !== 1) throw new Error("Несовместимый манифест модуля");
    for (const key of ["title", "version"]) if (typeof input[key] !== "string" || !input[key].trim() || input[key].length > 120) throw new Error(`Манифест: некорректное ${key}`);
    if (!Array.isArray(input.capabilities) || input.capabilities.some((item) => item !== "geojson" && item !== "shadows")) throw new Error("Манифест: неподдерживаемые возможности");
    const defaults = Object.freeze(settingsObject(input.defaults || {}));
    return Object.freeze({ id: input.id, apiVersion: 1, version: input.version, title: input.title, description: typeof input.description === "string" ? input.description.slice(0, 1000) : "", example: input.example === true, capabilities: Object.freeze([...new Set(input.capabilities)]), defaults });
  }

  function mergeSettings(defaults, current, patch) {
    const safe = settingsObject(patch);
    for (const [key, value] of Object.entries(safe)) {
      if (!Object.prototype.hasOwnProperty.call(defaults, key) || typeof value !== typeof defaults[key] || (value === null) !== (defaults[key] === null)) throw new Error(`Неизвестная настройка или неверный тип: ${key}`);
    }
    return Object.freeze(settingsObject({ ...current, ...safe }));
  }

  class Host {
    constructor(options) {
      if (!options || !options.map) throw new Error("Карта не задана");
      this.map = options.map;
      this.storage = options.storage;
      this.onChange = typeof options.onChange === "function" ? options.onChange : () => {};
      this.anchor = options.anchor || "selected-location";
      this.vehicleAnchor = options.vehicleAnchor || this.anchor;
      const services = options.services || {};
      if (!services || typeof services !== "object" || Array.isArray(services)
        || Object.keys(services).some((key) => key !== "shadows" || typeof services[key] !== "function")) {
        throw new Error("Неподдерживаемый сервис модуля");
      }
      this.shadowService = Object.prototype.hasOwnProperty.call(services, "shadows") ? services.shadows : undefined;
      this.shadowOwner = null;
      this.entries = new Map();
      this.suspended = false;
      this.disposed = false;
      this.storageWarning = null;
    }

    register(input, factory) {
      if (this.disposed) throw new Error("Host закрыт");
      const manifest = normalizeManifest(input);
      if (this.entries.has(manifest.id) || typeof factory !== "function") throw new Error("Модуль уже зарегистрирован или не имеет фабрики");
      this.entries.set(manifest.id, { manifest, factory, settings: manifest.defaults, enabled: false, status: "disabled", error: null, warning: null, session: null });
      this.notify();
      return this;
    }

    entry(id) {
      const entry = this.entries.get(id);
      if (!entry) throw new Error(`Модуль ${id} не зарегистрирован`);
      return entry;
    }

    get(id) {
      const entry = this.entry(id);
      const boxes = [...(entry.session?.sources.values() || [])].map((source) => source.bounds).filter(Boolean);
      const bounds = boxes.length ? [[Math.min(...boxes.map((box) => box[0][0])), Math.min(...boxes.map((box) => box[0][1]))], [Math.max(...boxes.map((box) => box[1][0])), Math.max(...boxes.map((box) => box[1][1]))]] : null;
      return Object.freeze({ ...entry.manifest, manifest: entry.manifest, settings: Object.freeze({ ...entry.settings }), enabled: entry.enabled, status: entry.status, error: entry.error, warning: entry.warning, bounds, storageWarning: this.storageWarning });
    }

    list() { return [...this.entries.keys()].map((id) => this.get(id)); }

    notify(change) {
      try { this.onChange(this.list(), change); } catch (error) { if (root.console) root.console.warn("Module observer failed", error); }
    }

    persist() {
      if (!this.storage) return;
      try {
        const modules = Object.fromEntries([...this.entries].map(([id, entry]) => [id, { enabled: entry.enabled, settings: entry.settings }]));
        this.storage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, modules }));
        this.storageWarning = null;
      } catch (_) { this.storageWarning = "Настройки модулей не сохраняются"; }
    }

    async restore() {
      if (this.disposed) return;
      let records = {};
      try {
        const value = this.storage && this.storage.getItem(STORAGE_KEY);
        if (value) {
          if (value.length > 512 * 1024) throw new Error("Слишком большая запись");
          const parsed = JSON.parse(value);
          if (parsed.version !== 1 || !parsed.modules || typeof parsed.modules !== "object" || Array.isArray(parsed.modules)) throw new Error("Несовместимая запись");
          records = parsed.modules;
        }
      } catch (_) { this.storageWarning = "Не удалось прочитать настройки модулей"; }
      const work = [];
      for (const [id, entry] of this.entries) {
        if (!Object.prototype.hasOwnProperty.call(records, id)) continue;
        const record = records[id];
        try {
          if (!record || typeof record.enabled !== "boolean") throw new Error("Повреждённая запись");
          const settings = mergeSettings(entry.manifest.defaults, entry.manifest.defaults, record.settings);
          this.stop(entry);
          entry.settings = settings;
          entry.enabled = record.enabled;
          entry.error = null;
          entry.status = entry.enabled ? "paused" : "disabled";
          if (entry.enabled && !this.suspended) work.push(this.start(entry));
        } catch (_) { entry.error = "Сохранённые настройки модуля повреждены"; }
      }
      this.notify();
      await Promise.all(work);
    }

    async enable(id) {
      if (this.disposed) throw new Error("Host закрыт");
      const entry = this.entry(id);
      if (entry.enabled && entry.session) return entry.session.promise;
      entry.enabled = true;
      entry.error = null;
      this.persist();
      if (this.suspended) { entry.status = "paused"; this.notify(); return this.get(id); }
      return this.start(entry);
    }

    disable(id) {
      const entry = this.entry(id);
      entry.enabled = false;
      this.stop(entry);
      entry.status = "disabled";
      entry.error = null;
      this.persist();
      this.notify();
      return this.get(id);
    }

    async configure(id, patch) {
      if (this.disposed) throw new Error("Host закрыт");
      const entry = this.entry(id);
      const settings = mergeSettings(entry.manifest.defaults, entry.settings, patch);
      if (JSON.stringify(settings) === JSON.stringify(entry.settings)) return this.get(id);
      this.stop(entry);
      entry.settings = settings;
      entry.error = null;
      this.persist();
      if (entry.enabled && !this.suspended) return this.start(entry);
      entry.status = entry.enabled ? "paused" : "disabled";
      this.notify();
      return this.get(id);
    }

    async refresh(id) {
      if (this.disposed) throw new Error("Host закрыт");
      const entry = this.entry(id);
      if (entry.enabled && !this.suspended) return this.start(entry);
      return this.get(id);
    }

    cleanupCallback(callback) {
      try { const result = callback(); if (result && typeof result.catch === "function") result.catch(() => {}); } catch (_) { /* Cleanup cannot retain other owned resources. */ }
    }

    stop(entry) {
      entry.warning = null;
      const session = entry.session;
      if (!session) return;
      entry.session = null;
      session.controller.abort();
      for (const callback of session.cleanups.splice(0).reverse()) this.cleanupCallback(callback);
    }

    fail(entry, session, error) {
      if (entry.session !== session || session.controller.signal.aborted) return;
      this.stop(entry);
      entry.status = "error";
      entry.error = String(error && error.message || error || "Ошибка модуля").slice(0, 400);
      this.notify();
    }

    start(entry) {
      this.stop(entry);
      const session = { controller: new AbortController(), cleanups: [], sources: new Map(), labelImages: new Map(), labelKeys: new Map(), nextLabelImage: 0, labelCleanup: false, vehicleImages: new Map(), vehicleKeys: new Map(), nextVehicleImage: 0, vehicleCleanup: false, promise: null, shadowsRequested: false };
      entry.session = session;
      entry.status = "loading";
      entry.error = null;
      const assertCurrent = () => {
        if (entry.session !== session || session.controller.signal.aborted) {
          const error = new Error("Работа модуля отменена"); error.name = "AbortError"; throw error;
        }
      };
      const getView = () => {
        assertCurrent();
        const center = this.map.getCenter();
        const bounds = this.map.getBounds();
        return Object.freeze({ center: Object.freeze([center.lng, center.lat]), zoom: this.map.getZoom(), bounds: Object.freeze([[bounds.getWest(), bounds.getSouth()], [bounds.getEast(), bounds.getNorth()]].map(Object.freeze)) });
      };
      const labelText = value => typeof value === "string" || typeof value === "number" ? String(value).trim().slice(0, 48) : "";
      const pruneLabels = () => {
        const used = new Set([...session.labelKeys.values()].flatMap(keys => [...keys]));
        for (const [cacheKey, id] of session.labelImages) if (!used.has(cacheKey)) {
          if (this.map.hasImage(id)) this.map.removeImage(id);
          session.labelImages.delete(cacheKey);
        }
      };
      const labelKey = (text, color, style) => (style === "text" ? `text-${root.document?.documentElement?.dataset?.theme || "light"}|` : `${style}|`) + color + "|" + text;
      const labelImage = (value, color, style) => {
        const text = labelText(value);
        if (!text) return "";
        const cacheKey = labelKey(text, color, style);
        if (session.labelImages.has(cacheKey)) return session.labelImages.get(cacheKey);
        if (session.labelImages.size >= limits.maxPointLabels) return "";
        const id = `module-${entry.manifest.id}:label-${session.nextLabelImage++}`;
        // Images belong to this session just like its layers/sources. Never
        // claim or later remove an image inserted by another owner.
        if (this.map.hasImage(id)) return "";
        const canvas = root.document.createElement("canvas"), context = canvas.getContext("2d");
        if (!context) return "";
        const font = style === "vehicle" ? "700 12px sans-serif" : "600 12px sans-serif";
        context.font = font;
        const width = Math.min(250, Math.max(style === "vehicle" ? 16 : 20, Math.ceil(context.measureText(text).width) + (style === "vehicle" ? 8 : 10))), height = style === "vehicle" ? 15 : 21;
        const pixelRatio = style === "vehicle" ? (root.SloiVehicleMarkers?.pixelRatio || 2) : 2;
        canvas.width = width * pixelRatio; canvas.height = height * pixelRatio;
        context.scale(pixelRatio, pixelRatio); context.font = font;
        if (style !== "text") {
          context.fillStyle = style === "vehicle" ? "#ffffff" : "rgba(255,255,255,.94)";
          context.beginPath();
          const radius = style === "vehicle" ? 3 : 4;
          context.moveTo(radius, 0); context.lineTo(width - radius, 0); context.quadraticCurveTo(width, 0, width, radius);
          context.lineTo(width, height - radius); context.quadraticCurveTo(width, height, width - radius, height);
          context.lineTo(radius, height); context.quadraticCurveTo(0, height, 0, height - radius);
          context.lineTo(0, radius); context.quadraticCurveTo(0, 0, radius, 0); context.fill();
        }
        context.fillStyle = color; context.textBaseline = "middle"; context.textAlign = "center";
        if (style === "text") {
          context.strokeStyle = root.document?.documentElement?.dataset?.theme === "dark" ? "#24272d" : "#ffffff";
          context.lineWidth = 3; context.lineJoin = "round";
          context.strokeText(text, width / 2, height / 2 + .5, width - 8);
        }
        context.fillText(text, width / 2, height / 2 + .5, width - 8);
        this.map.addImage(id, context.getImageData(0, 0, canvas.width, canvas.height), { pixelRatio });
        session.labelImages.set(cacheKey, id);
        // Layer/source cleanups run first, then the now-unreferenced badges.
        if (!session.labelCleanup) {
          session.labelCleanup = true;
          session.cleanups.unshift(() => {
            for (const id of session.labelImages.values()) { try { if (this.map.hasImage(id)) this.map.removeImage(id); } catch (_) {} }
            session.labelImages.clear(); session.labelKeys.clear();
          });
        }
        return id;
      };
      const removeVehicleImage = owned => {
        if (this.map.hasImage(owned.id) && (typeof this.map.getImage !== "function" || this.map.getImage(owned.id) === owned.image)) this.map.removeImage(owned.id);
      };
      const pruneVehicleImages = () => {
        const used = new Set([...session.vehicleKeys.values()].flatMap(keys => [...keys]));
        for (const [key, owned] of session.vehicleImages) if (!used.has(key)) {
          removeVehicleImage(owned); session.vehicleImages.delete(key);
        }
      };
      const vehicleImage = (key, draw) => {
        if (session.vehicleImages.has(key)) return session.vehicleImages.get(key).id;
        if (session.vehicleImages.size >= limits.maxVehicleImages) return "";
        let id;
        // Skip foreign resources instead of claiming them during later cleanup.
        for (let attempt = 0; attempt < 128; attempt++) {
          const candidate = `module-${entry.manifest.id}:vehicle-${session.nextVehicleImage++}`;
          if (!this.map.hasImage(candidate)) { id = candidate; break; }
        }
        if (!id) return "";
        const image = draw();
        if (!image) return "";
        this.map.addImage(id, image, { pixelRatio: root.SloiVehicleMarkers.pixelRatio });
        session.vehicleImages.set(key, { id, image: this.map.getImage?.(id) });
        if (!session.vehicleCleanup) {
          session.vehicleCleanup = true;
          session.cleanups.unshift(() => {
            for (const owned of session.vehicleImages.values()) { try { removeVehicleImage(owned); } catch (_) {} }
            session.vehicleImages.clear(); session.vehicleKeys.clear();
          });
        }
        return id;
      };
      const iconKey = (type, tint, background = "none") => {
        if (type === "metro") return "icon|metro";
        return background === "none" ? `icon|${type}|${tint}` : `icon|${type}|${background}|${tint}`;
      };
      const iconImage = (type, tint, background = "none") => vehicleImage(iconKey(type, tint, background), () => root.SloiVehicleMarkers.icon(type, tint, background));
      const context = Object.freeze({
        signal: session.controller.signal,
        settings: entry.settings,
        map: Object.freeze({ getView }),
        getView,
        useShadows: async (options) => {
          assertCurrent();
          if (!entry.manifest.capabilities.includes("shadows")) throw new Error("У модуля нет возможности shadows");
          if (typeof this.shadowService !== "function") throw new Error("Расчёт теней недоступен на этом устройстве");
          const safe = settingsObject(options);
          if (Object.keys(safe).length !== 1 || typeof safe.opacity !== "number"
            || !Number.isFinite(safe.opacity) || safe.opacity < .1 || safe.opacity > .75) {
            throw new Error("Некорректные настройки расчёта теней");
          }
          if (session.shadowsRequested) throw new Error("Сервис теней уже запрошен модулем");
          if (this.shadowOwner) throw new Error("Сервис теней уже используется другим модулем");
          session.shadowsRequested = true;
          this.shadowOwner = session;
          let released = false;
          let cleanup = null;
          const release = () => {
            if (released) return;
            released = true;
            if (this.shadowOwner === session) this.shadowOwner = null;
            if (cleanup) this.cleanupCallback(cleanup);
          };
          session.cleanups.push(release);
          try {
            const result = await this.shadowService(Object.freeze(safe), session.controller.signal);
            if (typeof result !== "function") throw new Error("Сервис теней должен вернуть функцию очистки");
            cleanup = result;
            if (released) this.cleanupCallback(cleanup);
            assertCurrent();
          } catch (error) {
            release();
            throw error;
          }
        },
        setGeoJson: (localId, data, options = {}) => {
          assertCurrent();
          if (!entry.manifest.capabilities.includes("geojson")) throw new Error("У модуля нет возможности geojson");
          if (!idPattern.test(localId)) throw new Error("Некорректный id источника");
          let safe = json(data, "GeoJSON", limits.maxGeoJsonBytes);
          const runtime = root.SloiLayerRuntime;
          if (!runtime) throw new Error("GeoJSON runtime недоступен");
          const color = options.color === undefined ? "#286b52" : options.color;
          const opacity = options.opacity === undefined ? 0.8 : options.opacity;
          const pointMinZoom = options.pointMinZoom === undefined ? 0 : options.pointMinZoom;
          const pointLabelMinZoom = options.pointLabelMinZoom === undefined ? pointMinZoom : options.pointLabelMinZoom;
          const pointRadius = options.pointRadius === undefined ? 5 : options.pointRadius;
          const pointLabel = options.pointLabel === undefined ? null : options.pointLabel;
          const pointLabelColorProperty = options.pointLabelColorProperty === undefined ? null : options.pointLabelColorProperty;
          const pointOpacity = options.pointOpacity === undefined ? null : options.pointOpacity;
          const colorProperty = options.colorProperty === undefined ? null : options.colorProperty;
          const pointLabelStyle = options.pointLabelStyle === undefined ? "badge" : options.pointLabelStyle;
          const pointMarker = options.pointMarker === undefined ? "circle" : options.pointMarker;
          const pointIcon = options.pointIcon === undefined ? null : options.pointIcon;
          const pointIconBackground = options.pointIconBackground === undefined ? "none" : options.pointIconBackground;
          const pointIconMinZoom = options.pointIconMinZoom === undefined ? pointMinZoom : options.pointIconMinZoom;
          const pointIconSize = options.pointIconSize === undefined ? .65 : options.pointIconSize;
          const pointHeading = options.pointHeading === undefined ? "heading" : options.pointHeading;
          const pointType = options.pointType === undefined ? "vehicleType" : options.pointType;
          const pointTransitionMs = options.pointTransitionMs === undefined ? 0 : options.pointTransitionMs;
          if (!Number.isFinite(pointTransitionMs) || pointTransitionMs < 0 || pointTransitionMs > 16000
            || (pointTransitionMs > 0 && pointMarker !== "vehicle")) throw new Error("Некорректная длительность движения транспорта");
          if (!["circle", "vehicle"].includes(pointMarker)) throw new Error("Некорректный вид маркера точек");
          if (!["badge", "text", "vehicle"].includes(pointLabelStyle)) throw new Error("Некорректный стиль подписи точек");
          if (!Number.isFinite(pointMinZoom) || pointMinZoom < 0 || pointMinZoom > 24) throw new Error("Некорректный масштаб точек слоя");
          if (!Number.isFinite(pointLabelMinZoom) || pointLabelMinZoom < pointMinZoom || pointLabelMinZoom > 24) throw new Error("Некорректный масштаб подписей слоя");
          if (!Number.isFinite(pointRadius) || pointRadius < 2 || pointRadius > 16) throw new Error("Некорректный размер точек слоя");
          if (pointIconBackground !== "none" && (pointIconBackground !== "rounded" || !["bus", "tram", "trolley"].includes(pointIcon))) {
            throw new Error("Некорректный фон пиктограммы точек");
          }
          if (pointIcon !== null) {
            if (pointMarker !== "circle" || !pointIconTypes.has(pointIcon)) throw new Error("Некорректная пиктограмма точек слоя");
            if (!Number.isFinite(pointIconMinZoom) || pointIconMinZoom < pointMinZoom || pointIconMinZoom > 24) throw new Error("Некорректный масштаб пиктограмм точек");
            if (!Number.isFinite(pointIconSize) || pointIconSize < .3 || pointIconSize > 1) throw new Error("Некорректный размер пиктограмм точек");
          }
          for (const property of [pointLabel, pointLabelColorProperty, pointOpacity, colorProperty, ...(pointMarker === "vehicle" ? [pointHeading, pointType] : [])]) if (property !== null && (typeof property !== "string" || !/^[a-zA-Z_][a-zA-Z0-9_]{0,31}$/.test(property))) throw new Error("Некорректное поле оформления точек");
          if (pointMarker === "vehicle" && (pointHeading === null || pointType === null)) throw new Error("Требуются поля вида и направления транспорта");
          if (typeof color !== "string" || !/^#[0-9a-fA-F]{6}$/.test(color) || typeof opacity !== "number" || !Number.isFinite(opacity) || opacity < 0 || opacity > 1) throw new Error("Некорректное оформление GeoJSON");
          const previousMotion = session.sources.get(localId)?.motion;
          if (previousMotion) safe = previousMotion.prepare(safe);
          // Normalize before creating paint expressions or canvas images. A
          // malformed feature value falls back to the module's literal color.
          const featureColor = feature => colorProperty !== null && typeof feature?.properties?.[colorProperty] === "string" && /^#[0-9a-fA-F]{6}$/.test(feature.properties[colorProperty]) ? feature.properties[colorProperty].toLowerCase() : color;
          if (colorProperty !== null && safe?.type === "FeatureCollection" && Array.isArray(safe.features)) {
            for (const feature of safe.features) if (feature?.type === "Feature") feature.properties = { ...feature.properties, __moduleColor: featureColor(feature) };
          }
          const paintColor = colorProperty === null ? color : ["coalesce", ["get", "__moduleColor"], color];
          const featureLabelColor = feature => pointLabelColorProperty !== null && typeof feature?.properties?.[pointLabelColorProperty] === "string"
            && /^#[0-9a-fA-F]{6}$/.test(feature.properties[pointLabelColorProperty]) ? feature.properties[pointLabelColorProperty].toLowerCase() : featureColor(feature);
          if (pointLabelColorProperty !== null) for (const feature of safe.features || []) {
            if (feature?.type === "Feature") feature.properties = { ...feature.properties, __moduleLabelColor: featureLabelColor(feature) };
          }
          const paintLabelColor = pointLabelColorProperty === null ? paintColor : ["coalesce", ["get", "__moduleLabelColor"], paintColor];
          const markerSprites = root.SloiVehicleMarkers;
          const supportsImages = typeof root.document?.createElement === "function" && typeof this.map.addImage === "function"
            && typeof this.map.hasImage === "function" && typeof this.map.removeImage === "function";
          const supportsMarkerSprites = Boolean(markerSprites) && Boolean(root.SloiTransportSymbols)
            && supportsImages && typeof root.Path2D === "function";
          const vehicleMarkers = pointMarker === "vehicle" && supportsMarkerSprites;
          const pointIcons = pointIcon !== null && supportsMarkerSprites;
          if (vehicleMarkers && safe?.type === "FeatureCollection" && Array.isArray(safe.features)) {
            const points = safe.features.filter(feature => feature?.geometry?.type === "Point");
            const heading = feature => typeof feature.properties?.[pointHeading] === "number" && Number.isFinite(feature.properties[pointHeading])
              && feature.properties[pointHeading] >= 0 && feature.properties[pointHeading] < 360 ? feature.properties[pointHeading] : null;
            const bodyKey = (color, directed) => `body|${color}|${directed ? "directional" : "neutral"}`;
            const neutralColor = "#59616d";
            const commonKeys = [bodyKey(neutralColor, true), bodyKey(neutralColor, false), ...markerSprites.types.flatMap(type => [iconKey(type, "#ffffff"), iconKey(type, "#1f2937")])];
            const fallbackKeys = [bodyKey(color, true), bodyKey(color, false)];
            const wanted = new Set(points.length ? [...commonKeys, ...fallbackKeys] : []);
            for (const feature of points) {
              wanted.add(bodyKey(featureColor(feature), heading(feature) !== null));
              const type = feature.properties?.[pointType];
              if (markerSprites.types.includes(type)) wanted.add(iconKey(type, markerSprites.foreground(featureColor(feature))));
            }
            session.vehicleKeys.set(localId, wanted); pruneVehicleImages();
            // Reserve each source's default bodies before optional custom colors.
            // An exhausted texture budget must not hide a vehicle entirely.
            const common = points.length ? Object.fromEntries([true, false].map(directed => [String(directed), vehicleImage(bodyKey(neutralColor, directed), () => root.SloiVehicleMarkers.body(neutralColor, directed))])) : {};
            if (points.length) for (const type of markerSprites.types) for (const foreground of ["#ffffff", "#1f2937"]) iconImage(type, foreground);
            const defaults = points.length ? Object.fromEntries([true, false].map(directed => [String(directed), vehicleImage(bodyKey(color, directed), () => root.SloiVehicleMarkers.body(color, directed)) || common[String(directed)]])) : {};
            for (const feature of points) {
              const course = heading(feature), directed = course !== null, type = feature.properties?.[pointType], tint = featureColor(feature);
              const customBody = vehicleImage(bodyKey(tint, directed), () => root.SloiVehicleMarkers.body(tint, directed));
              const fallback = defaults[String(directed)];
              const body = customBody || fallback || "";
              const actualTint = customBody ? tint : fallback === common[String(directed)] ? neutralColor : color;
              const foreground = markerSprites.foreground(actualTint);
              const icon = markerSprites.types.includes(type) ? iconImage(type, foreground) : "";
              feature.properties = { ...feature.properties, __moduleVehicleBodyImage: body, __moduleVehicleIconImage: icon, __moduleVehicleHeading: course ?? 0, __moduleVehicleHeadingKnown: course !== null };
            }
          }
          // Locally rasterized badges avoid a dependency on the basemap's font
          // server: a failed glyph request must not hide the entire live source.
          const rasterLabels = pointLabel !== null && supportsImages;
          if (rasterLabels && safe?.type === "FeatureCollection" && Array.isArray(safe.features)) {
            session.labelKeys.set(localId, new Set(safe.features.filter(feature => feature?.geometry?.type === "Point")
              .filter(feature => labelText(feature.properties?.[pointLabel])).map(feature => labelKey(labelText(feature.properties?.[pointLabel]), featureLabelColor(feature), pointLabelStyle))));
            pruneLabels();
            for (const feature of safe.features) if (feature?.geometry?.type === "Point") {
              feature.properties = { ...feature.properties, __moduleLabelImage: labelImage(feature.properties?.[pointLabel], featureLabelColor(feature), pointLabelStyle) };
            }
            safe = json(safe, "GeoJSON", limits.maxGeoJsonBytes);
          }
          // A viewport can legitimately contain no features. Imports still use
          // their stricter validator, while modules can clear an owned source.
          const checked = safe && safe.type === "FeatureCollection" && Array.isArray(safe.features) && safe.features.length === 0
            ? { data: safe, bounds: null, featureCount: 0 }
            : runtime.validateGeoJson(safe);
          if (pointIcons) {
            const points = checked.data.features.filter(feature => ["Point", "MultiPoint"].includes(feature.geometry.type));
            const colors = points.map(featureColor);
            const useFeatureTint = pointIconBackground === "rounded" || pointIcon === "metro-plain";
            const tints = colors.map(color => useFeatureTint ? color.toLowerCase() : markerSprites.foreground(color));
            session.vehicleKeys.set(localId, new Set(tints.map(tint => iconKey(pointIcon, tint, pointIconBackground))));
            pruneVehicleImages();
            for (const [index, feature] of points.entries()) {
              if (colorProperty !== null) feature.properties.__moduleColor = colors[index];
              feature.properties.__modulePointIconImage = iconImage(pointIcon, tints[index], pointIconBackground);
            }
            checked.data = json(checked.data, "GeoJSON", limits.maxGeoJsonBytes);
          }
          const pointAlpha = pointOpacity === null ? opacity : ["*", opacity, ["min", 1, ["max", 0, ["to-number", ["get", pointOpacity], 1]]]];
          const pointIconImage = ["get", "__modulePointIconImage"];
          // Keep the ordinary point if the entrance symbol cannot be drawn.
          const circleAlpha = pointIcons && (pointIcon === "metro-plain" || pointIconBackground === "rounded")
            ? ["step", ["zoom"], pointAlpha, pointIconMinZoom, ["case", ["==", pointIconImage, ""], pointAlpha, 0]]
            : pointAlpha;
          const id = `module-${entry.manifest.id}:${localId}`;
          let record = session.sources.get(localId);
          const existingSource = Boolean(record);
          if (!record) {
            if (session.sources.size >= limits.maxSources) throw new Error("Достигнут лимит источников модуля");
            const source = `${id}-source`;
            const iconLayer = vehicleMarkers ? `${id}-vehicle-icon` : pointIcons ? `${id}-point-icon` : null;
            record = {
              source, layers: [`${id}-fill`, `${id}-line`, `${id}-point`], pointLabel, pointMarker, vehicleMarkers,
              pointIcon, pointIcons, pointIconBackground, pointIconMinZoom, pointIconSize, iconLayer, ownedSource: null, ownedLayers: [], motion: null, pointLabelColorProperty, pointLabelStyle,
            };
            if (pointLabel !== null) record.layers.push(`${id}-label`);
            if (iconLayer) record.layers.push(iconLayer);
            session.sources.set(localId, record);
            session.cleanups.push(() => {
              for (const owned of [...record.ownedLayers].reverse()) { try { if (this.map.getLayer(owned.id) === owned.layer) this.map.removeLayer(owned.id); } catch (_) {} }
              try { if (record.ownedSource && this.map.getSource(source) === record.ownedSource) this.map.removeSource(source); } catch (_) {}
            });
            try {
              if (this.map.getSource(source) || record.layers.some((layerId) => this.map.getLayer(layerId))) throw new Error("Ресурсы модуля уже существуют на карте");
              this.map.addSource(source, { type: "geojson", data: checked.data });
              record.ownedSource = this.map.getSource(source);
              const specs = [
                { id: record.layers[0], type: "fill", source, filter: ["==", ["geometry-type"], "Polygon"], paint: { "fill-color": paintColor, "fill-opacity": opacity * 0.4 } },
                { id: record.layers[1], type: "line", source, filter: ["match", ["geometry-type"], ["LineString", "Polygon"], true, false], paint: { "line-color": paintColor, "line-opacity": opacity, "line-width": 3 } },
                vehicleMarkers ? { id: record.layers[2], type: "symbol", source, minzoom: pointMinZoom,
                  filter: ["all", ["==", ["geometry-type"], "Point"], ["!=", ["get", "__moduleVehicleBodyImage"], ""]],
                  layout: { "icon-image": ["get", "__moduleVehicleBodyImage"], "icon-size": .95, "icon-anchor": "center", "icon-rotate": ["get", "__moduleVehicleHeading"],
                    "icon-rotation-alignment": "map", "icon-pitch-alignment": "viewport", "icon-keep-upright": false, "icon-allow-overlap": true, "icon-ignore-placement": true },
                  paint: { "icon-opacity": pointAlpha } }
                  : { id: record.layers[2], type: "circle", source, minzoom: pointMinZoom, filter: ["==", ["geometry-type"], "Point"],
                    paint: { "circle-color": paintColor, "circle-opacity": circleAlpha, "circle-radius": pointRadius, "circle-stroke-color": "#ffffff",
                      "circle-stroke-width": 1.5, "circle-stroke-opacity": circleAlpha, "circle-pitch-alignment": "viewport", "circle-pitch-scale": "viewport" } },
              ];
              if (pointLabel !== null) specs.push(rasterLabels ? { id: record.layers[3], type: "symbol", source, minzoom: pointLabelMinZoom,
                filter: ["all", ["==", ["geometry-type"], "Point"], ["!=", ["get", "__moduleLabelImage"], ""]], layout: { "icon-image": ["get", "__moduleLabelImage"], "icon-offset": pointLabelStyle === "vehicle" ? [-10, -10] : [0, vehicleMarkers ? 20 : 10], "icon-anchor": pointLabelStyle === "vehicle" ? "bottom-right" : "top", "icon-rotation-alignment": "viewport", "icon-pitch-alignment": "viewport", "icon-allow-overlap": false },
                paint: { "icon-opacity": pointAlpha } } : { id: record.layers[3], type: "symbol", source, minzoom: pointLabelMinZoom,
                filter: ["==", ["geometry-type"], "Point"], layout: { "text-field": ["to-string", ["get", pointLabel]], "text-font": ["Noto Sans Regular"], "text-size": 12, "text-offset": [0, vehicleMarkers ? 1.8 : 1.1], "text-anchor": "top", "text-allow-overlap": false, "text-optional": true },
                paint: { "text-color": paintLabelColor, "text-opacity": pointAlpha, "text-halo-color": "#ffffff", "text-halo-width": 1.5 } });
              if (record.iconLayer) {
                const image = vehicleMarkers ? ["get", "__moduleVehicleIconImage"] : pointIconImage;
                specs.push({
                  id: record.iconLayer, type: "symbol", source, minzoom: vehicleMarkers ? pointMinZoom : pointIconMinZoom,
                  filter: ["all", ["==", ["geometry-type"], "Point"], ["!=", image, ""]],
                  layout: { "icon-image": image, "icon-size": vehicleMarkers ? .95 : pointIconSize, "icon-anchor": "center", "icon-rotate": 0,
                    "icon-rotation-alignment": "viewport", "icon-pitch-alignment": "viewport", "icon-allow-overlap": true, "icon-ignore-placement": true },
                  paint: { "icon-opacity": pointAlpha },
                });
              }
              record.rasterLabels = rasterLabels;
              const before = this.map.getLayer(this.anchor) ? this.anchor : undefined;
              const beforeVehicle = vehicleMarkers && this.map.getLayer(this.vehicleAnchor) ? this.vehicleAnchor : before;
              for (const spec of specs) {
                this.map.addLayer(spec, vehicleMarkers && spec.type === "symbol" ? beforeVehicle : before);
                record.ownedLayers.push({ id: spec.id, layer: this.map.getLayer(spec.id) });
              }
            } catch (error) { this.fail(entry, session, error); throw error; }
          } else {
            try {
              if (record.pointLabelColorProperty !== pointLabelColorProperty || record.pointLabelStyle !== pointLabelStyle) throw new Error("Стиль подписи источника нельзя менять без перезапуска модуля");
              if (record.pointLabel !== pointLabel) throw new Error("Поле подписи источника нельзя менять без перезапуска модуля");
              if (record.pointMarker !== pointMarker || record.vehicleMarkers !== vehicleMarkers) throw new Error("Вид маркера источника нельзя менять без перезапуска модуля");
              if (record.pointIcon !== pointIcon || record.pointIcons !== pointIcons || record.pointIconBackground !== pointIconBackground
                || (pointIcon !== null && (record.pointIconMinZoom !== pointIconMinZoom || record.pointIconSize !== pointIconSize))) {
                throw new Error("Пиктограмму источника нельзя менять без перезапуска модуля");
              }

              for (const [index, property] of ["fill", "line", "circle"].entries()) {
                if (index === 2 && vehicleMarkers) continue;
                this.map.setPaintProperty(record.layers[index], `${property}-color`, paintColor);
                this.map.setPaintProperty(record.layers[index], `${property}-opacity`, index === 0 ? opacity * 0.4 : opacity);
              }
              if (vehicleMarkers) {
                this.map.setPaintProperty(record.layers[2], "icon-opacity", pointAlpha);
              } else {
                this.map.setPaintProperty(record.layers[2], "circle-opacity", circleAlpha);
                this.map.setPaintProperty(record.layers[2], "circle-stroke-opacity", circleAlpha);
                this.map.setPaintProperty(record.layers[2], "circle-radius", pointRadius);
              }
              if (record.iconLayer) this.map.setPaintProperty(record.iconLayer, "icon-opacity", pointAlpha);
              if (pointLabel !== null) {
                if (record.rasterLabels) this.map.setPaintProperty(record.layers[3], "icon-opacity", pointAlpha);
                else {
                  this.map.setPaintProperty(record.layers[3], "text-color", paintLabelColor);
                  this.map.setPaintProperty(record.layers[3], "text-opacity", pointAlpha);
                }
              }
            } catch (error) { this.fail(entry, session, error); throw error; }
          }
          if (!record.motion && pointTransitionMs > 0 && typeof root.SloiGeoJsonMotion?.create === "function") {
            const owned = record;
            let queued = null, submittedEmpty = checked.data.features.length === 0;
            const publish = frame => {
              if (entry.session !== session || session.controller.signal.aborted
                || this.map.getSource(owned.source) !== owned.ownedSource) {
                owned.motion?.dispose(); queued = null;
                return;
              }
              const empty = frame.features.length === 0;
              if (empty && submittedEmpty) { queued = null; return; }
              // A slow worker needs only the most recent animation frame.
              // Send clears once immediately so stale vehicles cannot linger.
              if (!empty && owned.ownedSource.loaded?.() === false) { queued = frame; return; }
              queued = null; submittedEmpty = empty;
              try { owned.ownedSource.setData(frame); }
              catch (error) { this.fail(entry, session, error); }
            };
            const flush = event => {
              if (event.sourceId === owned.source && queued && owned.ownedSource.loaded?.() !== false) publish(queued);
            };
            record.motion = root.SloiGeoJsonMotion.create({
              document: root.document, headingProperty: pointHeading, typeProperty: pointType,
              matchMedia: root.matchMedia?.bind(root), onFrame: publish,
            });
            this.map.on("sourcedata", flush);
            this.map.on("dataabort", flush);
            this.map.on("error", flush);
            session.cleanups.push(() => {
              queued = null; owned.motion?.dispose();
              this.map.off("sourcedata", flush); this.map.off("dataabort", flush); this.map.off("error", flush);
            });
          }
          if (record.motion) record.motion.update(checked.data, pointTransitionMs);
          else if (existingSource) this.map.getSource(record.source).setData(checked.data);
          record.bounds = checked.bounds;
          return Object.freeze({ sourceId: record.source, layerIds: Object.freeze([...record.layers]) });
        },
        reportWarning: (message) => {
          assertCurrent();
          const warning = message == null ? null : String(message).trim().slice(0, 400) || null;
          if (entry.warning === warning) return;
          entry.warning = warning;
          this.notify("warning");
        },
        reportError: (message) => {
          assertCurrent();
          this.fail(entry, session, new Error(String(message || "Ошибка источника модуля").slice(0, 400)));
        },
        onMove: (callback) => {
          assertCurrent();
          if (typeof callback !== "function") throw new Error("onMove требует функцию");
          let timer = null;
          const listener = () => {
            clearTimeout(timer);
            timer = setTimeout(() => {
              if (entry.session !== session || session.controller.signal.aborted) return;
              Promise.resolve().then(() => { assertCurrent(); return callback(getView()); }).catch((error) => this.fail(entry, session, error));
            }, limits.moveDebounceMs);
          };
          this.map.on("moveend", listener);
          const unsubscribe = () => { clearTimeout(timer); this.map.off("moveend", listener); };
          session.cleanups.push(unsubscribe);
          return unsubscribe;
        },
      });
      session.promise = Promise.resolve().then(() => { assertCurrent(); return entry.factory(context); }).then((cleanup) => {
        if (cleanup !== undefined && typeof cleanup !== "function") throw new Error("Фабрика модуля должна вернуть функцию очистки");
        if (typeof cleanup === "function") {
          if (entry.session !== session || session.controller.signal.aborted) this.cleanupCallback(cleanup);
          else session.cleanups.push(cleanup);
        }
        if (entry.session === session && !session.controller.signal.aborted) { entry.status = "ready"; this.notify(); }
        return this.get(entry.manifest.id);
      }).catch((error) => { this.fail(entry, session, error); return this.get(entry.manifest.id); });
      this.notify();
      return session.promise;
    }

    async setSuspended(value) {
      const suspended = Boolean(value);
      if (this.disposed || this.suspended === suspended) return;
      this.suspended = suspended;
      const work = [];
      for (const entry of this.entries.values()) {
        if (!entry.enabled) continue;
        if (suspended) { this.stop(entry); entry.status = "paused"; }
        else work.push(this.start(entry));
      }
      this.notify();
      await Promise.all(work);
    }

    dispose() {
      if (this.disposed) return;
      this.disposed = true;
      for (const entry of this.entries.values()) { this.stop(entry); entry.status = "disabled"; }
      this.notify();
    }
  }

  root.SloiModules = Object.freeze({ Host, limits });
})(typeof window !== "undefined" ? window : globalThis);
