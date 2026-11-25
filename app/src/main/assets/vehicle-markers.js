(function (root) {
  "use strict";

  // Local sprites keep all vehicles in two GPU symbol layers. Their heading is
  // a layout property, never a new texture or DOM element for every position.
  const SIZE = 40;
  const devicePixelRatio = Number.isFinite(root.devicePixelRatio) ? root.devicePixelRatio : 1;
  const PIXEL_RATIO = Math.max(2, Math.min(3, Math.ceil(devicePixelRatio)));
  const BODY_SIZE = 44, BODY_SCALE = .8;
  const types = Object.freeze(["bus", "tram", "trolley"]);
  const whiteGlyphColors = new Set(["#1a73f0", "#eb5a2b", "#e9a300", "#c48900"]);
  const outlines = new WeakMap();
  function contrastInk(color, dark, darkBase) {
    const rgb = color.slice(1).match(/../g).map(value => parseInt(value, 16) / 255).map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4);
    const lightness = .2126 * rgb[0] + .7152 * rgb[1] + .0722 * rgb[2];
    return (lightness + .05) / darkBase > 1.05 / (lightness + .05) ? dark : "#ffffff";
  }
  const foreground = color => whiteGlyphColors.has(color.toLowerCase()) ? "#ffffff" : contrastInk(color, "#1f2937", .072);
  function canvas() {
    const element = root.document?.createElement("canvas");
    const context = element?.getContext("2d");
    if (!context) throw new Error("Рисование маркеров транспорта недоступно");
    element.width = SIZE * PIXEL_RATIO; element.height = SIZE * PIXEL_RATIO;
    context.scale(PIXEL_RATIO, PIXEL_RATIO);
    return context;
  }
  const image = context => context.getImageData(0, 0, SIZE * PIXEL_RATIO, SIZE * PIXEL_RATIO);

  function chevron(context, top, bottom) {
    context.beginPath();
    context.moveTo(22, top + 5);
    context.lineTo(33.5, bottom);
    context.lineTo(22, top);
    context.lineTo(10.5, bottom);
    context.closePath();
    context.fill();
  }
  function body(color, directional) {
    if (typeof color !== "string" || !/^#[0-9a-fA-F]{6}$/.test(color) || typeof directional !== "boolean") throw new Error("Некорректный маркер транспорта");
    const context = canvas();
    const inset = (SIZE - BODY_SIZE * BODY_SCALE) / 2;
    context.translate(inset, inset);
    context.scale(BODY_SCALE, BODY_SCALE);

    // The shared arrow template has two overlaid chevrons and two circles.
    // Its center stays at the GPS fix when the body rotates.
    context.fillStyle = "#ffffff";
    if (directional) chevron(context, 0, 9.5);
    context.strokeStyle = "#ffffff";
    context.lineWidth = 2;
    context.beginPath();
    context.arc(22, 22, 16, 0, Math.PI * 2);
    // Back the colored circle with white so independently anti-aliased
    // edges of the fill and outline cannot expose a ring of the basemap.
    context.fill();
    context.stroke();

    context.fillStyle = color;
    if (directional) chevron(context, 2, 12.18);
    context.strokeStyle = color;
    context.beginPath();
    context.arc(22, 22, 14, 0, Math.PI * 2);
    context.fill();
    context.stroke();
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
    const plainMetro = type === "metro-plain";
    const roadVehicle = types.includes(type);
    if (background !== "none" && (background !== "rounded" || !roadVehicle)) throw new Error("Некорректный фон пиктограммы");
    if (!roadVehicle && !plainMetro && type !== "metro") throw new Error("Неизвестный вид транспорта");
    if (typeof color !== "string" || !/^#[0-9a-fA-F]{6}$/.test(color)) throw new Error("Некорректный цвет пиктограммы");
    const busStop = type === "bus" && background === "rounded";
    const catalog = root.SloiTransportSymbols;
    const symbol = catalog?.getMap(busStop ? "bus-stop" : type, color) || catalog?.get(type);
    if (!symbol || typeof root.Path2D !== "function") return null;
    if (!outlines.has(symbol)) {
      outlines.set(symbol, symbol.paths.map(path => ({ ...path, outline: new root.Path2D(path.d) })));
    }
    const context = canvas();
    const backingColor = color;
    if (background === "rounded" && !busStop) {
      context.fillStyle = backingColor;
      context.beginPath();
      roundedBox(context, 9, 8, 22, 24, 3);
      context.closePath();
      context.fill();
    }
    if (background === "rounded") {
      // Keep the atlas palette for bundled stops and contrast for user colors.
      color = busStop && backingColor.toLowerCase() === "#64828c"
        ? "#202122"
        : contrastInk(backingColor, "#111820", .05877);
    }
    const [x, y, width, height] = symbol.viewBox;
    const size = busStop ? 22 : plainMetro ? 16 : type === "metro" ? 20 : BODY_SIZE * BODY_SCALE;
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
    if (plainMetro) {
      // Both originals clip their background to the 16 × 12 viewBox.
      context.beginPath();
      context.rect(x, y, width, height);
      context.clip();
    }
    for (const { outline, fillRule, fill, backing } of outlines.get(symbol)) {
      context.fillStyle = fill || (backing ? backingColor : color);
      context.fill(outline, fillRule);
    }
    return image(context);
  }
  root.SloiVehicleMarkers = Object.freeze({ body, icon, foreground, types, size: SIZE, pixelRatio: PIXEL_RATIO });
})(typeof window !== "undefined" ? window : globalThis);
