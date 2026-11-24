(function (root) {
  "use strict";

  // Local sprites keep all vehicles in two GPU symbol layers. Their heading is
  // a layout property, never a new texture or DOM element for every position.
  const SIZE = 40, PIXEL_RATIO = 2;
  const types = Object.freeze(["bus", "tram", "trolley"]);
  function foreground(color) {
    const rgb = color.slice(1).match(/../g).map(value => parseInt(value, 16) / 255).map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4);
    const lightness = .2126 * rgb[0] + .7152 * rgb[1] + .0722 * rgb[2];
    return (lightness + .05) / .072 > 1.05 / (lightness + .05) ? "#1f2937" : "#ffffff";
  }
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
    if (directional) {
      // Tip points north; the GPS anchor is the circle/pictogram center, not
      // the tip. Tangents make the transition from the tip to the circle smooth.
      const radius = 15, distance = 19, angle = Math.acos(radius / distance);
      const tangent = -Math.PI / 2 + angle;
      context.moveTo(20, 1);
      context.lineTo(20 + radius * Math.cos(tangent), 20 + radius * Math.sin(tangent));
      context.arc(20, 20, radius, tangent, -Math.PI / 2 - angle + 2 * Math.PI);
      context.closePath();
    } else context.arc(20, 20, 15, 0, Math.PI * 2);
    context.fill(); context.stroke();
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
  function icon(type, color = "#ffffff") {
    if (!types.includes(type)) throw new Error("Неизвестный вид транспорта");
    if (typeof color !== "string" || !/^#[0-9a-fA-F]{6}$/.test(color)) throw new Error("Некорректный цвет пиктограммы");
    const context = canvas();
    context.strokeStyle = color; context.fillStyle = color;
    context.lineWidth = 1.55; context.lineJoin = "round"; context.lineCap = "round";
    context.beginPath();
    const top = type === "bus" ? 14.5 : 16.3;
    roundedBox(context, 14.8, top, 10.4, 25 - top, 1.8);
    context.moveTo(15.3, 20.7); context.lineTo(24.7, 20.7);
    context.moveTo(17.2, 25); context.lineTo(17.2, 26.2);
    context.moveTo(22.8, 25); context.lineTo(22.8, 26.2);
    if (type === "tram") {
      context.moveTo(17.4, 14.4); context.lineTo(20, 12.1); context.lineTo(22.6, 14.4);
      context.lineTo(20, 16.3); context.closePath();
    } else if (type === "trolley") {
      context.moveTo(17.3, 16.3); context.lineTo(19.6, 12);
      context.moveTo(22.1, 16.3); context.lineTo(24.4, 12);
    }
    context.stroke();
    for (const x of [17.4, 22.6]) {
      context.beginPath(); context.arc(x, 23, .7, 0, Math.PI * 2); context.fill();
    }
    return image(context);
  }
  root.SloiVehicleMarkers = Object.freeze({ body, icon, foreground, types, size: SIZE, pixelRatio: PIXEL_RATIO });
})(typeof window !== "undefined" ? window : globalThis);
