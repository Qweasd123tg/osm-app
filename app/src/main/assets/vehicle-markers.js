(function (root) {
  "use strict";

  // Local sprites keep all vehicles in two GPU symbol layers. Their heading is
  // a layout property, never a new texture or DOM element for every position.
  const SIZE = 40, PIXEL_RATIO = 2;
  const types = Object.freeze(["bus", "tram", "trolley"]);
  const outlines = new Map();
  function contrastInk(color, dark, darkBase) {
    const rgb = color.slice(1).match(/../g).map(value => parseInt(value, 16) / 255).map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4);
    const lightness = .2126 * rgb[0] + .7152 * rgb[1] + .0722 * rgb[2];
    return (lightness + .05) / darkBase > 1.05 / (lightness + .05) ? dark : "#ffffff";
  }
  const foreground = color => contrastInk(color, "#1f2937", .072);
  function canvas() {
    const element = root.document?.createElement("canvas");
    const context = element?.getContext("2d");
    if (!context) throw new Error("Рисование маркеров транспорта недоступно");
    element.width = SIZE * PIXEL_RATIO; element.height = SIZE * PIXEL_RATIO;
    context.scale(PIXEL_RATIO, PIXEL_RATIO);
    return context;
  }
  const image = context => context.getImageData(0, 0, SIZE * PIXEL_RATIO, SIZE * PIXEL_RATIO);

  function body(color, directional) {
    if (typeof color !== "string" || !/^#[0-9a-fA-F]{6}$/.test(color) || typeof directional !== "boolean") throw new Error("Некорректный маркер транспорта");
    const context = canvas();
    context.fillStyle = color; context.strokeStyle = foreground(color);
    context.lineWidth = 1.4; context.lineJoin = "round";
    context.beginPath();
    context.arc(20, 20, 13.5, 0, Math.PI * 2);
    context.fill(); context.stroke();

    if (directional) {
      // The separate arrow starts at north. The circle's center stays on the
      // GPS fix as the sprite rotates along the vehicle's heading.
      context.lineWidth = .9;
      context.beginPath();
      context.moveTo(20, .9);
      context.lineTo(23.9, 4.6);
      context.lineTo(16.1, 4.6);
      context.closePath();
      context.fill(); context.stroke();
    }
    return image(context);
  }
  function roundedBox(context, x, y, width, height, radius) {
    context.moveTo(x + radius, y); context.lineTo(x + width - radius, y);
    context.quadraticCurveTo(x + width, y, x + width, y + radius);
    context.lineTo(x + width, y + height - radius);
    context.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
    context.lineTo(x + radius, y + height); context.quadraticCurveTo(x, y + height, x, y + height - radius);
    context.lineTo(x, y + radius); context.quadraticCurveTo(x, y, x + radius, y);
  }
  function icon(type, color = "#ffffff", background = "none") {
    if (background !== "none" && (background !== "rounded" || type === "metro")) throw new Error("Некорректный фон пиктограммы");
    if (type !== "metro" && !types.includes(type)) throw new Error("Неизвестный вид транспорта");
    if (typeof color !== "string" || !/^#[0-9a-fA-F]{6}$/.test(color)) throw new Error("Некорректный цвет пиктограммы");
    const symbol = root.SloiTransportSymbols?.get(type);
    if (!symbol || typeof root.Path2D !== "function") return null;
    if (!outlines.has(type)) {
      outlines.set(type, symbol.paths.map(({ d, fillRule }) => ({ outline: new root.Path2D(d), fillRule })));
    }
    const context = canvas();
    if (background === "rounded") {
      context.fillStyle = color;
      context.beginPath();
      roundedBox(context, 9, 8, 22, 24, 3);
      context.closePath();
      context.fill();
      // The near-black ink provides more contrast on the muted stop plate.
      color = contrastInk(color, "#111820", .05877);
    }
    const [x, y, width, height] = symbol.viewBox;
    const size = type === "metro" ? 20 : 16;
    if (type === "metro") {
      // White beneath the original black SVG makes the cutout readable.
      context.fillStyle = "#ffffff";
      context.beginPath();
      context.arc(SIZE / 2, SIZE / 2, size / 2 - .5, 0, Math.PI * 2);
      context.fill();
      color = "#000000";
    }
    const scale = size / Math.max(width, height);
    context.translate((SIZE - width * scale) / 2 - x * scale, (SIZE - height * scale) / 2 - y * scale);
    context.scale(scale, scale);
    context.fillStyle = color;
    for (const { outline, fillRule } of outlines.get(type)) context.fill(outline, fillRule);
    return image(context);
  }
  root.SloiVehicleMarkers = Object.freeze({ body, icon, foreground, types, size: SIZE, pixelRatio: PIXEL_RATIO });
})(typeof window !== "undefined" ? window : globalThis);
