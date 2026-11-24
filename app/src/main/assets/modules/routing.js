(function (root) {
  "use strict";

  const providers = new Map();
  const MAX_BYTES = 4 * 1024 * 1024;
  const MAX_POINTS = 80000;
  const MAX_ALTERNATIVES = 5;
  const TRANSPORT_TYPES = Object.freeze(["bus", "tram", "trolley", "subway"]);
  const canonicalTransport = value => ({ trolleybus: "trolley", metro: "subway" }[value] || value);
  function transportTypes(value) {
    if (value == null) return [...TRANSPORT_TYPES];
    if (!Array.isArray(value) || value.some(type => !TRANSPORT_TYPES.includes(type))) throw new Error("Выберите доступный вид транспорта");
    const selected = TRANSPORT_TYPES.filter(type => value.includes(type));
    if (!selected.length) throw new Error("Выберите хотя бы один вид транспорта");
    return selected;
  }
  let nextRoadRequest = 0;
  const aborted = () => Object.assign(new Error("Построение отменено"), { name: "AbortError" });
  const check = signal => { if (signal?.aborted) throw aborted(); };
  const number = value => typeof value === "number" && Number.isFinite(value) && value >= 0;
  const coordinate = value => Array.isArray(value) && value.length === 2
    && value.every(n => typeof n === "number" && Number.isFinite(n))
    && Math.abs(value[0]) <= 180 && Math.abs(value[1]) <= 85;

  function line(points) {
    if (!Array.isArray(points) || points.length < 2 || points.length > MAX_POINTS || !points.every(coordinate)) {
      throw new Error("Сервис вернул некорректную геометрию маршрута");
    }
    return { type: "LineString", coordinates: points.map(p => [...p]) };
  }

  function registerProvider(provider) {
    if (!provider || typeof provider.id !== "string" || !Array.isArray(provider.modes)
      || !provider.modes.length || provider.modes.some(mode => !["walk", "bicycle", "transit"].includes(mode))
      || (provider.preferences != null && (!Array.isArray(provider.preferences) || provider.preferences.some(value => !["directOnly", "transportTypes"].includes(value))))
      || typeof provider.plan !== "function" || providers.has(provider.id)) throw new Error("Некорректный источник маршрутов");
    providers.set(provider.id, Object.freeze({ ...provider, modes: Object.freeze([...provider.modes]), preferences: Object.freeze([...(provider.preferences || [])]) }));
  }

  async function readJson(url, signal) {
    check(signal);
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, 20000);
    try {
      const response = await root.fetch(url, { signal: controller.signal, credentials: "omit", redirect: "error", headers: { Accept: "application/json" } });
      if (!response.ok) throw new Error(response.status === 429 ? "Сервис маршрутов занят. Повторите чуть позже." : `Маршруты недоступны: HTTP ${response.status}`);
      if (Number(response.headers.get("content-length")) > MAX_BYTES) {
        await response.body?.cancel().catch(() => {});
        throw new Error("Маршрут слишком большой");
      }
      const reader = response.body?.getReader();
      if (!reader) throw new Error("Сервис маршрутов не передал данные");
      const decoder = new TextDecoder(); let bytes = 0, text = "";
      try {
        while (true) {
          check(signal);
          const chunk = await reader.read();
          if (chunk.done) break;
          bytes += chunk.value.byteLength;
          if (bytes > MAX_BYTES) throw new Error("Маршрут слишком большой");
          text += decoder.decode(chunk.value, { stream: true });
        }
        text += decoder.decode();
      } catch (error) { await reader.cancel().catch(() => {}); throw error; }
      finally { reader.releaseLock(); }
      check(signal);
      return JSON.parse(text);
    } catch (error) {
      if (signal?.aborted) throw aborted();
      if (timedOut) throw new Error("Сервис маршрутов не ответил. Повторите попытку.");
      if (error instanceof SyntaxError) throw new Error("Сервис вернул повреждённый маршрут");
      if (error?.name === "TypeError" || error?.name === "NetworkError") throw new Error("Сервис маршрутов недоступен. Проверьте соединение и повторите попытку.");
      throw error;
    } finally { clearTimeout(timer); signal?.removeEventListener("abort", abort); }
  }

  function wait(ms, signal) {
    check(signal);
    if (ms <= 0) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const abort = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); reject(aborted()); };
      const timer = setTimeout(() => { signal?.removeEventListener("abort", abort); resolve(); }, ms);
      signal?.addEventListener("abort", abort, { once: true });
    });
  }

  async function roadPlan({ from, to, mode, signal }) {
    // The public FOSSGIS service allows at most one request per second.
    const previousSlot = nextRoadRequest;
    const start = Math.max(Date.now(), nextRoadRequest);
    nextRoadRequest = start + 1050;
    try { await wait(start - Date.now(), signal); }
    catch (error) {
      // Cancelling a pending mode change must not consume a request slot.
      if (nextRoadRequest === start + 1050) nextRoadRequest = previousSlot;
      throw error;
    }
    check(signal);
    const profile = mode === "walk" ? "foot" : "bike";
    const url = new URL(`https://routing.openstreetmap.de/routed-${profile}/route/v1/${profile}/${from.join(",")};${to.join(",")}`);
    url.search = new URLSearchParams({ overview: "full", geometries: "geojson", steps: "true", alternatives: "true" }).toString();
    const payload = await readJson(url.href, signal);
    if (payload?.code === "NoRoute" || payload?.code === "NoSegment") throw new Error("Между этими точками маршрут не найден");
    if (payload?.code !== "Ok" || !Array.isArray(payload.routes)) throw new Error("Сервис не смог построить маршрут");
    return payload.routes.slice(0, MAX_ALTERNATIVES).map(route => {
      if (!number(route.distance) || !number(route.duration) || route.geometry?.type !== "LineString") throw new Error("Сервис вернул некорректный маршрут");
      const geometry = line(route.geometry.coordinates);
      return { provider: "osrm", mode, distance: route.distance, duration: route.duration, geometry,
        legs: [{ mode, distance: route.distance, duration: route.duration, geometry, label: mode === "walk" ? "Пешком" : "На велосипеде", stops: [] }],
        attribution: [{ title: "© OpenStreetMap", url: "https://www.openstreetmap.org/copyright" },
          { title: "OSRM / FOSSGIS", url: "https://routing.openstreetmap.de/about.html" },
          { title: "Исправить карту", url: `https://www.openstreetmap.org/fixthemap?lat=${from[1]}&lon=${from[0]}` }],
      };
    });
  }

  const transitNames = { subwaytransfer: "Переход в метро", walk: "Пешком", pathwaytransfer: "Переход", transfer: "Пересадка", bus: "Автобус", tram: "Трамвай", trolley: "Троллейбус", trolleybus: "Троллейбус", subway: "Метро" };
  function transitTime(value) {
    if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:?\d\d)?$/.test(value)) return null;
    // The city wrapper returns its local Petersburg timestamps without an
    // offset. Interpret those in the same zone as its requested startTime,
    // independently of the phone's own timezone.
    const timestamp = Date.parse(/(?:Z|[+-]\d\d:?\d\d)$/.test(value) ? value : `${value}+03:00`);
    return Number.isFinite(timestamp) ? timestamp : null;
  }
  function normalizeTransit(payload, { directOnly = false, transportTypes: requestedTypes } = {}) {
    const allowedTypes = transportTypes(requestedTypes);
    const allTypes = allowedTypes.length === TRANSPORT_TYPES.length;
    if (payload?.success !== true || !Array.isArray(payload.result) || !payload.result.length) throw new Error("На это время поездка общественным транспортом не найдена");
    // Filter before the display cap: a valid direct alternative can follow
    // faster journeys with transfers. The response byte limit bounds this work.
    const routes = payload.result.map(route => {
      if (!number(route.sumTime) || !number(route.sumDistance) || !Array.isArray(route.stages) || !route.stages.length) throw new Error("Сервис вернул некорректную поездку");
      let points = 0;
      const legs = route.stages.map(stage => {
        if (!number(stage.time) || !number(stage.distance) || !Array.isArray(stage.path)) throw new Error("Сервис вернул некорректный участок поездки");
        const coordinates = stage.path.map(point => [point?.longitude, point?.latitude]);
        points += coordinates.length;
        if (points > MAX_POINTS) throw new Error("Маршрут слишком большой");
        const geometry = line(coordinates);
        const stops = (Array.isArray(stage.stops) ? stage.stops : []).slice(0, 500).map(stop => ({
          name: String(stop.stopName || "Остановка").slice(0, 200), coordinates: [stop.stopLongitude, stop.stopLatitude],
        })).filter(stop => coordinate(stop.coordinates));
        const mode = ["walk", "pathwaytransfer", "transfer", "subwaytransfer"].includes(stage.type) ? "walk" : "transit";
        const routeNumber = stage.routeNumber == null ? "" : String(stage.routeNumber).slice(0, 40);
        return { mode, type: canonicalTransport(String(stage.type || "transit")), routeNumber, distance: stage.distance, duration: stage.time,
          geometry, stops, label: `${transitNames[canonicalTransport(stage.type)] || "Транспорт"}${routeNumber ? ` ${routeNumber}` : ""}` };
      });
      const vehicleLegs = legs.filter(leg => leg.mode === "transit").length;
      const reportedTransfers = Number.isInteger(route.numTransfers) && route.numTransfers >= 0 ? route.numTransfers : 0;
      const transfers = Math.max(Math.max(0, vehicleLegs - 1), reportedTransfers);
      // This API has no documented interlining/stay-on-vehicle marker. Separate
      // vehicle stages therefore count as separate boardings, even with equal
      // route numbers; claiming a direct journey would otherwise be unsafe.
      const departureTime = transitTime(route.startTime), endTime = transitTime(route.endTime);
      const arrivalTime = departureTime !== null && endTime !== null && endTime >= departureTime ? endTime : null;
      return { provider: "spb-transit", mode: "transit", distance: route.sumDistance, duration: route.sumTime,
        geometry: { type: "MultiLineString", coordinates: legs.map(leg => leg.geometry.coordinates) }, legs,
        transfers, departureTime, arrivalTime,
        attribution: [{ title: "Транспорт Санкт-Петербурга", url: "https://transport.orgp.spb.ru/" }],
      };
    });
    // Restrict the complete journey, never drop a disallowed vehicle leg from
    // its geometry. Keep unfamiliar future types only with the default all-types
    // choice; a restricted request must not silently include another vehicle.
    const matching = routes.filter(route => (!directOnly || route.transfers === 0)
      && (allTypes || route.legs.every(leg => leg.mode === "walk" || allowedTypes.includes(leg.type))));
    if (!matching.length && !allTypes) throw new Error(`Среди вариантов сервиса нет поездки с выбранными видами транспорта${directOnly ? " без пересадок" : ""}`);
    if (!matching.length && directOnly) throw new Error("Среди вариантов сервиса нет маршрута без пересадок");
    return matching.slice(0, MAX_ALTERNATIVES);
  }

  function petersburgTime(date = new Date()) {
    const parts = new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Moscow", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).formatToParts(date);
    const field = type => parts.find(part => part.type === type).value;
    return `${field("year")}-${field("month")}-${field("day")}T${field("hour")}:${field("minute")}:${field("second")}+03:00`;
  }

  async function transitPlan({ from, to, signal, preferences }) {
    const url = new URL("https://transport.orgp.spb.ru/transit-api-otp/routes");
    url.search = new URLSearchParams({ fromLat: from[1], fromLon: from[0], toLat: to[1], toLon: to[0],
      transports: transportTypes(preferences?.transportTypes).join(","), startTime: petersburgTime() }).toString();
    // The city wrapper exposes transports/time, not OTP's generic maxTransfers.
    // Enforce the selected constraint against all returned journeys instead of
    // sending an unsupported query argument that the wrapper could ignore.
    return normalizeTransit(await readJson(url.href, signal), preferences);
  }

  async function plan(request) {
    if (!request || !coordinate(request.from) || !coordinate(request.to)) throw new Error("Выберите начало и конец маршрута");
    check(request.signal);
    const provider = [...providers.values()].find(item => item.modes.includes(request.mode));
    if (!provider) throw new Error("Этот способ передвижения недоступен");
    const preferences = { directOnly: request.mode === "transit" && request.preferences?.directOnly === true };
    if (request.mode === "transit") preferences.transportTypes = transportTypes(request.preferences?.transportTypes);
    if (preferences.directOnly && !provider.preferences?.includes("directOnly")) throw new Error("Источник маршрутов не поддерживает поездки без пересадок");
    if (request.mode === "transit" && preferences.transportTypes.length !== TRANSPORT_TYPES.length && !provider.preferences?.includes("transportTypes")) throw new Error("Источник маршрутов не поддерживает выбор вида транспорта");
    const result = await provider.plan({ ...request, preferences, from: [...request.from], to: [...request.to] });
    check(request.signal);
    if (!Array.isArray(result) || !result.length) throw new Error("Маршрут не найден");
    return result;
  }

  registerProvider({ id: "osrm", modes: ["walk", "bicycle"], plan: roadPlan });
  registerProvider({ id: "spb-transit", modes: ["transit"], preferences: ["directOnly", "transportTypes"], plan: transitPlan });
  root.SloiRouting = Object.freeze({ plan, registerProvider, listProviders: () => [...providers.values()].map(({ id, modes }) => ({ id, modes: [...modes] })), normalizeTransit, petersburgTime });
})(typeof window !== "undefined" ? window : globalThis);
