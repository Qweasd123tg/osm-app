(function (root) {
  "use strict";
  const limits = Object.freeze({ "sloi-modules-state": 512 * 1024, "sloi-transport-presets": 64 * 1024 });
  function create({ native, fallback } = {}) {
    const durable = typeof native?.readExtensionState === "function" && typeof native?.writeExtensionState === "function";
    function checkKey(key) { if (!Object.hasOwn(limits, key)) throw new Error("Неизвестное хранилище расширения"); }
    function checkValue(key, value) {
      checkKey(key);
      if (typeof value !== "string" || new TextEncoder().encode(value).length > limits[key]) throw new Error("Слишком большой объём настроек расширения");
    }
    function writeNative(key, value) {
      if (native.writeExtensionState(key, value) !== true) throw new Error("Не удалось сохранить настройки на устройстве");
    }
    return Object.freeze({
      getItem(key) {
        checkKey(key);
        if (durable) {
          const value = native.readExtensionState(key);
          if (value !== null && value !== undefined) { checkValue(key, value); return value; }
          const previous = fallback?.getItem(key) ?? null;
          if (previous !== null) { checkValue(key, previous); writeNative(key, previous); }
          return previous;
        }
        return fallback?.getItem(key) ?? null;
      },
      setItem(key, value) {
        checkValue(key, value);
        if (durable) {
          // Android acknowledges only after the disk commit, independently of
          // WebView's delayed localStorage flush or sudden process termination.
          writeNative(key, value);
          try { fallback?.setItem(key, value); } catch (_) { /* Native is authoritative. */ }
        } else {
          if (!fallback) throw new Error("Хранилище настроек недоступно");
          fallback.setItem(key, value);
        }
      },
    });
  }
  root.SloiExtensionStorage = Object.freeze({ create });
})(typeof window !== "undefined" ? window : globalThis);
