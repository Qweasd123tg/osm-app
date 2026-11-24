(function (root) {
  "use strict";
  const onlineUrl = "https://tiles.openfreemap.org/planet";
  function boundsOf(value) {
    if (!Array.isArray(value) || value.length !== 2 || value.some(point => !Array.isArray(point) || point.length !== 2)) return null;
    const [west, south, east, north] = value.flat();
    if (![west, south, east, north].every(Number.isFinite) || west < -180 || east > 180 || south < -85.05112878 || north > 85.05112878 || west >= east || south >= north) return null;
    return [[west, south], [east, north]];
  }
  function parseRecord(value) {
    try {
      const record = typeof value === "string" ? JSON.parse(value) : value;
      if (!record || record.status !== "installed" || !boundsOf(record.bounds)
        || !/^https:\/\/appassets\.androidplatform\.net\/basemap\/p-[a-f0-9]{32}\/tilejson\.json$/.test(record.tileJsonUrl)) return null;
      return { ...record, bounds: boundsOf(record.bounds) };
    } catch (_) { return null; }
  }
  function covers(record, bounds, zoom = 14) {
    const view = boundsOf(bounds);
    if (!record || !view) return false;
    const [[west, south], [east, north]] = record.bounds;
    // The package stores complete tiles at every zoom, not a clipped image.
    // Use their real coverage so a small pan doesn't discard a ready area.
    const width = 2 ** Math.min(14, Math.max(0, Math.floor(Number(zoom) || 0)));
    const x = longitude => Math.max(0, Math.min(width - 1, Math.floor((longitude + 180) / 360 * width)));
    const y = latitude => {
      const radians = latitude * Math.PI / 180;
      return Math.max(0, Math.min(width - 1, Math.floor((1 - Math.log(Math.tan(radians) + 1 / Math.cos(radians)) / Math.PI) / 2 * width)));
    };
    const longitude = tile => tile / width * 360 - 180;
    const latitude = tile => Math.atan(Math.sinh(Math.PI * (1 - 2 * tile / width))) * 180 / Math.PI;
    const coverage = [[longitude(x(west)), latitude(y(south) + 1)], [longitude(x(east) + 1), latitude(y(north))]];
    const epsilon = 1e-7;
    return view[0][0] >= coverage[0][0] - epsilon && view[0][1] >= coverage[0][1] - epsilon
      && view[1][0] <= coverage[1][0] + epsilon && view[1][1] <= coverage[1][1] + epsilon;
  }
  function install({ host, getMap, document, callbacks, formatBytes, onUseChange = () => {} }) {
    const panel = document.getElementById("offline-basemap");
    const status = document.getElementById("offline-basemap-status");
    const download = document.getElementById("offline-basemap-download");
    const remove = document.getElementById("offline-basemap-delete");
    const progress = document.getElementById("offline-basemap-progress");
    const available = ["listOfflineBasemap", "downloadOfflineBasemap", "cancelOfflineBasemap", "deleteOfflineBasemap"].every(method => typeof host?.[method] === "function");
    let record = null, requestId = null, sequence = 0, error = "", deleting = false, canceling = false, usingOffline = false;
    let sourceIdentity = null, sourceUrl = onlineUrl;
    // Resolve the installed source before MapLibre can begin any online fetch.
    // The native getter reads only its in-memory committed snapshot.
    try { if (typeof host?.getOfflineBasemap === "function") record = parseRecord(host.getOfflineBasemap()); }
    catch (_) { /* Older hosts still support the asynchronous inventory. */ }
    function refresh() {
      const map = getMap(), source = map?.getSource("openmaptiles");
      if (!source || typeof source.setUrl !== "function") return;
      const local = covers(record, map.getBounds().toArray(), map.getZoom()) && !deleting;
      const url = local ? record.tileJsonUrl : onlineUrl;
      if (sourceIdentity !== source) { sourceIdentity = source; sourceUrl = source.serialize().url || onlineUrl; }
      if (sourceUrl !== url) { source.setUrl(url); sourceUrl = url; }
      if (usingOffline !== local) { usingOffline = local; onUseChange(local); }
    }
    function render(message) {
      panel.dataset.status = requestId ? "downloading" : deleting ? "deleting" : error ? "error" : record ? "installed" : "empty";
      status.textContent = message || error || (record ? `На устройстве · ${formatBytes(record.bytes)}` : available ? "Область на экране" : "Доступно в Android-приложении");
      download.textContent = requestId ? "Отмена" : "Скачать область на экране";
      download.disabled = !available || deleting || canceling;
      remove.hidden = !record;
      remove.disabled = !!requestId || deleting;
      progress.style.visibility = requestId ? "visible" : "hidden";
      panel.setAttribute("aria-busy", String(!!requestId || deleting));
    }
    function receive(value, complete) {
      record = parseRecord(value);
      if (complete) { requestId = null; deleting = false; canceling = false; error = ""; }
      render(); refresh();
    }
    Object.assign(callbacks, {
      onOfflineBasemap(value) { receive(value, false); },
      onOfflineBasemapChanged(value) { receive(value, true); },
      onOfflineBasemapProgress(id, phase, current, total) {
        if (!requestId || canceling || String(id) !== requestId) return;
        progress.max = Math.max(1, Number(total) || 1);
        if (Number(total) > 0) progress.value = Math.max(0, Number(current) || 0);
        else progress.removeAttribute("value");
        render(phase === "metadata" ? "Подключаюсь к источнику…" : phase === "install" || phase === "ready" ? "Сохраняю карту…" : `Загружено ${formatBytes(current)}`);
      },
      onOfflineBasemapError(id, message) {
        if (id && String(id) !== requestId) return;
        requestId = null; deleting = false; canceling = false; error = String(message || "Не удалось скачать карту");
        render(); refresh();
      },
    });
    download.addEventListener("click", () => {
      if (!available) return;
      error = "";
      if (requestId) {
        canceling = true;
        try { host.cancelOfflineBasemap(); render("Отменяю загрузку…"); }
        catch (failure) { canceling = false; error = failure.message; render(); }
        return;
      }
      const bounds = boundsOf(getMap()?.getBounds().toArray());
      if (!bounds) { error = "Приблизьте карту и выберите область"; render(); return; }
      requestId = `basemap-${Date.now()}-${++sequence}`;
      progress.removeAttribute("value"); render("Подключаюсь к источнику…");
      try { host.downloadOfflineBasemap(JSON.stringify({ requestId, bounds, name: "Сохранённая область" })); }
      catch (failure) { requestId = null; error = failure.message; render(); }
    });
    remove.addEventListener("click", () => {
      if (!available || requestId || deleting) return;
      deleting = true; error = ""; render("Удаляю карту…"); refresh();
      try { host.deleteOfflineBasemap(); }
      catch (failure) { deleting = false; error = failure.message; render(); refresh(); }
    });
    render();
    if (available) {
      try { host.listOfflineBasemap(); }
      catch (failure) { error = failure.message; render(); }
    }
    return Object.freeze({ refresh, initialUrl: () => record?.tileJsonUrl || onlineUrl, isUsingOffline: () => usingOffline });
  }
  root.SloiOfflineBasemap = Object.freeze({ install, covers, parseRecord });
})(typeof window !== "undefined" ? window : globalThis);
