(function (root) {
  "use strict";

  // The small, attributed snapshot is part of the APK. Opening a line must not
  // depend on a municipal server, location permission or a full city download.
  const DATA_URL = "modules/metro-spb.json", MAX_BYTES = 256 * 1024;
  const lines = Object.freeze([
    { id: "1", name: "Кировско-Выборгская", color: "#d9534f" },
    { id: "2", name: "Московско-Петроградская", color: "#223af0" },
    { id: "3", name: "Невско-Василеостровская", color: "#5cb85c" },
    { id: "4", name: "Лахтинско-Правобережная", color: "#f0ad4e" },
    { id: "5", name: "Фрунзенско-Приморская", color: "#6f5499" },
    { id: "6", name: "Красносельско-Калининская", color: "#8b5a35" },
  ].map(Object.freeze));
  const EMPTY = () => ({ type: "FeatureCollection", features: [] });
  const cancelled = () => Object.assign(new Error("Загрузка отменена"), { name: "AbortError" });
  const incompatible = () => new Error("Данные метро повреждены. Обновите приложение.");
  let cached = null, pending = null;

  function freeze(value) {
    if (value && typeof value === "object" && !Object.isFrozen(value)) {
      for (const item of Object.values(value)) freeze(item);
      Object.freeze(value);
    }
    return value;
  }
  function point(value) {
    return Array.isArray(value) && value.length === 2 && value.every(Number.isFinite)
      && value[0] >= 29.3 && value[0] <= 31.4 && value[1] >= 59.45 && value[1] <= 60.45;
  }
  const validText = (value, length = 120) => typeof value === "string" && value.length > 0 && value.length <= length && !/[\x00-\x1f]/.test(value);
  function validate(data) {
    if (!data || data.version !== 1 || data.license !== "ODbL-1.0" || !validText(data.sourceUpdatedAt, 40)
      || !Array.isArray(data.lines) || data.lines.length !== 6 || !Array.isArray(data.entrances) || data.entrances.length > 600) throw incompatible();
    let coordinateCount = 0;
    const ids = new Set();
    for (const expected of lines) {
      const line = data.lines.find(item => item?.id === expected.id);
      if (!line || line.name !== expected.name || line.color !== expected.color || !Array.isArray(line.stations)
        || line.stations.length < 2 || line.stations.length > 32 || !Array.isArray(line.bounds) || line.bounds.length !== 2
        || !line.bounds.every(point) || line.bounds[0][0] > line.bounds[1][0] || line.bounds[0][1] > line.bounds[1][1]) throw incompatible();
      for (const station of line.stations) {
        if (!station || !validText(station.id, 64) || ids.has(station.id) || !validText(station.name) || !point(station.coordinates)
          || typeof station.closed !== "boolean" || typeof station.note !== "string" || station.note.length > 160) throw incompatible();
        ids.add(station.id);
      }
      const geometry = line.geometry;
      if (!geometry || geometry.type !== "MultiLineString" || !Array.isArray(geometry.coordinates) || !geometry.coordinates.length || geometry.coordinates.length > 400) throw incompatible();
      for (const part of geometry.coordinates) {
        if (!Array.isArray(part) || part.length < 2 || part.length > 4000 || !part.every(point)) throw incompatible();
        coordinateCount += part.length;
      }
    }
    if (coordinateCount > 10000) throw incompatible();
    const entranceIds = new Set();
    for (const entrance of data.entrances) {
      if (!entrance || !validText(entrance.id, 64) || entranceIds.has(entrance.id) || !validText(entrance.name)
        || !point(entrance.coordinates) || !lines.some(line => line.id === entrance.line) || !ids.has(entrance.stationId)) throw incompatible();
      entranceIds.add(entrance.id);
    }
    const catalog = {
      sourceUpdatedAt: data.sourceUpdatedAt,
      checkedAt: data.checkedAt,
      attribution: "© OpenStreetMap contributors", license: "ODbL-1.0", licenseUrl: "https://www.openstreetmap.org/copyright",
      lines: data.lines.map(({ id, name, color, stations, bounds }) => ({ id, name, color, stations, bounds })),
    };
    return freeze({ data, catalog });
  }

  async function readSnapshot(signal) {
    const timer = setTimeout(() => { signal.timedOut = true; signal.controller.abort(); }, 8000);
    try {
      const response = await root.fetch(DATA_URL, { signal: signal.controller.signal, credentials: "omit", redirect: "error" });
      if (!response.ok) throw incompatible();
      const length = Number(response.headers.get("content-length"));
      if (length > MAX_BYTES) { await response.body?.cancel().catch(() => {}); throw incompatible(); }
      if (!response.body?.getReader) throw incompatible();
      const reader = response.body.getReader(), decoder = new TextDecoder("utf-8", { fatal: true });
      let bytes = 0, body = "";
      try {
        while (true) {
          if (signal.controller.signal.aborted) throw cancelled();
          const part = await reader.read();
          if (part.done) break;
          bytes += part.value.byteLength;
          if (bytes > MAX_BYTES) throw incompatible();
          body += decoder.decode(part.value, { stream: true });
        }
        body += decoder.decode();
      } catch (error) { await reader.cancel().catch(() => {}); throw error; }
      finally { reader.releaseLock(); }
      if (signal.controller.signal.aborted) throw cancelled();
      let data;
      try { data = JSON.parse(body); } catch (_) { throw incompatible(); }
      return validate(data);
    } catch (error) {
      if (signal.timedOut) throw new Error("Не удалось открыть данные метро вовремя. Повторите попытку.");
      if (signal.controller.signal.aborted) throw cancelled();
      if (error?.message === incompatible().message) throw error;
      throw new Error("Не удалось открыть данные метро. Повторите попытку.");
    } finally { clearTimeout(timer); }
  }
  function load(signal) {
    if (signal?.aborted) return Promise.reject(cancelled());
    if (cached) return Promise.resolve(cached);
    if (!pending) {
      const request = { controller: new AbortController(), clients: new Set(), settled: false, promise: null };
      pending = request;
      request.promise = readSnapshot(request).then(result => {
        if (request.controller.signal.aborted) throw cancelled();
        cached = result; return result;
      }).finally(() => { request.settled = true; if (pending === request) pending = null; });
    }
    const request = pending;
    return new Promise((resolve, reject) => {
      const token = {}, finish = (callback, value) => {
        if (!request.clients.delete(token)) return;
        signal?.removeEventListener("abort", abort);
        if (!request.settled && !request.clients.size) {
          if (pending === request) pending = null;
          request.controller.abort();
        }
        callback(value);
      };
      const abort = () => finish(reject, cancelled());
      request.clients.add(token);
      signal?.addEventListener("abort", abort, { once: true });
      request.promise.then(result => finish(resolve, result), error => finish(reject, error));
      if (signal?.aborted) abort();
    });
  }
  async function catalog({ signal } = {}) { return (await load(signal)).catalog; }

  function selectedLine(value) {
    if (typeof value !== "string" || value !== "" && !lines.some(line => line.id === value)) throw new Error("Выберите линию метро");
    return value;
  }
  async function activate(ctx) {
    const selected = selectedLine(ctx.settings.selectedLine);
    if (typeof ctx.settings.entrances !== "boolean") throw new Error("Некорректные настройки входов метро");
    const { data } = await load(ctx.signal);
    if (ctx.signal.aborted) throw cancelled();
    const result = { lines: EMPTY(), stations: EMPTY(), entrances: EMPTY() };
    for (const line of data.lines) {
      if (selected && line.id !== selected) continue;
      const common = { line: line.id, color: line.color, lineName: line.name };
      result.lines.features.push({ type: "Feature", id: `line-${line.id}`, properties: {
        ...common, kind: "metro_line", name: `${line.id} · ${line.name}`, statusText: `${line.stations.length} станций · ${line.stations[0].name} — ${line.stations.at(-1).name}`,
      }, geometry: line.geometry });
      for (const station of line.stations) result.stations.features.push({ type: "Feature", id: station.id, properties: {
        ...common, kind: "metro_station", name: station.name, label: station.name, closed: station.closed, opacity: station.closed ? .5 : 1,
        statusText: `Линия ${line.id} · ${line.name}${station.note ? ` · ${station.note}` : ""}`,
      }, geometry: { type: "Point", coordinates: station.coordinates } });
    }
    if (ctx.settings.entrances) for (const entrance of data.entrances) {
      if (selected && entrance.line !== selected) continue;
      const line = lines.find(item => item.id === entrance.line);
      result.entrances.features.push({ type: "Feature", id: entrance.id, properties: {
        kind: "metro_entrance", line: line.id, lineName: line.name, color: line.color, name: entrance.name,
        statusText: `Вход метро · Линия ${line.id} · ${line.name}`,
      }, geometry: { type: "Point", coordinates: entrance.coordinates } });
    }
    ctx.setGeoJson("lines", result.lines, { color: "#6f5499", colorProperty: "color", opacity: .9 });
    ctx.setGeoJson("stations", result.stations, { color: "#6f5499", colorProperty: "color", opacity: 1, pointOpacity: "opacity", pointMinZoom: 10, pointLabelMinZoom: 12, pointRadius: 4, pointLabel: "label", pointLabelStyle: "text" });
    ctx.setGeoJson("entrances", result.entrances, { color: "#6f5499", colorProperty: "color", opacity: .8, pointMinZoom: 15, pointRadius: 3 });
  }
  function register(host) {
    host.register({ id: "spb-metro", apiVersion: 1, version: "1.1.0", title: "Метро Петербурга", description: "Шесть линий, станции и входы. Схема доступна без сети.", capabilities: ["geojson"], defaults: { entrances: true, selectedLine: "" } }, activate);
    return host;
  }
  const controls = Object.freeze({ "spb-metro": Object.freeze([{ key: "entrances", label: "Показывать входы", type: "checkbox" }]) });
  root.SloiMetro = Object.freeze({ register, controls, lines, catalog });
})(typeof window !== "undefined" ? window : globalThis);
