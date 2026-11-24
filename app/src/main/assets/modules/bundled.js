(function (root) {
  "use strict";

  const ORIGIN = "https://transport.orgp.spb.ru";
  const MAX_BYTES = 2 * 1024 * 1024;
  const cache = new Map();
  const cacheTtl = 5 * 60 * 1000;
  const networkMessage = "Источник транспорта недоступен. Проверьте сеть и доверие к сертификату портала.";

  function aborted(signal) {
    if (signal.aborted) { const error = new Error("Загрузка отменена"); error.name = "AbortError"; throw error; }
  }

  async function requestJson(path, body, signal) {
    aborted(signal);
    const url = new URL(path, ORIGIN);
    if (url.protocol !== "https:" || url.origin !== ORIGIN) throw new Error("Недопустимый источник транспорта");
    const key = url.href + "|" + (body || "");
    const existing = cache.get(key);
    if (existing && Date.now() - existing.time < cacheTtl) {
      cache.delete(key); cache.set(key, existing);
      return existing.value;
    }
    cache.delete(key);
    const controller = new AbortController();
    const cancel = () => controller.abort();
    signal.addEventListener("abort", cancel, { once: true });
    const timer = setTimeout(cancel, 16000);
    try {
      let response;
      try {
        response = await root.fetch(url.href, {
          method: body === null ? "GET" : "POST",
          headers: body === null ? { Accept: "application/json" } : { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
          ...(body === null ? {} : { body }),
          credentials: "omit", redirect: "error", signal: controller.signal,
        });
      } catch (error) { aborted(signal); throw new Error(networkMessage); }
      if (!response.ok) throw new Error(`${networkMessage} HTTP ${response.status}.`);
      const declared = Number(response.headers.get("content-length"));
      if (declared > MAX_BYTES) {
        if (response.body) await response.body.cancel().catch(() => {});
        throw new Error("Ответ транспорта превышает лимит 2 МиБ");
      }
      if (!response.body || typeof response.body.getReader !== "function") throw new Error("Потоковая загрузка транспорта недоступна");
      const reader = response.body.getReader();
      const decoder = new TextDecoder("utf-8", { fatal: true });
      let length = 0, text = "";
      try {
        while (true) {
          aborted(signal);
          const part = await reader.read();
          if (part.done) break;
          length += part.value.byteLength;
          if (length > MAX_BYTES) throw new Error("Ответ транспорта превышает лимит 2 МиБ");
          text += decoder.decode(part.value, { stream: true });
        }
        text += decoder.decode();
      } catch (error) {
        await reader.cancel().catch(() => {});
        aborted(signal);
        if (controller.signal.aborted) throw new Error(networkMessage);
        throw error;
      } finally { reader.releaseLock(); }
      aborted(signal);
      let value;
      try { value = JSON.parse(text); } catch (_) { throw new Error("Источник транспорта вернул повреждённый JSON"); }
      cache.set(key, { time: Date.now(), value });
      while (cache.size > 4) cache.delete(cache.keys().next().value);
      return value;
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", cancel);
    }
  }

  function numeric(value) {
    if (typeof value !== "number" && !(typeof value === "string" && value.trim())) return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  function lonLat(longitude, latitude) {
    const lon = numeric(longitude), lat = numeric(latitude);
    return lon !== null && lat !== null && Math.abs(lon) <= 180 && Math.abs(lat) <= 85 ? [lon, lat] : null;
  }

  function shapeCoordinates(shape) {
    if (typeof shape !== "string" || !shape.trim()) return null;
    const points = shape.split(",").map((pair) => {
      const values = pair.trim().split(/\s+/);
      return values.length === 2 ? lonLat(values[0], values[1]) : null;
    });
    return points.length >= 2 && points.every(Boolean) ? points : null;
  }

  function parseRoute(payload, direction, routeName, includeStops) {
    if (!payload || !Array.isArray(payload.Directions)) throw new Error("Источник транспорта вернул несовместимый маршрут");
    const directions = payload.Directions.filter((item) => item && numeric(item.Direction) === direction);
    if (directions.length !== 1 || !Array.isArray(directions[0].Items)) throw new Error("Выбранное направление маршрута недоступно");
    const items = directions[0].Items.filter((item) => item && numeric(item.Order) !== null)
      .slice().sort((a, b) => numeric(a.Order) - numeric(b.Order));
    const features = [], stops = new Map();
    for (const item of items) {
      const coordinates = shapeCoordinates(item.Shape);
      if (coordinates) features.push({ type: "Feature", properties: { name: `Автобус ${routeName}`, route: routeName, kind: "route", order: numeric(item.Order) }, geometry: { type: "LineString", coordinates } });
      if (!includeStops) continue;
      for (const prefix of ["StartStop", "FinishStop"]) {
        const position = lonLat(item[`${prefix}Longitude`], item[`${prefix}Latitude`]);
        if (!position) continue;
        const stopId = item[`${prefix}Id`];
        const key = typeof stopId === "string" || typeof stopId === "number" ? String(stopId) : position.join(",");
        if (stops.has(key)) continue;
        stops.set(key, { type: "Feature", properties: { name: String(item[`${prefix}Name`] || "Остановка"), kind: "stop", route: routeName, stopId: key }, geometry: { type: "Point", coordinates: position } });
      }
    }
    if (!features.length) throw new Error("Для выбранного направления нет геометрии маршрута");
    return { type: "FeatureCollection", features: features.concat([...stops.values()]) };
  }

  function routeQuery(query) {
    const match = /^\s*(?:(?:автобус|bus)\s*№?\s*|№\s*)?(\d{1,4}[a-zа-я]?)\s*$/iu.exec(String(query || ""));
    return match ? match[1] : null;
  }

  async function searchRoutes(query, { signal } = {}) {
    const route = routeQuery(query);
    if (!route) return [];
    signal = signal || new AbortController().signal;
    aborted(signal);
    const body = new URLSearchParams({ skip: "0", take: "50", transportTypes: "bus", routeShortName: route, desc: "false" }).toString();
    const response = await requestJson("/api/visary/operator/route", body, signal);
    aborted(signal);
    const routes = Array.isArray(response) ? response : response?.Items;
    if (!Array.isArray(routes)) throw new Error("Источник транспорта вернул несовместимый список маршрутов");
    const seen = new Set();
    return routes.filter((item) => {
      const name = item && String(item.ShortName || "").trim();
      if (!name || !name.toLocaleLowerCase("ru").startsWith(route.toLocaleLowerCase("ru")) || seen.has(name)) return false;
      seen.add(name); return true;
    }).slice(0, 6).map((item) => ({
      id: `spb-bus:${String(item.Id)}`, moduleId: "spb-bus", title: `Автобус ${String(item.ShortName).trim()}`,
      subtitle: String(item.Name || item.LongName || "Санкт-Петербург"),
      settings: { route: String(item.ShortName).trim(), direction: 1 },
    }));
  }

  function register(host) {
    host.register({ id: "spb-bus", apiVersion: 1, version: "1.0.0", title: "Автобусы Петербурга", description: "Маршрут и остановки по данным городского портала транспорта.", capabilities: ["geojson"], defaults: { route: "3", direction: 1, stops: true, color: "#7054aa" } }, async (ctx) => {
      const route = ctx.settings.route.trim();
      if (!route || route.length > 12 || ![1, 2].includes(ctx.settings.direction)) throw new Error("Укажите номер маршрута и направление");
      const body = new URLSearchParams({ skip: "0", take: "50", transportTypes: "bus", routeShortName: route, desc: "false" }).toString();
      const response = await requestJson("/api/visary/operator/route", body, ctx.signal);
      const routes = Array.isArray(response) ? response : response && response.Items;
      if (!Array.isArray(routes)) throw new Error("Источник транспорта вернул несовместимый список маршрутов");
      const matches = routes.filter((item) => item && String(item.ShortName).trim().toLocaleLowerCase("ru") === route.toLocaleLowerCase("ru"));
      if (!matches.length) throw new Error(`Автобус ${route} не найден`);
      if (matches.length !== 1) throw new Error(`Номер ${route} неоднозначен в источнике транспорта`);
      const id = matches[0].Id;
      if (!(typeof id === "string" && id.trim()) && !(typeof id === "number" && Number.isFinite(id))) throw new Error("Источник транспорта не указал идентификатор маршрута");
      const payload = await requestJson(`/api/visary/stop/byRoute?routeId=${encodeURIComponent(id)}`, null, ctx.signal);
      aborted(ctx.signal);
      const geometry = parseRoute(payload, ctx.settings.direction, route, ctx.settings.stops);
      ctx.setGeoJson("route", geometry, { color: ctx.settings.color, opacity: 0.9, pointMinZoom: 15 });
    });
    return host;
  }

  const controls = Object.freeze({
    "spb-bus": Object.freeze([{ key: "route", label: "Номер автобуса", type: "text", maxLength: 12 }, { key: "direction", label: "Направление", type: "select", options: [{ value: 1, label: "Туда" }, { value: 2, label: "Обратно" }] }, { key: "stops", label: "Показывать остановки", type: "checkbox" }]),
  });
  const searchProviders = Object.freeze([Object.freeze({ moduleId: "spb-bus", search: searchRoutes })]);
  root.SloiBundledModules = Object.freeze({ register, controls, parseRoute, searchProviders });
})(typeof window !== "undefined" ? window : globalThis);
