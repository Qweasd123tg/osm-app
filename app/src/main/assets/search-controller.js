(function (root) {
  "use strict";

  const clean = (value) => String(value || "").trim().replace(/\s+/g, " ").slice(0, 160);
  const abortError = () => Object.assign(new Error("Поиск отменён"), { name: "AbortError" });
  const check = (signal) => { if (signal?.aborted) throw abortError(); };

  function normalizePhoton(payload) {
    if (!payload || !Array.isArray(payload.features)) throw new Error("Поиск вернул повреждённые данные");
    const places = [], seen = new Set();
    for (const feature of payload.features) {
      const coordinates = feature?.geometry?.coordinates, p = feature?.properties;
      if (feature?.geometry?.type !== "Point" || !Array.isArray(coordinates) || coordinates.length !== 2 || !p) continue;
      const [longitude, latitude] = coordinates;
      if (![longitude, latitude].every((n) => typeof n === "number" && Number.isFinite(n)) || Math.abs(longitude) > 180 || Math.abs(latitude) > 85) continue;
      const field = (key) => typeof p[key] === "string" ? p[key].trim() : "";
      const address = `${field("street")}${field("housenumber") ? " " + field("housenumber") : ""}`.trim();
      const name = field("name") || address || field("city");
      if (!name) continue;
      const display_name = [...new Set([name, address, ...["district", "city", "state", "country"].map(field)].filter(Boolean))].join(", ");
      const identity = `${display_name}|${longitude}|${latitude}`;
      if (seen.has(identity)) continue;
      seen.add(identity); places.push({ name, display_name, latitude, longitude });
      if (places.length === 6) break;
    }
    return places;
  }

  async function webPlaces(query, { signal, center, zoom } = {}) {
    check(signal);
    const url = new URL("https://photon.komoot.io/api/");
    url.search = new URLSearchParams({ q: clean(query), limit: "6" }).toString();
    if (Array.isArray(center) && center.length === 2 && center.every(Number.isFinite) && Math.abs(center[0]) <= 180 && Math.abs(center[1]) <= 85) {
      url.searchParams.set("lon", center[0]); url.searchParams.set("lat", center[1]);
      // Photon requires an integer and uses 0..18 for its location bias.
      const biasZoom = Math.round(Math.max(0, Math.min(18, typeof zoom === "number" && Number.isFinite(zoom) ? zoom : 12)));
      url.searchParams.set("zoom", biasZoom);
    }
    const controller = new AbortController(), cancel = () => controller.abort();
    signal?.addEventListener("abort", cancel, { once: true });
    const timer = setTimeout(cancel, 8000);
    try {
      const response = await root.fetch(url.href, { signal: controller.signal, credentials: "omit", redirect: "error", headers: { Accept: "application/json", "Accept-Language": "ru,en;q=0.7" } });
      if (!response.ok) throw new Error(response.status === 429 ? "Поиск занят. Повторите чуть позже." : `Поиск недоступен: HTTP ${response.status}`);
      if (Number(response.headers.get("content-length")) > 512 * 1024) throw new Error("Ответ поиска слишком большой");
      const reader = response.body?.getReader();
      if (!reader) throw new Error("Поток поиска недоступен");
      const decoder = new TextDecoder(); let length = 0, text = "";
      try {
        while (true) {
          check(signal); const part = await reader.read(); if (part.done) break;
          length += part.value.byteLength;
          if (length > 512 * 1024) throw new Error("Ответ поиска слишком большой");
          text += decoder.decode(part.value, { stream: true });
        }
        text += decoder.decode();
      } catch (error) { await reader.cancel().catch(() => {}); throw error; }
      finally { reader.releaseLock(); }
      check(signal);
      return normalizePhoton(JSON.parse(text));
    } finally { clearTimeout(timer); signal?.removeEventListener("abort", cancel); }
  }

  function create(options) {
    if (typeof options?.places !== "function") throw new Error("Источник поиска не задан");
    let timer = null, controller = null, sequence = 0, composing = false, disposed = false;
    const cache = new Map();
    const fold = value => clean(value).toLocaleLowerCase().replace(/ё/g, "е");
    const context = () => String(options.contextKey?.() || "");
    const keyFor = (query, location) => `${location}\n${fold(query)}`;
    const valid = entry => entry && Date.now() - entry.at < 5 * 60 * 1000;
    const emit = (value) => options.onResults?.(value);
    function remember(key, entry) {
      entry.at = Date.now(); cache.delete(key); cache.set(key, entry);
      while (cache.size > 32) cache.delete(cache.keys().next().value);
    }
    function cached(query, location) {
      const key = keyFor(query, location), entry = cache.get(key);
      if (valid(entry)) { cache.delete(key); cache.set(key, entry); return entry; }
      cache.delete(key); return null;
    }
    function preview(query, location, providers, entry) {
      const result = { query, places: entry?.places || [], transport: providers.flatMap(provider => entry?.transport.get(provider.moduleId) || []) };
      if (entry?.places !== null && entry?.places !== undefined) return result;
      const tokens = fold(query).match(/[\p{L}\p{N}]+/gu) || [];
      if (!tokens.length || query.length < 2) return result;
      const seen = new Set();
      // Only already received, text-matching places are useful as instant
      // suggestions. Never relabel an unrelated old query as a new result.
      for (const candidate of [...cache.values()].reverse()) {
        if (candidate.context !== location || !valid(candidate) || !candidate.places) continue;
        for (const place of candidate.places) {
          const words = fold(place.display_name || place.name).match(/[\p{L}\p{N}]+/gu) || [];
          if (!tokens.every(token => words.some(word => word.startsWith(token)))) continue;
          const identity = `${place.longitude}|${place.latitude}|${place.display_name || place.name}`;
          if (seen.has(identity)) continue;
          seen.add(identity); result.places.push(place);
          if (result.places.length === 6) return result;
        }
      }
      return result;
    }
    function cancel() {
      sequence++; clearTimeout(timer); timer = null;
      controller?.abort(); controller = null;
      options.onLoading?.(false);
    }
    async function run(query) {
      if (disposed || composing) return;
      const generation = sequence, active = controller = new AbortController();
      const current = () => !disposed && generation === sequence && !active.signal.aborted;
      const providers = options.providers?.() || [], location = context(), key = keyFor(query, location);
      const entry = cached(query, location) || { context: location, places: query.length < 2 ? [] : null, transport: new Map(), at: Date.now() };
      const update = () => emit(preview(query, location, providers, entry));
      const jobs = [];
      if (entry.places === null) jobs.push(Promise.resolve().then(() => options.places(query, { signal: active.signal })).then(places => {
        if (!current()) return;
        entry.places = Array.isArray(places) ? places.slice(0, 6) : [];
        remember(key, entry); update();
      }).catch(error => { if (current() && error?.name !== "AbortError") options.onError?.(error, "places"); }));
      for (const provider of providers) if (!entry.transport.has(provider.moduleId)) jobs.push(Promise.resolve().then(() => provider.search(query, { signal: active.signal })).then(items => {
        if (!current()) return;
        entry.transport.set(provider.moduleId, Array.isArray(items) ? items.slice(0, 6) : []);
        remember(key, entry); update();
      }).catch(error => { if (current() && error?.name !== "AbortError") options.onError?.(error, provider.moduleId); }));
      options.onLoading?.(jobs.length > 0); update();
      await Promise.all(jobs);
      if (!current()) return;
      controller = null; options.onLoading?.(false);
    }
    function input(value, immediate = false) {
      const query = clean(value); cancel();
      if (disposed || composing) return;
      const shortTransportQuery = /^\d$/.test(query) && (options.providers?.() || []).length > 0;
      if (query.length < 2 && !shortTransportQuery) { emit({ query, places: [], transport: [] }); return; }
      const providers = options.providers?.() || [], location = context(), entry = cached(query, location);
      const missing = !entry || entry.places === null || providers.some(provider => !entry.transport.has(provider.moduleId));
      options.onLoading?.(missing);
      emit(preview(query, location, providers, entry));
      if (!missing) return;
      if (immediate) return run(query);
      timer = setTimeout(() => { timer = null; void run(query); }, options.debounceMs ?? 180);
    }
    return Object.freeze({ input, submit: (value) => input(value, true), cancel,
      compositionStart() { composing = true; cancel(); },
      compositionEnd(value) { composing = false; input(value); },
      dispose() { disposed = true; cancel(); cache.clear(); },
    });
  }

  root.SloiSearch = Object.freeze({ create, webPlaces, normalizePhoton });
})(typeof window !== "undefined" ? window : globalThis);
