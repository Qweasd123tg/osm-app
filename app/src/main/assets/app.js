"use strict";

const $ = (id) => document.getElementById(id);
const fallbackData = window.SLOI_MAP_DATA;
let data = fallbackData;
let sceneDataStatus = String(fallbackData?.buildings?.features?.length || 0) + " зданий · встроенный район";
let map = null;
let mapReady = false;
let popup = null;
let playbackTimer = null;
let tileErrorTimer = null;
let sceneRequestId = 0;
let searchRequestId = 0;
let frameRequestId = 0;
let frameDebounceTimer = null;
let frameWatchdog = null;
let activeSceneId = null;
let pendingScene = null;
let sceneWatchdog = null;
let layerRuntime = null;
let styleFrame = null;
let renderedShadowGeometry;
let lastSavedState = null;
let economyMode = false;
try { economyMode = localStorage.getItem("sloi-economy-mode") === "true"; } catch (_) { /* Optional preference. */ }
const customLayers = new Map();
const cityPacks = new Map();
const viewport = {
  epoch: 0,
  requestId: null,
  timer: null,
  signature: null,
  blockedSignature: null,
  desired: new Map(),
  pending: new Set(),
  loaded: new Map(),
  pack: null,
  packRevision: null,
  error: null,
};

const elements = {
  loading: $("loading"),
  fatal: $("fatal"),
  fatalMessage: $("fatal-message"),
  regionName: $("region-name"),
  layersButton: $("layers-button"),
  activeCount: $("active-count"),
  mode2d: $("mode-2d"),
  mode3d: $("mode-3d"),
  connection: $("connection"),
  recenter: $("recenter"),
  locate: $("locate"),
  play: $("play"),
  timeValue: $("time-value"),
  sunValue: $("sun-value"),
  daylightPill: $("daylight-pill"),
  timeRange: $("time-range"),
  scrim: $("scrim"),
  sheet: $("layers-sheet"),
  closeSheet: $("close-sheet"),
  baseLight: $("base-light"),
  baseDark: $("base-dark"),
  shadowToggle: $("shadow-toggle"),
  shadowOpacity: $("shadow-opacity"),
  shadowOpacityValue: $("shadow-opacity-value"),
  buildingToggle: $("building-toggle"),
  confidenceToggle: $("confidence-toggle"),
  windToggle: $("wind-toggle"),
  dataStatus: $("data-status"),
  placeForm: $("place-form"),
  placeQuery: $("place-query"),
  placeSubmit: $("place-submit"),
  myLocation: $("my-location"),
  loadCenter: $("load-center"),
  placeStatus: $("place-status"),
  placeResults: $("place-results"),
  cityPackList: $("city-pack-list"),
  windCard: $("wind-card"),
  windSource: $("wind-source"),
  windValue: $("wind-value"),
  layerList: $("active-layer-list"),
  heightLegend: $("height-legend"),
  presetForm: $("preset-form"),
  presetName: $("preset-name"),
  presetList: $("preset-list"),
  presetStatus: $("preset-status"),
  importButton: $("import-layer"),
  importFile: $("layer-file"),
  importStatus: $("import-status"),
  sceneDateLabel: $("scene-date-label"),
  sceneDate: $("scene-date"),
  sceneTimezone: $("scene-timezone"),
  sceneDateForm: $("scene-date-form"),
  sceneRecalculate: $("scene-recalculate"),
  sceneToday: $("scene-today"),
  cancelScene: $("cancel-scene"),
  economyMode: $("economy-mode"),
  retryFrame: $("retry-frame"),
};

function showFatal(message) {
  elements.loading.classList.add("is-hidden");
  elements.fatalMessage.textContent = String(message || "Неизвестная ошибка");
  elements.fatal.classList.add("is-visible");
}

window.SloiApp = {
  showFatal,
  closeTransientUi() {
    if (elements.sheet.classList.contains("is-open")) {
      closeSheet();
      return true;
    }
    if (popup) {
      popup.remove();
      popup = null;
      return true;
    }
    return false;
  },
};

if (!fallbackData || !fallbackData.region || !Array.isArray(fallbackData.shadeFrames)) {
  showFatal("В APK отсутствуют данные карты");
  throw new Error("SLOI_MAP_DATA is missing or malformed");
}
if (typeof maplibregl === "undefined") {
  showFatal("В APK отсутствует MapLibre");
  throw new Error("MapLibre is missing");
}

let frames = data.shadeFrames;
let windAvailable = false;
const defaultFrame = Math.max(0, frames.findIndex((frame) => frame.label === "15:00"));
const layerSettings = window.SloiLayerSettings;
const layerLibrary = new window.SloiLayerLibrary.Library();
const layerControls = new Map();
for (const layer of layerSettings.registry) layerControls.set(layer.id, createLayerControls(layer));

function createLayerControls(layer) {
  const prefix = { shadows: "shadow", buildings: "building", wind: "wind", sun: "sun" }[layer.id] || layer.id;
  let card = elements.layerList.querySelector(`[data-layer="${layer.id}"]`);
  if (!card) {
    card = document.createElement("div");
    card.className = "layer-card has-control";
    card.dataset.layer = layer.id;
    card.innerHTML = '<div class="layer-icon" aria-hidden="true"></div><div class="layer-copy"><strong></strong><span></span></div>'
      + '<label class="switch"><input type="checkbox"><span></span></label>'
      + '<div class="layer-options"><div class="range-row"><input class="opacity-range" type="range" step="1"><output></output></div><div class="layer-order"></div></div>';
    card.querySelector(".layer-icon").textContent = layer.id === "sun" ? "☀" : "◇";
    const source = card.querySelector(".layer-copy span");
    source.id = `${prefix}-source`;
    source.textContent = layer.source;
    const toggle = card.querySelector(".switch input");
    toggle.id = `${prefix}-toggle`;
    card.querySelector(".switch").setAttribute("aria-label", `Показывать ${layer.title}`);
    const opacity = card.querySelector(".opacity-range");
    opacity.id = `${prefix}-opacity`;
    opacity.setAttribute("aria-label", `Прозрачность слоя ${layer.title}`);
    card.querySelector("output").id = `${prefix}-opacity-value`;
    card.querySelector("output").htmlFor = opacity.id;
    elements.layerList.append(card);
  }
  const order = card.querySelector(".layer-order");
  card.querySelector(".layer-copy strong").textContent = layer.title;
  $(`${prefix}-opacity`).min = String(layer.min * 100);
  $(`${prefix}-opacity`).max = String(layer.max * 100);
  const up = document.createElement("button");
  const down = document.createElement("button");
  up.type = down.type = "button";
  up.textContent = "↑ Выше";
  down.textContent = "↓ Ниже";
  up.setAttribute("aria-label", `${layer.title}: выше`);
  down.setAttribute("aria-label", `${layer.title}: ниже`);
  up.addEventListener("click", () => moveLayerGroup(layer.id, 1));
  down.addEventListener("click", () => moveLayerGroup(layer.id, -1));
  order.append(up, down);
  const controls = {
    card, up, down, toggle: $(`${prefix}-toggle`),
    opacity: $(`${prefix}-opacity`), output: $(`${prefix}-opacity-value`),
  };
  controls.toggle.addEventListener("change", () => {
    if (layer.custom) {
      state.customLayers[layer.id] = { ...settingsForLayer(layer), enabled: controls.toggle.checked };
    } else state[layer.id] = controls.toggle.checked;
    haptic();
    applyMapState();
    if (layer.id === "buildings") scheduleViewportTiles();
  });
  controls.opacity.addEventListener("input", () => {
    const opacity = Number(controls.opacity.value) / 100;
    if (layer.custom) state.customLayers[layer.id] = { ...settingsForLayer(layer), opacity };
    else state[layer.opacityKey] = opacity;
    scheduleMapState();
  });
  return controls;
}

function customDescriptor(entry) {
  return { id: entry.id, title: entry.name, source: `Локальный GeoJSON · ${entry.featureCount} объектов`, custom: true, min: .1, max: 1 };
}

function allLayers() {
  return [...layerSettings.registry, ...[...customLayers.values()].map(customDescriptor)];
}

function settingsForLayer(layer) {
  return layer.custom ? state.customLayers[layer.id] || { enabled: false, opacity: .7 }
    : { enabled: state[layer.id], opacity: state[layer.opacityKey] };
}

function currentLayerOrder() {
  const ids = allLayers().map((layer) => layer.id);
  return [...new Set([...state.layerOrder.filter((id) => ids.includes(id)), ...ids])];
}

function stateOptions() {
  return { defaultFrame, frameCount: frames.length, frameLabels: frames.map((frame) => frame.label) };
}

function loadState() {
  try {
    const saved = JSON.parse(localStorage.getItem("sloi-map-state") || "{}");
    return layerSettings.normalizeState(saved, stateOptions());
  } catch (error) {
    console.warn("Could not restore state", error);
    return layerSettings.normalizeState(null, stateOptions());
  }
}

const state = loadState();
let shadowWasEnabled = state.shadows;
let presets = loadPresets();
let libraryLoaded = false;
let importBusy = false;

function setImportStatus(message, isError = false) {
  elements.importStatus.textContent = message;
  elements.importStatus.classList.toggle("is-error", isError);
}

function setImportBusy(busy) {
  importBusy = busy;
  elements.importButton.disabled = busy || !libraryLoaded || !mapReady;
}

async function restoreCustomLayers() {
  try {
    const result = await layerLibrary.load();
    for (const entry of result.entries) attachCustomLayer(entry);
    if (result.warnings.length) setImportStatus("Некоторые сохранённые слои повреждены и пропущены.", true);
    applyMapState();
  } catch (error) {
    setImportStatus(`Не удалось открыть библиотеку: ${error.message}`, true);
  } finally {
    libraryLoaded = true;
    reconcileCustomSettings();
    applyMapState();
    setImportBusy(false);
  }
}

function reconcileCustomSettings() {
  if (!libraryLoaded) return;
  state.customLayers = Object.fromEntries(Object.entries(state.customLayers)
    .filter(([id]) => customLayers.has(id)));
  state.layerOrder = currentLayerOrder();
}

function attachCustomLayer(entry) {
  const checked = entry.bounds && Number.isInteger(entry.featureCount)
    ? { data: entry.data, bounds: entry.bounds, featureCount: entry.featureCount }
    : window.SloiLayerRuntime.validateGeoJson(entry.data);
  const record = { ...entry, bounds: checked.bounds, featureCount: checked.featureCount };
  const style = window.SloiLayerRuntime.geoJsonStyle(entry.id, entry.color);
  customLayers.set(entry.id, record);
  const descriptor = customDescriptor(record);
  layerRuntime.register({
    ...descriptor, dataType: "geojson", sourceLabel: descriptor.source,
    mapLayers: () => {
      if (!settingsForLayer(descriptor).enabled) {
        for (const spec of style.layers) {
          map.off("click", spec.id, showCustomPopup);
          if (map.getLayer(spec.id)) map.removeLayer(spec.id);
        }
        if (map.getSource(style.sourceId)) map.removeSource(style.sourceId);
        return [];
      }
      if (!map.getSource(style.sourceId)) {
        map.addSource(style.sourceId, { type: "geojson", data: checked.data });
        for (const spec of style.layers) {
          map.addLayer(spec, "selected-location");
          map.on("click", spec.id, showCustomPopup);
        }
      }
      return style.bindings;
    },
    getSettings: () => settingsForLayer(descriptor),
    apply: () => {
      const color = customLayers.get(entry.id).color;
      for (const spec of style.layers) {
        const property = { fill: "fill-color", line: "line-color", circle: "circle-color" }[spec.type];
        setPaintIfChanged(spec.id, property, color);
      }
    },
  });
  const controls = createLayerControls(descriptor);
  layerControls.set(entry.id, controls);
  const actions = document.createElement("div");
  actions.className = "custom-actions";
  const color = document.createElement("input");
  color.type = "color";
  color.value = entry.color;
  color.setAttribute("aria-label", `Цвет слоя ${entry.name}`);
  color.addEventListener("change", async () => {
    color.disabled = true;
    try {
      const saved = await layerLibrary.updateColor(entry.id, color.value);
      customLayers.set(entry.id, { ...record, ...saved });
      applyMapState();
    } catch (error) {
      color.value = customLayers.get(entry.id).color;
      setImportStatus(error.message, true);
    } finally { color.disabled = false; }
  });
  const locate = document.createElement("button");
  locate.type = "button";
  locate.className = "secondary-button";
  locate.textContent = "На карте";
  locate.setAttribute("aria-label", `Показать слой ${entry.name} на карте`);
  locate.addEventListener("click", () => {
    state.customLayers[entry.id] = { ...settingsForLayer(descriptor), enabled: true };
    applyMapState();
    closeSheet();
    map.fitBounds(record.bounds, { padding: 70, maxZoom: 17, duration: 600 });
  });
  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "secondary-button";
  remove.textContent = "Удалить";
  remove.setAttribute("aria-label", `Удалить слой ${entry.name}`);
  remove.addEventListener("click", async () => {
    remove.disabled = true;
    color.disabled = true;
    try {
      await layerLibrary.remove(entry.id);
      layerRuntime.unregister(entry.id);
      for (const spec of style.layers) {
        map.off("click", spec.id, showCustomPopup);
        if (map.getLayer(spec.id)) map.removeLayer(spec.id);
      }
      if (map.getSource(style.sourceId)) map.removeSource(style.sourceId);
      customLayers.delete(entry.id);
      controls.card.remove();
      layerControls.delete(entry.id);
      delete state.customLayers[entry.id];
      state.layerOrder = state.layerOrder.filter((id) => id !== entry.id);
      if (popup) { popup.remove(); popup = null; }
      applyMapState();
      setImportStatus(`Слой «${entry.name}» удалён.`);
      elements.importButton.focus();
    } catch (error) {
      remove.disabled = false;
      color.disabled = false;
      setImportStatus(error.message, true);
    }
  });
  actions.append(color, locate, remove);
  controls.card.querySelector(".layer-options").append(actions);
}

function showCustomPopup(event) {
  const feature = event.features?.[0];
  if (!feature) return;
  const content = document.createElement("div");
  content.className = "building-popup";
  const heading = document.createElement("strong");
  heading.textContent = String(feature.properties?.name || "Объект слоя");
  content.append(heading);
  for (const [key, value] of Object.entries(feature.properties || {}).filter(([key]) => key !== "name").slice(0, 8)) {
    const row = document.createElement("span");
    row.textContent = `${key}: ${value}`;
    content.append(row);
  }
  if (popup) popup.remove();
  popup = new maplibregl.Popup({ offset: 12 }).setLngLat(event.lngLat).setDOMContent(content).addTo(map);
  popup.on("close", () => { popup = null; });
}

async function importGeoJson(name, text) {
  try {
    setImportStatus("Проверяю и сохраняю слой…");
    const checked = window.SloiLayerRuntime.validateGeoJson(text);
    const entry = await layerLibrary.put({
      id: `custom-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      name: String(name || "Мой слой").replace(/\.(geojson|json)$/i, "").slice(0, 60),
      color: "#7856bd", data: checked.data,
    });
    attachCustomLayer(entry);
    state.customLayers[entry.id] = { enabled: true, opacity: .7 };
    state.layerOrder = [...currentLayerOrder().filter((id) => id !== entry.id), entry.id];
    applyMapState();
    setImportStatus(`Добавлен слой «${entry.name}»: ${checked.featureCount} объектов. Нажмите «На карте», чтобы увидеть его.`);
  } catch (error) {
    setImportStatus(`Не удалось добавить слой: ${error.message}`, true);
  } finally { setImportBusy(false); }
}

function saveState() {
  const serialized = JSON.stringify(state);
  if (serialized === lastSavedState) return;
  try {
    localStorage.setItem("sloi-map-state", serialized);
    lastSavedState = serialized;
  } catch (error) {
    setPresetStatus("Настройки действуют, но не сохранятся после закрытия приложения.", true);
  }
}

function renderPixelRatio() {
  return Math.min(window.devicePixelRatio || 1, economyMode ? 1 : 1.5);
}

function viewportBudget() {
  return economyMode ? { tiles: 32, features: 6000, bytes: 8 * 1024 * 1024 }
    : { tiles: 64, features: 16000, bytes: 16 * 1024 * 1024 };
}

function scheduleMapState() {
  if (styleFrame !== null) return;
  styleFrame = window.requestAnimationFrame(() => { styleFrame = null; applyMapState(); });
}

function setPaintIfChanged(id, property, value) {
  if (!map.getLayer(id)) return;
  const current = map.getPaintProperty(id, property);
  if (Array.isArray(value) ? JSON.stringify(current) === JSON.stringify(value) : current === value) return;
  map.setPaintProperty(id, property, value);
}

function setPresetStatus(message, isError = false) {
  elements.presetStatus.textContent = message;
  elements.presetStatus.classList.toggle("is-error", isError);
}

function loadPresets() {
  try {
    return layerSettings.normalizePresets(JSON.parse(localStorage.getItem("sloi-map-presets") || "[]"));
  } catch (error) {
    setPresetStatus("Не удалось прочитать сохранённые наборы.", true);
    return [];
  }
}

function storePresets(next) {
  try {
    localStorage.setItem("sloi-map-presets", JSON.stringify(next));
    presets = next;
    renderPresets();
    return true;
  } catch (error) {
    setPresetStatus("Не удалось сохранить набор. Возможно, закончилось место.", true);
    return false;
  }
}

function renderPresets() {
  elements.presetList.replaceChildren();
  for (const preset of presets) {
    const row = document.createElement("div");
    row.className = "preset-row";
    const name = document.createElement("span");
    name.className = "preset-name";
    name.textContent = preset.name;
    const actions = document.createElement("div");
    actions.className = "preset-actions";
    const apply = document.createElement("button");
    apply.type = "button";
    apply.textContent = "Применить";
    apply.setAttribute("aria-label", `Применить набор «${preset.name}»`);
    apply.addEventListener("click", () => {
      stopPlayback();
      const previousMode = state.mode;
      Object.assign(state, layerSettings.applyPreset(preset.config, stateOptions()));
      reconcileCustomSettings();
      setPresetStatus(`Применён набор «${preset.name}».`);
      applyMapState();
      if (previousMode !== state.mode) applyCameraMode(true);
      showFrame(state.frame);
      scheduleViewportTiles();
      haptic();
    });
    const remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = "Удалить";
    remove.setAttribute("aria-label", `Удалить набор «${preset.name}»`);
    remove.addEventListener("click", () => {
      if (storePresets(presets.filter((entry) => entry.id !== preset.id))) {
        setPresetStatus(`Набор «${preset.name}» удалён.`);
        elements.presetName.focus();
      }
    });
    actions.append(apply, remove);
    row.append(name, actions);
    elements.presetList.append(row);
  }
}

function haptic() {
  try {
    if (window.AndroidHost && typeof window.AndroidHost.haptic === "function") {
      window.AndroidHost.haptic();
    }
  } catch (error) {
    console.debug("Haptic feedback unavailable", error);
  }
}

function androidHost(method) {
  const host = window.AndroidHost;
  if (!host || typeof host[method] !== "function") {
    throw new Error("Локальный движок доступен только в Android-приложении");
  }
  return host;
}

function setPlaceStatus(message, isError = false) {
  elements.placeStatus.textContent = message;
  elements.placeStatus.classList.toggle("is-error", isError);
}

function setPlaceBusy(busy) {
  if (busy) stopPlayback();
  elements.placeSubmit.disabled = busy;
  elements.myLocation.disabled = busy;
  elements.loadCenter.disabled = busy;
  elements.locate.disabled = busy;
  elements.timeRange.disabled = busy;
  elements.play.disabled = busy;
  elements.retryFrame.disabled = busy;
  elements.sceneRecalculate.disabled = busy;
  elements.sceneDate.disabled = busy;
  elements.sceneTimezone.disabled = busy;
  elements.sceneToday.disabled = busy;
  elements.cancelScene.hidden = !busy;
}

function localDateString(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function offsetLabel(minutes) {
  return `UTC${minutes < 0 ? "−" : "+"}${String(Math.floor(Math.abs(minutes) / 60)).padStart(2, "0")}:${String(Math.abs(minutes) % 60).padStart(2, "0")}`;
}

function sceneClock() {
  const time = frames[0]?.time || "";
  const offset = /([+-])(\d{2}):(\d{2})$/.exec(time);
  return {
    localDate: /^\d{4}-\d{2}-\d{2}T/.test(time) ? time.slice(0, 10) : "",
    offset: offset ? (offset[1] === "-" ? -1 : 1) * (Number(offset[2]) * 60 + Number(offset[3])) : 0,
  };
}

function updateSceneClock() {
  const clock = sceneClock();
  elements.sceneDate.value = clock.localDate;
  const offsets = new Set([clock.offset, 345, 525, 765]);
  for (let offset = -720; offset <= 840; offset += 30) offsets.add(offset);
  elements.sceneTimezone.replaceChildren();
  for (const offset of [...offsets].sort((a, b) => a - b)) {
    const option = document.createElement("option");
    option.value = String(offset);
    option.textContent = offsetLabel(offset);
    elements.sceneTimezone.append(option);
  }
  elements.sceneTimezone.value = String(clock.offset);
  elements.sceneDateLabel.textContent = clock.localDate
    ? `${clock.localDate.split("-").reverse().join(".")} · ${offsetLabel(clock.offset)}`
    : "Дата расчёта неизвестна";
}

function validSceneDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value < "1900-01-01" || value > "2100-12-31") return false;
  const parsed = new Date(`${value}T12:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function invalidateFrameRequest() {
  window.clearTimeout(frameDebounceTimer);
  window.clearTimeout(frameWatchdog);
  frameDebounceTimer = null;
  frameRequestId++;
}

function showFrameFailure(message) {
  window.clearTimeout(frameWatchdog);
  stopPlayback();
  elements.retryFrame.hidden = !state.shadows;
  elements.sunValue.textContent = "Не удалось рассчитать тень";
  setPlaceStatus(`Не удалось рассчитать тень: ${message}`, true);
}

function armSceneWatchdog(requestId) {
  window.clearTimeout(sceneWatchdog);
  sceneWatchdog = window.setTimeout(() => {
    if (pendingScene?.requestId === requestId) cancelSceneLoad("Расчёт не отвечает. Предыдущий район сохранён; можно повторить попытку.");
  }, 90000);
}

function cancelSceneLoad(message = "Расчёт отменён. Предыдущий район сохранён.") {
  if (!pendingScene) return;
  const current = pendingScene;
  pendingScene = null;
  window.clearTimeout(sceneWatchdog);
  invalidateFrameRequest();
  try { androidHost("cancelScene").cancelScene(current.requestId); } catch (error) { console.warn(error); }
  setPlaceBusy(false);
  setSelectedLocation(data.region.center[1], data.region.center[0]);
  setPlaceStatus(message);
  showFrame(state.frame, false);
  current.resolve(null);
}

async function readJsonUrl(url, options = {}) {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch(url, { cache: "no-store", credentials: "same-origin", signal: controller.signal });
    const text = await response.text();
    const maxBytes = options.maxBytes || 20 * 1024 * 1024;
    if (text.length > maxBytes) throw new Error("Результат слишком велик для отображения");
    let payload;
    try { payload = JSON.parse(text); } catch (_) { throw new Error("Результат содержит повреждённый JSON"); }
    if (!response.ok) {
      const message = payload && (payload.error || payload.message || payload.detail);
      throw new Error(message || `Локальный движок вернул HTTP ${response.status}`);
    }
    if (options.measure && payload && typeof payload === "object") {
      Object.defineProperty(payload, "_byteSize", { value: text.length * 2 });
    }
    return payload;
  } finally {
    window.clearTimeout(timeout);
  }
}

async function readLocalJson(url, pathPrefix, label, options) {
  const resolved = new URL(String(url), window.location.origin);
  if (resolved.origin !== window.location.origin || !resolved.pathname.startsWith(pathPrefix)) {
    throw new Error(`Движок вернул небезопасный путь к ${label}`);
  }
  return readJsonUrl(resolved.toString(), options);
}

function compassPoint(degrees) {
  if (!Number.isFinite(degrees)) return "";
  const points = ["С", "СВ", "В", "ЮВ", "Ю", "ЮЗ", "З", "СЗ"];
  return points[Math.round(((degrees % 360) + 360) % 360 / 45) % points.length];
}

function destinationPoint(center, bearingDegrees, distanceMeters) {
  const radius = 6371008.8;
  const angularDistance = distanceMeters / radius;
  const bearing = bearingDegrees * Math.PI / 180;
  const latitude1 = center[1] * Math.PI / 180;
  const longitude1 = center[0] * Math.PI / 180;
  const latitude2 = Math.asin(
    Math.sin(latitude1) * Math.cos(angularDistance)
      + Math.cos(latitude1) * Math.sin(angularDistance) * Math.cos(bearing),
  );
  const longitude2 = longitude1 + Math.atan2(
    Math.sin(bearing) * Math.sin(angularDistance) * Math.cos(latitude1),
    Math.cos(angularDistance) - Math.sin(latitude1) * Math.sin(latitude2),
  );
  return [longitude2 * 180 / Math.PI, latitude2 * 180 / Math.PI];
}

function setWindGeometry(directionTo) {
  const source = mapReady && map.getSource("wind-vector");
  if (!source) return;
  if (!windAvailable || !Number.isFinite(directionTo)) {
    source.setData({ type: "FeatureCollection", features: [] });
    return;
  }
  const center = data.region.center;
  const start = destinationPoint(center, (directionTo + 180) % 360, 260);
  const end = destinationPoint(center, directionTo, 260);
  source.setData({
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        properties: { kind: "line" },
        geometry: { type: "LineString", coordinates: [start, center, end] },
      },
      {
        type: "Feature",
        properties: { kind: "head" },
        geometry: { type: "Point", coordinates: end },
      },
    ],
  });
}

function updateWind(bundle) {
  const wind = bundle && bundle.layers && bundle.layers.wind;
  const speed = Number(wind && (wind.speedMps ?? wind.speed));
  const directionFrom = Number(wind && (wind.directionFromDeg ?? wind.directionFrom));
  const directionTo = Number(wind && (wind.directionToDeg ?? wind.directionTo));
  if (!wind || !Number.isFinite(speed)) {
    windAvailable = false;
    elements.windValue.textContent = "нет данных";
    elements.windSource.textContent = "Для этого района прогноз недоступен";
    elements.windCard.classList.add("is-disabled");
    elements.windToggle.disabled = true;
    setWindGeometry(null);
    applyControls();
    return;
  }
  const to = Number.isFinite(directionTo) ? directionTo : (directionFrom + 180) % 360;
  windAvailable = Number.isFinite(to);
  elements.windValue.textContent = `${speed.toFixed(1)} м/с · ${compassPoint(to)}`;
  const observed = typeof wind.observedAt === "string"
    ? wind.observedAt.replace("T", " ")
    : null;
  elements.windSource.textContent = Number.isFinite(directionFrom)
    ? `Open-Meteo: от ${compassPoint(directionFrom)} к ${compassPoint(to)}${observed ? ` · ${observed}` : ""}`
    : `Снимок Open-Meteo${observed ? ` · ${observed}` : ""}`;
  elements.windCard.classList.remove("is-disabled");
  elements.windToggle.disabled = !windAvailable;
  setWindGeometry(to);
  applyMapState();
}

function updateSunDirection(frame) {
  const azimuth = Number.isFinite(frame.azimuth) ? frame.azimuth : (frame.shadow_bearing + 180) % 360;
  const daylight = frame.altitude > .5 && Number.isFinite(azimuth);
  const sourceLabel = $("sun-source");
  if (sourceLabel) sourceLabel.textContent = daylight
    ? `На солнце: ${compassPoint(azimuth)} · азимут ${Math.round(azimuth)}°`
    : "Солнце ниже горизонта";
  if (!mapReady) return;
  const center = data.region.center;
  const target = destinationPoint(center, azimuth, 400);
  map.getSource("sun-direction")?.setData({ type: "FeatureCollection", features: daylight ? [
    { type: "Feature", properties: { kind: "line" }, geometry: { type: "LineString", coordinates: [center, target] } },
    { type: "Feature", properties: { kind: "head" }, geometry: { type: "Point", coordinates: target } },
  ] : [] });
}

function setSelectedLocation(latitude, longitude) {
  if (!mapReady) return;
  const source = map.getSource("selected-location");
  if (source) {
    source.setData({
      type: "FeatureCollection",
      features: [{
        type: "Feature",
        properties: {},
        geometry: { type: "Point", coordinates: [longitude, latitude] },
      }],
    });
  }
}

function validLonLat(value) {
  return Array.isArray(value) && value.length >= 2
    && Number.isFinite(value[0]) && Math.abs(value[0]) <= 180
    && Number.isFinite(value[1]) && Math.abs(value[1]) <= 85;
}

function validCoordinateTree(value) {
  if (!Array.isArray(value) || value.length === 0) return false;
  if (typeof value[0] === "number") return validLonLat(value);
  return value.every(validCoordinateTree);
}

function validPolygonGeometry(geometry) {
  return geometry && (geometry.type === "Polygon" || geometry.type === "MultiPolygon")
    && validCoordinateTree(geometry.coordinates);
}

function validShadowGeometry(geometry) {
  return validPolygonGeometry(geometry)
    || (geometry?.type === "GeometryCollection"
      && Array.isArray(geometry.geometries) && geometry.geometries.length === 0);
}

function validateBundle(bundle) {
  const region = bundle && bundle.region;
  const buildings = bundle && bundle.buildings;
  const nextFrames = bundle?.layers?.shadows?.frames;
  const bounds = region && region.bounds;
  if (bundle?.schemaVersion !== 1 || !validLonLat(region?.center)
    || !Array.isArray(bounds) || bounds.length !== 2
    || !validLonLat(bounds[0]) || !validLonLat(bounds[1])
    || bounds[0][0] >= bounds[1][0] || bounds[0][1] >= bounds[1][1]
    || buildings?.type !== "FeatureCollection" || !Array.isArray(buildings.features)
    || buildings.features.length === 0 || !Array.isArray(nextFrames) || nextFrames.length === 0) {
    return false;
  }
  if (!buildings.features.every((feature) => feature?.type === "Feature"
    && validPolygonGeometry(feature.geometry)
    && Number.isFinite(feature.properties?.height)
    && Number.isFinite(feature.properties?.min_height ?? 0))) {
    return false;
  }
  return nextFrames.every((frame) => typeof frame?.label === "string"
    && Number.isFinite(frame.altitude)
    && Number.isFinite(frame.shadow_bearing)
    && (frame.geometry === null || validShadowGeometry(frame.geometry)));
}

function applyBundle(bundle, requestedName, keepCamera = false) {
  const region = bundle && bundle.region;
  const buildings = bundle && bundle.buildings;
  const nextFrames = bundle && bundle.layers && bundle.layers.shadows
    && bundle.layers.shadows.frames;
  if (!validateBundle(bundle)) {
    throw new Error("Локальный движок вернул несовместимый MapBundle");
  }

  const previousLabel = frames[state.frame] && frames[state.frame].label;
  stopPlayback();
  if (popup) {
    popup.remove();
    popup = null;
  }
  activeSceneId = String(bundle.sceneId || region.id || "");
  const normalizedFrames = nextFrames.map((frame) => ({
    ...frame,
    computed: typeof frame.computed === "boolean"
      ? frame.computed
      : frame.geometry !== null || frame.altitude <= .5,
  }));
  data = {
    region: { ...region, name: requestedName || region.name || "Выбранный район" },
    buildings,
    shadeFrames: normalizedFrames,
  };
  frames = normalizedFrames;
  const matchingFrame = previousLabel
    ? frames.findIndex((frame) => frame.label === previousLabel)
    : -1;
  state.frame = matchingFrame >= 0
    ? matchingFrame
    : Math.max(0, Number(bundle.layers.shadows.initialFrameIndex) || 0);
  elements.timeRange.max = String(frames.length - 1);
  elements.regionName.textContent = data.region.name;
  const delivery = String(bundle.source || "").startsWith("city-pack:")
    ? "ОФЛАЙН-ПАКЕТ"
    : bundle.cacheHit ? "КЭШ" : "ТЕЛЕФОН";
  elements.dataStatus.textContent = `${buildings.features.length} зданий · тени по запросу · ${delivery}`;
  map.getSource("buildings")?.setData(buildings);
  updateSceneClock();
  showFrame(state.frame);
  updateWind(bundle);
  if (!keepCamera) fitRegion(true);
  sceneDataStatus = elements.dataStatus.textContent;
  saveState();
}

async function loadSceneAt(latitude, longitude, name = "Выбранный район", options = {}) {
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)
    || Math.abs(latitude) > 85 || Math.abs(longitude) > 180) {
    throw new Error("Получены некорректные координаты района");
  }

  const localDate = options.localDate || elements.sceneDate.value;
  const timezoneOffsetMinutes = options.timezoneOffsetMinutes ?? Number(elements.sceneTimezone.value);
  if (!validSceneDate(localDate) || !Number.isInteger(timezoneOffsetMinutes)
    || timezoneOffsetMinutes < -720 || timezoneOffsetMinutes > 840) {
    throw new Error("Выберите корректные дату и часовой пояс расчёта");
  }

  const requestId = String(++sceneRequestId);
  if (pendingScene) pendingScene.resolve(null);
  window.clearTimeout(sceneWatchdog);
  invalidateFrameRequest();
  searchRequestId++;
  setPlaceBusy(true);
  setPlaceStatus("Телефон загружает OSM и готовит геометрию…");
  setSelectedLocation(latitude, longitude);
  const currentFrame = frames[state.frame];
  const selectedMinutes = currentFrame && /^\d\d:\d\d$/.test(currentFrame.label)
    ? Number(currentFrame.label.slice(0, 2)) * 60 + Number(currentFrame.label.slice(3))
    : 15 * 60;
  const request = {
    requestId,
    latitude,
    longitude,
    radiusM: 450,
    localDate,
    timezoneOffsetMinutes,
    selectedMinutes,
    name,
  };
  return new Promise((resolve, reject) => {
    pendingScene = { requestId, name, resolve, reject, keepCamera: Boolean(options.keepCamera) };
    try {
      androidHost("requestScene").requestScene(JSON.stringify(request));
      armSceneWatchdog(requestId);
    } catch (error) {
      pendingScene = null;
      setPlaceBusy(false);
      setPlaceStatus(`Не удалось запустить расчёт: ${error.message}`, true);
      showFrame(state.frame, false);
      reject(error);
    }
  });
}

function getCurrentPosition() {
  if (!navigator.geolocation) {
    return Promise.reject(new Error("Геолокация недоступна на этом устройстве"));
  }
  return new Promise((resolve, reject) => {
    navigator.geolocation.getCurrentPosition(resolve, (error) => {
      const messages = {
        1: "Нет разрешения на примерное местоположение",
        2: "Устройство не смогло определить местоположение",
        3: "Истекло время определения местоположения",
      };
      reject(new Error(messages[error.code] || error.message || "Ошибка геолокации"));
    }, { enableHighAccuracy: false, timeout: 15000, maximumAge: 120000 });
  });
}

async function locateAndLoad() {
  openSheet();
  setPlaceStatus("Определяю примерное местоположение…");
  setPlaceBusy(true);
  try {
    const position = await getCurrentPosition();
    await loadSceneAt(
      position.coords.latitude,
      position.coords.longitude,
      "Рядом со мной",
    );
  } catch (error) {
    if (error?.name !== "AbortError") {
      setPlaceStatus(error.message || "Не удалось определить местоположение", true);
    }
  } finally {
    setPlaceBusy(false);
  }
}

function normalizePlace(item) {
  if (!item) return null;
  if (item.type === "Feature" && item.geometry?.type === "Point") {
    return {
      name: item.properties?.display_name || item.properties?.name || "Найденное место",
      longitude: Number(item.geometry.coordinates[0]),
      latitude: Number(item.geometry.coordinates[1]),
    };
  }
  return {
    name: item.display_name || item.name || item.label || "Найденное место",
    latitude: Number(item.latitude ?? item.lat),
    longitude: Number(item.longitude ?? item.lon),
  };
}

function renderPlaces(payload) {
  const rawItems = Array.isArray(payload)
    ? payload
    : payload?.places || payload?.results || payload?.features || [];
  const places = rawItems.map(normalizePlace).filter((place) => place
    && Number.isFinite(place.latitude) && Number.isFinite(place.longitude));
  if (!places.length) {
    setPlaceStatus("Ничего не найдено. Попробуйте уточнить запрос.", true);
    return;
  }
  const fragment = document.createDocumentFragment();
  for (const place of places) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "place-result";
    button.textContent = place.name;
    button.addEventListener("click", () => {
      loadSceneAt(place.latitude, place.longitude, place.name).catch(console.warn);
    });
    fragment.append(button);
  }
  elements.placeResults.append(fragment);
  setPlaceStatus("Выберите место — расчёт пойдёт на телефоне.");
}

function searchPlaces(query) {
  const requestId = String(++searchRequestId);
  elements.placeSubmit.disabled = true;
  elements.placeResults.replaceChildren();
  setPlaceStatus("Ищу место…");
  try {
    androidHost("searchPlaces").searchPlaces(JSON.stringify({ requestId, query, limit: 5 }));
  } catch (error) {
    elements.placeSubmit.disabled = false;
    setPlaceStatus(`Поиск недоступен: ${error.message}`, true);
  }
}

function formatBytes(bytes) {
  const value = Math.max(0, Number(bytes) || 0);
  if (value >= 1073741824) return `${(value / 1073741824).toFixed(1)} ГБ`;
  if (value >= 1048576) return `${(value / 1048576).toFixed(value < 10485760 ? 1 : 0)} МБ`;
  if (value >= 1024) return `${Math.round(value / 1024)} КБ`;
  return `${Math.round(value)} Б`;
}

function cityPackPhase(record) {
  const phases = {
    metadata: "Проверяю размер…",
    download: `Загружено ${formatBytes(record.current)} из ${formatBytes(record.total)}`,
    extract: "Распаковываю пакет…",
    index: "Строю индекс зданий на телефоне…",
    ready: "Пакет установлен",
  };
  return phases[record.phase] || "Подготавливаю офлайн-пакет…";
}

function renderCityPacks() {
  elements.cityPackList.replaceChildren();
  if (!cityPacks.size) {
    const empty = document.createElement("div");
    empty.className = "city-pack";
    empty.innerHTML = '<div class="city-pack-copy"><strong>Пакеты недоступны</strong><span>Проверьте соединение и откройте меню снова</span></div>';
    elements.cityPackList.append(empty);
    return;
  }
  for (const record of cityPacks.values()) {
    const card = document.createElement("div");
    card.className = "city-pack";
    const copy = document.createElement("div");
    copy.className = "city-pack-copy";
    const title = document.createElement("strong");
    title.textContent = record.name || record.id;
    const detail = document.createElement("span");
    const installed = record.status === "installed";
    const downloading = record.status === "downloading";
    const downloadSize = formatBytes(record.downloadBytes || record.total);
    const diskSize = formatBytes(record.installedBytes);
    const updatedAt = record.updatedAt || record.date;
    const attribution = record.source && record.license ? " · BBBike / ODbL" : "";
    detail.textContent = downloading
      ? `Здания и высоты · ${cityPackPhase(record)}`
      : installed
        ? `Здания и высоты · на устройстве · ${diskSize}${updatedAt ? ` · ${updatedAt}` : ""}${attribution}`
        : record.status === "error"
          ? `Ошибка: ${record.error || "загрузка прервана"}`
          : `Здания и высоты · скачать ${downloadSize}${record.expectedInstalledBytes || record.installedEstimateBytes || record.installedBytes ? ` · на диске ≈ ${formatBytes(record.expectedInstalledBytes || record.installedEstimateBytes || record.installedBytes)}` : ""}${attribution}`;
    copy.append(title, detail);

    const button = document.createElement("button");
    button.type = "button";
    if (downloading) {
      button.textContent = "Отмена";
      button.addEventListener("click", () => {
        androidHost("cancelCityPack").cancelCityPack(record.id);
      });
    } else if (installed) {
      button.textContent = "Удалить";
      button.className = "is-delete";
      button.addEventListener("click", () => {
        record.status = "deleting";
        detail.textContent = "Удаляю пакет…";
        button.disabled = true;
        androidHost("deleteCityPack").deleteCityPack(record.id);
      });
    } else {
      button.textContent = record.status === "error" ? "Повторить" : "Скачать";
      button.addEventListener("click", () => {
        record.status = "downloading";
        record.phase = "metadata";
        record.current = 0;
        renderCityPacks();
        androidHost("downloadCityPack").downloadCityPack(record.id);
      });
    }
    card.append(copy, button);
    if (downloading) {
      const progress = document.createElement("progress");
      progress.max = Math.max(1, Number(record.total) || 1);
      progress.value = Math.max(0, Number(record.current) || 0);
      if (!(Number(record.total) > 0)) progress.removeAttribute("value");
      card.append(progress);
    }
    elements.cityPackList.append(card);
  }
}

function requestCityPacks() {
  try {
    androidHost("listCityPacks").listCityPacks();
  } catch (error) {
    console.debug("City packs unavailable", error);
  }
}

const viewportMinZoom = 14.25;
const viewportMaxTiles = 96;
// Keep dynamic buildings below the controls/markers added after the scene buildings.
const viewportInsertBeforeLayer = "wind-line";

function cityPackBounds(record) {
  const bounds = record?.bounds;
  if (Array.isArray(bounds) && validLonLat(bounds[0]) && validLonLat(bounds[1])) {
    return { west: bounds[0][0], south: bounds[0][1], east: bounds[1][0], north: bounds[1][1] };
  }
  if (!bounds || ![bounds.west, bounds.south, bounds.east, bounds.north].every(Number.isFinite)) return null;
  if (bounds.west >= bounds.east || bounds.south >= bounds.north) return null;
  return { west: bounds.west, south: bounds.south, east: bounds.east, north: bounds.north };
}

function activeInstalledPack() {
  for (const record of cityPacks.values()) {
    const bounds = cityPackBounds(record);
    if (record?.status === "installed" && bounds) {
      return {
        id: String(record.id),
        bounds,
        // Newer native catalogues expose revision directly. Older catalogues do not,
        // so tile responses establish the revision for this viewport epoch.
        revision: typeof record.revision === "string" && record.revision ? record.revision : null,
        catalogRevision: String(record.revision || record.updatedAt || record.date || record.installedBytes || "installed"),
      };
    }
  }
  return null;
}

function viewportBounds() {
  const bounds = map?.getBounds();
  if (!bounds) return null;
  return { west: bounds.getWest(), south: bounds.getSouth(), east: bounds.getEast(), north: bounds.getNorth() };
}

function boundsIntersect(a, b) {
  return a && b && a.west < b.east && a.east > b.west && a.south < b.north && a.north > b.south;
}

function viewportTileZoom(zoom) {
  if (zoom < 16) return 15;
  if (zoom < 17) return 16;
  return 17;
}

function canonicalTileX(x, z) {
  const width = 2 ** z;
  return ((x % width) + width) % width;
}

function longitudeToTileX(longitude, z) {
  return (longitude + 180) / 360 * (2 ** z);
}

function latitudeToTileY(latitude, z) {
  const safeLatitude = Math.max(-85.05112878, Math.min(85.05112878, latitude));
  const radians = safeLatitude * Math.PI / 180;
  return (1 - Math.asinh(Math.tan(radians)) / Math.PI) / 2 * (2 ** z);
}

function tileBounds(z, x, y) {
  const width = 2 ** z;
  const west = x / width * 360 - 180;
  const east = (x + 1) / width * 360 - 180;
  const north = Math.atan(Math.sinh(Math.PI * (1 - 2 * y / width))) * 180 / Math.PI;
  const south = Math.atan(Math.sinh(Math.PI * (1 - 2 * (y + 1) / width))) * 180 / Math.PI;
  return { west, south, east, north };
}

function viewportTileId(z, x, y) {
  return `${z}/${x}/${y}`;
}

function viewportTileCenterDistance(tile, center) {
  const width = 2 ** tile.z;
  const centerX = longitudeToTileX(center.lng, tile.z);
  const centerY = latitudeToTileY(center.lat, tile.z);
  const rawX = Math.abs(tile.x + .5 - centerX);
  const dx = Math.min(rawX, width - rawX);
  const dy = tile.y + .5 - centerY;
  return dx * dx + dy * dy;
}

function parseViewportTileId(tileId) {
  const match = /^(15|16|17|18)\/(\d+)\/(\d+)$/.exec(String(tileId));
  if (!match) return null;
  const z = Number(match[1]);
  const x = Number(match[2]);
  const y = Number(match[3]);
  const width = 2 ** z;
  if (!Number.isSafeInteger(x) || !Number.isSafeInteger(y) || x < 0 || x >= width || y < 0 || y >= width) return null;
  return { id: `${z}/${x}/${y}`, z, x, y, bounds: tileBounds(z, x, y) };
}

function desiredViewportTiles(bounds, packBounds, z) {
  const width = 2 ** z;
  const minX = Math.floor(longitudeToTileX(bounds.west, z)) - 1;
  const maxX = Math.floor(longitudeToTileX(bounds.east, z)) + 1;
  const minY = Math.max(0, Math.floor(latitudeToTileY(bounds.north, z)) - 1);
  const maxY = Math.min(width - 1, Math.floor(latitudeToTileY(bounds.south, z)) + 1);
  const tiles = new Map();
  for (let rawX = minX; rawX <= maxX; rawX += 1) {
    const x = canonicalTileX(rawX, z);
    for (let y = minY; y <= maxY; y += 1) {
      const id = viewportTileId(z, x, y);
      const tile = { id, z, x, y, bounds: tileBounds(z, x, y) };
      if (boundsIntersect(tile.bounds, packBounds)) tiles.set(id, tile);
    }
  }
  return tiles;
}

function viewportLayerIds(tileId) {
  const tile = parseViewportTileId(tileId);
  if (!tile) return null;
  const suffix = `${tile.z}-${tile.x}-${tile.y}`;
  return { source: `viewport-buildings-${suffix}`, flat: `viewport-buildings-flat-${suffix}`, extrusion: `viewport-buildings-3d-${suffix}` };
}

function viewportBuildingEnter() {
  map.getCanvas().style.cursor = "pointer";
}

function viewportBuildingLeave() {
  map.getCanvas().style.cursor = "";
}

function removeViewportTile(tileId) {
  if (!mapReady) return;
  const ids = viewportLayerIds(tileId);
  if (!ids) return;
  for (const layerId of [ids.flat, ids.extrusion]) {
    map.off("click", layerId, buildingPopup);
    map.off("mouseenter", layerId, viewportBuildingEnter);
    map.off("mouseleave", layerId, viewportBuildingLeave);
    if (map.getLayer(layerId)) map.removeLayer(layerId);
  }
  if (map.getSource(ids.source)) map.removeSource(ids.source);
}

function cancelViewportRequest() {
  window.clearTimeout(viewport.timer);
  viewport.timer = null;
  const requestId = viewport.requestId;
  if (requestId) {
    try {
      androidHost("cancelViewportBuildings").cancelViewportBuildings();
    } catch (error) {
      console.debug("Viewport cancellation unavailable", error);
    }
  }
  viewport.pending.clear();
  viewport.requestId = null;
}

function discardViewportTiles(cancel = false) {
  if (cancel) cancelViewportRequest();
  else {
    window.clearTimeout(viewport.timer);
    viewport.timer = null;
    viewport.pending.clear();
    viewport.requestId = null;
  }
  for (const tileId of viewport.loaded.keys()) removeViewportTile(tileId);
  viewport.loaded.clear();
  viewport.desired.clear();
  viewport.pack = null;
  viewport.packRevision = null;
  elements.dataStatus.textContent = sceneDataStatus;
}

function hasViewportBuildings() {
  for (const tileId of viewport.loaded.keys()) {
    if (viewport.desired.has(tileId)) return true;
  }
  return false;
}

function updateViewportStatus() {
  if (viewport.blockedSignature && viewport.blockedSignature === viewport.signature) {
    elements.dataStatus.textContent = viewport.error || "Приблизьте карту для 3D-зданий";
    return;
  }
  if (!viewport.pack || !viewport.desired.size) return;
  let count = 0;
  for (const [tileId, entry] of viewport.loaded) {
    if (viewport.desired.has(tileId)) count += entry.featureCount;
  }
  elements.dataStatus.textContent = `${count} зданий · офлайн-пакет · ${viewport.loaded.size}/${viewport.desired.size} тайлов`;
}

function disableViewportForCurrentSignature(message) {
  viewport.error = message;
  viewport.blockedSignature = viewport.signature;
  discardViewportTiles(true);
  applyMapState();
  updateViewportStatus();
}

function validateViewportTile(payload, expectedTile, pack) {
  const tile = payload?.tile;
  const responsePack = payload?.pack;
  const buildings = payload?.buildings;
  if (payload?.schemaVersion !== 1 || tile?.id !== expectedTile.id
    || tile.z !== expectedTile.z || tile.x !== expectedTile.x || tile.y !== expectedTile.y
    || responsePack?.id !== pack.id || typeof responsePack.revision !== "string" || !responsePack.revision
    || buildings?.type !== "FeatureCollection" || !Array.isArray(buildings.features)
    || !Number.isInteger(payload.featureCount) || payload.featureCount !== buildings.features.length
    || !Array.isArray(tile.bounds) || tile.bounds.length !== 2
    || !validLonLat(tile.bounds[0]) || !validLonLat(tile.bounds[1])) {
    return false;
  }
  const bounds = { west: tile.bounds[0][0], south: tile.bounds[0][1], east: tile.bounds[1][0], north: tile.bounds[1][1] };
  const expected = expectedTile.bounds;
  const close = (a, b) => Math.abs(a - b) < 0.000001;
  if (!close(bounds.west, expected.west) || !close(bounds.south, expected.south)
    || !close(bounds.east, expected.east) || !close(bounds.north, expected.north)) return false;
  if (pack.revision && responsePack.revision !== pack.revision) return false;
  if (viewport.packRevision && responsePack.revision !== viewport.packRevision) return false;
  return buildings.features.every((feature) => feature?.type === "Feature"
    && validPolygonGeometry(feature.geometry)
    && Number.isFinite(feature.properties?.height)
    && Number.isFinite(feature.properties?.min_height ?? 0));
}

function addViewportTile(tileId, payload) {
  const ids = viewportLayerIds(tileId);
  if (!ids || !mapReady) return false;
  const budget = viewportBudget();
  const byteSize = payload._byteSize || JSON.stringify(payload.buildings).length * 2;
  let features = payload.featureCount;
  let bytes = byteSize;
  for (const [id, entry] of viewport.loaded) {
    if (id !== tileId) { features += entry.featureCount; bytes += entry.byteSize || 0; }
  }
  if (features > budget.features || bytes > budget.bytes) {
    throw new Error("Слишком плотный район для текущего режима. Приблизьте карту.");
  }
  removeViewportTile(tileId);
  map.addSource(ids.source, { type: "geojson", data: payload.buildings });
  map.addLayer({
    id: ids.flat,
    type: "fill",
    source: ids.source,
    paint: { "fill-color": neutralBuildingColor, "fill-opacity": .8, "fill-outline-color": "#8b928c" },
  }, viewportInsertBeforeLayer);
  map.addLayer({
    id: ids.extrusion,
    type: "fill-extrusion",
    source: ids.source,
    paint: {
      "fill-extrusion-color": neutralBuildingColor,
      "fill-extrusion-height": ["get", "height"],
      "fill-extrusion-base": ["get", "min_height"],
      "fill-extrusion-opacity": .9,
      "fill-extrusion-vertical-gradient": true,
    },
  }, viewportInsertBeforeLayer);
  for (const layerId of [ids.flat, ids.extrusion]) {
    map.on("click", layerId, buildingPopup);
    map.on("mouseenter", layerId, viewportBuildingEnter);
    map.on("mouseleave", layerId, viewportBuildingLeave);
  }
  viewport.loaded.set(tileId, { featureCount: payload.featureCount, byteSize });
  return true;
}

function refreshViewportTiles() {
  if (!mapReady || document.hidden) return;
  const pack = activeInstalledPack();
  const bounds = viewportBounds();
  const zoom = map.getZoom();
  if (!pack || !bounds || !state.buildings || zoom < viewportMinZoom || !boundsIntersect(bounds, pack.bounds)) {
    if (viewport.requestId || viewport.loaded.size) {
      discardViewportTiles(true);
      viewport.signature = null;
      viewport.blockedSignature = null;
      applyMapState();
    }
    return;
  }
  const z = viewportTileZoom(zoom);
  const desired = desiredViewportTiles(bounds, pack.bounds, z);
  const signature = `${pack.id}|${pack.catalogRevision}|${z}|${[...desired.keys()].sort().join(",")}`;
  if (desired.size > Math.min(viewportMaxTiles, viewportBudget().tiles)) {
    viewport.signature = signature;
    disableViewportForCurrentSignature("Приблизьте карту для 3D-зданий");
    return;
  }
  if (viewport.blockedSignature === signature) {
    updateViewportStatus();
    return;
  }
  if (viewport.signature === signature) {
    updateViewportStatus();
    return;
  }

  const samePack = viewport.pack && viewport.pack.id === pack.id
    && viewport.pack.catalogRevision === pack.catalogRevision;
  if (!samePack) {
    discardViewportTiles(true);
    viewport.packRevision = null;
  } else {
    cancelViewportRequest();
    for (const tileId of viewport.loaded.keys()) {
      if (!desired.has(tileId)) {
        removeViewportTile(tileId);
        viewport.loaded.delete(tileId);
      }
    }
  }
  viewport.epoch += 1;
  viewport.signature = signature;
  viewport.blockedSignature = null;
  viewport.error = null;
  viewport.pack = pack;
  viewport.desired = desired;
  const center = map.getCenter();
  const tiles = [...desired.values()]
    .filter((tile) => !viewport.loaded.has(tile.id))
    .sort((left, right) => viewportTileCenterDistance(left, center) - viewportTileCenterDistance(right, center)
      || left.id.localeCompare(right.id));
  if (!tiles.length) {
    applyMapState();
    updateViewportStatus();
    return;
  }
  const requestId = `viewport-${viewport.epoch}`;
  viewport.requestId = requestId;
  for (const tile of tiles) viewport.pending.add(tile.id);
  try {
    androidHost("requestViewportBuildings").requestViewportBuildings(JSON.stringify({
      requestId,
      tiles: tiles.map(({ z: tileZoom, x, y }) => ({ z: tileZoom, x, y })),
    }));
    updateViewportStatus();
  } catch (error) {
    disableViewportForCurrentSignature(`Не удалось загрузить 3D-здания: ${error.message}. Приблизьте карту.`);
  }
}

function scheduleViewportTiles() {
  window.clearTimeout(viewport.timer);
  viewport.timer = window.setTimeout(refreshViewportTiles, 180);
}

async function readGeneratedJson(url) {
  return readLocalJson(url, "/generated/", "результату");
}

async function readViewportJson(url) {
  return readLocalJson(url, "/viewport/", "viewport-тайлу", { maxBytes: 4 * 1024 * 1024, measure: true });
}

Object.assign(window.SloiApp, {
  onSceneProgress(requestId, stage, current, total) {
    if (!pendingScene || String(requestId) !== pendingScene.requestId) return;
    armSceneWatchdog(String(requestId));
    const byteProgress = stage === "download-bytes";
    const fallback = byteProgress
      ? `Загружаю OSM: ${(Math.max(0, Number(current)) / 1048576).toFixed(1)} МБ`
      : stage === "download"
        ? "Подключаюсь к источнику OSM…"
      : stage === "buildings"
        ? "Разбираю здания на телефоне…"
        : stage === "initial-shadow"
          ? "Считаю выбранную тень на телефоне…"
          : stage === "wind"
            ? "Обновляю необязательный слой ветра…"
          : "Готовлю район на телефоне…";
    const progress = byteProgress && Number(total) > 0
      ? ` из ${(Number(total) / 1048576).toFixed(1)} МБ`
      : !byteProgress && Number(total) > 0
        ? ` · ${Number(current)}/${Number(total)}`
        : "";
    setPlaceStatus(fallback + progress);
  },
  async onSceneReady(requestId, url) {
    if (!pendingScene || String(requestId) !== pendingScene.requestId) return;
    const current = pendingScene;
    try {
      const bundle = await readGeneratedJson(url);
      if (!pendingScene || pendingScene.requestId !== current.requestId) return;
      applyBundle(bundle, current.name, current.keepCamera);
      if (window.AndroidHost && typeof window.AndroidHost.acceptScene === "function") {
        window.AndroidHost.acceptScene(activeSceneId);
      }
      const cityPack = String(bundle.source || "").startsWith("city-pack:");
      setPlaceStatus(cityPack
        ? `Готово: ${data.region.name}. Здания взяты из офлайн-пакета, высоты и тени рассчитаны на телефоне.`
        : bundle.cacheHit
          ? `Готово: ${data.region.name}. Сырые данные взяты из кэша телефона.`
          : `Готово: ${data.region.name}. Здания и тень рассчитаны на телефоне.`);
      elements.placeResults.replaceChildren();
      closeSheet();
      current.resolve(bundle);
    } catch (error) {
      if (!pendingScene || pendingScene.requestId !== current.requestId) return;
      setPlaceStatus(`Не удалось открыть результат: ${error.message}. Оставлен предыдущий район.`, true);
      current.reject(error);
    } finally {
      if (pendingScene && pendingScene.requestId === current.requestId) {
        pendingScene = null;
        window.clearTimeout(sceneWatchdog);
        setPlaceBusy(false);
        showFrame(state.frame, false);
      }
    }
  },
  onSceneError(requestId, message) {
    if (!pendingScene || String(requestId) !== pendingScene.requestId) return;
    const current = pendingScene;
    pendingScene = null;
    window.clearTimeout(sceneWatchdog);
    setPlaceBusy(false);
    const error = new Error(String(message || "Ошибка локального расчёта"));
    setPlaceStatus(`Не удалось рассчитать район: ${error.message}. Оставлен предыдущий.`, true);
    setSelectedLocation(data.region.center[1], data.region.center[0]);
    showFrame(state.frame, false);
    current.reject(error);
  },
  onPlacesReady(requestId, payloadText) {
    if (String(requestId) !== String(searchRequestId)) return;
    elements.placeSubmit.disabled = false;
    try {
      const payload = typeof payloadText === "string" ? JSON.parse(payloadText) : payloadText;
      renderPlaces(payload);
    } catch (error) {
      setPlaceStatus(`Поиск вернул повреждённые данные: ${error.message}`, true);
    }
  },
  onPlacesError(requestId, message) {
    if (String(requestId) !== String(searchRequestId)) return;
    elements.placeSubmit.disabled = false;
    setPlaceStatus(`Поиск недоступен: ${String(message || "ошибка сети")}`, true);
  },
  onCityPacks(payloadText) {
    try {
      const payload = typeof payloadText === "string" ? JSON.parse(payloadText) : payloadText;
      const records = payload?.packs || payload?.cities || [];
      const previous = activeInstalledPack();
      cityPacks.clear();
      for (const record of records) cityPacks.set(String(record.id), { ...record });
      const next = activeInstalledPack();
      const previousKey = previous && `${previous.id}|${previous.catalogRevision}`;
      const nextKey = next && `${next.id}|${next.catalogRevision}`;
      if (previousKey !== nextKey) {
        if (viewport.requestId || viewport.loaded.size) {
          discardViewportTiles(true);
          applyMapState();
        }
        viewport.signature = null;
        viewport.blockedSignature = null;
        viewport.pack = null;
        viewport.packRevision = null;
      }
      renderCityPacks();
      scheduleViewportTiles();
    } catch (error) {
      console.warn("Invalid city pack catalog", error);
    }
  },
  onCityPackProgress(id, phase, current, total) {
    const record = cityPacks.get(String(id));
    if (!record) return;
    record.status = "downloading";
    record.phase = String(phase);
    record.current = Number(current) || 0;
    record.total = Number(total) || 0;
    if (record.total > 0) record.downloadBytes = record.total;
    renderCityPacks();
  },
  onCityPackChanged(payloadText) {
    window.SloiApp.onCityPacks(payloadText);
    setPlaceStatus("Офлайн-пакеты обновлены.");
  },
  onCityPackError(id, message) {
    const record = cityPacks.get(String(id));
    if (record) {
      record.status = "error";
      record.error = String(message || "ошибка загрузки");
      renderCityPacks();
    }
    setPlaceStatus(`Пакет города не установлен: ${String(message || "ошибка")}`, true);
  },
  async onViewportTileReady(requestId, tileId, url) {
    if (String(requestId) !== viewport.requestId) return;
    const expectedTile = parseViewportTileId(tileId);
    if (!expectedTile || !viewport.desired.has(expectedTile.id) || !viewport.pending.has(expectedTile.id)) return;
    const currentEpoch = viewport.epoch;
    const pack = viewport.pack;
    try {
      const payload = await readViewportJson(url);
      if (String(requestId) !== viewport.requestId || currentEpoch !== viewport.epoch
        || !viewport.desired.has(expectedTile.id) || !viewport.pending.has(expectedTile.id) || !pack) return;
      if (!validateViewportTile(payload, expectedTile, pack)) {
        throw new Error("Получен несовместимый viewport-тайл");
      }
      viewport.packRevision = payload.pack.revision;
      if (!addViewportTile(expectedTile.id, payload)) throw new Error("Не удалось добавить viewport-тайл на карту");
      viewport.pending.delete(expectedTile.id);
      applyMapState();
      updateViewportStatus();
    } catch (error) {
      if (String(requestId) === viewport.requestId && currentEpoch === viewport.epoch) {
        disableViewportForCurrentSignature(`Не удалось загрузить 3D-здания: ${error.message}. Приблизьте карту.`);
      }
    }
  },
  onViewportTileError(requestId, tileId, code, message) {
    if (String(requestId) !== viewport.requestId) return;
    const tile = parseViewportTileId(tileId);
    if (!tile || !viewport.desired.has(tile.id) || !viewport.pending.has(tile.id)) return;
    const detail = String(message || code || "ошибка движка");
    const tooDense = String(code || "").toLowerCase() === "too_dense";
    disableViewportForCurrentSignature(tooDense
      ? "Приблизьте карту для 3D-зданий"
      : `Не удалось загрузить 3D-здания: ${detail}. Приблизьте карту.`);
  },
  onViewportBatchComplete(requestId) {
    if (String(requestId) !== viewport.requestId) return;
    // URL reads are asynchronous; do not clear pending here or a late fetch
    // could be mistaken for a stale callback and leave a visible hole.
    updateViewportStatus();
  },
  onViewportInvalidated() {
    if (viewport.requestId || viewport.loaded.size) {
      discardViewportTiles(true);
      applyMapState();
    }
    viewport.signature = null;
    viewport.blockedSignature = null;
    viewport.error = null;
    scheduleViewportTiles();
  },
  async onFrameReady(sceneId, index, requestId, url) {
    if (String(sceneId) !== activeSceneId || String(requestId) !== String(frameRequestId)) return;
    try {
      const payload = await readGeneratedJson(url);
      if (String(sceneId) !== activeSceneId || String(requestId) !== String(frameRequestId)) return;
      const safeIndex = Number(index);
      const frame = payload?.frame || payload;
      if (!Number.isInteger(safeIndex) || safeIndex < 0 || safeIndex >= frames.length
        || !frame || (frame.geometry !== null && !validShadowGeometry(frame.geometry))) {
        throw new Error("Некорректный кадр тени");
      }
      frames[safeIndex] = { ...frames[safeIndex], ...frame, computed: true };
      window.clearTimeout(frameWatchdog);
      if (state.frame === safeIndex) {
        showFrame(safeIndex, false);
        setPlaceStatus(`Тень ${frames[safeIndex].label} рассчитана на телефоне.`);
      }
    } catch (error) {
      if (String(sceneId) !== activeSceneId || String(requestId) !== String(frameRequestId)) return;
      if (state.frame === Number(index)) {
        showFrameFailure(error.message);
      }
    }
  },
  onFrameError(sceneId, index, requestId, message) {
    if (String(sceneId) !== activeSceneId || String(requestId) !== String(frameRequestId)) return;
    if (state.frame === Number(index)) {
      showFrameFailure(String(message || "ошибка движка"));
    }
  },
  onGeoJsonImported(name, text) { importGeoJson(name, text); },
  onGeoJsonImportError(message) {
    setImportBusy(false);
    setImportStatus(String(message || "Не удалось прочитать файл"), true);
  },
  onGeoJsonImportCancelled() {
    setImportBusy(false);
    setImportStatus("Выбор файла отменён.");
  },
});

function shadowCollection(geometry) {
  if (!geometry || (geometry.type === "GeometryCollection"
    && Array.isArray(geometry.geometries) && geometry.geometries.length === 0)) {
    return { type: "FeatureCollection", features: [] };
  }
  return {
    type: "FeatureCollection",
    features: [{ type: "Feature", properties: {}, geometry }],
  };
}

const neutralBuildingColor = "#d9d8cf";
const confidenceColor = [
  "match",
  ["get", "height_source"],
  "height", "#3f8b67",
  "levels", "#e0a22f",
  "#c76357",
];

function setLayerVisibility(id, visible) {
  if (mapReady && map.getLayer(id)) {
    const value = visible ? "visible" : "none";
    if (map.getLayoutProperty(id, "visibility") !== value) map.setLayoutProperty(id, "visibility", value);
  }
}

function applyControls() {
  const focused = document.activeElement;
  elements.mode2d.setAttribute("aria-pressed", String(state.mode === "2d"));
  elements.mode3d.setAttribute("aria-pressed", String(state.mode === "3d"));
  elements.baseLight.setAttribute("aria-pressed", String(state.basemap === "light"));
  elements.baseDark.setAttribute("aria-pressed", String(state.basemap === "dark"));
  elements.confidenceToggle.checked = state.confidence;
  elements.confidenceToggle.disabled = !state.buildings;
  elements.heightLegend.hidden = !state.confidence || !state.buildings;
  let activeCount = 0;
  const order = currentLayerOrder();
  for (const layer of allLayers()) {
    const controls = layerControls.get(layer.id);
    const available = layer.id !== "wind" || windAvailable;
    const settings = settingsForLayer(layer);
    const opacity = Math.round(settings.opacity * 100);
    controls.toggle.checked = settings.enabled;
    controls.toggle.disabled = !available;
    controls.opacity.disabled = !available || !settings.enabled;
    controls.opacity.value = String(opacity);
    controls.output.value = controls.output.textContent = `${opacity}%`;
    const position = order.indexOf(layer.id);
    controls.up.disabled = position === order.length - 1;
    controls.down.disabled = position === 0;
    if (available && settings.enabled) activeCount++;
  }
  const displayOrder = [...order].reverse();
  const currentOrder = [...elements.layerList.children].map((card) => card.dataset.layer);
  if (displayOrder.join() !== currentOrder.join()) {
    for (const id of displayOrder) elements.layerList.append(layerControls.get(id).card);
    if (focused && elements.layerList.contains(focused)) {
      const target = focused.disabled
        ? focused.closest(".layer-order")?.querySelector("button:not(:disabled)")
        : focused;
      target?.focus({ preventScroll: true });
    }
  }
  elements.activeCount.textContent = String(activeCount);
}

function moveLayerGroup(id, direction) {
  state.layerOrder = currentLayerOrder();
  const index = state.layerOrder.indexOf(id);
  const next = index + direction;
  if (index < 0 || next < 0 || next >= state.layerOrder.length) return;
  [state.layerOrder[index], state.layerOrder[next]] = [state.layerOrder[next], state.layerOrder[index]];
  applyMapState();
  haptic();
}

function initializeLayerRuntime() {
  layerRuntime = new window.SloiLayerRuntime.Runtime(map);
  for (const layer of layerSettings.registry) {
    layerRuntime.register({
      ...layer, sourceLabel: layer.source,
      available: () => layer.id !== "wind" || windAvailable,
      getSettings: () => settingsForLayer(layer),
      mapLayers: () => {
        if (layer.id === "shadows") return [{ id: "ground-shadows", opacityProperty: "fill-opacity" }];
        if (layer.id === "wind") return [
          { id: "wind-line", opacityProperty: "line-opacity" },
          { id: "wind-head", opacityProperty: "circle-opacity", extraOpacityProperties: ["circle-stroke-opacity"] },
        ];
        if (layer.id === "sun") return [
          { id: "sun-line", opacityProperty: "line-opacity" },
          { id: "sun-head", opacityProperty: "circle-opacity", extraOpacityProperties: ["circle-stroke-opacity"] },
        ];
        const bindings = [
          { id: "buildings-flat", opacityProperty: "fill-opacity", visible: () => !hasViewportBuildings() && state.mode === "2d" },
          { id: "buildings-3d", opacityProperty: "fill-extrusion-opacity", visible: () => !hasViewportBuildings() && state.mode === "3d" },
        ];
        for (const tileId of viewport.loaded.keys()) {
          const ids = viewportLayerIds(tileId);
          if (ids) bindings.push(
            { id: ids.flat, opacityProperty: "fill-opacity", visible: () => state.mode === "2d" },
            { id: ids.extrusion, opacityProperty: "fill-extrusion-opacity", visible: () => state.mode === "3d" },
          );
        }
        return bindings;
      },
    });
  }
}

function applyMapState() {
  if (styleFrame !== null) { window.cancelAnimationFrame(styleFrame); styleFrame = null; }
  if (shadowWasEnabled !== state.shadows) {
    shadowWasEnabled = state.shadows;
    invalidateFrameRequest();
    if (!state.shadows && window.AndroidHost && typeof window.AndroidHost.cancelShadowFrame === "function") window.AndroidHost.cancelShadowFrame();
    showFrame(state.frame, false);
  }
  applyControls();
  saveState();
  if (!mapReady) return;
  setLayerVisibility("base-light", state.basemap === "light");
  setLayerVisibility("base-dark", state.basemap === "dark");
  setPaintIfChanged("ground-shadows", "fill-color", state.basemap === "dark" ? "#09110e" : "#17231f");
  const buildingColor = state.confidence ? confidenceColor : neutralBuildingColor;
  const pairs = [{ flat: "buildings-flat", extrusion: "buildings-3d" },
    ...[...viewport.loaded.keys()].map(viewportLayerIds).filter(Boolean)];
  for (const ids of pairs) {
    setPaintIfChanged(ids.flat, "fill-color", buildingColor);
    setPaintIfChanged(ids.extrusion, "fill-extrusion-color", buildingColor);
  }
  layerRuntime.apply(state, currentLayerOrder());
}

function applyCameraMode(animate) {
  if (!mapReady) return;
  const camera = state.mode === "3d"
    ? { pitch: 56, bearing: -22 }
    : { pitch: 0, bearing: 0 };
  map.easeTo({ ...camera, duration: animate ? 550 : 0 });
}

function requestFrame(index) {
  if (!activeSceneId || pendingScene || !state.shadows || document.hidden) return;
  window.clearTimeout(frameDebounceTimer);
  window.clearTimeout(frameWatchdog);
  const requestId = String(++frameRequestId);
  const sceneId = activeSceneId;
  frameDebounceTimer = window.setTimeout(() => {
    if (pendingScene || !state.shadows || document.hidden || activeSceneId !== sceneId || String(frameRequestId) !== requestId
      || state.frame !== index || frames[index]?.computed) return;
    try {
      setPlaceStatus(`Считаю тень ${frames[index].label} на телефоне…`);
      androidHost("requestShadowFrame").requestShadowFrame(
        sceneId,
        index,
        requestId,
      );
      frameWatchdog = window.setTimeout(() => {
        if (sceneId !== activeSceneId || requestId !== String(frameRequestId) || state.frame !== index) return;
        invalidateFrameRequest();
        if (window.AndroidHost && typeof window.AndroidHost.cancelShadowFrame === "function") window.AndroidHost.cancelShadowFrame();
        showFrameFailure("Расчёт не отвечает. Повторите попытку.");
      }, 90000);
    } catch (error) {
      showFrameFailure(error.message);
    }
  }, 180);
}

function showFrame(index, persist = true) {
  const value = Number(index);
  const safeIndex = Number.isInteger(value) ? Math.max(0, Math.min(frames.length - 1, value)) : 0;
  const frame = frames[safeIndex];
  state.frame = safeIndex;
  elements.retryFrame.hidden = true;
  elements.timeRange.value = String(safeIndex);
  elements.timeValue.textContent = frame.label;
  elements.sunValue.textContent = frame.altitude <= .5
    ? "Солнце ниже горизонта — наземной тени нет"
    : `Солнце ${Math.round(frame.altitude)}° · тень ${Math.round(frame.shadow_bearing)}°`;
  elements.daylightPill.textContent = frame.altitude <= .5 ? "Ночь" : "День";
  elements.daylightPill.classList.toggle("is-night", frame.altitude <= .5);
  const needsComputation = frame.altitude > .5 && frame.geometry === null
    && frame.computed === false;
  if (mapReady && state.shadows && renderedShadowGeometry !== frame.geometry) {
    const source = map.getSource("shadows");
    if (source) { source.setData(shadowCollection(frame.geometry)); renderedShadowGeometry = frame.geometry; }
  }
  updateSunDirection(frame);
  if (needsComputation && state.shadows) {
    elements.sunValue.textContent = `Солнце ${Math.round(frame.altitude)}° · считаю тень…`;
    requestFrame(safeIndex);
  }
  if (persist) saveState();
}

function stopPlayback() {
  if (playbackTimer !== null) window.clearInterval(playbackTimer);
  playbackTimer = null;
  elements.play.textContent = "▶";
  elements.play.setAttribute("aria-label", "Запустить движение тени");
  elements.play.setAttribute("aria-pressed", "false");
}

function startPlayback() {
  if (playbackTimer !== null) {
    stopPlayback();
    return;
  }
  haptic();
  elements.play.textContent = "❚❚";
  elements.play.setAttribute("aria-label", "Остановить движение тени");
  elements.play.setAttribute("aria-pressed", "true");
  playbackTimer = window.setInterval(() => {
    const current = frames[state.frame];
    if (state.shadows && current && current.altitude > .5 && current.geometry === null
      && current.computed === false) return;
    const next = (state.frame + 1) % frames.length;
    showFrame(next, false);
    if (next === 0) saveState();
  }, 900);
}

function openSheet() {
  elements.sheet.inert = false;
  elements.scrim.classList.add("is-open");
  elements.sheet.classList.add("is-open");
  elements.sheet.setAttribute("aria-hidden", "false");
  elements.layersButton.setAttribute("aria-expanded", "true");
  setMapInert(true);
  elements.closeSheet.focus();
}

function closeSheet() {
  elements.scrim.classList.remove("is-open");
  elements.sheet.classList.remove("is-open");
  elements.sheet.setAttribute("aria-hidden", "true");
  elements.sheet.inert = true;
  elements.layersButton.setAttribute("aria-expanded", "false");
  setMapInert(false);
  elements.layersButton.focus();
}

function setMapInert(inert) {
  for (const node of document.querySelectorAll("#map, .topbar, .mode-switch, #recenter, #locate, #time-card")) {
    node.inert = inert;
  }
}

function fitRegion(animate) {
  if (!map) return;
  const padding = { top: 120, right: 24, bottom: 190, left: 24 };
  if (state.mode !== "3d") {
    map.fitBounds(data.region.bounds, { padding, pitch: 0, bearing: 0, duration: animate ? 650 : 0 });
    return;
  }
  const camera = map.cameraForBounds(data.region.bounds, { padding });
  if (camera) {
    map.easeTo({
      ...camera,
      zoom: Math.min(map.getMaxZoom(), Math.max(14.5, camera.zoom)),
      pitch: 56,
      bearing: -22,
      duration: animate ? 650 : 0,
    });
    return;
  }
  map.fitBounds(data.region.bounds, { padding, pitch: 56, bearing: -22, duration: animate ? 650 : 0 });
}

function setConnectionWarning(message) {
  window.clearTimeout(tileErrorTimer);
  elements.connection.textContent = message;
  elements.connection.classList.add("is-visible");
  if (navigator.onLine) {
    tileErrorTimer = window.setTimeout(
      () => elements.connection.classList.remove("is-visible"),
      4000,
    );
  }
}

function updateOnlineState() {
  if (navigator.onLine) {
    elements.connection.classList.remove("is-visible");
  } else {
    setConnectionWarning("Без подложки");
  }
}

function buildingPopup(event) {
  const feature = event.features && event.features[0];
  if (!feature) return;
  const properties = feature.properties || {};
  const content = document.createElement("div");
  content.className = "building-popup";
  const title = document.createElement("strong");
  title.textContent = properties.name || "Здание";
  const height = document.createElement("span");
  height.textContent = `Высота: ${Math.round(Number(properties.height) || 0)} м`;
  const source = document.createElement("span");
  source.textContent = `Источник: ${properties.height_source || "default"}`;
  content.append(title, height, source);
  if (popup) popup.remove();
  popup = new maplibregl.Popup({ offset: 12, closeButton: true })
    .setLngLat(event.lngLat)
    .setDOMContent(content)
    .addTo(map);
  popup.on("close", () => { popup = null; });
}

elements.regionName.textContent = data.region.name;
elements.dataStatus.textContent = `${data.buildings.features.length} зданий · встроенный район`;
elements.timeRange.max = String(frames.length - 1);
elements.economyMode.checked = economyMode;
updateSceneClock();
updateWind(null);
applyControls();
showFrame(state.frame);
updateOnlineState();
requestCityPacks();
renderPresets();
setImportBusy(true);

elements.importButton.addEventListener("click", () => {
  if (importBusy) return;
  setImportBusy(true);
  if (window.AndroidHost && typeof window.AndroidHost.importGeoJson === "function") {
    try { window.AndroidHost.importGeoJson(); }
    catch (error) { window.SloiApp.onGeoJsonImportError(error.message); }
  } else {
    elements.importFile.value = "";
    elements.importFile.click();
  }
});
elements.importFile.addEventListener("cancel", () => window.SloiApp.onGeoJsonImportCancelled());
elements.importFile.addEventListener("change", async () => {
  const file = elements.importFile.files[0];
  if (!file) { window.SloiApp.onGeoJsonImportCancelled(); return; }
  if (file.size > 2 * 1024 * 1024) { window.SloiApp.onGeoJsonImportError("Файл больше 2 МБ."); return; }
  try { await importGeoJson(file.name, await file.text()); }
  catch (error) { window.SloiApp.onGeoJsonImportError(error.message); }
});
elements.cancelScene.addEventListener("click", () => cancelSceneLoad());
elements.retryFrame.addEventListener("click", () => showFrame(state.frame, false));
elements.economyMode.addEventListener("change", () => {
  economyMode = elements.economyMode.checked;
  try { localStorage.setItem("sloi-economy-mode", String(economyMode)); }
  catch (_) { setImportStatus("Режим действует, но не сохранится после закрытия.", true); }
  if (mapReady) {
    discardViewportTiles(true);
    viewport.signature = null;
    viewport.blockedSignature = null;
    viewport.error = null;
    map.setPixelRatio(renderPixelRatio());
    applyMapState();
    scheduleViewportTiles();
  }
});
elements.sceneToday.addEventListener("click", () => { elements.sceneDate.value = localDateString(); });
elements.sceneDateForm.addEventListener("submit", (event) => {
  event.preventDefault();
  loadSceneAt(data.region.center[1], data.region.center[0], data.region.name, { keepCamera: true })
    .catch((error) => setPlaceStatus(error.message, true));
});

elements.presetForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const name = elements.presetName.value.trim();
  if (!name) {
    setPresetStatus("Введите название набора.", true);
    return;
  }
  if (presets.length >= 20) {
    setPresetStatus("Можно сохранить до 20 наборов. Удалите ненужный набор.", true);
    return;
  }
  const preset = {
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
    name,
    config: layerSettings.capturePreset(state, frames[state.frame].label),
  };
  if (storePresets([...presets, preset])) {
    elements.presetName.value = "";
    setPresetStatus(`Набор «${name}» сохранён на этом устройстве.`);
  }
});

elements.layersButton.addEventListener("click", openSheet);
elements.closeSheet.addEventListener("click", closeSheet);
elements.scrim.addEventListener("click", closeSheet);
elements.mode2d.addEventListener("click", () => {
  state.mode = "2d";
  haptic();
  applyMapState();
  applyCameraMode(true);
});
elements.mode3d.addEventListener("click", () => {
  state.mode = "3d";
  haptic();
  applyMapState();
  applyCameraMode(true);
});
elements.baseLight.addEventListener("click", () => {
  state.basemap = "light";
  haptic();
  applyMapState();
});
elements.baseDark.addEventListener("click", () => {
  state.basemap = "dark";
  haptic();
  applyMapState();
});
elements.confidenceToggle.addEventListener("change", () => {
  state.confidence = elements.confidenceToggle.checked;
  haptic();
  applyMapState();
});
elements.timeRange.addEventListener("input", () => {
  stopPlayback();
  showFrame(elements.timeRange.value);
});
elements.play.addEventListener("click", startPlayback);
elements.recenter.addEventListener("click", () => {
  haptic();
  fitRegion(true);
});
elements.locate.addEventListener("click", () => {
  haptic();
  locateAndLoad();
});
elements.myLocation.addEventListener("click", () => {
  haptic();
  locateAndLoad();
});
elements.loadCenter.addEventListener("click", () => {
  const center = map.getCenter();
  haptic();
  loadSceneAt(center.lat, center.lng, "Центр карты").catch(console.warn);
});
elements.placeForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const query = elements.placeQuery.value.trim();
  if (query.length < 2) {
    setPlaceStatus("Введите хотя бы два символа.", true);
    return;
  }
  searchPlaces(query);
});
window.addEventListener("online", updateOnlineState);
window.addEventListener("offline", updateOnlineState);
document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    stopPlayback();
    invalidateFrameRequest();
    if (window.AndroidHost && typeof window.AndroidHost.cancelShadowFrame === "function") window.AndroidHost.cancelShadowFrame();
    cancelViewportRequest();
    viewport.signature = null;
  } else {
    showFrame(state.frame, false);
    scheduleViewportTiles();
  }
});
document.addEventListener("keydown", (event) => {
  if (!elements.sheet.classList.contains("is-open")) return;
  if (event.key === "Escape") {
    event.preventDefault();
    closeSheet();
  } else if (event.key === "Tab") {
    const focusable = [...elements.sheet.querySelectorAll("button, input, select, summary, [tabindex='0']")]
      .filter((node) => !node.disabled && node.getClientRects().length > 0);
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }
});

try {
  map = new maplibregl.Map({
    container: "map",
    pixelRatio: renderPixelRatio(),
    maxTileCacheSize: 64,
    fadeDuration: 0,
    center: data.region.center,
    zoom: 14.8,
    pitch: state.mode === "3d" ? 56 : 0,
    bearing: state.mode === "3d" ? -22 : 0,
    maxPitch: 70,
    attributionControl: false,
    style: {
      version: 8,
      sources: {
        "carto-light": {
          type: "raster",
          tiles: ["https://a.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png"],
          tileSize: 256,
          attribution: "© OpenStreetMap contributors © CARTO",
        },
        "carto-dark": {
          type: "raster",
          tiles: ["https://a.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png"],
          tileSize: 256,
          attribution: "© OpenStreetMap contributors © CARTO",
        },
      },
      layers: [
        { id: "base-light", type: "raster", source: "carto-light" },
        {
          id: "base-dark",
          type: "raster",
          source: "carto-dark",
          layout: { visibility: "none" },
        },
      ],
    },
  });
  map.addControl(new maplibregl.AttributionControl({ compact: true }), "bottom-right");

  const initializeMapLayers = () => {
    if (mapReady) return;
    map.addSource("shadows", {
      type: "geojson",
      data: shadowCollection(frames[state.frame].geometry),
    });
    map.addSource("buildings", {
      type: "geojson",
      data: data.buildings,
    });
    map.addSource("selected-location", {
      type: "geojson",
      data: { type: "FeatureCollection", features: [] },
    });
    map.addSource("wind-vector", {
      type: "geojson",
      data: { type: "FeatureCollection", features: [] },
    });
    map.addSource("sun-direction", {
      type: "geojson", data: { type: "FeatureCollection", features: [] },
    });
    map.addLayer({
      id: "ground-shadows",
      type: "fill",
      source: "shadows",
      paint: {
        "fill-color": "#17231f",
        "fill-opacity": state.shadowOpacity,
      },
    });
    map.addLayer({
      id: "buildings-flat",
      type: "fill",
      source: "buildings",
      paint: {
        "fill-color": neutralBuildingColor,
        "fill-opacity": .8,
        "fill-outline-color": "#8b928c",
      },
    });
    map.addLayer({
      id: "buildings-3d",
      type: "fill-extrusion",
      source: "buildings",
      paint: {
        "fill-extrusion-color": neutralBuildingColor,
        "fill-extrusion-height": ["get", "height"],
        "fill-extrusion-base": ["get", "min_height"],
        "fill-extrusion-opacity": .9,
        "fill-extrusion-vertical-gradient": true,
      },
    });
    map.addLayer({
      id: "wind-line",
      type: "line",
      source: "wind-vector",
      filter: ["==", ["get", "kind"], "line"],
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": "#1976d2",
        "line-width": 5,
        "line-opacity": .82,
        "line-dasharray": [1.2, 1.2],
      },
    });
    map.addLayer({
      id: "wind-head",
      type: "circle",
      source: "wind-vector",
      filter: ["==", ["get", "kind"], "head"],
      paint: {
        "circle-radius": 7,
        "circle-color": "#1976d2",
        "circle-stroke-color": "#ffffff",
        "circle-stroke-width": 2,
      },
    });
    map.addLayer({
      id: "sun-line", type: "line", source: "sun-direction",
      filter: ["==", ["get", "kind"], "line"],
      paint: { "line-color": "#ed9c13", "line-width": 3, "line-dasharray": [2, 1] },
    });
    map.addLayer({
      id: "sun-head", type: "circle", source: "sun-direction",
      filter: ["==", ["get", "kind"], "head"],
      paint: { "circle-radius": 9, "circle-color": "#ffba2c", "circle-stroke-color": "#fff4cc", "circle-stroke-width": 3 },
    });
    map.addLayer({
      id: "selected-location",
      type: "circle",
      source: "selected-location",
      paint: {
        "circle-radius": 8,
        "circle-color": "#286b52",
        "circle-stroke-color": "#ffffff",
        "circle-stroke-width": 3,
      },
    });

    mapReady = true;
    initializeLayerRuntime();
    applyMapState();
    showFrame(state.frame);
    fitRegion(false);
    scheduleViewportTiles();
    restoreCustomLayers();
    elements.loading.classList.add("is-hidden");

    for (const layer of ["buildings-flat", "buildings-3d"]) {
      map.on("click", layer, buildingPopup);
      map.on("mouseenter", layer, () => { map.getCanvas().style.cursor = "pointer"; });
      map.on("mouseleave", layer, () => { map.getCanvas().style.cursor = ""; });
    }
  };
  // Local overlays must not wait for raster tiles or a load event that already fired.
  if (map.isStyleLoaded()) initializeMapLayers();
  else map.once("style.load", initializeMapLayers);

  map.on("error", (event) => {
    const message = String(event.error && event.error.message || "");
    if (/tile|network|fetch|request/i.test(message)) {
      setConnectionWarning("Подложка недоступна");
    } else {
      console.warn("MapLibre error", event.error);
    }
  });
  map.on("moveend", scheduleViewportTiles);
} catch (error) {
  console.error(error);
  showFatal(error.message || "Ошибка запуска карты");
}
