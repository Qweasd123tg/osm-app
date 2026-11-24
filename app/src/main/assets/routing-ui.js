(function (root) {
  "use strict";
  const SOURCE = "route-plan-source";
  const LAYERS = ["route-plan-casing", "route-plan-line", "route-plan-walk", "route-plan-stops", "route-plan-endpoints"];
  const empty = () => ({ type: "FeatureCollection", features: [] });
  const coordinates = place => {
    if (Array.isArray(place) && place.length === 2) return place;
    const pair = [Number(place?.longitude ?? place?.lon), Number(place?.latitude ?? place?.lat)];
    return pair.every(Number.isFinite) && Math.abs(pair[0]) <= 180 && Math.abs(pair[1]) <= 85 ? pair : null;
  };
  const duration = seconds => { const minutes = Math.max(1, Math.ceil(seconds / 60)); return minutes < 60 ? `${minutes} мин` : `${Math.floor(minutes / 60)} ч${minutes % 60 ? ` ${minutes % 60} мин` : ""}`; };
  const distance = meters => meters < 1000 ? `${Math.round(meters)} м` : `${(meters / 1000).toFixed(1).replace(".", ",")} км`;
  const node = (tag, className, text) => { const element = document.createElement(tag); if (className) element.className = className; if (text) element.textContent = text; return element; };
  const iconPaths = {
    walk: '<circle cx="13" cy="4" r="2"/><path d="m10 9 3-2 3 5 4 1M13 7l-2 7-5 6m5-6 5 6M10 9l-4 3"/>',
    bicycle: '<circle cx="5.5" cy="16.5" r="4"/><circle cx="18.5" cy="16.5" r="4"/><path d="m5.5 16.5 5-9 8 9M5.5 16.5h9L9 6H6m8-2h3l2 4"/>',
    train: '<rect x="5" y="3" width="14" height="17" rx="4"/><path d="M5 11h14M12 3v8M9 20l-2 2m8-2 2 2M8 16h1m6 0h1"/>',
    ferry: '<path d="M3 15 12 11l9 4-4 5H7ZM7 13V6h10v7M10 6V3h4v3M2 22l4-1 6 1 6-1 4 1"/>',
    locate: '<circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="2"/><path d="M12 2v3m0 14v3M2 12h3m14 0h3"/>',
    pin: '<path d="M19 10c0 5-7 11-7 11S5 15 5 10a7 7 0 1 1 14 0Z"/><circle cx="12" cy="10" r="2.5"/>',
  };
  function icon(kind) {
    const transport = root.SloiTransportSymbols?.create(kind === "subway" ? "metro-plain" : kind, "routing-icon");
    if (transport) return transport;
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("class", "routing-icon"); svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("fill", "none"); svg.setAttribute("stroke", "currentColor"); svg.setAttribute("stroke-width", "1.8");
    svg.setAttribute("stroke-linecap", "round"); svg.setAttribute("stroke-linejoin", "round");
    svg.setAttribute("aria-hidden", "true"); svg.setAttribute("focusable", "false");
    svg.innerHTML = iconPaths[kind] || iconPaths.pin;
    return svg;
  }
  const legIcon = leg => leg.mode !== "transit" ? leg.mode : ({ trolleybus: "trolley", rail: "train", metro: "subway" }[leg.type] || leg.type);
  const routeColors = Object.freeze({
    walk: "#23b34b", bicycle: "#168a85", bus: "#1a73f0", tram: "#eb5a2b",
    trolley: "#e9a300", subway: "#9b4db2", transit: "#1a73f0",
  });
  const legColor = leg => routeColors[leg.mode === "transit" ? legIcon(leg) : leg.mode] || routeColors.transit;
  const transferLabel = transfers => {
    if (transfers === 0) return "Без пересадок";
    const last = transfers % 10, lastTwo = transfers % 100;
    return `${transfers} ${lastTwo >= 11 && lastTwo <= 14 ? "пересадок" : last === 1 ? "пересадка" : last >= 2 && last <= 4 ? "пересадки" : "пересадок"}`;
  };

  function routeBounds(geometry, from, to) {
    const lines = geometry?.type === "LineString" ? [geometry.coordinates]
      : geometry?.type === "MultiLineString" && Array.isArray(geometry.coordinates) ? geometry.coordinates : [];
    let west = Infinity, south = Infinity, east = -Infinity, north = -Infinity;
    function include(point) {
      if (!Array.isArray(point) || point.length !== 2) return;
      const [lon, lat] = point;
      if (!Number.isFinite(lon) || !Number.isFinite(lat) || Math.abs(lon) > 180 || Math.abs(lat) > 85) return;
      west = Math.min(west, point[0]); east = Math.max(east, point[0]);
      south = Math.min(south, point[1]); north = Math.max(north, point[1]);
    }
    for (const line of lines) if (Array.isArray(line)) for (const point of line) include(point);
    if (!Number.isFinite(west) || west === east && south === north) return null;
    // A provider may snap the line to the street some distance from an A/B pin.
    include(from); include(to);
    return [[west, south], [east, north]];
  }

  function routeViewport(canvas, panel) {
    const frame = canvas.getBoundingClientRect();
    // offsetTop gives the final position during the sheet's entrance animation.
    let area = { left: 0, top: 0, right: frame.width, bottom: Math.min(frame.height, panel.offsetTop - frame.top) };
    const size = box => (box.right - box.left) * (box.bottom - box.top);
    const usable = box => box.right - box.left >= 32 && box.bottom - box.top >= 32;
    for (const control of document.querySelectorAll(".bottom-nav, .connection.is-visible, .map-toolbar:not([hidden]), .map-actions, .topbar, .map-scale, .maplibregl-ctrl-attrib")) {
      const rect = control.getBoundingClientRect();
      if (!rect.width || !rect.height || root.getComputedStyle(control).visibility === "hidden") continue;
      const left = rect.left - frame.left, right = rect.right - frame.left;
      const top = rect.top - frame.top, bottom = rect.bottom - frame.top;
      if (right <= area.left || left >= area.right || bottom <= area.top || top >= area.bottom) continue;
      // A side button on a short screen can cost less width than height.
      const available = [{ ...area, top: bottom }, { ...area, bottom: top },
        { ...area, left: right }, { ...area, right: left }].filter(usable);
      if (!available.length) return null;
      area = available.reduce((largest, box) => size(box) > size(largest) ? box : largest);
    }
    if (!usable(area)) return null;
    const margin = Math.min(20, (area.right - area.left) / 8, (area.bottom - area.top) / 8);
    return { left: area.left + margin, top: area.top + margin, right: area.right - margin, bottom: area.bottom - margin };
  }

  function fitRoute(map, panel, route, from, to) {
    const bounds = routeBounds(route.geometry, from, to);
    if (!bounds) return;
    const canvas = map.getCanvas(), container = map.getContainer();
    // A route can finish just after rotation or a WebView resize.
    if (canvas.clientWidth !== container.clientWidth || canvas.clientHeight !== container.clientHeight) map.resize();
    const area = routeViewport(canvas, panel);
    if (!area) return;
    const maxZoom = Math.min(map.getMaxZoom(), 17), bearing = map.getBearing(), pitch = map.getPitch();
    const flat = map.cameraForBounds(bounds, { maxZoom });
    if (!flat) return;
    const target = flat.center;
    const [[west, south], [east, north]] = bounds;
    const corners = [[west, south], [west, north], [east, south], [east, north]].map(point => root.maplibregl.LngLat.convert(point));
    const midpoint = { x: (area.left + area.right) / 2, y: (area.top + area.bottom) / 2 };
    // MapLibre's cameraForBounds calculates the scale in 2D. Project the
    // corners with a scratch copy of the pinned 4.7 transform to keep the
    // real bearing, pitch and padding without moving the live camera twice.
    const transform = map.transform.clone();
    function atZoom(zoom) {
      transform.zoom = zoom;
      transform.center = target;
      transform.setLocationAtPoint(target, midpoint);
      const fits = corners.every(corner => {
        const point = transform.locationPoint(corner);
        return point.x >= area.left && point.x <= area.right && point.y >= area.top && point.y <= area.bottom;
      });
      return fits ? { center: transform.center, zoom: transform.zoom } : null;
    }
    let camera = atZoom(maxZoom);
    if (!camera) {
      // Start near the route scale; the world limits can prevent centering a
      // mid-latitude route high in the screen at the map's minimum zoom.
      const minZoom = map.getMinZoom();
      let low = Math.max(minZoom, flat.zoom), high = maxZoom;
      camera = atZoom(low);
      while (!camera && low > minZoom) {
        high = low;
        low = Math.max(minZoom, low - 1);
        camera = atZoom(low);
      }
      if (!camera) return;
      for (let i = 0; i < 12; i++) {
        const zoom = (low + high) / 2, candidate = atZoom(zoom);
        if (candidate) { low = zoom; camera = candidate; }
        else high = zoom;
      }
    }
    const reducedMotion = root.matchMedia("(prefers-reduced-motion: reduce)").matches;
    map.easeTo({ ...camera, pitch, bearing, duration: reducedMotion ? 0 : 450 });
  }

  function install(options) {
    const map = options?.map;
    if (!map || !root.SloiRouting || typeof options.searchPlaces !== "function") throw new Error("Построение маршрутов недоступно");
    let disposed = false, opened = false, active = null, generation = 0, mode = "walk", selectedRoute = null, source = null;
    let fromPlace = null, toPlace = null, useLocation = true, opener = null, fitOnReady = true, externalDestinationKey = null, picking = null;
    const panel = node("section", "routing-panel"); panel.id = "routing-panel"; panel.hidden = true;
    panel.setAttribute("role", "region"); panel.setAttribute("aria-labelledby", "routing-title");
    const header = node("header", "routing-header");
    const title = node("h2", "", "Маршрут"); title.id = "routing-title";
    const close = node("button", "routing-close", "×"); close.type = "button"; close.setAttribute("aria-label", "Закрыть маршрут");
    header.append(title, close);
    const form = node("form", "routing-form");
    const inputs = {}, mapButtons = {};
    const draftMarkers = new Map(), nameRequests = new Map();
    function cancelPlaceName(key) { nameRequests.get(key)?.abort(); nameRequests.delete(key); }
    function updateDraftMarkers() {
      for (const [key, place] of [["from", useLocation ? null : fromPlace], ["to", toPlace]]) {
        const point = coordinates(place);
        if (!point || (!opened && !picking && !selectedRoute)) { draftMarkers.get(key)?.remove(); draftMarkers.delete(key); continue; }
        let marker = draftMarkers.get(key);
        if (!marker) {
          const element = node("div", "routing-draft-marker", key === "from" ? "А" : "Б");
          element.dataset.endpoint = key; element.setAttribute("aria-label", key === "from" ? "Начало маршрута" : "Конец маршрута");
          marker = new root.maplibregl.Marker({ element, anchor: "center" }).setLngLat(point).addTo(map);
          draftMarkers.set(key, marker);
        } else marker.setLngLat(point);
      }
    }
    async function resolvePickedName(key, place) {
      cancelPlaceName(key);
      if (typeof root.SloiPlaceNames?.resolve !== "function") return;
      const controller = new AbortController(); nameRequests.set(key, controller);
      try {
        const named = await root.SloiPlaceNames.resolve({ latitude: place.latitude, longitude: place.longitude }, { signal: controller.signal });
        if (disposed || controller.signal.aborted || nameRequests.get(key) !== controller || (key === "from" ? fromPlace : toPlace) !== place) return;
        const label = String(named?.name || named?.display_name || "").trim().slice(0, 200);
        if (label) { place.name = label; inputs[key].value = label; }
      } catch (_) { /* A name is optional: the exact confirmed point stays valid. */ }
      finally { if (nameRequests.get(key) === controller) nameRequests.delete(key); }
    }
    for (const [key, label] of [["from", "Откуда"], ["to", "Куда"]]) {
      const row = node("div", "routing-field");
      const fieldLabel = node("label", "", label); fieldLabel.htmlFor = `routing-${key}`;
      const input = node("input"); input.id = `routing-${key}`; input.type = "search"; input.autocomplete = "off"; input.maxLength = 160; input.placeholder = label;
      input.setAttribute("aria-autocomplete", "list"); input.setAttribute("aria-controls", "routing-suggestions");
      row.append(fieldLabel, input); inputs[key] = input;
      const fieldActions = node("div", "routing-field-actions");
      if (key === "from") {
        const locate = node("button", "routing-origin"); locate.type = "button";
        locate.setAttribute("aria-label", "Использовать моё местоположение"); locate.append(icon("locate"));
        locate.addEventListener("click", () => { abort(); cancelPlaceName("from"); clearResults(); fromPlace = null; useLocation = true; updateDraftMarkers(); input.value = "Моё место"; search.cancel(); suggestions.replaceChildren(); status.textContent = ""; });
        fieldActions.append(locate);
      }
      const pick = node("button", "routing-map-point"); pick.type = "button";
      pick.setAttribute("aria-label", key === "from" ? "Выбрать начало на карте" : "Выбрать конец на карте");
      pick.title = pick.getAttribute("aria-label"); pick.append(icon("pin"));
      pick.addEventListener("click", () => beginPicking(key)); mapButtons[key] = pick;
      fieldActions.append(pick); row.append(fieldActions);
      form.append(row);
    }
    const suggestions = node("div", "routing-suggestions"); suggestions.id = "routing-suggestions";
    const results = node("div", "routing-results routing-options");
    results.setAttribute("role", "group"); results.setAttribute("aria-label", "Варианты маршрута");
    const modes = node("div", "routing-modes"); modes.setAttribute("role", "group"); modes.setAttribute("aria-label", "Способ передвижения");
    const parameters = node("details", "routing-parameters"); parameters.hidden = true;
    parameters.append(node("summary", "", "Параметры"));
    const directLabel = node("label", "routing-preference");
    const directOnly = node("input"); directOnly.id = "routing-direct-only"; directOnly.type = "checkbox";
    directLabel.append(directOnly, node("span", "", "Без пересадок")); parameters.append(directLabel);
    const preferencesChanged = () => { abort(); clearResults(); status.textContent = ""; };
    directOnly.addEventListener("change", preferencesChanged);
    const transportChoices = new Map();
    const transportTypes = node("fieldset", "routing-transport-types");
    transportTypes.append(node("legend", "", "Виды транспорта"));
    const transportOptions = node("div", "routing-transport-options");
    for (const [type, label] of [["bus", "Автобус"], ["subway", "Метро"], ["tram", "Трамвай"], ["trolley", "Троллейбус"]]) {
      const choice = node("label", "routing-transport-type");
      const input = node("input"); input.type = "checkbox"; input.checked = true; input.value = type;
      input.id = `routing-transport-${type}`; input.addEventListener("change", preferencesChanged);
      choice.append(input, icon(type), node("span", "", label)); transportOptions.append(choice);
      transportChoices.set(type, input);
    }
    transportTypes.append(transportOptions); parameters.append(transportTypes);
    for (const [key, text] of [["walk", "Пешком"], ["bicycle", "Велосипед"], ["transit", "Транспорт"]]) {
      const button = node("button"); button.type = "button"; button.dataset.mode = key;
      button.append(icon(key === "transit" ? "bus" : key), node("span", "", text));
      button.setAttribute("aria-pressed", String(key === mode));
      button.addEventListener("click", () => {
        abort(); mode = key; clearResults(); parameters.hidden = mode !== "transit";
        for (const item of modes.children) item.setAttribute("aria-pressed", String(item === button));
        status.textContent = "";
      }); modes.append(button);
    }
    const actions = node("div", "routing-actions");
    const submit = node("button", "routing-submit", "Построить"); submit.type = "submit";
    const cancel = node("button", "routing-cancel", "Отменить"); cancel.type = "button"; cancel.hidden = true;
    actions.append(submit, cancel); form.append(suggestions, results, modes, parameters, actions);
    const status = node("p", "routing-status"); status.setAttribute("role", "status");
    const details = node("div", "routing-details");
    form.append(details);
    const attribution = node("div", "routing-attribution");
    const chip = node("div", "routing-chip"); chip.hidden = true;
    const resume = node("button", "routing-resume"); resume.type = "button";
    const clearButton = node("button", "routing-clear", "×"); clearButton.type = "button"; clearButton.setAttribute("aria-label", "Убрать маршрут");
    chip.append(resume, clearButton); panel.append(header, form, status, attribution);
    const picker = node("section", "routing-picker"); picker.id = "routing-picker"; picker.hidden = true;
    picker.setAttribute("role", "region"); picker.setAttribute("aria-labelledby", "routing-picker-title");
    const pickerTitle = node("strong"); pickerTitle.id = "routing-picker-title";
    const pickerActions = node("div", "routing-picker-actions");
    const pickCancel = node("button", "routing-picker-cancel", "Отмена"); pickCancel.type = "button";
    const pickConfirm = node("button", "routing-picker-confirm", "Выбрать точку"); pickConfirm.type = "button";
    pickerActions.append(pickCancel, pickConfirm); picker.append(pickerTitle, pickerActions);
    const target = node("div", "routing-picker-target"); target.hidden = true; target.setAttribute("aria-hidden", "true"); target.append(icon("locate"));
    document.body.append(panel, chip, target, picker);

    function positionTarget() {
      if (!picking) return;
      const rect = map.getCanvas().getBoundingClientRect();
      target.style.left = `${rect.left + rect.width / 2}px`;
      target.style.top = `${rect.top + rect.height / 2}px`;
    }
    function beginPicking(key) {
      if (disposed || !opened) return;
      abort(); cancelPlaceName(key); search.cancel(); suggestions.replaceChildren(); status.textContent = "";
      picking = key; opened = false; panel.hidden = true; chip.hidden = true;
      document.activeElement?.blur?.();
      pickerTitle.textContent = key === "from" ? "Начало маршрута" : "Конец маршрута";
      document.body.classList.add("is-picking-route");
      target.hidden = false; picker.hidden = false; positionTarget(); updateDraftMarkers();
      pickConfirm.focus({ preventScroll: true });
    }
    function finishPicking(confirm) {
      if (!picking) return;
      const key = picking;
      if (confirm) {
        // The geographic camera centre can differ from the physical canvas
        // centre after a padded route fit. Choose exactly under the crosshair.
        const canvas = map.getCanvas();
        const point = map.unproject([canvas.clientWidth / 2, canvas.clientHeight / 2]);
        const longitude = ((point.lng + 180) % 360 + 360) % 360 - 180;
        const latitude = point.lat;
        const place = { name: "Точка на карте", longitude, latitude };
        clearResults();
        if (key === "from") { fromPlace = place; useLocation = false; } else toPlace = place;
        inputs[key].value = place.name;
        resolvePickedName(key, place);
      }
      picking = null; picker.hidden = true; target.hidden = true;
      document.body.classList.remove("is-picking-route");
      opened = true; panel.hidden = false; updateDraftMarkers();
      mapButtons[key].focus({ preventScroll: true });
    }
    pickConfirm.addEventListener("click", () => finishPicking(true));
    pickCancel.addEventListener("click", () => finishPicking(false));
    map.on("resize", positionTarget);

    function abort() {
      generation++; active?.abort(); active = null;
      submit.disabled = false; cancel.hidden = true;
    }
    let focusedField = "to";
    const search = root.SloiSearch.create({ places: options.searchPlaces, providers: () => [],
      contextKey: () => { const centre = map.getCenter(); return `${root.SloiOfflinePlacesRevision || ""}|${centre.lng.toFixed(2)},${centre.lat.toFixed(2)},${Math.round(map.getZoom())}`; },
      onResults(value) {
        if (!opened) return;
        suggestions.replaceChildren();
        for (const place of value.places) {
          if (!coordinates(place)) continue;
          const button = node("button", "routing-suggestion", place.display_name || place.name || "Место"); button.type = "button";
          button.addEventListener("click", () => {
            abort(); cancelPlaceName(focusedField); clearResults(); search.cancel();
            if (focusedField === "from") { fromPlace = place; useLocation = false; } else toPlace = place;
            inputs[focusedField].value = place.name || place.display_name || "Место"; updateDraftMarkers();
            suggestions.replaceChildren(); status.textContent = "";
            inputs[focusedField === "from" ? "to" : "from"].focus({ preventScroll: true });
          }); suggestions.append(button);
        }
      },
      onError(error) { if (opened) status.textContent = error.message || "Поиск недоступен"; },
    });
    for (const [key, input] of Object.entries(inputs)) {
      input.addEventListener("focus", () => { if (focusedField !== key) { search.cancel(); suggestions.replaceChildren(); } focusedField = key; });
      input.addEventListener("input", () => {
        abort(); cancelPlaceName(key); clearResults(); focusedField = key;
        if (key === "from") { fromPlace = null; useLocation = false; } else toPlace = null;
        updateDraftMarkers();
        status.textContent = ""; search.input(input.value);
      });
      input.addEventListener("compositionstart", () => search.compositionStart());
      input.addEventListener("compositionend", () => search.compositionEnd(input.value));
    }

    function routeFeatures(route, from, to) {
      const features = route.legs.map(leg => ({
        type: "Feature", geometry: leg.geometry,
        properties: {
          kind: leg.mode, transportType: leg.type || leg.mode, routeColor: legColor(leg),
          walkConnector: route.mode === "transit" && leg.mode === "walk",
        },
      }));
      const seen = new Set();
      for (const leg of route.legs) for (const stop of leg.stops || []) {
        const key = stop.coordinates.join(","); if (seen.has(key)) continue; seen.add(key);
        features.push({ type: "Feature", properties: { kind: "stop", name: stop.name, routeColor: legColor(leg) }, geometry: { type: "Point", coordinates: stop.coordinates } });
      }
      for (const [index, point] of [from, to].entries()) features.push({ type: "Feature", properties: { kind: "endpoint", number: index + 1 }, geometry: { type: "Point", coordinates: point } });
      return { type: "FeatureCollection", features };
    }

    function ensureSource() {
      if (source && map.getSource(SOURCE) === source) return;
      if (map.getSource(SOURCE) || LAYERS.some(id => map.getLayer(id))) throw new Error("Слой маршрута уже занят");
      map.addSource(SOURCE, { type: "geojson", data: empty() }); source = map.getSource(SOURCE);
      const before = map.getLayer("selected-location") ? "selected-location" : undefined;
      const isLine = ["==", ["geometry-type"], "LineString"];
      const walkConnector = ["==", ["get", "walkConnector"], true];
      const solidRoute = ["all", isLine, ["!", walkConnector]];
      const roundedLine = { "line-cap": "round", "line-join": "round" };
      const lineColor = ["get", "routeColor"];
      map.addLayer({
        id: LAYERS[0], type: "line", source: SOURCE, filter: solidRoute, layout: roundedLine,
        paint: { "line-color": "#10191f", "line-width": 6.5, "line-opacity": .75 },
      }, before);
      map.addLayer({
        id: LAYERS[1], type: "line", source: SOURCE, filter: solidRoute, layout: roundedLine,
        paint: { "line-color": lineColor, "line-width": 5 },
      }, before);
      map.addLayer({
        id: LAYERS[2], type: "line", source: SOURCE, filter: ["all", isLine, walkConnector], layout: roundedLine,
        paint: { "line-color": lineColor, "line-width": 4, "line-dasharray": [1, 1.4] },
      }, before);
      map.addLayer({ id: LAYERS[3], type: "circle", source: SOURCE, minzoom: 15, filter: ["==", ["get", "kind"], "stop"], paint: { "circle-color": "#ffffff", "circle-radius": 4, "circle-stroke-color": ["get", "routeColor"], "circle-stroke-width": 2 } }, before);
      map.addLayer({ id: LAYERS[4], type: "circle", source: SOURCE, filter: ["==", ["get", "kind"], "endpoint"], paint: { "circle-color": "#3974d5", "circle-radius": 6, "circle-stroke-color": "#ffffff", "circle-stroke-width": 2 } }, before);
    }

    function showRoute(route, from, to, fit) {
      ensureSource(); source.setData(routeFeatures(route, from, to)); selectedRoute = route; updateDraftMarkers();
      resume.textContent = `${duration(route.duration)} · ${distance(route.distance)}`;
      chip.hidden = opened;
      attribution.replaceChildren();
      for (const item of route.attribution) { const link = node("a", "", item.title); link.href = item.url; link.target = "_blank"; link.rel = "noopener noreferrer"; attribution.append(link); }
      renderSteps(route);
      if (fit) fitRoute(map, panel, route, from, to);
    }

    function renderRoutes(routes, from, to) {
      results.replaceChildren();
      routes.forEach((route, index) => {
        const button = node("button", "routing-option"); button.type = "button";
        button.setAttribute("aria-pressed", String(index === 0));
        const top = node("span", "routing-option-top"); top.append(node("strong", "", duration(route.duration)));
        if (Number.isFinite(route.arrivalTime)) top.append(node("span", "routing-option-arrival", `К ${new Intl.DateTimeFormat("ru-RU", { timeZone: "Europe/Moscow", hour: "2-digit", minute: "2-digit" }).format(route.arrivalTime)}`));
        const meta = node("span", "routing-option-meta", `${distance(route.distance)}${route.mode === "transit" ? ` · ${transferLabel(route.transfers)}` : ""}`);
        const legs = node("span", "routing-option-legs");
        legs.setAttribute("aria-label", route.legs.map(leg => leg.label).join(" → "));
        const summaryLegs = [];
        for (const leg of route.legs) {
          const previous = summaryLegs.at(-1);
          if (leg.mode === "walk" && previous?.mode === "walk") previous.duration += leg.duration;
          else summaryLegs.push({ ...leg });
        }
        summaryLegs.slice(0, 3).forEach((leg, legIndex) => {
          if (legIndex) legs.append(node("span", "routing-leg-separator", "›"));
          const badge = node("span", "routing-leg-badge"); badge.append(icon(legIcon(leg)), node("span", "", leg.mode === "walk" ? duration(leg.duration) : leg.mode === "transit" && leg.routeNumber ? leg.routeNumber : leg.label));
          badge.style.setProperty("--route-color", legColor(leg));
          badge.setAttribute("aria-label", leg.label); legs.append(badge);
        });
        if (summaryLegs.length > 3) {
          const more = node("span", "routing-leg-more", `+${summaryLegs.length - 3}`);
          more.setAttribute("aria-label", `Ещё участков: ${summaryLegs.length - 3}`); legs.append(more);
        }
        button.append(top, meta, legs);
        button.addEventListener("click", () => {
          if (disposed || !opened || button.parentNode !== results) return;
          for (const row of results.querySelectorAll(".routing-option")) row.setAttribute("aria-pressed", String(row === button));
          showRoute(route, from, to, true);
        }); results.append(button);
      });
      results.scrollLeft = 0;
      form.scrollTop = 0;
      showRoute(routes[0], from, to, fitOnReady);
    }

    function renderSteps(route) {
      const expanded = details.querySelector(".routing-itinerary")?.open === true;
      details.replaceChildren();
      if (route.mode !== "transit") return;
      const disclosure = node("details", "routing-itinerary"); disclosure.open = expanded;
      disclosure.append(node("summary", "", "Поездка по шагам"));
      const list = node("ol", "routing-steps");
      for (const leg of route.legs) {
        const step = node("li"); step.style.setProperty("--route-color", legColor(leg)); const title = node("strong", "", `${leg.label} · ${duration(leg.duration)}`); step.append(icon(legIcon(leg)), title);
        if (leg.stops.length) step.append(node("span", "", `${leg.stops[0].name} → ${leg.stops[leg.stops.length - 1].name}`));
        list.append(step);
      }
      disclosure.append(list); details.append(disclosure);
    }

    function clearResults() {
      results.replaceChildren(); details.replaceChildren(); attribution.replaceChildren();
      selectedRoute = null; chip.hidden = true;
      if (source && map.getSource(SOURCE) === source) source.setData(empty());
      updateDraftMarkers();
    }

    form.addEventListener("submit", async event => {
      event.preventDefault(); abort(); search.cancel(); suggestions.replaceChildren(); clearResults();
      const destination = coordinates(toPlace);
      if (!destination) { status.textContent = "Выберите пункт назначения из результатов поиска"; inputs.to.focus(); return; }
      if (!useLocation && !coordinates(fromPlace)) { status.textContent = "Выберите начало маршрута из результатов поиска"; inputs.from.focus(); return; }
      const chosenTypes = [...transportChoices].filter(([, input]) => input.checked).map(([type]) => type);
      if (mode === "transit" && !chosenTypes.length) {
        status.textContent = "Выберите хотя бы один вид транспорта"; parameters.open = true;
        transportChoices.get("bus").focus(); return;
      }
      const request = active = new AbortController(), current = generation;
      fitOnReady = true;
      const requestMode = mode, preferences = { directOnly: mode === "transit" && directOnly.checked };
      if (mode === "transit") preferences.transportTypes = chosenTypes;
      submit.disabled = true; cancel.hidden = false; status.textContent = useLocation ? "Определяю местоположение…" : "Строю маршрут…";
      try {
        let origin = coordinates(fromPlace);
        if (useLocation) {
          const position = await options.getCurrentPosition();
          if (request.signal.aborted || current !== generation) return;
          origin = coordinates(position?.coords ? [position.coords.longitude, position.coords.latitude] : position);
          if (!origin) throw new Error("Не удалось определить местоположение");
        }
        status.textContent = "Строю маршрут…";
        const routes = await root.SloiRouting.plan({ from: origin, to: destination, mode: requestMode, preferences, signal: request.signal });
        if (disposed || !opened || request.signal.aborted || current !== generation) return;
        renderRoutes(routes, origin, destination); status.textContent = "";
      } catch (error) {
        if (current === generation && !request.signal.aborted) status.textContent = error.message || "Не удалось построить маршрут";
      } finally {
        if (current === generation) { active = null; submit.disabled = false; cancel.hidden = true; }
      }
    });
    cancel.addEventListener("click", () => { abort(); status.textContent = ""; });

    function closePanel() {
      if (!opened && !picking) return;
      abort(); cancelPlaceName("from"); cancelPlaceName("to"); search.cancel(); picking = null; opened = false; panel.hidden = true; picker.hidden = true; target.hidden = true; suggestions.replaceChildren();
      document.body.classList.remove("is-picking-route");
      chip.hidden = !selectedRoute; updateDraftMarkers();
      options.onClose?.(); opener?.focus?.({ preventScroll: true });
    }
    function open() {
      if (disposed || opened || picking) return;
      options.onOpen?.(); opener = document.activeElement;
      const destination = options.getDestination?.();
      const destinationCoordinates = coordinates(destination);
      const destinationKey = destinationCoordinates ? `${destinationCoordinates.join(",")}:${destination.name || ""}` : null;
      if (destinationKey !== null && destinationKey !== externalDestinationKey) {
        cancelPlaceName("to"); clearResults();
        toPlace = destination; inputs.to.value = destination.name || "Выбранное место";
      }
      externalDestinationKey = destinationKey;
      if (!fromPlace && useLocation) inputs.from.value = "Моё место";
      opened = true; panel.hidden = false; chip.hidden = true; updateDraftMarkers();
      (toPlace ? submit : inputs.to).focus({ preventScroll: true });
    }
    function clear() {
      abort(); clearResults();
    }
    function keydown(event) {
      if (!opened && !picking) return;
      if (event.key === "Escape") { event.preventDefault(); event.stopImmediatePropagation(); back(); }
    }
    function back() {
      if (picking) { finishPicking(false); return true; }
      if (opened) { closePanel(); return true; }
      return false;
    }
    close.addEventListener("click", closePanel);
    resume.addEventListener("click", open); clearButton.addEventListener("click", clear);
    document.addEventListener("keydown", keydown, true);
    const manualMove = event => { if (active && event.originalEvent?.isTrusted) fitOnReady = false; };
    map.on("movestart", manualMove);
    function dispose(mapRemoved = false) {
      if (disposed) return;
      closePanel(); disposed = true; abort(); search.dispose();
      cancelPlaceName("from"); cancelPlaceName("to");
      for (const marker of draftMarkers.values()) marker.remove(); draftMarkers.clear();
      if (!mapRemoved) {
        for (const id of [...LAYERS].reverse()) if (map.getLayer(id)?.source === SOURCE) map.removeLayer(id);
        if (source && map.getSource(SOURCE) === source) map.removeSource(SOURCE);
      }
      document.removeEventListener("keydown", keydown, true); map.off("remove", onRemove);
      map.off("movestart", manualMove); map.off("resize", positionTarget);
      panel.remove(); chip.remove(); picker.remove(); target.remove();
    }
    const onRemove = () => dispose(true); map.on("remove", onRemove);
    function invalidateSearchData() {
      search.cancel(); suggestions.replaceChildren();
      if (opened && Object.values(inputs).includes(document.activeElement)) search.input(document.activeElement.value);
    }
    return Object.freeze({ open, isOpen: () => opened || picking !== null, isPicking: () => picking !== null, back, close: closePanel, clear, dispose, invalidateSearchData });
  }
  root.SloiRoutingUI = Object.freeze({ install, duration, distance });
})(typeof window !== "undefined" ? window : globalThis);
