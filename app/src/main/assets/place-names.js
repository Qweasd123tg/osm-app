(function (root) {
  "use strict";

  // A reverse label describes the picked point. It deliberately has no
  // latitude/longitude fields, so callers cannot accidentally snap endpoints.
  const cache = new Map(), inflight = new Map(), nativeRequests = new Map();
  const abortError = () => Object.assign(new Error("Определение места отменено"), { name: "AbortError" });
  const check = signal => { if (signal?.aborted) throw abortError(); };
  const clean = (value, limit = 240) => typeof value === "string" ? value.trim().replace(/\s+/g, " ").slice(0, limit) : "";
  let sequence = 0;

  function point(value) {
    const latitude = value?.latitude, longitude = value?.longitude;
    if (![latitude, longitude].every(n => typeof n === "number" && Number.isFinite(n)) || Math.abs(latitude) > 85 || Math.abs(longitude) > 180)
      throw new Error("Некорректная точка карты");
    return { latitude, longitude };
  }

  function metres(a, b) {
    const rad = Math.PI / 180, dy = (b.latitude-a.latitude)*rad, dx = (b.longitude-a.longitude)*rad;
    const h = Math.sin(dy/2)**2 + Math.cos(a.latitude*rad)*Math.cos(b.latitude*rad)*Math.sin(dx/2)**2;
    return 6371008.8 * 2 * Math.asin(Math.min(1, Math.sqrt(h)));
  }

  function nativeLabel(value) {
    if (typeof value === "string") { try { value = JSON.parse(value); } catch (_) { return null; } }
    if (!value || !clean(value.name) || !Number.isFinite(value.distance) || value.distance < 0 || value.distance > 250) return null;
    return { name: clean(value.name), display_name: clean(value.display_name, 360) || clean(value.name), distance: value.distance, source: "offline" };
  }

  function onNativeResult(id, value) {
    nativeRequests.get(String(id))?.finish(nativeLabel(value));
  }

  function fromNative(location, signal) {
    if (typeof root.AndroidHost?.reversePlaceLookup !== "function") return Promise.resolve(null);
    check(signal);
    const requestId = `name_${++sequence}`;
    return new Promise((resolve, reject) => {
      const cancelNative = () => { try { root.AndroidHost.cancelPlaceNameLookup?.(requestId); } catch (_) {} };
      const finish = (value, cancelled = false) => {
        if (!nativeRequests.delete(requestId)) return;
        clearTimeout(timer); signal?.removeEventListener("abort", abort);
        cancelled ? reject(abortError()) : resolve(value);
      };
      const abort = () => { cancelNative(); finish(null, true); };
      const timer = setTimeout(() => { cancelNative(); finish(null); }, 1500);
      nativeRequests.set(requestId, { finish });
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) { abort(); return; }
      try { root.AndroidHost.reversePlaceLookup(JSON.stringify({ requestId, ...location })); }
      catch (_) { finish(null); }
    });
  }

  function photonLabel(payload, location) {
    if (!Array.isArray(payload?.features)) return null;
    const choices = [];
    for (const feature of payload.features.slice(0, 12)) {
      const c = feature?.geometry?.coordinates, p = feature?.properties;
      if (feature?.geometry?.type !== "Point" || !Array.isArray(c) || c.length !== 2 || !p) continue;
      let near;
      try { near = point({ longitude: c[0], latitude: c[1] }); } catch (_) { continue; }
      const distance = metres(location, near), field = key => clean(p[key]);
      const address = `${field("street")}${field("housenumber") ? " " + field("housenumber") : ""}`.trim();
      const house = Boolean(field("housenumber") && field("street"));
      if (distance > (house ? 150 : 250)) continue;
      // City/district centroids cannot name an arbitrary nearby map point.
      const name = house ? address : field("name") || address;
      if (!name || ["city", "county", "state", "country", "district", "locality"].includes(field("type"))) continue;
      const display_name = [...new Set([name, field("name"), address, field("district"), field("city")].filter(Boolean))].join(", ");
      choices.push({ name, display_name, distance: Math.round(distance), source: "photon", house });
    }
    choices.sort((a, b) => Number(b.house) - Number(a.house) || a.distance - b.distance);
    if (!choices.length) return null;
    const { house, ...result } = choices[0];
    return result;
  }

  async function fromPhoton(location, signal) {
    check(signal);
    if (root.navigator?.onLine === false || typeof root.fetch !== "function") return null;
    const controller = new AbortController(), abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(abort, 3500);
    try {
      const url = new URL("https://photon.komoot.io/reverse");
      url.search = new URLSearchParams({ lat: location.latitude, lon: location.longitude, radius: ".25", limit: "6", lang: "ru" }).toString();
      const response = await root.fetch(url.href, { signal: controller.signal, credentials: "omit", redirect: "error", headers: { Accept: "application/json" } });
      if (!response.ok || Number(response.headers.get("content-length")) > 128 * 1024) return null;
      const reader = response.body?.getReader();
      if (!reader) return null;
      let length = 0, text = "";
      const decoder = new TextDecoder();
      try {
        while (true) {
          check(signal);
          const part = await reader.read();
          if (part.done) break;
          length += part.value.byteLength;
          if (length > 128 * 1024) { await reader.cancel().catch(() => {}); return null; }
          text += decoder.decode(part.value, { stream: true });
        }
        text += decoder.decode();
      } finally { reader.releaseLock(); }
      check(signal);
      return photonLabel(JSON.parse(text), location);
    } catch (error) { check(signal); return null; }
    finally { clearTimeout(timer); signal?.removeEventListener("abort", abort); }
  }

  function subscribe(entry, signal) {
    check(signal);
    entry.users++;
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error, value) => {
        if (settled) return;
        settled = true; signal?.removeEventListener("abort", abort); entry.users--;
        if (!entry.users && !entry.done) entry.controller.abort();
        error ? reject(error) : resolve(value ? { ...value } : null);
      };
      const abort = () => finish(abortError());
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) { abort(); return; }
      entry.promise.then(value => finish(null, value), error => finish(error));
    });
  }

  function resolve(value, { signal } = {}) {
    try {
      check(signal);
      const location = point(value);
      const revision = String(root.SloiOfflinePlacesRevision || "");
      const key = `${revision}|${location.latitude.toFixed(5)}|${location.longitude.toFixed(5)}`;
      const hit = cache.get(key);
      if (hit && Date.now() - hit.at < (hit.value ? 300000 : 15000)) return Promise.resolve(hit.value ? { ...hit.value } : null);
      let entry = inflight.get(key);
      if (entry?.controller.signal.aborted) { inflight.delete(key); entry = null; }
      if (!entry) {
        while (inflight.size >= 8) { const oldest = inflight.keys().next().value; inflight.get(oldest).controller.abort(); inflight.delete(oldest); }
        entry = { controller: new AbortController(), users: 0, done: false };
        const owned = entry;
        entry.promise = (async () => {
          const local = await fromNative(location, owned.controller.signal);
          check(owned.controller.signal);
          const result = local || await fromPhoton(location, owned.controller.signal);
          check(owned.controller.signal);
          cache.delete(key); cache.set(key, { value: result, at: Date.now() });
          while (cache.size > 64) cache.delete(cache.keys().next().value);
          return result;
        })().finally(() => {
          owned.done = true;
          if (inflight.get(key) === owned) inflight.delete(key);
        });
        inflight.set(key, entry);
      }
      return subscribe(entry, signal);
    } catch (error) { return Promise.reject(error); }
  }

  root.SloiPlaceNames = Object.freeze({ resolve, onNativeResult, onNativeError: id => onNativeResult(id, null) });
})(typeof window !== "undefined" ? window : globalThis);
