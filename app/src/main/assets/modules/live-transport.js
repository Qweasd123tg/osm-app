(function (root) {
  "use strict";

  const ORIGIN = "https://transport.orgp.spb.ru";
  const POLL_MS = 16000, MAX_BYTES = 2 * 1024 * 1024, MAX_ROWS = 5000;
  const MIN_ZOOM = 12, MAX_AGE_MS = 5 * 60 * 1000, MAX_PRESET_ROUTES = 20, MAX_ROUTES_SETTING = 8192;
  const TYPES = Object.freeze({
    bus: { name: "Автобус", prefix: "А", color: "#1a73f0", labelColor: "#436abd" },
    tram: { name: "Трамвай", prefix: "Т", color: "#eb5a2b", labelColor: "#eb5a2b" },
    trolley: { name: "Троллейбус", prefix: "Тб", color: "#c48900", labelColor: "#71a73d" },
  });
  const EMPTY = () => ({ type: "FeatureCollection", features: [] });
  const cancelled = () => Object.assign(new Error("Загрузка отменена"), { name: "AbortError" });
  const number = (value) => (typeof value === "number" || typeof value === "string" && value.trim()) && Number.isFinite(Number(value)) ? Number(value) : null;
  function position(longitude, latitude) {
    const lon = number(longitude), lat = number(latitude);
    return lon !== null && lat !== null && Math.abs(lon) <= 180 && Math.abs(lat) <= 85 ? [lon, lat] : null;
  }
  const text = (value, limit = 120) => typeof value === "string" || typeof value === "number" ? String(value).replace(/\s+/g, " ").trim().slice(0, limit) : "";
  const inside = (point, box) => point[0] >= box[0][0] && point[0] <= box[1][0] && point[1] >= box[0][1] && point[1] <= box[1][1];
  const hidden = () => root.document?.hidden === true;
  const routeKey = (type, route) => `${type}:${route.toLocaleLowerCase("ru")}`;
  const clockFormatter = new Intl.DateTimeFormat("ru-RU", { timeZone: "Europe/Moscow", hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const retryMessage = "Не удалось обновить транспорт. Повторим автоматически.";
  class RetryableFeedError extends Error {}

  // A preset is a bounded list of typed route numbers. A bus and a tram with
  // the same number are independent selections; route destination is irrelevant.
  function normalizeRoutes(value) {
    if (value === null) return null;
    if (!Array.isArray(value) || value.length > MAX_PRESET_ROUTES) throw new Error(`В наборе должно быть не больше ${MAX_PRESET_ROUTES} маршрутов`);
    const seen = new Set();
    return Object.freeze(value.map(item => {
      if (!item || typeof item !== "object" || Array.isArray(item) || !Object.hasOwn(TYPES, item.type)
        || Object.keys(item).some(key => !["type", "number", "color"].includes(key))) throw new Error("Неверный вид транспорта в наборе");
      if (typeof item.number !== "string" || !item.number.trim() || item.number.trim().length > 12
        || /[\u0000-\u001f\u007f]/.test(item.number)) throw new Error("Номер маршрута должен содержать от 1 до 12 символов");
      if (typeof item.color !== "string" || !/^#[0-9a-fA-F]{6}$/.test(item.color)) throw new Error("Выберите цвет маршрута");
      const number = text(item.number, 12), key = routeKey(item.type, number);
      if (seen.has(key)) throw new Error("Этот маршрут уже добавлен в набор");
      seen.add(key);
      return Object.freeze({ type: item.type, number, color: item.color.toLowerCase() });
    }));
  }
  function parseRoutes(value) {
    if (value === "") return null;
    if (typeof value !== "string" || value.length > MAX_ROUTES_SETTING) throw new Error("Набор маршрутов повреждён");
    let routes;
    try { routes = JSON.parse(value); } catch (_) { throw new Error("Набор маршрутов повреждён"); }
    // Only the empty setting means legacy mode. A serialized null must not
    // accidentally expose every route after a malformed preset is restored.
    if (routes === null) throw new Error("Набор маршрутов повреждён");
    return normalizeRoutes(routes);
  }
  function viewport(view) {
    const bounds = view?.bounds;
    if (!Number.isFinite(view?.zoom) || view.zoom < MIN_ZOOM || !Array.isArray(bounds) || bounds.length !== 2) return null;
    const southWest = position(bounds[0]?.[0], bounds[0]?.[1]), northEast = position(bounds[1]?.[0], bounds[1]?.[1]);
    if (!southWest || !northEast || southWest[0] >= northEast[0] || southWest[1] >= northEast[1]) return null;
    // The municipal feed covers Petersburg. Never request the whole world or
    // another city after restoring a camera saved elsewhere.
    const box = [[Math.max(29.3, southWest[0]), Math.max(59.45, southWest[1])], [Math.min(31.4, northEast[0]), Math.min(60.45, northEast[1])]];
    return box[0][0] < box[1][0] && box[0][1] < box[1][1] ? box : null;
  }
  function key(view) {
    const bounds = viewport(view);
    return bounds ? bounds.flat().map(value => value.toFixed(4)).join(",") : "";
  }

  async function requestJson(path, signal) {
    if (signal.aborted) throw cancelled();
    const url = new URL(path, ORIGIN);
    if (url.origin !== ORIGIN || url.protocol !== "https:") throw new Error("Недопустимый источник транспорта");
    const controller = new AbortController();
    const cancel = () => { clearTimeout(timer); controller.abort(); };
    const timer = setTimeout(cancel, 8000);
    signal.addEventListener("abort", cancel, { once: true });
    try {
      let response;
      try {
        response = await root.fetch(url.href, { signal: controller.signal, credentials: "omit", redirect: "error", cache: "no-store", headers: { Accept: "application/json" } });
      } catch (error) {
        throw new RetryableFeedError("Источник транспорта недоступен. Проверьте соединение.", { cause: error });
      }
      if (controller.signal.aborted) throw cancelled();
      if (!response.ok) {
        response.body?.cancel().catch(() => {});
        const status = response.status;
        const message = `Источник транспорта: HTTP ${status}`;
        if (status === 408 || status === 425 || status === 429 || (status >= 500 && status <= 599)) throw new RetryableFeedError(message);
        throw new Error(message);
      }
      if (number(response.headers.get("content-length")) > MAX_BYTES) {
        response.body?.cancel().catch(() => {});
        throw new Error("Ответ транспорта превышает 2 МиБ");
      }
      if (!response.body?.getReader) throw new Error("Потоковая загрузка транспорта недоступна");
      const reader = response.body.getReader(), decoder = new TextDecoder("utf-8", { fatal: true });
      let bytes = 0, body = "";
      try {
        while (true) {
          if (signal.aborted || controller.signal.aborted) throw cancelled();
          let part;
          try { part = await reader.read(); }
          catch (error) { throw new RetryableFeedError("Загрузка позиций транспорта прервана", { cause: error }); }
          if (controller.signal.aborted) throw cancelled();
          if (part.done) break;
          bytes += part.value.byteLength;
          if (bytes > MAX_BYTES) throw new Error("Ответ транспорта превышает 2 МиБ");
          body += decoder.decode(part.value, { stream: true });
        }
        body += decoder.decode();
      } catch (error) { reader.cancel().catch(() => {}); throw error; }
      finally { reader.releaseLock(); }
      if (controller.signal.aborted) throw cancelled();
      let data;
      try { data = JSON.parse(body); } catch (_) { throw new Error("Источник транспорта вернул повреждённый JSON"); }
      if (!Array.isArray(data) || data.length > MAX_ROWS) throw new Error("Источник транспорта вернул несовместимый список");
      const receivedAt = Date.now(), serverDate = Date.parse(response.headers.get("date") || "");
      return { data, receivedAt, referenceTime: Number.isFinite(serverDate) && Math.abs(serverDate - receivedAt) < 10 * 60 * 1000 ? serverDate : receivedAt };
    } catch (error) {
      if (signal.aborted) throw cancelled();
      if (controller.signal.aborted) throw new RetryableFeedError("Источник транспорта не ответил вовремя", { cause: error });
      throw error;
    } finally { clearTimeout(timer); signal.removeEventListener("abort", cancel); }
  }

  function clock(ms) {
    const date = new Date(ms);
    return Number.isFinite(date.getTime()) ? clockFormatter.format(date) : "Invalid Date";
  }
  function normalizeVehicles(payload, { bounds, types, route = "", routes = null, receivedAt, referenceTime = receivedAt }) {
    if (!Array.isArray(payload) || payload.length > MAX_ROWS) throw new Error("Источник транспорта вернул несовместимый список");
    const selection = normalizeRoutes(routes), selected = selection === null ? null : new Map(selection.map(item => [routeKey(item.type, item.number), item]));
    const parsedTimes = payload.map(item => Date.parse(typeof item?.DateTime === "string" ? item.DateTime : "")).filter(Number.isFinite);
    const maxTime = parsedTimes.length ? Math.max(...parsedTimes) : NaN;
    // In the verified municipal response Moscow wall time is labelled "Z".
    // Detect that response-level anomaly only to reject clearly old positions.
    // It is NOT a documented timezone contract: adjusted points remain visibly
    // unconfirmed, rather than being presented as guaranteed fresh GPS fixes.
    const difference = maxTime - referenceTime;
    const inferredOffset = difference > 2.8 * 3600000 && difference < 3.2 * 3600000 ? 3 * 3600000 : 0;
    const result = Object.fromEntries(Object.keys(TYPES).map(type => [type, EMPTY()]));
    const seen = new Set(), wanted = text(route, 12).toLocaleLowerCase("ru");
    let receivedTime;
    for (const item of payload) {
      const type = item?.TransportType;
      if (!Object.hasOwn(TYPES, type) || !types.includes(type)) continue;
      const point = position(item.Location?.Longitude, item.Location?.Latitude);
      const id = text(item.VehicleId, 64), routeName = text(item.RouteShortName, 12);
      if (!point || !inside(point, bounds) || !id || !routeName || seen.has(`${type}:${id}`)) continue;
      const chosen = selected?.get(routeKey(type, routeName));
      if (selected !== null ? !chosen : wanted && routeName.toLocaleLowerCase("ru") !== wanted) continue;
      const rawTimestamp = typeof item.DateTime === "string" ? item.DateTime.slice(0, 40) : "";
      const observed = Date.parse(rawTimestamp), adjusted = observed - inferredOffset, age = referenceTime - adjusted;
      const validTime = Number.isFinite(observed) && age >= -60000;
      if (validTime && age > MAX_AGE_MS) continue;
      const confirmed = validTime && !inferredOffset;
      const timeStatus = confirmed ? `Позиция от ${clock(observed)}`
        : `Время позиции не подтверждено${rawTimestamp ? ` (источник: ${rawTimestamp.slice(11, 19)})` : ""}`;
      const direction = number(item.Direction);
      const heading = direction !== null && direction >= 0 && direction < 360 ? direction : null;
      receivedTime ??= clock(receivedAt);
      const statusText = `${timeStatus} · Получено ${receivedTime}${heading === null ? "" : ` · Курс ${Math.round(heading)}°`}`;
      const opacity = validTime && age > 60000 ? .4 : confirmed ? .95 : .65;
      result[type].features.push({ type: "Feature", id: `${type}:${id}`, properties: {
        kind: "vehicle", name: `${routeName} · ${TYPES[type].name}`, label: routeName, statusText,
        color: chosen?.color || TYPES[type].color, labelColor: chosen?.color || TYPES[type].labelColor, vehicleType: type,
        opacity, heading, rawTimestamp, observationTime: validTime ? new Date(adjusted).toISOString() : "", receivedAt, timeConfirmed: confirmed, route: routeName, vehicleId: id,
      }, geometry: { type: "Point", coordinates: point } });
      seen.add(`${type}:${id}`);
    }
    return result;
  }

  async function activateVehicles(ctx) {
    const routes = parseRoutes(ctx.settings.routes);
    const types = Object.keys(TYPES).filter(type => routes === null ? ctx.settings[type] === true : routes.some(route => route.type === type));
    const route = routes === null ? text(ctx.settings.route, 12) : "";
    if (routes === null && (typeof ctx.settings.route !== "string" || ctx.settings.route.trim().length > 12)) throw new Error("Номер маршрута не должен быть длиннее 12 символов");
    let generation = 0, request = null, timer = null, disposed = false;
    const render = data => {
      for (const type of Object.keys(TYPES)) ctx.setGeoJson(type, data[type], { color: TYPES[type].color, colorProperty: "color", opacity: 1, pointMinZoom: MIN_ZOOM, pointLabelMinZoom: MIN_ZOOM + 1, pointRadius: 7, pointMarker: "vehicle", pointTransitionMs: POLL_MS, pointHeading: "heading", pointType: "vehicleType", pointLabel: "label", pointLabelStyle: "vehicle", pointLabelColorProperty: "labelColor", pointOpacity: "opacity" });
    };
    const clear = () => render(Object.fromEntries(Object.keys(TYPES).map(type => [type, EMPTY()])));
    const invalidate = () => { generation++; clearTimeout(timer); timer = null; request?.abort(); request = null; };
    const fail = error => {
      if (disposed || ctx.signal.aborted || error?.name === "AbortError") return;
      ctx.reportError(error?.message || "Источник позиций транспорта недоступен");
    };
    async function refresh(view = ctx.getView()) {
      invalidate();
      if (disposed || ctx.signal.aborted) return;
      const current = generation, bounds = viewport(view), viewKey = key(view);
      if (hidden() || !bounds || !types.length) {
        clear();
        ctx.reportWarning(null);
        return;
      }
      const controller = new AbortController(); request = controller;
      const bbox = [bounds[1][0], bounds[1][1], bounds[0][0], bounds[0][1]].map(value => value.toFixed(5)).join(",");
      const isCurrent = () => !disposed && !ctx.signal.aborted && current === generation && !hidden();
      try {
        let response;
        try {
          response = await requestJson(`/api/visary/geometry/vehicle?${new URLSearchParams({ transport: types.join(","), bbox })}`, controller.signal);
        } catch (error) {
          if (!isCurrent() || controller.signal.aborted) return;
          if (key(ctx.getView()) !== viewKey) return;
          if (!(error instanceof RetryableFeedError)) throw error;
          clear();
          ctx.reportWarning(retryMessage);
          return;
        }
        if (!isCurrent()) return;
        if (key(ctx.getView()) !== viewKey) { await refresh(); return; }
        render(normalizeVehicles(response.data, { bounds, types, route, routes, receivedAt: response.receivedAt, referenceTime: response.referenceTime }));
        ctx.reportWarning(null);
      } finally {
        if (isCurrent()) {
          request = null; timer = setTimeout(() => { timer = null; refresh().catch(fail); }, POLL_MS);
        }
      }
    }
    const unsubscribe = ctx.onMove(view => refresh(view));
    const visibility = () => refresh().catch(fail);
    root.document?.addEventListener("visibilitychange", visibility);
    function cleanup() {
      if (disposed) return;
      disposed = true; invalidate(); unsubscribe?.();
      root.document?.removeEventListener("visibilitychange", visibility);
      ctx.signal.removeEventListener("abort", cleanup);
    }
    ctx.signal.addEventListener("abort", cleanup, { once: true });
    clear();
    await refresh();
    return cleanup;
  }

  function register(host) {
    host.register({ id: "spb-live", apiVersion: 1, version: "1.3.0", title: "Транспорт сейчас", description: "Позиции автобусов, трамваев и троллейбусов Петербурга. Обновление каждые 16 секунд в видимой области от масштаба 12.", capabilities: ["geojson"], defaults: { bus: true, tram: true, trolley: true, route: "", routes: "" } }, activateVehicles);
  }
  const controls = Object.freeze({
    "spb-live": Object.freeze([
      { key: "bus", label: "Автобусы", type: "checkbox" }, { key: "tram", label: "Трамваи", type: "checkbox" }, { key: "trolley", label: "Троллейбусы", type: "checkbox" },
      { key: "route", label: "Номер маршрута", type: "text", maxLength: 12 },
    ]),
  });
  root.SloiLiveTransport = Object.freeze({ register, controls, normalizeVehicles, normalizeRoutes, parseRoutes, types: TYPES, maxPresetRoutes: MAX_PRESET_ROUTES, viewport, pollInterval: POLL_MS });
})(typeof window !== "undefined" ? window : globalThis);
