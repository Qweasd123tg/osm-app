(function (root) {
  "use strict";

  const manifest = Object.freeze({
    id: "shadows",
    apiVersion: 1,
    version: "1.0.0",
    title: "Тени",
    description: "Тени зданий для видимой области карты в текущее время",
    capabilities: Object.freeze(["shadows"]),
    defaults: Object.freeze({ opacity: 38 }),
  });

  async function activate(context) {
    const opacity = context.settings.opacity;
    if (typeof opacity !== "number" || !Number.isFinite(opacity) || opacity < 10 || opacity > 75) {
      throw new Error("Прозрачность теней должна быть от 10 до 75%");
    }
    await context.useShadows({ opacity: opacity / 100 });
  }

  function register(host) {
    host.register(manifest, activate);
  }

  const controls = Object.freeze({ shadows: Object.freeze([
    Object.freeze({ key: "opacity", label: "Непрозрачность, %", type: "number", min: 10, max: 75, step: 1 }),
  ]) });

  root.SloiNativeShadows = Object.freeze({ register, controls });
})(typeof window !== "undefined" ? window : globalThis);
