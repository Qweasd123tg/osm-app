"use strict";

const $ = (id) => document.getElementById(id);
let fallbackData = null;
let data = null;
let selectedPlace = null;
let selectedPlaceNameRequest = null;
let demoPromise = null;
let navigationGeneration = 0;
let cameraInputGeneration = 0;
let locationGeneration = 0;
let sceneDataStatus = "OpenStreetMap · выберите место или добавьте свой слой";
let map = null;
let offlineBasemap = null;
let offlinePlaceState = null;
let offlinePlaceRevision = "";
let searchNeedsRefresh = false;
let routingUI = null;
let transportUI = null;
let transportPresets = null;
let mapReady = false;
let mapTouchActive = false;
let shadowExtensionActive = false;
let shadowRefreshTimer = null;
let shadowFailedView = null;
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
let moduleHost = null;
let activePanel = "layers";
let sheetOpener = null;
let settingsOpener = null;
let activeSettingsPanel = "settings";
let sliderFrame = null;
const retainedFrames = new Map();
let styleFrame = null;
let renderedShadowGeometry;
let lastSavedState = null;
let economyMode = false;
try { economyMode = localStorage.getItem("sloi-economy-mode") === "true"; } catch (_) { /* Optional preference. */ }
const customLayers = new Map();
const cityPacks = new Map();
const cityPackControls = new Map();
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
  cancelShadowScene: $("cancel-shadow-scene"),
  shadowStatus: $("shadow-status"),
  economyMode: $("economy-mode"),
  retryFrame: $("retry-frame"),
  timeCard: $("time-card"),
  demoButton: $("load-demo"),
};

function showFatal(message) {
  elements.loading.classList.add("is-hidden");
  elements.fatalMessage.textContent = String(message || "Неизвестная ошибка");
  elements.fatal.classList.add("is-visible");
}

window.SloiApp = {
  showFatal,
  closeTransientUi() {
    if (!$("settings-page").hidden) {
      backSettingsPage();
      return true;
    }
    if (transportUI?.isOpen()) { transportUI.back(); return true; }
    if (routingUI?.isOpen?.()) {
      if (routingUI.back) routingUI.back(); else routingUI.close();
      return true;
    }
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

offlineBasemap = window.SloiOfflineBasemap.install({
  host: window.AndroidHost, getMap: () => map, document, callbacks: window.SloiApp,
  formatBytes, onUseChange: () => updateOnlineState(),
});

if (typeof maplibregl === "undefined") {
  showFatal("В APK отсутствует MapLibre");
  throw new Error("MapLibre is missing");
}

let frames = [];
let windAvailable = false;
let defaultFrame = 0;
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
  const options = card.querySelector(".layer-options");
  if (["shadows", "wind", "sun"].includes(layer.id)) card.hidden = true;
  if (options && !options.closest("details")) {
    const detail = document.createElement("details");
    detail.className = "layer-options-details";
    const summary = document.createElement("summary"); summary.textContent = "Настроить";
    options.replaceWith(detail); detail.append(summary, options);
  }
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
    const normalized = layerSettings.normalizeState({ mode: "2d", ...saved }, stateOptions());
    if (localStorage.getItem("sloi-building-transparency-v1") !== "done") {
      normalized.buildingOpacity = Math.min(normalized.buildingOpacity, .65);
      // Write the migrated value first so a completed marker cannot retain an
      // old opaque value. Later opacity changes remain the user's preference.
      try {
        localStorage.setItem("sloi-map-state", JSON.stringify(normalized));
        localStorage.setItem("sloi-building-transparency-v1", "done");
      } catch (error) { console.warn("Could not persist building transparency", error); }
    }
    return normalized;
  } catch (error) {
    console.warn("Could not restore state", error);
    return layerSettings.normalizeState({ mode: "2d" }, stateOptions());
  }
}

const state = loadState();
// Optional calculations are enabled by extensions, never by legacy demo state.
state.shadows = false;
state.wind = false;
state.sun = false;
let savedCamera = null;
try { savedCamera = window.SloiMapCamera.load(localStorage); } catch (_) { /* Map works without storage. */ }
if (!savedCamera) state.mode = "2d";
let storedPitch = state.mode === "3d" ? (savedCamera?.pitch || 56) : 0;
try {
  const savedPitch = JSON.parse(localStorage.getItem("sloi-pitch-angle"));
  if (state.mode === "3d" && typeof savedPitch === "number" && savedPitch > 0 && savedPitch <= 60) storedPitch = savedPitch;
} catch (_) {}
const pitchController = window.SloiMapCamera.createPitchController(storedPitch);
let themePreference = "system";
try { themePreference = localStorage.getItem("sloi-theme") || "system"; } catch (_) {}
const systemTheme = window.matchMedia("(prefers-color-scheme: dark)");
function applyTheme() {
  let prefersDark = systemTheme.matches;
  try { if (window.AndroidHost?.isDarkTheme) prefersDark = window.AndroidHost.isDarkTheme(); } catch (_) {}
  const dark = themePreference === "dark" || (themePreference === "system" && prefersDark);
  const themeChanged = document.documentElement.dataset.theme !== (dark ? "dark" : "light");
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  state.basemap = dark ? "dark" : "light";
  document.querySelector('meta[name="theme-color"]').content = dark ? "#24272d" : "#ffffff";
  for (const button of document.querySelectorAll("#theme-options button")) button.setAttribute("aria-pressed", String(button.dataset.theme === themePreference));
  try { window.AndroidHost?.setSystemBarTheme?.(dark); } catch (_) {}
  if (mapReady) applyMapState();
  if (mapReady && themeChanged && moduleHost) {
    for (const id of ["spb-metro", "spb-stops"]) if (moduleHost.entries.has(id) && moduleHost.get(id).enabled) {
      // Locally rasterized text halos follow the basemap without moving it.
      moduleHost.refresh(id).catch(error => console.debug("Transit theme refresh", error));
    }
  }
}
systemTheme.addEventListener("change", applyTheme);
applyTheme();

const moduleCards = new Map();
function renderModules(snapshots) {
  const statuses = { disabled: "Выключен", loading: "Загрузка…", ready: "На карте", paused: "Приостановлен", error: "Не удалось загрузить" };
  for (const module of snapshots) {
    let controls = moduleCards.get(module.id);
    if (!controls) {
      const card = document.createElement("section");
      card.className = "module-card";
      card.dataset.module = module.id;
      const heading = document.createElement("div");
      heading.className = "module-heading";
      const copy = document.createElement("div");
      copy.className = "module-copy";
      const title = document.createElement("strong"); title.textContent = module.title;
      copy.append(title);
      const toggleLabel = document.createElement("label"); toggleLabel.className = "switch";
      const toggle = document.createElement("input"); toggle.type = "checkbox";
      toggle.setAttribute("aria-label", `Модуль ${module.title}`);
      toggle.addEventListener("change", () => toggle.checked ? moduleHost.enable(module.id) : moduleHost.disable(module.id));
      toggleLabel.append(toggle, document.createElement("span"));
      heading.append(copy, toggleLabel);
      const status = document.createElement("p"); status.className = "module-status"; status.setAttribute("role", "status");
      const form = document.createElement("form"); form.className = "module-settings";
      const fields = new Map();
      for (const spec of window.SloiNativeShadows?.controls[module.id] || window.SloiMetro?.controls[module.id] || window.SloiLiveTransport?.controls[module.id] || window.SloiBundledModules.controls[module.id] || []) {
        const label = document.createElement("label"); label.textContent = spec.label;
        const input = document.createElement(spec.type === "select" ? "select" : "input");
        input.setAttribute("aria-label", `${module.title}: ${spec.label}`);
        if (spec.type === "select") for (const choice of spec.options) {
          const option = document.createElement("option"); option.value = String(choice.value); option.textContent = choice.label; input.append(option);
        } else input.type = spec.type;
        for (const key of ["min", "max", "step", "maxLength"]) if (spec[key] !== undefined) input[key] = spec[key];
        if (spec.type !== "checkbox") input.value = String(module.settings[spec.key]); else input.checked = module.settings[spec.key];
        fields.set(spec.key, input); label.append(input); form.append(label);
      }
      const apply = document.createElement("button"); apply.type = "submit"; apply.className = "secondary-button"; apply.textContent = "Применить";
      form.append(apply);
      form.hidden = fields.size === 0;
      form.addEventListener("submit", async (event) => {
        event.preventDefault();
        const patch = {};
        for (const [key, input] of fields) patch[key] = typeof module.settings[key] === "boolean" ? input.checked : typeof module.settings[key] === "number" ? Number(input.value) : input.value;
        try {
          if (module.id === "spb-live") { patch.routes = ""; transportPresets?.clearActive(); }
          await moduleHost.configure(module.id, patch);
        } catch (error) {
          status.textContent = error.message;
          settingsStatus.textContent = error.message;
          settingsStatus.hidden = false;
        }
      });
      const retry = document.createElement("button"); retry.type = "button"; retry.className = "secondary-button"; retry.textContent = "Повторить";
      retry.addEventListener("click", () => moduleHost.enable(module.id));
      const locate = document.createElement("button"); locate.type = "button"; locate.className = "secondary-button"; locate.textContent = "На карте";
      locate.setAttribute("aria-label", `Показать модуль ${module.title} на карте`);
      locate.addEventListener("click", () => { const bounds = moduleHost.get(module.id).bounds; if (bounds) { closeSheet(); map.fitBounds(bounds, { padding: 100, maxZoom: 16, duration: 500 }); } });
      const configuration = document.createElement("section"); configuration.className = "module-configuration";
      configuration.dataset.moduleSettings = module.id;
      const settingsTitle = document.createElement("h3"); settingsTitle.textContent = module.title;
      const settingsStatus = document.createElement("p"); settingsStatus.className = "module-status";
      settingsStatus.setAttribute("role", "status"); settingsStatus.hidden = true;
      configuration.append(settingsTitle, form, settingsStatus, locate);
      $("module-settings-list").append(configuration);
      card.append(heading, status, retry); $(module.example ? "example-module-list" : "module-list").append(card);
      if (["spb-metro", "spb-live"].includes(module.id)) {
        const browse = document.createElement("button"); browse.type = "button"; browse.className = "secondary-button";
        browse.textContent = module.id === "spb-metro" ? "Линии метро" : "Наборы маршрутов";
        browse.addEventListener("click", () => transportUI?.open(module.id === "spb-metro" ? "metro" : "presets"));
        card.append(browse);
      }
      if (module.id === "shadows") card.append(elements.cancelShadowScene);
      controls = { card, toggle, status, settingsStatus, retry, locate, fields, settingsSignature: JSON.stringify(module.settings) }; moduleCards.set(module.id, controls);
    }
    controls.toggle.checked = module.enabled;
    controls.card.dataset.status = module.status;
    controls.status.textContent = module.error || module.storageWarning || statuses[module.status];
    if (module.id === "shadows" && module.enabled && elements.shadowStatus.textContent) controls.status.textContent = elements.shadowStatus.textContent;
    controls.status.hidden = !module.error && !module.storageWarning && module.status !== "loading"
      && ["Выключен", "На карте", "Приостановлен"].includes(controls.status.textContent);
    controls.settingsStatus.textContent = module.error || module.storageWarning || "";
    controls.settingsStatus.hidden = !controls.settingsStatus.textContent;
    controls.settingsStatus.classList.toggle("is-error", Boolean(module.error));
    controls.retry.hidden = module.status !== "error";
    controls.locate.hidden = module.status !== "ready" || !module.bounds;
    const settingsSignature = JSON.stringify(module.settings);
    if (controls.settingsSignature !== settingsSignature) {
      for (const [key, input] of controls.fields) {
        if (input.type === "checkbox") input.checked = module.settings[key]; else input.value = String(module.settings[key]);
      }
      controls.settingsSignature = settingsSignature;
    }
  }
  updateActiveCount(snapshots);
  transportUI?.refresh();
}

function initializeModules() {
  let fallbackStorage;
  try { fallbackStorage = localStorage; } catch (_) {}
  const storage = window.SloiExtensionStorage.create({ native: window.AndroidHost, fallback: fallbackStorage });
  moduleHost = new window.SloiModules.Host({ map, storage, onChange: renderModules,
    services: { shadows: activateShadowExtension } });
  window.SloiBundledModules.register(moduleHost);
  window.SloiLiveTransport?.register(moduleHost);
  window.SloiMetro?.register(moduleHost);
  window.SloiBusStops?.register(moduleHost);
  window.SloiNativeShadows.register(moduleHost);
  transportPresets = window.SloiTransportPresets.create({ storage,
    onSelect: async (routes, { isCurrent }) => {
      const snapshot = await moduleHost.configure("spb-live", { routes: routes === null ? "" : JSON.stringify(routes), route: "" });
      if (!isCurrent()) return;
      const result = snapshot.enabled ? snapshot : await moduleHost.enable("spb-live");
      if (isCurrent() && result.status === "error") throw new Error(result.error || "Не удалось открыть транспорт");
    },
  });
  transportUI = window.SloiTransportUI.install({ map, host: moduleHost, presets: transportPresets, editor: $("transport-presets-editor"),
    onOpen: () => { closeSheet(false); routingUI?.close(); cancelSearch(); $("transport-open").setAttribute("aria-expanded", "true"); },
    onClose: () => { $("transport-open").setAttribute("aria-expanded", "false"); },
    onEditPresets: () => { openSettingsPage("transport-presets"); transportUI.showEditor(); },
  });
  let hasSavedStops = false;
  try { hasSavedStops = Object.hasOwn(JSON.parse(storage.getItem("sloi-modules-state") || "{}").modules || {}, "spb-stops"); } catch (_) {}
  moduleHost.restore();
  if (!hasSavedStops) moduleHost.enable("spb-stops");
}
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
      setImportStatus(error.message, true);
    }
  });
  actions.append(locate, remove);
  controls.card.querySelector(".layer-options").append(actions);
}

function showCustomPopup(event) {
  if (routingUI?.isPicking?.()) return;
  const feature = event.features?.[0];
  if (!feature) return;
  const content = document.createElement("div");
  content.className = "building-popup";
  const heading = document.createElement("strong");
  heading.textContent = String(feature.properties?.name || "Объект слоя");
  content.append(heading);
  if (["vehicle", "metro_station", "metro_entrance", "metro_line", "bus_stop", "stop"].includes(feature.properties?.kind)) {
    for (const key of ["detail", "statusText"]) {
      if (!feature.properties[key]) continue;
      const row = document.createElement("span"); row.textContent = String(feature.properties[key]); content.append(row);
    }
  } else {
    for (const [key, value] of Object.entries(feature.properties || {}).filter(([key]) => key !== "name").slice(0, 8)) {
      const row = document.createElement("span");
      row.textContent = `${key}: ${value}`;
      content.append(row);
    }
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
  return Math.min(window.devicePixelRatio || 1, economyMode ? 1 : 2);
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

function setShadowStatus(message, isError = false) {
  elements.shadowStatus.textContent = message;
  elements.shadowStatus.classList.toggle("is-error", isError);
  const status = moduleCards.get("shadows")?.status;
  if (status && shadowExtensionActive) {
    status.textContent = message;
    status.hidden = !isError && (!message || message === "На карте");
    status.classList.toggle("is-error", isError);
  }
}

function setPlaceBusy(busy) {
  if (busy) stopPlayback();
  elements.placeSubmit.disabled = busy;
  elements.myLocation.disabled = busy;
  elements.loadCenter.disabled = busy;
  elements.locate.disabled = busy;
  elements.timeRange.disabled = busy || !frames.length;
  elements.play.disabled = busy || !frames.length;
  elements.retryFrame.disabled = busy;
  elements.sceneRecalculate.disabled = busy;
  elements.sceneDate.disabled = busy;
  elements.sceneTimezone.disabled = busy;
  elements.sceneToday.disabled = busy;
  elements.cancelScene.hidden = !busy;
  elements.cancelScene.textContent = "Отменить";
  elements.cancelShadowScene.hidden = !pendingScene;
}

function cancelPlaceOperation() {
  if (pendingScene) { cancelSceneLoad(); return; }
  navigationGeneration++;
  invalidateLocation();
  setPlaceStatus("Поиск местоположения отменён.");
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
    localDate: /^\d{4}-\d{2}-\d{2}T/.test(time) ? time.slice(0, 10) : localDateString(),
    offset: offset ? (offset[1] === "-" ? -1 : 1) * (Number(offset[2]) * 60 + Number(offset[3])) : -new Date().getTimezoneOffset(),
  };
}

function updateSceneClock(preserveInputs = false) {
  const clock = sceneClock();
  if (preserveInputs && validSceneDate(elements.sceneDate.value)) {
    clock.localDate = elements.sceneDate.value;
    const offset = Number(elements.sceneTimezone.value);
    if (Number.isInteger(offset) && offset >= -720 && offset <= 840) clock.offset = offset;
  }
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

function cancelSceneLoad(message = data ? "Расчёт отменён. Предыдущий район сохранён." : "Расчёт отменён. Карта доступна для просмотра.") {
  if (!pendingScene) return;
  const current = pendingScene;
  pendingScene = null;
  window.clearTimeout(sceneWatchdog);
  invalidateFrameRequest();
  try { androidHost("cancelScene").cancelScene(current.requestId); } catch (error) { console.warn(error); }
  setPlaceBusy(false);
  restoreSelectedLocation();
  if (current.background) setShadowStatus(message);
  else setPlaceStatus(message);
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
  if (!data || !windAvailable || !Number.isFinite(directionTo)) {
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
  if (!frame || !data) {
    if (mapReady) map.getSource("sun-direction")?.setData({ type: "FeatureCollection", features: [] });
    return;
  }
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

function restoreSelectedLocation() {
  if (selectedPlace) setSelectedLocation(selectedPlace.latitude, selectedPlace.longitude);
  else if (mapReady) map.getSource("selected-location")?.setData({ type: "FeatureCollection", features: [] });
}

function saveCamera() {
  if (!mapReady) return;
  try {
    window.SloiMapCamera.save(localStorage, map);
    localStorage.setItem("sloi-pitch-angle", JSON.stringify(pitchController.intent));
  } catch (_) { /* Optional preference. */ }
}

function invalidateLocation() {
  locationGeneration++;
  if (elements.locate.getAttribute("aria-busy") === "true"
      && elements.placeStatus.textContent === "Определяю местоположение…") setPlaceStatus("");
  elements.locate.removeAttribute("aria-busy");
  if (!pendingScene || pendingScene.background) setPlaceBusy(false);
}

function clearScene() {
  selectedPlaceNameRequest?.abort(); selectedPlaceNameRequest = null;
  navigationGeneration++;
  searchRequestId++;
  elements.placeResults.replaceChildren();
  cancelSceneLoad();
  invalidateLocation();
  stopPlayback();
  invalidateFrameRequest();
  if (window.AndroidHost && typeof window.AndroidHost.cancelShadowFrame === "function") window.AndroidHost.cancelShadowFrame();
  activeSceneId = null;
  data = null;
  frames = [];
  retainedFrames.clear();
  defaultFrame = 0;
  renderedShadowGeometry = undefined;
  state.frame = 0;
  sceneDataStatus = "OpenStreetMap · выберите место или добавьте свой слой";
  elements.dataStatus.textContent = sceneDataStatus;
  if (mapReady) {
    map.getSource("buildings")?.setData({ type: "FeatureCollection", features: [] });
    map.getSource("shadows")?.setData({ type: "FeatureCollection", features: [] });
  }
  if (popup) { popup.remove(); popup = null; }
  updateSceneClock(true);
  updateWind(null);
  showFrame(0);
  applyMapState();
}

function selectPlace(latitude, longitude, name = "Выбранное место") {
  if (!validLonLat([longitude, latitude])) throw new Error("Получены некорректные координаты места");
  clearScene();
  selectedPlace = { latitude, longitude, name };
  if (["Выбранное место", "Точка на карте", "Рядом со мной"].includes(name)) {
    const place = selectedPlace, controller = new AbortController();
    selectedPlaceNameRequest = controller;
    window.SloiPlaceNames.resolve(place, { signal: controller.signal }).then((label) => {
      if (!label || controller.signal.aborted || selectedPlace !== place) return;
      place.name = label.name;
      elements.regionName.textContent = label.name;
    }).catch(() => {}).finally(() => {
      if (selectedPlaceNameRequest === controller) selectedPlaceNameRequest = null;
    });
  }
  elements.regionName.textContent = name;
  elements.recenter.hidden = false;
  restoreSelectedLocation();
  map.flyTo({ center: [longitude, latitude], zoom: Math.max(15, map.getZoom()), duration: 650 });
  setPlaceStatus("");
  closeSheet();
}

async function loadDemoScene() {
  const generation = ++navigationGeneration;
  searchRequestId++;
  elements.placeResults.replaceChildren();
  cancelSceneLoad();
  invalidateLocation();
  invalidateFrameRequest();
  elements.demoButton.disabled = true;
  $("demo-status").textContent = "Открываю пример теней…";
  $("demo-status").classList.remove("is-error");
  setPlaceStatus("Открываю пример теней…");
  try {
    if (!fallbackData) {
      if (!demoPromise) {
        demoPromise = new Promise((resolve, reject) => {
          const script = document.createElement("script");
          script.src = "map-data.js";
          script.onload = () => {
            if (window.SLOI_MAP_DATA?.region && Array.isArray(window.SLOI_MAP_DATA.shadeFrames)) resolve(window.SLOI_MAP_DATA);
            else { script.remove(); demoPromise = null; reject(new Error("Данные примера повреждены")); }
          };
          script.onerror = () => { script.remove(); demoPromise = null; reject(new Error("Не удалось загрузить пример")); };
          document.head.append(script);
        });
      }
      fallbackData = await demoPromise;
    }
    if (generation !== navigationGeneration) return false;
    const bundle = {
      schemaVersion: 1, source: "demo", region: fallbackData.region, buildings: fallbackData.buildings,
      layers: { shadows: { frames: fallbackData.shadeFrames, initialFrameIndex: Math.max(0, fallbackData.shadeFrames.findIndex((frame) => frame.label === "15:00")) } },
    };
    if (!validateBundle(bundle)) throw new Error("Данные примера несовместимы с картой");
    state.mode = "3d";
    applyBundle(bundle, `Пример · ${fallbackData.region.name}`);
    $("demo-status").textContent = "Пример открыт.";
    setPlaceStatus("Открыт пример за 17 июля 2026 года. Это сохранённый расчёт, а не текущие тени.");
    closeSheet();
    return true;
  } catch (error) {
    if (generation === navigationGeneration) {
      const message = `Пример недоступен: ${error.message}. Можно повторить попытку.`;
      $("demo-status").textContent = message;
      $("demo-status").classList.add("is-error");
      setPlaceStatus(message, true);
    }
    return false;
  } finally { elements.demoButton.disabled = false; }
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

function applyBundle(bundle, requestedName, keepCamera = false, background = false) {
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
  activeSceneId = bundle.source === "demo" ? null : String(bundle.sceneId || region.id || "") || null;
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
    demo: bundle.source === "demo",
  };
  frames = normalizedFrames;
  retainedFrames.clear();
  const initialFrame = bundle.layers.shadows.initialFrameIndex;
  defaultFrame = Number.isInteger(initialFrame) ? Math.max(0, Math.min(frames.length - 1, initialFrame)) : 0;
  if (!background) selectedPlace = { latitude: region.center[1], longitude: region.center[0], name: data.region.name };
  restoreSelectedLocation();
  const matchingFrame = previousLabel
    ? frames.findIndex((frame) => frame.label === previousLabel)
    : -1;
  state.frame = !background && matchingFrame >= 0
    ? matchingFrame
    : defaultFrame;
  elements.timeRange.max = String(frames.length - 1);
  if (!background) elements.regionName.textContent = data.region.name;
  const delivery = bundle.source === "demo" ? "ПРИМЕР · 17.07.2026" : String(bundle.source || "").startsWith("city-pack:")
    ? "ОФЛАЙН-ПАКЕТ"
    : bundle.cacheHit ? "КЭШ" : "ТЕЛЕФОН";
  elements.dataStatus.textContent = `${buildings.features.length} зданий · ${delivery}`;
  map.getSource("buildings")?.setData(buildings);
  updateSceneClock();
  showFrame(state.frame);
  retainFrame(state.frame);
  updateWind(bundle);
  applyMapState();
  if (!keepCamera) fitRegion(true);
  sceneDataStatus = elements.dataStatus.textContent;
  saveState();
}

function activateShadowExtension(options, signal) {
  if (!window.AndroidHost?.requestScene) throw new Error("Тени доступны в Android-приложении");
  shadowExtensionActive = true;
  state.shadows = true;
  state.shadowOpacity = options.opacity;
  shadowFailedView = null;
  applyMapState();
  scheduleShadowViewport();
  const timer = window.setInterval(scheduleShadowViewport, 60000);
  return () => {
    window.clearInterval(timer);
    window.clearTimeout(shadowRefreshTimer);
    shadowExtensionActive = false;
    state.shadows = false;
    if (pendingScene?.background) cancelSceneLoad();
    invalidateFrameRequest();
    window.AndroidHost?.cancelShadowFrame?.();
    if (mapReady) applyMapState();
  };
}

function currentViewportBox() {
  const bounds = viewportBounds();
  return bounds && [[bounds.west, bounds.south], [bounds.east, bounds.north]];
}

function scheduleShadowViewport() {
  window.clearTimeout(shadowRefreshTimer);
  if (!shadowExtensionActive || !mapReady || document.hidden || mapTouchActive || map.isMoving()) return;
  shadowRefreshTimer = window.setTimeout(() => {
    if (!shadowExtensionActive || document.hidden || mapTouchActive || map.isMoving()) return;
    const now = new Date();
    const currentMinutes = now.getHours() * 60 + now.getMinutes();
    const clockMatches = sceneClock().localDate === localDateString(now)
      && Math.abs((frames[state.frame]?.minutes ?? Number(frames[state.frame]?.label?.slice(0, 2)) * 60 + Number(frames[state.frame]?.label?.slice(3))) - currentMinutes) <= 15;
    const visible = currentViewportBox();
    if (activeSceneId && clockMatches && window.SloiShadowViewport.contains(data?.region.bounds, visible)) return;
    if (pendingScene && window.SloiShadowViewport.contains(pendingScene.displayBounds, visible)) return;
    const key = JSON.stringify(visible);
    if (shadowFailedView === key) return;
    let displayBounds;
    try { displayBounds = window.SloiShadowViewport.plan(visible); }
    catch (error) { setShadowStatus(error.message); return; }
    loadViewportScene("Область карты", { displayBounds, background: true })
      .catch(error => { shadowFailedView = key; setShadowStatus(error.message, true); });
  }, 550);
}

async function loadViewportScene(name = "Область карты", options = {}) {
  const displayBounds = options.displayBounds || window.SloiShadowViewport.plan(currentViewportBox());
  const background = options.background !== false;
  const now = new Date();
  const localDate = options.localDate || localDateString(now);
  const timezoneOffsetMinutes = options.timezoneOffsetMinutes ?? -now.getTimezoneOffset();
  if (!validSceneDate(localDate) || !Number.isInteger(timezoneOffsetMinutes)
    || timezoneOffsetMinutes < -720 || timezoneOffsetMinutes > 840) {
    throw new Error("Выберите корректные дату и часовой пояс расчёта");
  }

  if (!background) { navigationGeneration++; invalidateLocation(); }
  const requestId = String(++sceneRequestId);
  if (pendingScene) pendingScene.resolve(null);
  window.clearTimeout(sceneWatchdog);
  invalidateFrameRequest();
  if (!background) { searchRequestId++; setPlaceBusy(true); }
  elements.cancelShadowScene.hidden = false;
  setShadowStatus("Рассчитываю тени…");
  const selectedMinutes = options.selectedMinutes ?? now.getHours() * 60 + now.getMinutes();
  const request = {
    requestId,
    displayBounds,
    localDate,
    timezoneOffsetMinutes,
    selectedMinutes,
    name,
  };
  return new Promise((resolve, reject) => {
    pendingScene = { requestId, name, resolve, reject, keepCamera: true, background, displayBounds };
    try {
      androidHost("requestScene").requestScene(JSON.stringify(request));
      armSceneWatchdog(requestId);
    } catch (error) {
      pendingScene = null;
      setPlaceBusy(false);
      setShadowStatus(`Не удалось запустить расчёт: ${error.message}`, true);
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
        1: "Разрешите приложению доступ к местоположению",
        2: "Не удалось определить местоположение. Проверьте, включена ли геолокация",
        3: "Истекло время определения местоположения",
      };
      reject(new Error(messages[error.code] || error.message || "Ошибка геолокации"));
    }, { enableHighAccuracy: true, timeout: 20000, maximumAge: 30000 });
  });
}

async function locateOnMap() {
  cancelSearch();
  $("location-settings").hidden = true;
  navigationGeneration++;
  searchRequestId++;
  elements.placeResults.replaceChildren();
  cancelSceneLoad();
  const generation = navigationGeneration;
  const locationRequest = ++locationGeneration;
  setPlaceStatus("Определяю местоположение…");
  elements.locate.setAttribute("aria-busy", "true");
  setPlaceBusy(true);
  try {
    const position = await getCurrentPosition();
    if (generation !== navigationGeneration) return;
    selectPlace(position.coords.latitude, position.coords.longitude, "Рядом со мной");
  } catch (error) {
    if (generation === navigationGeneration && error?.name !== "AbortError") {
      openSheet("search");
      setPlaceStatus(error.message || "Не удалось определить местоположение", true);
      if (window.AndroidHost?.getLocationState) {
        try {
          const access = JSON.parse(window.AndroidHost.getLocationState());
          const button = $("location-settings");
          button.hidden = access.enabled && ["precise", "approximate"].includes(access.permission);
          button.dataset.locationOff = String(!access.enabled);
          button.textContent = access.enabled ? "Разрешить доступ в настройках" : "Включить геолокацию";
        } catch (_) { /* Keep the original location error. */ }
      }
    }
  } finally {
    if (locationRequest === locationGeneration) {
      elements.locate.removeAttribute("aria-busy");
      if (!pendingScene || pendingScene.background) setPlaceBusy(false);
    }
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
    && validLonLat([place.longitude, place.latitude]));
  renderSearchResults({ query: elements.placeQuery.value.trim(), places, transport: [] });
}

let searchController = null;
let searchLoading = false;
const nativePlaceRequests = new Map();
const searchErrors = new Map();
let lastSearchResults = { query: "", places: [], transport: [] };

function searchStatus() {
  if (searchErrors.size) {
    elements.placeStatus.textContent = [...searchErrors.values()].join(" · ");
    elements.placeStatus.classList.add("is-error");
  } else {
    const found = lastSearchResults.places.length + lastSearchResults.transport.length;
    elements.placeStatus.textContent = !found && searchLoading ? "Поиск…"
      : !found && lastSearchResults.query.length >= 2 ? "Ничего не найдено" : "";
    elements.placeStatus.classList.remove("is-error");
  }
}

function renderSearchResults(result) {
  lastSearchResults = result;
  const previousKey = document.activeElement?.dataset?.searchResult;
  const fragment = document.createDocumentFragment();
  const heading = (text) => {
    const label = document.createElement("div"); label.className = "section-label"; label.textContent = text; fragment.append(label);
  };
  const places = result.places.map(normalizePlace).filter((place) => place && validLonLat([place.longitude, place.latitude]));
  if (places.length) heading("Места");
  for (const place of places) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "place-result";
    button.textContent = place.name;
    button.dataset.searchResult = `place:${place.latitude},${place.longitude}:${place.name}`;
    button.addEventListener("click", () => {
      cancelSearch();
      selectPlace(place.latitude, place.longitude, place.name);
    });
    fragment.append(button);
  }
  if (result.transport.length) heading("Транспорт");
  for (const route of result.transport) {
    const button = document.createElement("button"); button.type = "button"; button.className = "place-result";
    button.dataset.searchResult = `transport:${route.id}`;
    const number = document.createElement("strong"); number.className = "transport-result-number";
    number.textContent = route.settings?.route || route.title;
    const kind = document.createElement("span"); kind.className = "transport-result-type"; kind.textContent = "Автобус";
    button.append(number, kind);
    button.setAttribute("aria-label", `Автобус ${route.settings?.route || route.title}`);
    button.addEventListener("click", async () => {
      cancelSearch(); button.disabled = true;
      const generation = ++navigationGeneration;
      const cameraGeneration = cameraInputGeneration;
      invalidateLocation();
      try {
        if (!moduleHost) throw new Error("Расширения ещё загружаются");
        const configured = await moduleHost.configure(route.moduleId, route.settings);
        const loaded = configured.enabled ? configured : await moduleHost.enable(route.moduleId);
        if (generation !== navigationGeneration || cameraGeneration !== cameraInputGeneration) return;
        if (loaded.status === "error") throw new Error(loaded.error || "Маршрут недоступен");
        const bounds = moduleHost.get(route.moduleId).bounds;
        if (bounds) map.fitBounds(bounds, { padding: 60, maxZoom: 16, duration: 450 });
        closeSheet();
        if (route.moduleId === "spb-bus" && moduleHost.entries.has("spb-live")) {
          // Opening a bus also shows its reported positions. This runs after
          // displaying the path, so live data cannot delay opening the route.
          const wasEnabled = moduleHost.get("spb-live").enabled;
          transportPresets?.clearActive();
          moduleHost.configure("spb-live", { routes: "", route: String(route.settings.route) }).then((snapshot) => {
            if (!wasEnabled && generation === navigationGeneration && !snapshot.enabled) return moduleHost.enable("spb-live");
          }).catch((error) => console.debug("Live transport unavailable", error));
        }
      } catch (error) {
        if (generation !== navigationGeneration || cameraGeneration !== cameraInputGeneration) return;
        elements.placeStatus.textContent = error.message || "Не удалось открыть маршрут";
        elements.placeStatus.classList.add("is-error"); button.disabled = false;
      }
    });
    fragment.append(button);
  }
  elements.placeResults.replaceChildren(fragment);
  if (previousKey) [...elements.placeResults.querySelectorAll("button")].find((button) => button.dataset.searchResult === previousKey)?.focus({ preventScroll: true });
  searchStatus();
}

function queryPlaceSuggestions(query, { signal }) {
  const cancelled = () => Object.assign(new Error("Поиск отменён"), { name: "AbortError" });
  if (signal.aborted) return Promise.reject(cancelled());
  const center = map?.getCenter();
  if (!window.AndroidHost || typeof window.AndroidHost.searchPlaces !== "function") {
    return window.SloiSearch.webPlaces(query, { signal, center: center ? [center.lng, center.lat] : null, zoom: map?.getZoom() });
  }
  const requestId = String(++searchRequestId);
  // The native bridge intentionally runs only the latest search. Finish older
  // JS callers now as well, rather than leaving their promises until 14s later.
  for (const pending of [...nativePlaceRequests.values()]) pending.finish(cancelled());
  return new Promise((resolve, reject) => {
    const finish = (error, value) => {
      if (!nativePlaceRequests.has(requestId)) return;
      nativePlaceRequests.delete(requestId); clearTimeout(timer); signal.removeEventListener("abort", abort);
      if (error) reject(error); else resolve(value);
    };
    const cancelOwnedNativeRequest = () => {
      if (String(searchRequestId) !== requestId) return;
      searchRequestId++;
      try { window.AndroidHost.cancelPlaceSearch?.(); } catch (_) {}
    };
    const abort = () => {
      if (!nativePlaceRequests.has(requestId)) return;
      cancelOwnedNativeRequest();
      finish(cancelled());
    };
    const timer = setTimeout(() => {
      if (!nativePlaceRequests.has(requestId)) return;
      cancelOwnedNativeRequest();
      finish(new Error("Поиск не отвечает. Проверьте соединение."));
    }, 14000);
    nativePlaceRequests.set(requestId, { finish }); signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) { abort(); return; }
    try { window.AndroidHost.searchPlaces(JSON.stringify({ requestId, query, limit: 6, latitude: center?.lat, longitude: center?.lng, zoom: map?.getZoom() })); }
    catch (error) { finish(error); }
  });
}

function placeSearchController() {
  if (!searchController) searchController = window.SloiSearch.create({
    places: queryPlaceSuggestions,
    contextKey: () => {
      const center = map?.getCenter();
      return `${offlinePlaceRevision}|${center ? `${center.lng.toFixed(2)},${center.lat.toFixed(2)},${Math.round(map.getZoom())}` : ""}`;
    },
    providers: () => window.SloiBundledModules.searchProviders || [],
    onResults: renderSearchResults,
    onError(error, provider) {
      searchErrors.set(provider, provider === "places" ? error.message || "Поиск мест недоступен" : "Транспорт недоступен"); searchStatus();
    },
    onLoading(loading) { searchLoading = loading; elements.placeResults.setAttribute("aria-busy", String(loading)); searchStatus(); },
  });
  return searchController;
}

function cancelSearch() {
  searchController?.cancel();
  searchRequestId++;
}

function searchPlaces(query, immediate = true) {
  searchErrors.clear();
  const controller = placeSearchController();
  return immediate ? controller.submit(query) : controller.input(query);
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
    "import-select": "Выберите ZIP или GeoPackage…",
    "import-copy": `Копирую пакет: ${formatBytes(record.current)}`,
    "import-check": "Проверяю данные…",
    metadata: "Проверяю размер…",
    download: `Загружено ${formatBytes(record.current)} из ${formatBytes(record.total)}`,
    extract: "Распаковываю пакет…",
    index: "Готовлю данные города…",
    ready: "Пакет установлен",
  };
  return phases[record.phase] || "Подготавливаю офлайн-пакет…";
}

function renderOfflinePlacesState() {
  const status = $("offline-place-status"), retry = $("offline-place-retry");
  if (!offlinePlaceState) { status.hidden = true; retry.hidden = true; return; }
  const state = offlinePlaceState;
  const message = state.phase === "error" ? `Поиск на устройстве: ${state.error || "не удалось подготовить данные"}`
    : state.phase === "indexing" ? `Готовлю поиск на устройстве${Number(state.total) > 0 ? ` · ${Math.min(100, Math.floor(Number(state.current) / Number(state.total) * 100))}%` : "…"}`
      : Number(state.rows) > 0 ? `Поиск на устройстве · ${Number(state.rows).toLocaleString("ru-RU")} объектов`
        : "Адреса и места будут доступны после установки данных города.";
  status.hidden = false;
  if (status.textContent !== message) status.textContent = message;
  retry.hidden = state.phase !== "error";
}

function renderCityPacks() {
  cityPackControls.clear();
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
    card.dataset.status = record.status;
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
    const attribution = record.source && record.license ? record.imported ? " · OSM / ODbL" : " · BBBike / ODbL" : "";
    detail.textContent = downloading
      ? cityPackPhase(record)
      : installed
        ? `Адреса, места и здания · на устройстве · ${diskSize}${updatedAt ? ` · ${updatedAt}` : ""}${attribution}`
        : record.status === "error"
          ? `Ошибка: ${record.error || "загрузка прервана"}`
          : `Адреса, места и здания · скачать ${downloadSize}${record.expectedInstalledBytes || record.installedEstimateBytes || record.installedBytes ? ` · на диске ≈ ${formatBytes(record.expectedInstalledBytes || record.installedEstimateBytes || record.installedBytes)}` : ""}${attribution}`;
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
    const actions = document.createElement("div"); actions.className = "city-pack-actions";
    actions.append(button);
    if (typeof window.AndroidHost?.importCityPack === "function") {
      const importButton = document.createElement("button"); importButton.type = "button"; importButton.className = "is-import";
      importButton.textContent = "Из файла"; importButton.disabled = downloading || record.status === "deleting";
      importButton.setAttribute("aria-label", `Импортировать пакет ${record.name || record.id}`);
      importButton.addEventListener("click", () => {
        record.status = "downloading"; record.phase = "import-select"; record.current = 0; record.total = 0; renderCityPacks();
        try { window.AndroidHost.importCityPack(record.id); }
        catch (error) { window.SloiApp.onCityPackError(record.id, error.message); }
      }); actions.append(importButton);
    }
    card.append(copy, actions);
    let progress = null;
    if (downloading) {
      progress = document.createElement("progress");
      progress.max = Math.max(1, Number(record.total) || 1);
      progress.value = Math.max(0, Number(record.current) || 0);
      if (!(Number(record.total) > 0)) progress.removeAttribute("value");
      card.append(progress);
    }
    cityPackControls.set(String(record.id), { card, button, detail, progress });
    elements.cityPackList.append(card);
  }
}

function requestCityPacks() {
  try {
    androidHost("listCityPacks").listCityPacks();
  } catch (error) {
    console.debug("City packs unavailable", error);
    elements.cityPackList.innerHTML = '<p class="control-note">Пакеты городов доступны в Android-приложении.</p>';
  }
}

const buildingDetail = Object.freeze({ fullScaleMeters: 100, flatScaleMeters: 250 });
const viewportMaxTiles = 96;
// Keep dynamic buildings below the controls/markers added after the scene buildings.
const viewportInsertBeforeLayer = "wind-line";

function buildings3dVisible() {
  return mapReady && state.mode === "3d"
    && window.SloiMapCamera.scaleMeters(map.getCenter().lat, map.getZoom()) < buildingDetail.flatScaleMeters;
}

function updateBuildingVisibility() {
  if (!mapReady) return;
  const near = window.SloiMapCamera.scaleMeters(map.getCenter().lat, map.getZoom()) < buildingDetail.flatScaleMeters;
  const volume = state.buildings && state.mode === "3d" && near;
  const flat = state.buildings && state.mode === "2d" && near;
  const fromViewport = hasViewportBuildings();
  const pairs = [{ flat: "buildings-flat", extrusion: "buildings-3d", scene: true },
    ...[...viewport.loaded.keys()].map(viewportLayerIds).filter(Boolean)];
  for (const ids of pairs) {
    for (const [id, visible] of [[ids.flat, flat && (!ids.scene || !fromViewport)],
      [ids.extrusion, volume && (!ids.scene || !fromViewport)]]) {
      const visibility = visible ? "visible" : "none";
      if (map.getLayer(id) && map.getLayoutProperty(id, "visibility") !== visibility) map.setLayoutProperty(id, "visibility", visibility);
    }
  }
  if (!volume && viewport.requestId) {
    cancelViewportRequest();
    viewport.signature = null;
  }
}

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
  // Building geometry is identical at these levels. A fixed grid keeps the
  // same sources alive through zoom instead of deleting and reloading a city.
  return 15;
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
  return viewport.loaded.size > 0 || Boolean(activeInstalledPack() && mapReady
    && buildings3dVisible() && boundsIntersect(viewportBounds(), activeInstalledPack().bounds));
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
  cancelViewportRequest();
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
    paint: { "fill-color": neutralBuildingColor, "fill-opacity": state.buildingOpacity, "fill-outline-color": "#8b928c" },
  }, viewportInsertBeforeLayer);
  map.addLayer({
    id: ids.extrusion,
    type: "fill-extrusion",
    source: ids.source,
    paint: {
      "fill-extrusion-color": neutralBuildingColor,
      "fill-extrusion-height": ["get", "height"],
      "fill-extrusion-base": ["get", "min_height"],
      "fill-extrusion-opacity": state.buildingOpacity,
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
  if (!mapReady || document.hidden || mapTouchActive || map.isMoving()) return;
  const pack = activeInstalledPack();
  const bounds = viewportBounds();
  const zoom = map.getZoom();
  if (!pack || !bounds || !state.buildings || !boundsIntersect(bounds, pack.bounds)) {
    if (viewport.requestId || viewport.loaded.size) {
      discardViewportTiles(true);
      viewport.signature = null;
      viewport.blockedSignature = null;
      applyMapState();
    }
    return;
  }
  if (!buildings3dVisible()) {
    cancelViewportRequest();
    viewport.signature = null;
    // Stop native work and drawing, retaining only the bounded ready cache so
    // returning to street detail does not delete/recreate unchanged sources.
    applyMapState();
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
      if (!desired.has(tileId) && !boundsIntersect(parseViewportTileId(tileId)?.bounds, bounds)) {
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
  if (mapTouchActive || !mapReady || map.isMoving()) return;
  viewport.timer = window.setTimeout(refreshViewportTiles, 180);
}

async function readGeneratedJson(url) {
  return readLocalJson(url, "/generated/", "результату");
}

async function readViewportJson(url) {
  return readLocalJson(url, "/viewport/", "viewport-тайлу", { maxBytes: 4 * 1024 * 1024, measure: true });
}

Object.assign(window.SloiApp, {
  onOfflinePlacesState(payload) {
    try {
      const state = typeof payload === "string" ? JSON.parse(payload) : payload;
      if (!state || typeof state !== "object") return;
      const revision = String(state.revision || state.signature || "");
      const changed = revision !== offlinePlaceRevision;
      offlinePlaceState = state; offlinePlaceRevision = revision;
      window.SloiOfflinePlacesRevision = revision;
      renderOfflinePlacesState();
      if (changed) {
        cancelSearch();
        searchController?.dispose(); searchController = null;
        renderSearchResults({ query: "", places: [], transport: [] });
        searchErrors.clear();
        searchNeedsRefresh = elements.placeQuery.value.trim().length >= 2;
        routingUI?.invalidateSearchData?.();
        if (activePanel === "search" && elements.sheet.classList.contains("is-open") && searchNeedsRefresh) {
          searchNeedsRefresh = false;
          searchPlaces(elements.placeQuery.value, true);
        }
      }
    } catch (error) { console.warn("Invalid offline search state", error); }
  },
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
    setShadowStatus(fallback + progress);
  },
  async onSceneReady(requestId, url) {
    if (!pendingScene || String(requestId) !== pendingScene.requestId) return;
    const current = pendingScene;
    try {
      const bundle = await readGeneratedJson(url);
      if (!pendingScene || pendingScene.requestId !== current.requestId) return;
      applyBundle(bundle, current.name, current.keepCamera, current.background);
      if (window.AndroidHost && typeof window.AndroidHost.acceptScene === "function") {
        window.AndroidHost.acceptScene(activeSceneId);
      }
      const cityPack = String(bundle.source || "").startsWith("city-pack:");
      setShadowStatus(frames[state.frame]?.altitude <= .5 ? "Сейчас ночь — теней нет" : "На карте");
      if (!current.background) { elements.placeResults.replaceChildren(); closeSheet(); }
      current.resolve(bundle);
    } catch (error) {
      if (!pendingScene || pendingScene.requestId !== current.requestId) return;
      setShadowStatus(`Не удалось открыть результат: ${error.message}`, true);
      restoreSelectedLocation();
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
    setShadowStatus(`Не удалось рассчитать тени: ${error.message}`, true);
    restoreSelectedLocation();
    showFrame(state.frame, false);
    current.reject(error);
  },
  onPlacesReady(requestId, payloadText) {
    try {
      const payload = typeof payloadText === "string" ? JSON.parse(payloadText) : payloadText;
      const pending = nativePlaceRequests.get(String(requestId));
      if (pending) { pending.finish(null, Array.isArray(payload) ? payload : payload?.places || payload?.results || []); return; }
      if (String(requestId) !== String(searchRequestId)) return;
      elements.placeSubmit.disabled = false;
      renderPlaces(payload);
    } catch (error) {
      const pending = nativePlaceRequests.get(String(requestId));
      if (pending) pending.finish(new Error("Поиск вернул повреждённые данные"));
      else if (String(requestId) === String(searchRequestId)) setPlaceStatus(`Поиск вернул повреждённые данные: ${error.message}`, true);
    }
  },
  onPlacesError(requestId, message) {
    const pending = nativePlaceRequests.get(String(requestId));
    if (pending) { pending.finish(new Error(String(message || "Поиск недоступен"))); return; }
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
      applyMapState();
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
    if (record.phase === "download" && record.total > 0) record.downloadBytes = record.total;
    let controls = cityPackControls.get(String(id));
    if (!controls?.progress || controls.card.dataset.status !== "downloading") {
      renderCityPacks();
      controls = cityPackControls.get(String(id));
    }
    controls.detail.textContent = cityPackPhase(record);
    controls.progress.max = Math.max(1, record.total);
    if (record.total > 0) controls.progress.value = Math.max(0, record.current);
    else controls.progress.removeAttribute("value");
  },
  onCityPackChanged(payloadText) {
    window.SloiApp.onCityPacks(payloadText);
  },
  onCityPackError(id, message) {
    const record = cityPacks.get(String(id));
    if (record) {
      record.status = "error";
      record.error = String(message || "ошибка загрузки");
      renderCityPacks();
    }
    if (!record) elements.cityPackList.textContent = `Пакеты недоступны: ${String(message || "ошибка")}`;
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
      retainFrame(safeIndex);
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

const neutralBuildingColor = "#c7cdd0";
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

function layerAvailable(layer) {
  if (layer.id === "wind") return windAvailable;
  if (layer.id === "shadows" || layer.id === "sun") return frames.length > 0;
  if (layer.id === "buildings") return Boolean(data) || Boolean(activeInstalledPack()) || hasViewportBuildings();
  return true;
}

function retainFrame(index) {
  if (!activeSceneId || !frames[index]?.geometry) return;
  retainedFrames.delete(index);
  retainedFrames.set(index, JSON.stringify(frames[index].geometry).length * 2);
  let bytes = [...retainedFrames.values()].reduce((sum, value) => sum + value, 0);
  for (const [old, size] of retainedFrames) {
    if (retainedFrames.size <= 3 && bytes <= 4 * 1024 * 1024) break;
    if (old === index) continue; // The displayed frame is the irreducible working set.
    frames[old] = { ...frames[old], geometry: null, computed: false };
    retainedFrames.delete(old);
    bytes -= size;
  }
}

function shadowWorkAllowed() {
  return mapReady && Boolean(data) && !document.hidden && !map.isMoving() && !mapTouchActive
    && boundsIntersect(viewportBounds(), { west: data.region.bounds[0][0], south: data.region.bounds[0][1], east: data.region.bounds[1][0], north: data.region.bounds[1][1] });
}

function updateMapDetail() {
  if (!mapReady) return;
  const meters = window.SloiMapCamera.scaleMeters(map.getCenter().lat, map.getZoom());
  $("map-scale-label").textContent = meters >= 1000 ? `${(meters / 1000).toFixed(meters >= 10000 ? 0 : 1)} км` : `${Math.round(meters)} м`;
  const latitude = map.getCenter().lat;
  const flatZoom = Math.log2(window.SloiMapCamera.scaleMeters(latitude, 0) / buildingDetail.flatScaleMeters);
  const fullZoom = Math.log2(window.SloiMapCamera.scaleMeters(latitude, 0) / buildingDetail.fullScaleMeters);
  for (const id of ["buildings-3d", ...[...viewport.loaded.keys()].map((tile) => viewportLayerIds(tile)?.extrusion).filter(Boolean)]) {
    setPaintIfChanged(id, "fill-extrusion-height", ["interpolate", ["linear"], ["zoom"], flatZoom, 0, fullZoom, ["get", "height"]]);
    setPaintIfChanged(id, "fill-extrusion-base", ["interpolate", ["linear"], ["zoom"], flatZoom, 0, fullZoom, ["get", "min_height"]]);
  }
  updateBuildingVisibility();
}

function applyControls() {
  const focused = document.activeElement;
  elements.mode2d.setAttribute("aria-pressed", String(state.mode === "2d"));
  elements.mode3d.setAttribute("aria-pressed", String(state.mode === "3d"));
  elements.baseLight.setAttribute("aria-pressed", String(state.basemap === "light"));
  elements.baseDark.setAttribute("aria-pressed", String(state.basemap === "dark"));
  elements.confidenceToggle.checked = state.confidence;
  const buildingsAvailable = layerAvailable({ id: "buildings" });
  elements.confidenceToggle.disabled = !state.buildings || !buildingsAvailable;
  elements.heightLegend.hidden = !state.confidence || !state.buildings || !buildingsAvailable;
  elements.timeCard.hidden = shadowExtensionActive || !frames.length;
  elements.recenter.hidden = !selectedPlace;
  $("clear-scene").hidden = true;
  document.body.classList.toggle("has-scene", !elements.timeCard.hidden);
  const order = currentLayerOrder();
  for (const layer of allLayers()) {
    const controls = layerControls.get(layer.id);
    const available = layerAvailable(layer);
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
  updateActiveCount();
}

function updateActiveCount(modules = moduleHost?.list() || []) {
  const layers = allLayers().filter((layer) => !["shadows", "wind", "sun"].includes(layer.id)
    && layerAvailable(layer) && settingsForLayer(layer).enabled).length;
  elements.activeCount.textContent = String(layers + modules.filter((module) => module.enabled && module.status === "ready").length);
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
      available: () => layerAvailable(layer),
      getSettings: () => {
        const settings = settingsForLayer(layer);
        return layer.id === "shadows" ? { ...settings, enabled: settings.enabled && Boolean(data) } : settings;
      },
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
          { id: "buildings-flat", opacityProperty: "fill-opacity", visible: () => !hasViewportBuildings() && state.mode === "2d" && window.SloiMapCamera.scaleMeters(map.getCenter().lat, map.getZoom()) < buildingDetail.flatScaleMeters },
          { id: "buildings-3d", opacityProperty: "fill-extrusion-opacity", visible: () => !hasViewportBuildings() && buildings3dVisible() },
        ];
        for (const tileId of viewport.loaded.keys()) {
          const ids = viewportLayerIds(tileId);
          if (ids) bindings.push(
            { id: ids.flat, opacityProperty: "fill-opacity", visible: () => state.mode === "2d" && window.SloiMapCamera.scaleMeters(map.getCenter().lat, map.getZoom()) < buildingDetail.flatScaleMeters },
            { id: ids.extrusion, opacityProperty: "fill-extrusion-opacity", visible: buildings3dVisible },
          );
        }
        return bindings;
      },
    });
  }
}

function applyMapState() {
  state.wind = false;
  state.sun = false;
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
  if (!state.shadows && renderedShadowGeometry !== undefined) {
    map.getSource("shadows")?.setData({ type: "FeatureCollection", features: [] });
    renderedShadowGeometry = undefined;
  }
  window.SloiBasemap.applyTheme(map, state.basemap);
  setPaintIfChanged("ground-shadows", "fill-color", state.basemap === "dark" ? "#09110e" : "#17231f");
  const buildingColor = state.confidence ? confidenceColor : state.basemap === "dark" ? "#39434b" : neutralBuildingColor;
  const pairs = [{ flat: "buildings-flat", extrusion: "buildings-3d" },
    ...[...viewport.loaded.keys()].map(viewportLayerIds).filter(Boolean)];
  for (const ids of pairs) {
    setPaintIfChanged(ids.flat, "fill-color", buildingColor);
    setPaintIfChanged(ids.extrusion, "fill-extrusion-color", buildingColor);
  }
  layerRuntime.apply(state, currentLayerOrder(), { anchor: "module-anchor" });
  updateMapDetail();
}

function applyCameraMode(animate) {
  if (!mapReady) return;
  pitchController.select(state.mode === "3d" ? (pitchController.intent || 56) : 0);
  const camera = state.mode === "3d"
    ? { pitch: pitchController.intent }
    : { pitch: 0 };
  map.easeTo({ ...camera, duration: animate && !window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 450 : 0 });
}

function requestFrame(index) {
  if (!activeSceneId || pendingScene || !state.shadows || !shadowWorkAllowed()) return;
  window.clearTimeout(frameDebounceTimer);
  window.clearTimeout(frameWatchdog);
  const requestId = String(++frameRequestId);
  const sceneId = activeSceneId;
  frameDebounceTimer = window.setTimeout(() => {
    if (pendingScene || !state.shadows || !shadowWorkAllowed() || activeSceneId !== sceneId || String(frameRequestId) !== requestId
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
  if (!frames.length) {
    state.frame = 0;
    elements.timeRange.value = "0";
    elements.timeRange.max = "0";
    elements.timeRange.disabled = true;
    elements.play.disabled = true;
    elements.timeCard.hidden = true;
    elements.retryFrame.hidden = true;
    updateSunDirection(null);
    if (persist) saveState();
    return;
  }
  const value = Number(index);
  const safeIndex = Number.isInteger(value) ? Math.max(0, Math.min(frames.length - 1, value)) : 0;
  const frame = frames[safeIndex];
  elements.timeCard.hidden = shadowExtensionActive;
  elements.timeRange.disabled = Boolean(pendingScene);
  elements.play.disabled = Boolean(pendingScene);
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
  if (mapReady && state.shadows && shadowWorkAllowed() && renderedShadowGeometry !== frame.geometry) {
    const source = map.getSource("shadows");
    if (source) { source.setData(shadowCollection(frame.geometry)); renderedShadowGeometry = frame.geometry; }
  }
  updateSunDirection(frame);
  if (needsComputation && state.shadows && shadowWorkAllowed()) {
    elements.sunValue.textContent = `Солнце ${Math.round(frame.altitude)}° · считаю тень…`;
    requestFrame(safeIndex);
  }
  if (state.shadows && mapReady && !shadowWorkAllowed()) elements.sunValue.textContent = "Приблизьте выбранный район для теней";
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
  if (!frames.length) return;
  if (state.shadows && !shadowWorkAllowed()) return;
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

function switchPanel(panel) {
  if (["offline", "settings", "module-settings", "transport-presets"].includes(panel)) { openSettingsPage(panel); return; }
  if (!["search", "layers"].includes(panel)) panel = "layers";
  activePanel = panel;
  for (const node of elements.sheet.querySelectorAll(".sheet-panel")) node.hidden = node.id !== `panel-${panel}`;
  for (const button of document.querySelectorAll(".sheet-tabs button")) button.setAttribute("aria-pressed", String(button.dataset.panel === panel));
  $("layers-title").textContent = panel === "search" ? "Найти место" : "Мои слои";
  $("nav-map").setAttribute("aria-pressed", String(panel === "search"));
  elements.layersButton.setAttribute("aria-pressed", String(panel === "layers"));
  elements.sheet.scrollTop = 0;
  if (panel === "search" && searchNeedsRefresh) {
    searchNeedsRefresh = false;
    searchPlaces(elements.placeQuery.value, true);
  }
}

function showSettingsPanel(panel, focus = true) {
  if (!["settings", "offline", "module-settings", "transport-presets"].includes(panel)) panel = "settings";
  const previous = activeSettingsPanel;
  activeSettingsPanel = panel;
  for (const node of $("settings-page").querySelectorAll(".settings-panel")) node.hidden = node.id !== `panel-${panel}`;
  $("settings-title").textContent = { settings: "Настройки", offline: "Офлайн-карты", "module-settings": "Настройки расширений", "transport-presets": "Наборы транспорта" }[panel];
  $("settings-back").setAttribute("aria-label", panel === "settings" ? "Вернуться к карте" : "Назад в настройки");
  $("nav-offline").setAttribute("aria-pressed", String(panel === "offline"));
  $("nav-module-settings").setAttribute("aria-pressed", String(panel === "module-settings"));
  $("nav-transport-presets").setAttribute("aria-pressed", String(panel === "transport-presets"));
  if (focus) {
    const parentLink = previous === "offline" ? $("nav-offline") : previous === "module-settings" ? $("nav-module-settings") : previous === "transport-presets" ? $("nav-transport-presets") : null;
    (panel === "settings" && parentLink ? parentLink : $("settings-back")).focus({ preventScroll: true });
  }
}

function openSettingsPage(panel = "settings") {
  const page = $("settings-page");
  if (page.hidden) {
    settingsOpener = document.activeElement;
    if (routingUI?.isOpen?.()) routingUI.close();
    transportUI?.close();
    closeSheet(false);
    for (const panel of elements.sheet.querySelectorAll(".sheet-panel")) panel.hidden = true;
    page.hidden = false;
    page.inert = false;
    page.setAttribute("aria-hidden", "false");
  }
  showSettingsPanel(panel);
  $("nav-settings").setAttribute("aria-expanded", "true");
  setMapInert(true);
}

function closeSettingsPage(restoreFocus = true) {
  const page = $("settings-page");
  const wasOpen = !page.hidden;
  page.hidden = true;
  page.inert = true;
  page.setAttribute("aria-hidden", "true");
  $("nav-settings").setAttribute("aria-expanded", "false");
  setMapInert(elements.sheet.classList.contains("is-open"));
  if (wasOpen && restoreFocus) {
    const opener = settingsOpener?.isConnected && !settingsOpener.closest(".sheet, .settings-page") && !settingsOpener.inert ? settingsOpener : elements.layersButton;
    opener.focus({ preventScroll: true });
  }
}

function backSettingsPage() {
  if (activeSettingsPanel === "transport-presets" && transportUI?.editorBack()) return;
  if (activeSettingsPanel !== "settings") showSettingsPanel("settings");
  else closeSettingsPage();
}

function openSheet(panel = "layers") {
  panel = typeof panel === "string" ? panel : "layers";
  if (["offline", "settings", "module-settings", "transport-presets"].includes(panel)) { openSettingsPage(panel); return; }
  if (routingUI?.isOpen?.()) routingUI.close();
  transportUI?.close();
  if (!$("settings-page").hidden) closeSettingsPage(false);
  if (!elements.sheet.classList.contains("is-open")) sheetOpener = document.activeElement;
  switchPanel(panel);
  elements.sheet.inert = false;
  elements.scrim.classList.add("is-open");
  elements.sheet.classList.add("is-open");
  elements.sheet.setAttribute("aria-hidden", "false");
  elements.layersButton.setAttribute("aria-expanded", "true");
  setMapInert(true);
  elements.closeSheet.focus();
}

function closeSheet(restoreFocus = true) {
  if (!$("settings-page").hidden) closeSettingsPage(restoreFocus);
  const wasOpen = elements.sheet.classList.contains("is-open");
  elements.scrim.classList.remove("is-open");
  elements.sheet.classList.remove("is-open");
  elements.sheet.setAttribute("aria-hidden", "true");
  elements.sheet.inert = true;
  elements.layersButton.setAttribute("aria-expanded", "false");
  setMapInert(!$("settings-page").hidden);
  elements.layersButton.setAttribute("aria-pressed", "false");
  $("nav-map").setAttribute("aria-pressed", "true");
  if (wasOpen && restoreFocus) (sheetOpener && !sheetOpener.closest(".sheet, .settings-page") ? sheetOpener : elements.layersButton).focus({ preventScroll: true });
}

function setMapInert(inert) {
  for (const node of document.querySelectorAll("#map, .topbar, .map-toolbar, .map-actions, .bottom-nav, #time-card, .routing-chip")) {
    node.inert = inert;
  }
}

function fitRegion(animate) {
  if (!map || !data) return;
  const padding = { top: 120, right: 24, bottom: 190, left: 24 };
  if (state.mode !== "3d") {
    map.fitBounds(data.region.bounds, { padding, pitch: 0, bearing: map.getBearing(), duration: animate ? 650 : 0 });
    return;
  }
  const camera = map.cameraForBounds(data.region.bounds, { padding });
  if (camera) {
    map.easeTo({
      ...camera,
      zoom: Math.min(map.getMaxZoom(), Math.max(14.5, camera.zoom)),
      pitch: pitchController.intent || 56,
      bearing: map.getBearing(),
      duration: animate ? 650 : 0,
    });
    return;
  }
  map.fitBounds(data.region.bounds, { padding, pitch: pitchController.intent || 56, bearing: map.getBearing(), duration: animate ? 650 : 0 });
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
  if (offlineBasemap?.isUsingOffline() || navigator.onLine) {
    elements.connection.classList.remove("is-visible");
  } else {
    setConnectionWarning("Нет сети");
  }
}

function buildingPopup(event) {
  if (routingUI?.isPicking?.()) return;
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

elements.regionName.textContent = savedCamera ? "Последнее место" : "OpenStreetMap";
elements.dataStatus.textContent = sceneDataStatus;
elements.economyMode.checked = economyMode;
updateSceneClock();
updateWind(null);
applyControls();
showFrame(state.frame);
updateOnlineState();
requestCityPacks();
try { window.AndroidHost?.listOfflinePlaces?.(); } catch (error) { console.debug("Offline search unavailable", error); }
$("offline-place-retry").addEventListener("click", () => window.AndroidHost?.prepareOfflinePlaces?.());
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
elements.cancelScene.addEventListener("click", cancelPlaceOperation);
elements.cancelShadowScene.addEventListener("click", () => {
  shadowFailedView = JSON.stringify(currentViewportBox());
  cancelPlaceOperation();
});
elements.demoButton.addEventListener("click", loadDemoScene);
$("clear-scene").addEventListener("click", () => {
  clearScene();
  restoreSelectedLocation();
  setPlaceStatus("Расчёт убран. Можно просматривать карту и добавлять свои слои.");
});
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
  loadViewportScene("Область карты")
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
    config: layerSettings.capturePreset(state, frames[state.frame]?.label || "15:00"),
  };
  if (storePresets([...presets, preset])) {
    elements.presetName.value = "";
    setPresetStatus(`Набор «${name}» сохранён на этом устройстве.`);
  }
});

elements.layersButton.addEventListener("click", openSheet);
$("search-button").addEventListener("click", () => { openSheet("search"); elements.placeQuery.focus(); });
$("route-open").addEventListener("click", () => routingUI?.open());
$("transport-open").addEventListener("click", () => transportUI?.open());
$("nav-map").addEventListener("click", closeSheet);
$("nav-offline").addEventListener("click", () => openSheet("offline"));
$("nav-module-settings").addEventListener("click", () => openSheet("module-settings"));
$("nav-transport-presets").addEventListener("click", () => { openSettingsPage("transport-presets"); transportUI?.showEditor(); });
$("settings-back").addEventListener("click", backSettingsPage);
$("nav-settings").addEventListener("click", () => openSheet("settings"));
for (const button of document.querySelectorAll(".sheet-tabs button")) button.addEventListener("click", () => switchPanel(button.dataset.panel));
for (const button of document.querySelectorAll("#theme-options button")) button.addEventListener("click", () => {
  themePreference = button.dataset.theme;
  try { localStorage.setItem("sloi-theme", themePreference); } catch (_) { setPresetStatus("Тема действует, но не сохранится.", true); }
  applyTheme();
});
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
  invalidateFrameRequest();
  if (window.AndroidHost?.cancelShadowFrame) window.AndroidHost.cancelShadowFrame();
  if (sliderFrame !== null) cancelAnimationFrame(sliderFrame);
  sliderFrame = requestAnimationFrame(() => { sliderFrame = null; showFrame(elements.timeRange.value); });
});
elements.play.addEventListener("click", startPlayback);
elements.recenter.addEventListener("click", () => {
  haptic();
  if (selectedPlace) map.flyTo({ center: [selectedPlace.longitude, selectedPlace.latitude], zoom: 15, duration: 650 });
  else if (data?.demo) fitRegion(true);
});
elements.locate.addEventListener("click", () => {
  haptic();
  locateOnMap();
});
elements.myLocation.addEventListener("click", () => {
  haptic();
  locateOnMap();
});
$("location-settings").addEventListener("click", () => {
  const host = window.AndroidHost;
  if ($("location-settings").dataset.locationOff === "true") host?.openLocationSettings?.();
  else host?.openAppSettings?.();
});
elements.loadCenter.addEventListener("click", () => {
  haptic();
  loadViewportScene("Область карты")
    .catch((error) => setPlaceStatus(error.message, true));
});
elements.placeForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const query = elements.placeQuery.value.trim();
  searchPlaces(query);
});
elements.placeQuery.addEventListener("input", () => searchPlaces(elements.placeQuery.value, false));
elements.placeQuery.addEventListener("compositionstart", () => placeSearchController().compositionStart());
elements.placeQuery.addEventListener("compositionend", () => {
  searchErrors.clear(); placeSearchController().compositionEnd(elements.placeQuery.value);
});
window.addEventListener("pagehide", cancelSearch);
window.addEventListener("online", updateOnlineState);
window.addEventListener("offline", updateOnlineState);
document.addEventListener("visibilitychange", () => {
  moduleHost?.setSuspended(document.hidden);
  if (document.hidden) {
    saveCamera();
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
window.addEventListener("pagehide", saveCamera);
document.addEventListener("keydown", (event) => {
  const settingsOpen = !$("settings-page").hidden;
  const surface = settingsOpen ? $("settings-page") : elements.sheet.classList.contains("is-open") ? elements.sheet : null;
  if (!surface) return;
  if (event.key === "Escape") {
    event.preventDefault();
    if (settingsOpen) backSettingsPage(); else closeSheet();
  } else if (event.key === "Tab") {
    const focusable = [...surface.querySelectorAll("button, input, select, summary, [tabindex='0']")]
      .filter((node) => {
        if (node.disabled || !node.getClientRects().length) return false;
        for (let parent = node.parentElement; parent && parent !== surface; parent = parent.parentElement) {
          if (parent.matches("details:not([open])") && parent.querySelector(":scope > summary") !== node) return false;
        }
        return true;
      });
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
    ...(savedCamera || window.SloiMapCamera.defaultCamera),
    pitch: storedPitch,
    minZoom: 1,
    maxZoom: 19,
    maxPitch: 60,
    cooperativeGestures: false,
    bearingSnap: 0,
    transformCameraUpdate: (next) => {
      const result = pitchController.update(next);
      state.mode = pitchController.intent > .1 ? "3d" : "2d";
      return result;
    },
    attributionControl: false,
    style: (() => {
      const style = window.SloiBasemap.createStyle(state.basemap);
      style.sources.openmaptiles.url = offlineBasemap.initialUrl();
      return style;
    })(),
  });
  window.SloiMapGestures.install(map, { onActiveChange(active) {
    mapTouchActive = active;
    if (!active && mapReady) { scheduleViewportTiles(); scheduleShadowViewport(); showFrame(state.frame, false); }
  } });
  // Manual camera input owns navigation. A late GPS, example or route reply
  // must not pull the map back after the user has begun exploring elsewhere.
  const cameraSurface = map.getCanvasContainer();
  const manualCameraInput = (event) => {
    if (!event.isTrusted || !cameraSurface.contains(event.target)) return;
    if (event.type === "keydown" && !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "+", "-", "="].includes(event.key)) return;
    cameraInputGeneration++;
    navigationGeneration++;
    invalidateLocation();
  };
  for (const type of ["pointerdown", "wheel", "keydown"]) window.addEventListener(type, manualCameraInput, { capture: true, passive: true });
  map.on("remove", () => {
    for (const type of ["pointerdown", "wheel", "keydown"]) window.removeEventListener(type, manualCameraInput, true);
  });
  map.addControl(new maplibregl.AttributionControl({ compact: true }), "bottom-right");

  const initializeMapLayers = () => {
    if (mapReady) return;
    map.addSource("shadows", {
      type: "geojson",
      data: shadowCollection(null),
    });
    map.addSource("buildings", {
      type: "geojson",
      data: { type: "FeatureCollection", features: [] },
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
        "fill-opacity": state.buildingOpacity,
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
        "fill-extrusion-opacity": state.buildingOpacity,
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

    map.addLayer({ id: "module-anchor", type: "background", paint: { "background-opacity": 0 } }, "selected-location");
    mapReady = true;
    offlineBasemap.refresh();
    initializeLayerRuntime();
    applyMapState();
    showFrame(state.frame);
    scheduleViewportTiles();
    restoreCustomLayers();
    initializeModules();
    routingUI = window.SloiRoutingUI.install({ map,
      getDestination: () => selectedPlace,
      getCurrentPosition,
      searchPlaces: queryPlaceSuggestions,
      onOpen: () => { transportUI?.close(); closeSheet(); cancelSearch(); },
      onClose: () => $("route-open").focus({ preventScroll: true }),
    });
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
  map.on("moveend", scheduleShadowViewport);
  map.on("moveend", saveCamera);
  map.on("moveend", () => offlineBasemap.refresh());
  map.on("move", () => {
    const meters = window.SloiMapCamera.scaleMeters(map.getCenter().lat, map.getZoom());
    $("map-scale-label").textContent = meters >= 1000 ? `${(meters / 1000).toFixed(meters >= 10000 ? 0 : 1)} км` : `${Math.round(meters)} м`;
    updateBuildingVisibility();
  });
  map.on("movestart", () => {
    stopPlayback();
    invalidateFrameRequest();
    if (window.AndroidHost?.cancelShadowFrame) window.AndroidHost.cancelShadowFrame();
  });
  map.on("moveend", () => { applyMapState(); showFrame(state.frame, false); });
  map.on("click", (event) => {
    const ids = map.getStyle().layers.filter((layer) => layer.id.startsWith("module-")).map((layer) => layer.id);
    if (!ids.length) return;
    const features = map.queryRenderedFeatures(event.point, { layers: ids });
    if (features.length) showCustomPopup({ features, lngLat: event.lngLat });
  });
} catch (error) {
  console.error(error);
  showFatal(error.message || "Ошибка запуска карты");
}
