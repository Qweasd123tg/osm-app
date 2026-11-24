(function (root) {
  "use strict";
  const KEY = "sloi-transport-presets", MAX_PRESETS = 20, MAX_BYTES = 65536;
  const copy = value => JSON.parse(JSON.stringify(value));
  const validId = value => typeof value === "string" && /^[a-zA-Z0-9-]{1,64}$/.test(value);
  function normalize(value, id) {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Набор транспорта повреждён");
    if (!validId(id)) throw new Error("Набор транспорта не найден");
    const name = typeof value.name === "string" ? value.name.replace(/\s+/g, " ").trim() : "";
    if (!name || name.length > 48 || /[\u0000-\u001f\u007f]/.test(name)) throw new Error("Название должно содержать от 1 до 48 символов");
    const routes = root.SloiLiveTransport.normalizeRoutes(value.routes);
    if (!routes?.length) throw new Error("Добавьте хотя бы один маршрут");
    return Object.freeze({ id, name, routes });
  }
  function create({ storage, onSelect = async () => {} } = {}) {
    let state = { version: 1, presets: [], activeId: null }, warning = "", generation = 0;
    const listeners = new Set();
    const notify = () => { for (const listener of listeners) { try { listener(); } catch (_) {} } };
    try {
      const serialized = storage?.getItem(KEY);
      if (serialized) {
        if (serialized.length > MAX_BYTES) throw new Error();
        const saved = JSON.parse(serialized);
        if (saved?.version !== 1 || !Array.isArray(saved.presets) || saved.presets.length > MAX_PRESETS) throw new Error();
        const seen = new Set();
        const presets = saved.presets.map(value => {
          const preset = normalize(value, value?.id);
          if (seen.has(preset.id)) throw new Error();
          seen.add(preset.id); return preset;
        });
        state = { version: 1, presets, activeId: seen.has(saved.activeId) ? saved.activeId : null };
      }
    } catch (_) { warning = "Не удалось прочитать сохранённые наборы"; }
    function commit(next) {
      const serialized = JSON.stringify(next);
      if (new TextEncoder().encode(serialized).length > MAX_BYTES) throw new Error("Наборы занимают слишком много места");
      // A failed write must not erase a previously saved collection in memory.
      if (!storage) throw new Error("Хранилище наборов недоступно");
      try { storage.setItem(KEY, serialized); }
      catch (_) { throw new Error("Не удалось сохранить набор. Проверьте свободное место."); }
      state = next; warning = ""; notify();
    }
    return Object.freeze({
      list: () => copy(state.presets),
      activeId: () => state.activeId,
      warning: () => warning,
      save(value) {
        const id = value?.id || root.crypto?.randomUUID?.() || `preset-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
        const preset = normalize(value, id), existing = state.presets.findIndex(item => item.id === id);
        if (value?.id && existing < 0) throw new Error("Набор транспорта не найден");
        if (existing < 0 && state.presets.length >= MAX_PRESETS) throw new Error(`Можно сохранить не больше ${MAX_PRESETS} наборов`);
        const presets = [...state.presets];
        if (existing < 0) presets.push(preset); else presets[existing] = preset;
        commit({ ...state, presets });
        return copy(preset);
      },
      remove(id) {
        if (!state.presets.some(item => item.id === id)) return;
        generation++;
        commit({ ...state, presets: state.presets.filter(item => item.id !== id), activeId: state.activeId === id ? null : state.activeId });
      },
      async select(id) {
        const preset = id === null ? null : state.presets.find(item => item.id === id);
        if (id !== null && !preset) throw new Error("Набор транспорта не найден");
        const current = ++generation;
        commit({ ...state, activeId: id });
        await onSelect(preset ? copy(preset.routes) : null, { isCurrent: () => current === generation });
      },
      clearActive() {
        generation++;
        if (state.activeId === null) return;
        commit({ ...state, activeId: null });
      },
      cancelPending() { generation++; },
      subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    });
  }
  root.SloiTransportPresets = Object.freeze({ create, storageKey: KEY, maxPresets: MAX_PRESETS });
})(typeof window !== "undefined" ? window : globalThis);
