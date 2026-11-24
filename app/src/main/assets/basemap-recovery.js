(function (root) {
  "use strict";

  const SOURCE_ID = "openmaptiles";
  const ONLINE_URL = "https://tiles.openfreemap.org/planet";
  const RETRY_DELAYS = [2000, 6000, 15000];

  function isBasemapUrl(value) {
    if (typeof value !== "string") return false;
    try {
      const url = new URL(value);
      return url.origin === "https://tiles.openfreemap.org"
        && /^\/planet(?:\/[^/]+\/\d+\/\d+\/\d+\.pbf)?\/?$/.test(url.pathname);
    } catch (_) { return false; }
  }

  function isTransient(error) {
    if (!error || error.name === "AbortError") return false;
    if (Number.isFinite(error.status)) {
      return [0, 408, 425, 429].includes(error.status) || (error.status >= 500 && error.status < 600);
    }
    // Fetch failures from a tile worker may arrive as a generic Error.
    return /failed to fetch|fetch failed|network\s*error|network request failed|load failed|net::ERR_|request (?:failed|timed out)|timeout/i.test(error.message || "");
  }

  function install({ map, document = root.document, window = root }) {
    let source = null, timer = null, attempts = 0, failed = false;
    let moving = map.isMoving?.() === true, disposed = false, retrying = false;
    const isOnline = () => window.navigator?.onLine !== false;
    let wasOnline = isOnline();
    const viewportKey = () => JSON.stringify(map.getBounds().toArray());
    let viewport = viewportKey();

    function cancel() {
      if (timer !== null) window.clearTimeout(timer);
      timer = null;
    }

    function reset() {
      cancel();
      attempts = 0;
      failed = false;
    }

    function syncSource() {
      if (disposed) return null;
      const current = map.getSource(SOURCE_ID);
      const onlineSource = current?.serialize()?.url === ONLINE_URL && typeof current.setUrl === "function"
        ? current : null;
      if (onlineSource !== source) {
        reset();
        source = onlineSource;
      }
      return source;
    }

    function recovered(allowEmpty = false) {
      if (!failed || !source || source.loaded?.() === false || !map.isSourceLoaded(SOURCE_ID)) return false;
      // 4.7.1 treats errored tiles as finished. Read the active cache to
      // distinguish a fully loaded viewport from one with missing tiles.
      const cache = map.style?.sourceCaches?.[SOURCE_ID];
      const tiles = cache?._tiles ? Object.values(cache._tiles) : [];
      return (allowEmpty || tiles.length > 0) && tiles.every(tile => tile.state === "loaded");
    }

    function schedule() {
      const current = syncSource();
      if (!current || !failed || timer !== null || attempts >= RETRY_DELAYS.length
        || moving || document.hidden || !isOnline()) return;
      timer = window.setTimeout(() => {
        timer = null;
        if (disposed || syncSource() !== current || moving || document.hidden || !isOnline()) return;
        if (recovered()) { reset(); return; }
        attempts++;
        // setUrl reloads metadata, then resets failed tiles in the source cache.
        // The map style, overlays, and camera stay in place.
        retrying = true;
        try { current.setUrl(ONLINE_URL); }
        finally { retrying = false; }
      }, RETRY_DELAYS[attempts]);
    }

    function onError(event) {
      if (!syncSource() || (event.sourceId && event.sourceId !== SOURCE_ID)) return;
      const url = event.error?.url;
      if (url ? !isBasemapUrl(url) : event.sourceId !== SOURCE_ID) return;
      if (!isTransient(event.error)) return;
      failed = true;
      schedule();
    }

    function onSourceLoading(event) {
      if (event.sourceId !== SOURCE_ID || !syncSource()) return;
      // An external source reload supersedes the pending attempt. The event
      // raised synchronously by this helper must preserve its retry budget.
      if (!event.tile && !retrying) reset();
    }

    function onSourceData(event) {
      if (event.sourceId !== SOURCE_ID || !syncSource()) return;
      if (recovered()) reset();
    }

    function onIdle() {
      if (syncSource() && recovered(true)) reset();
    }

    function onMoveStart() { moving = true; cancel(); }
    function onMoveEnd() {
      moving = false;
      const next = viewportKey();
      if (next !== viewport) { viewport = next; attempts = 0; }
      if (syncSource() && recovered()) reset();
      schedule();
    }

    function onConnectivity() {
      const online = isOnline();
      if (online && !wasOnline) attempts = 0;
      wasOnline = online;
      if (!online || document.hidden) cancel();
      else if (syncSource() && recovered()) reset();
      else schedule();
    }

    function dispose() {
      if (disposed) return;
      disposed = true;
      cancel();
      for (const [event, callback] of Object.entries(listeners)) map.off(event, callback);
      document.removeEventListener("visibilitychange", onConnectivity);
      window.removeEventListener("offline", onConnectivity);
      window.removeEventListener("online", onConnectivity);
    }

    const listeners = { error: onError, sourcedataloading: onSourceLoading, sourcedata: onSourceData,
      idle: onIdle, movestart: onMoveStart, moveend: onMoveEnd, remove: dispose };
    for (const [event, callback] of Object.entries(listeners)) map.on(event, callback);
    document.addEventListener("visibilitychange", onConnectivity);
    window.addEventListener("offline", onConnectivity);
    window.addEventListener("online", onConnectivity);
    return dispose;
  }

  root.SloiBasemapRecovery = Object.freeze({ install });
})(typeof window !== "undefined" ? window : globalThis);
