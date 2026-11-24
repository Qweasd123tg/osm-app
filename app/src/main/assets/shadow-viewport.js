(function (root) {
  "use strict";
  const message = "Приблизьте карту для расчёта теней";
  function valid(bounds) {
    if (!Array.isArray(bounds) || bounds.length !== 2 || !bounds.every(p => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite))) return false;
    const [[west, south], [east, north]] = bounds;
    if (west < -180 || east > 180 || south < -85 || north > 85 || west >= east || south >= north) return false;
    const height = (north - south) * 111320;
    const width = (east - west) * 111320 * Math.cos((north + south) * Math.PI / 360);
    return width <= 5900 && height <= 5900 && width * height <= 11500000;
  }
  function plan(bounds) {
    if (!valid(bounds)) throw new Error(message);
    const [[west, south], [east, north]] = bounds;
    const dy = 100 / 111320;
    const dx = dy / Math.cos((north + south) * Math.PI / 360);
    // A small grid-aligned margin avoids rebuilding for every few pixels of pan.
    const padded = [[Math.floor(west / dx) * dx - dx, Math.floor(south / dy) * dy - dy],
      [Math.ceil(east / dx) * dx + dx, Math.ceil(north / dy) * dy + dy]];
    return valid(padded) ? padded : bounds.map(point => [...point]);
  }
  function contains(outer, inner) {
    return outer && inner && outer[0][0] <= inner[0][0] && outer[0][1] <= inner[0][1]
      && outer[1][0] >= inner[1][0] && outer[1][1] >= inner[1][1];
  }
  root.SloiShadowViewport = Object.freeze({ plan, contains });
})(typeof window !== "undefined" ? window : globalThis);
