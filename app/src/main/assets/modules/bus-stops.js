(function (root) {
  "use strict";
  const MIN_ZOOM = 15, MAX_BYTES = 512 * 1024, EMPTY = () => ({ type: "FeatureCollection", features: [] });
  let cached = null;
  const aborted = () => Object.assign(new Error("Загрузка отменена"), { name: "AbortError" });
  function validate(data) {
    if (data?.version !== 1 || data.license !== "ODbL-1.0" || !Array.isArray(data.stops) || data.stops.length > 8000) throw new Error("Данные остановок повреждены");
    const seen = new Set();
    for (const row of data.stops) {
      if (!Array.isArray(row) || row.length !== 4 || typeof row[0] !== "string" || !/^\d{1,20}$/.test(row[0]) || seen.has(row[0])
        || typeof row[1] !== "string" || !row[1].trim() || row[1].length > 240 || /[\x00-\x1f]/.test(row[1])
        || !Number.isFinite(row[2]) || !Number.isFinite(row[3]) || row[2] < 29 || row[2] > 32 || row[3] < 59 || row[3] > 61) throw new Error("Данные остановок повреждены");
      seen.add(row[0]);
    }
    return data.stops;
  }
  async function load(signal) {
    if (signal.aborted) throw aborted();
    if (cached) return cached;
    const response = await root.fetch("modules/bus-stops-spb.json", { signal, credentials: "omit", redirect: "error" });
    if (!response.ok) throw new Error("Не удалось открыть остановки");
    if (Number(response.headers.get("content-length")) > MAX_BYTES) { await response.body?.cancel().catch(() => {}); throw new Error("Данные остановок слишком большие"); }
    const reader = response.body?.getReader();
    if (!reader) throw new Error("Чтение остановок недоступно");
    const decoder = new TextDecoder("utf-8", { fatal: true }); let bytes = 0, text = "";
    try {
      while (true) {
        if (signal.aborted) throw aborted();
        const part = await reader.read(); if (part.done) break;
        bytes += part.value.byteLength;
        if (bytes > MAX_BYTES) throw new Error("Данные остановок слишком большие");
        text += decoder.decode(part.value, { stream: true });
      }
      text += decoder.decode();
      if (signal.aborted) throw aborted();
      cached = validate(JSON.parse(text)); return cached;
    } catch (error) { await reader.cancel().catch(() => {}); throw error; }
    finally { reader.releaseLock(); }
  }
  function forView(stops, view) {
    const bounds = view?.bounds;
    if (!Number.isFinite(view?.zoom) || view.zoom < MIN_ZOOM || !Array.isArray(bounds) || bounds.length !== 2 || !bounds.flat().every(Number.isFinite)) return EMPTY();
    const [[west, south], [east, north]] = bounds;
    const visible = stops.filter(row => row[2] >= west && row[2] <= east && row[3] >= south && row[3] <= north).slice(0, 512);
    return { type: "FeatureCollection", features: visible.map(([id, name, lon, lat]) => ({ type: "Feature", id: `osm-${id}`,
      properties: { kind: "bus_stop", name, label: name, statusText: "Автобусная остановка" }, geometry: { type: "Point", coordinates: [lon, lat] } })) };
  }
  async function activate(ctx) {
    let generation = 0, request = null, disposed = false, renderedIds = null;
    const render = data => {
      // Coordinates and names are immutable in this bundled snapshot. The same
      // ordered IDs need no worker upload, label rasterization or paint writes.
      const ids = data.features.map(feature => feature.id).join("|");
      if (ids === renderedIds) return;
      ctx.setGeoJson("stops", data, { color: "#547c9f", opacity: .9, pointMinZoom: 15, pointLabelMinZoom: 16, pointRadius: 4, pointLabel: "label", pointLabelStyle: "text" });
      renderedIds = ids;
    };
    async function update(view = ctx.getView()) {
      const current = ++generation; request?.abort(); request = null;
      if (disposed || ctx.signal.aborted) return;
      if (view.zoom < MIN_ZOOM) { render(EMPTY()); return; }
      const controller = new AbortController(); request = controller;
      try {
        const stops = await load(controller.signal);
        if (!disposed && !ctx.signal.aborted && current === generation) render(forView(stops, view));
      } catch (error) {
        if (disposed || controller.signal.aborted || ctx.signal.aborted || current !== generation) return;
        throw error;
      } finally { if (request === controller) request = null; }
    }
    const unsubscribe = ctx.onMove(view => update(view));
    function cleanup() { if (disposed) return; disposed = true; generation++; request?.abort(); unsubscribe?.(); ctx.signal.removeEventListener("abort", cleanup); }
    ctx.signal.addEventListener("abort", cleanup, { once: true });
    render(EMPTY()); await update(); return cleanup;
  }
  function register(host) {
    host.register({ id: "spb-stops", apiVersion: 1, version: "1.0.0", title: "Остановки Петербурга", description: "Автобусные остановки на ближнем масштабе. Работают без сети.", capabilities: ["geojson"], defaults: {} }, activate);
  }
  root.SloiBusStops = Object.freeze({ register, validate, forView });
})(typeof window !== "undefined" ? window : globalThis);
