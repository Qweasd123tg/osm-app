(function (root) {
  "use strict";

  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
  const point = (touch) => ({ id: touch.identifier, x: touch.clientX, y: touch.clientY });
  const distance = (a, b) => Math.hypot(b.x - a.x, b.y - a.y);
  const angle = (a, b) => Math.atan2(b.y - a.y, b.x - a.x) * 180 / Math.PI;
  const angleDelta = (value) => ((value + 180) % 360 + 360) % 360 - 180;

  function install(map, { onActiveChange = () => {} } = {}) {
    const surface = map.getCanvasContainer();
    const canvas = map.getCanvas();
    const templatePoint = map.project(map.getCenter());
    const mapPoints = (points) => points.map(({ x, y }) => {
      const result = templatePoint.clone(); result.x = x; result.y = y; return result;
    });
    // Use MapLibre's incremental rotation, including its direction and vector
    // bookkeeping. 4.7.1 exports the handler, but has no public sensitivity
    // option. This one override changes only its 25px activation distance to
    // 4px; below-threshold movement is still discarded by the stock handler.
    // https://github.com/maplibre/maplibre-gl-js/blob/v4.7.1/src/ui/handler/two_fingers_touch.ts
    class TouchRotate extends root.maplibregl.TwoFingersTouchRotateHandler {
      _isBelowThreshold(vector) {
        this._minDiameter = Math.min(this._minDiameter, vector.mag());
        const threshold = 4 / (Math.PI * Math.max(1, this._minDiameter)) * 360;
        return Math.abs(vector.angleWith(this._startVector) * 180 / Math.PI) < threshold;
      }
    }
    const initial = {
      pitch: map.touchPitch.isEnabled(),
      zoomRotate: map.touchZoomRotate.isEnabled(),
      cooperative: map.cooperativeGestures?.isEnabled(),
      surfaceTouchAction: surface.style.touchAction,
      canvasTouchAction: canvas.style.touchAction,
    };
    map.touchPitch.disable();
    map.touchZoomRotate.disable();
    map.cooperativeGestures?.disable();
    // Disabling the built-in pair handlers removes their CSS touch-action rule.
    // Keep browser scrolling/zooming from stealing this full-screen map gesture.
    surface.style.touchAction = "none";
    canvas.style.touchAction = "none";

    let pair = null;
    let captured = false;
    let blocked = false;
    let restorePan = false;
    let disposed = false;

    function suppress(event) {
      if (event.cancelable) event.preventDefault();
      event.stopImmediatePropagation();
    }

    function capture() {
      if (captured) return;
      captured = true;
      onActiveChange(true);
      restorePan = map.dragPan.isEnabled();
      map.stop(); // End a one-finger drag before it can become a pair pan.
      map.dragPan.disable();
    }

    function reset(notify = true) {
      const wasCaptured = captured;
      if (captured) {
        map.stop();
        if (restorePan) map.dragPan.enable();
      }
      pair = null;
      captured = false;
      blocked = false;
      restorePan = false;
      if (wasCaptured && notify) onActiveChange(false);
    }

    function startPair(touches, event) {
      const points = Array.from(touches, point);
      const rotate = new TouchRotate();
      rotate.enable({ around: "center" });
      rotate.touchstart(event, mapPoints(points), Array.from(touches));
      pair = {
        rotate,
        points,
        previous: points,
        distance: Math.max(1, distance(...points)),
        angle: angle(...points),
        zoom: map.getZoom(),
        bearing: map.getBearing(),
        pitch: map.getPitch(),
        zoomStartDistance: Math.max(1, distance(...points)),
        zoomStartZoom: map.getZoom(),
        zoomBearing: map.getBearing(),
        zoomPitch: map.getPitch(),
        started: event.timeStamp,
        minDistance: Math.max(1, distance(...points)),
        maxDistance: Math.max(1, distance(...points)),
        lastRotation: 0,
        lastZoomDelta: 0,
        lastRadialTravel: 0,
        lastAngularTravel: 0,
        mode: null,
      };
    }

    function touchStart(event) {
      const count = event.touches.length;
      if (!captured && count < 2) return;
      capture();
      suppress(event);
      if (blocked) { pair = null; return; }
      if (count !== 2) {
        blocked = true;
        pair = null;
      } else if (!blocked && !pair) {
        startPair(event.touches, event);
      }
    }

    function touchMove(event) {
      const count = event.touches.length;
      if (!captured && count < 2) return;
      capture();
      suppress(event);
      if (blocked) { pair = null; return; }
      if (count !== 2) {
        blocked = true;
        pair = null;
        return;
      }
      if (!pair) return;
      const touches = Array.from(event.touches, point);
      const points = pair.points.map((start) => touches.find((touch) => touch.id === start.id));
      if (points.some((touch) => !touch)) {
        blocked = true;
        pair = null;
        return;
      }
      updatePair(points, event);
    }

    function updatePair(points, event, finalSample = false) {
      const rotationChange = pair.rotate.touchmove(event, mapPoints(points),
        points.map(({ id }) => ({ identifier: id })))?.bearingDelta || 0;
      const delta = points.map((touch, index) => ({
        x: touch.x - pair.points[index].x,
        y: touch.y - pair.points[index].y,
      }));
      const previous = pair.previous;
      const step = points.map((touch, index) => ({
        x: touch.x - pair.previous[index].x,
        y: touch.y - pair.previous[index].y,
      }));
      pair.previous = points;
      const dy = (delta[0].y + delta[1].y) / 2;
      const dx = (delta[0].x + delta[1].x) / 2;
      const lengths = delta.map((value) => Math.hypot(value.x, value.y));
      const separation = Math.max(1, distance(...points));
      pair.minDistance = Math.min(pair.minDistance, separation);
      pair.maxDistance = Math.max(pair.maxDistance, separation);
      const zoomDelta = Math.log2(separation / pair.distance);
      const rotation = angleDelta(angle(...points) - pair.angle);
      const radialTravel = Math.abs(separation - pair.distance);
      const angularTravel = Math.min(separation, pair.distance) * Math.abs(rotation) * Math.PI / 180;
      const previousSeparation = Math.max(1, distance(...previous));
      const stepRadial = Math.abs(separation - previousSeparation);
      const stepAngular = Math.min(separation, previousSeparation)
        * Math.abs(angleDelta(angle(...points) - angle(...previous))) * Math.PI / 180;
      Object.assign(pair, { lastRotation: rotation, lastZoomDelta: zoomDelta,
        lastRadialTravel: radialTravel, lastAngularTravel: angularTravel });
      const zoomIntent = Math.abs(zoomDelta) > .06 && radialTravel > angularTravel * .8;
      const radialRange = pair.maxDistance - pair.minDistance;
      const rotationIntent = pair.rotate.isActive() && angularTravel > radialTravel * 2.5;
      if (!pair.mode) {
        // Recognise the movement, not the initial finger alignment or a 100ms
        // deadline. A naturally staggered second finger can still join a tilt.
        const coherentVertical = (moves, ratio) => moves[0].y * moves[1].y > 0
          && moves.every(move => Math.abs(move.y) > Math.abs(move.x) * 1.2)
          && Math.min(...moves.map(move => Math.abs(move.y))) > Math.max(...moves.map(move => Math.abs(move.y))) * ratio;
        const togetherVertically = delta[0].y * delta[1].y > 0
          && Math.min(...lengths) > 3
          && Math.abs(dy) >= 6 && Math.abs(dy) > Math.abs(dx) * 1.2
          && (coherentVertical(step, .5) || coherentVertical(delta, .75))
          && Math.abs(zoomDelta) < .3 && Math.abs(rotation) < 18;
        const ready = Math.min(...lengths) > 1 || event.timeStamp - pair.started > 220;
        if (togetherVertically) pair.mode = "pitch";
        else if (ready && zoomIntent) pair.mode = "zoom";
        else if (rotationIntent) pair.mode = "rotate";
      }
      // Once a pinch is clear its angular drift cannot rotate the map. A real
      // turn can yield to a clear pinch, starting from the CURRENT orientation;
      // slight radius wobble must not undo a turn or permanently lock it out.
      if (!finalSample && pair.mode === "pitch" && Math.abs(zoomDelta) > .4) pair.mode = "zoom";
      if (!finalSample && pair.mode === "rotate" && Math.abs(zoomDelta) > .16
        && radialRange > Math.max(8, pair.distance * .1) && stepRadial > stepAngular * 2.5) {
        pair.mode = "zoom";
        pair.zoomStartDistance = previousSeparation;
        pair.zoomStartZoom = map.getZoom();
        pair.zoomBearing = map.getBearing();
        pair.zoomPitch = map.getPitch();
      }
      if (pair.mode === "pitch") {
        map.jumpTo({ pitch: clamp(pair.pitch - dy * .45, map.getMinPitch(), map.getMaxPitch()) }, { originalEvent: event });
      } else if (pair.mode === "zoom" || pair.mode === "rotate") {
        // Once zoom is recognized, keep it until all fingers lift. Angular drift
        // cannot take over a pinch, even after reversing its zoom direction.
        // The fixed map centre also prevents an unintended two-finger pan.
        map.jumpTo({
          zoom: pair.mode === "zoom" ? clamp(pair.zoomStartZoom + Math.log2(separation / pair.zoomStartDistance), map.getMinZoom(), map.getMaxZoom()) : pair.zoom,
          bearing: pair.mode === "rotate" ? map.getBearing() + rotationChange : pair.zoomBearing,
          pitch: pair.mode === "zoom" ? pair.zoomPitch : pair.pitch,
        }, { originalEvent: event });
      }
    }

    function touchEnd(event) {
      if (!captured) return;
      suppress(event);
      // Android may predict/resample touchmove beyond the last actual sample.
      // Pointer-up includes the real final coordinates for both the remaining
      // and released fingers; reconcile before discarding the captured pair.
      const completing = pair && (!blocked || pair.releasing);
      if (completing) {
        const ended = pair.releasePoints || new Map();
        const released = pair.releasedIds || new Set();
        for (const touch of Array.from(event.touches, point)) if (!released.has(touch.id)) ended.set(touch.id, touch);
        for (const touch of Array.from(event.changedTouches || [], point)) if (!released.has(touch.id)) {
          ended.set(touch.id, touch); released.add(touch.id);
        }
        pair.releasePoints = ended; pair.releasedIds = released;
        const points = pair.points.map(start => ended.get(start.id));
        if (points.every(Boolean)) updatePair(points, event, true);
      }
      // Never let a surviving finger resume an old native drag. A new one-finger
      // gesture starts only after the entire captured gesture has been released.
      if (event.touches.length === 0) reset();
      else {
        blocked = true;
        // The surviving touch can still contain a predicted position. Retain
        // only the final correction until its own raw changedTouch arrives.
        // Any new start/move discards this snapshot and stays fully blocked.
        if (completing) pair.releasing = true;
        else pair = null;
      }
    }

    function touchCancel(event) {
      if (captured) suppress(event);
      reset();
    }

    const listeners = [["touchstart", touchStart], ["touchmove", touchMove],
      ["touchend", touchEnd], ["touchcancel", touchCancel]];
    for (const [name, listener] of listeners) surface.addEventListener(name, listener, { capture: true, passive: false });
    root.addEventListener("blur", reset);
    root.addEventListener("pagehide", reset);

    function dispose(removed = false) {
      if (disposed) return;
      disposed = true;
      reset(!removed);
      for (const [name, listener] of listeners) surface.removeEventListener(name, listener, true);
      root.removeEventListener("blur", reset);
      root.removeEventListener("pagehide", reset);
      if (initial.pitch) map.touchPitch.enable();
      if (initial.zoomRotate) map.touchZoomRotate.enable();
      if (initial.cooperative) map.cooperativeGestures.enable();
      surface.style.touchAction = initial.surfaceTouchAction;
      canvas.style.touchAction = initial.canvasTouchAction;
      map.off("remove", onRemove);
    }
    function onRemove() { dispose(true); }
    map.on("remove", onRemove);
    return dispose;
  }

  root.SloiMapGestures = Object.freeze({ install });
})(typeof window !== "undefined" ? window : globalThis);
