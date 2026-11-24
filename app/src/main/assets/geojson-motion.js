(function (root) {
  "use strict";

  const MAX_FEATURES = 5000, MAX_DURATION_MS = 16000, FRAME_MS = 1000 / 30;
  const MAX_DISTANCE_METERS = 1000, MAX_SPEED_METERS_PER_SECOND = 60;
  const EARTH_RADIUS_METERS = 6371008.8, RAD = Math.PI / 180;
  const HEADING = "__moduleVehicleHeading";
  const KNOWN_HEADING = "__moduleVehicleHeadingKnown";
  const OBSERVATION_FIELDS = ["observationTime", "rawTimestamp", "receivedAt", "timeConfirmed", "statusText"];

  const samePoint = (left, right) => left[0] === right[0] && left[1] === right[1];
  const angularDelta = (from, to) => ((to - from + 540) % 360) - 180;
  const headingOf = feature => {
    const properties = feature.properties || {};
    const normalized = Object.hasOwn(properties, HEADING);
    if (normalized && properties[KNOWN_HEADING] === false) return null;
    const heading = normalized ? properties[HEADING] : properties.heading;
    return Number.isFinite(heading) && heading >= 0 && heading < 360 ? heading : null;
  };
  const timeOf = feature => {
    const properties = feature.properties || {};
    const timestamp = Object.hasOwn(properties, "observationTime") ? properties.observationTime : properties.rawTimestamp;
    return typeof timestamp === "string" ? Date.parse(timestamp) : NaN;
  };

  function identity(feature) {
    return feature?.geometry?.type === "Point" && (typeof feature.id === "string" || typeof feature.id === "number")
      ? feature.id : undefined;
  }

  function allowedMove(from, to, elapsed) {
    if (!(elapsed > 0)) return false;
    const east = angularDelta(from[0], to[0]) * RAD * Math.cos((from[1] + to[1]) * RAD / 2);
    const north = (to[1] - from[1]) * RAD;
    // The local approximation is sufficient for the short distances we animate.
    const distance = Math.hypot(east, north) * EARTH_RADIUS_METERS;
    return distance <= MAX_DISTANCE_METERS && distance <= MAX_SPEED_METERS_PER_SECOND * elapsed / 1000;
  }

  function atPosition(feature, coordinates, heading) {
    const samePosition = samePoint(feature.geometry.coordinates, coordinates);
    const sameHeading = heading === headingOf(feature);
    if (samePosition && sameHeading) return feature;
    const updated = { ...feature };
    if (!samePosition) updated.geometry = { ...feature.geometry, coordinates };
    if (!sameHeading) {
      const key = Object.hasOwn(feature.properties, HEADING) ? HEADING : "heading";
      updated.properties = { ...feature.properties, [key]: heading };
    }
    return updated;
  }

  function keepNewerFix(incoming, previous, headingProperty) {
    // Retain the accepted observation and the incoming presentation fields.
    const properties = { ...incoming.properties };
    const fields = [...OBSERVATION_FIELDS, headingProperty];
    if (Object.hasOwn(properties, HEADING)) fields.push(HEADING, KNOWN_HEADING);
    for (const key of fields) {
      if (Object.hasOwn(previous.properties || {}, key)) properties[key] = previous.properties[key];
      else delete properties[key];
    }
    return { ...incoming, geometry: previous.geometry, properties };
  }

  function compatiblePoint(feature, previous, typeProperty) {
    return previous && previous.target.properties?.route === feature.properties?.route
      && previous.target.properties?.[typeProperty] === feature.properties?.[typeProperty];
  }

  function nextPoint(feature, previous, time, duration, headingProperty, typeProperty) {
    const observed = timeOf(feature);
    const point = { target: feature, displayed: feature, acceptedAt: time,
      observed, latestObserved: observed, positionMove: null, headingMove: null };
    if (!compatiblePoint(feature, previous, typeProperty)) return point;

    const older = observed < previous.latestObserved;
    if (older) point.target = keepNewerFix(feature, previous.target, headingProperty);
    if (!Number.isFinite(observed) || older) point.latestObserved = previous.latestObserved;

    const previousTarget = previous.target.geometry.coordinates, nextTarget = point.target.geometry.coordinates;
    const sameTarget = samePoint(previousTarget, nextTarget);
    const newerObservation = Number.isFinite(observed) && (!Number.isFinite(previous.observed) || observed > previous.observed);
    if (older || sameTarget && !newerObservation) {
      point.acceptedAt = previous.acceptedAt;
      point.observed = previous.observed;
    }
    point.displayed = point.target;
    if (!duration) return point;

    const elapsed = observed > previous.observed ? observed - previous.observed : time - previous.acceptedAt;
    if (!sameTarget && !allowedMove(previousTarget, nextTarget, elapsed)) return point;

    const from = previous.displayed.geometry.coordinates;
    if (sameTarget) point.positionMove = previous.positionMove;
    else if (!samePoint(from, nextTarget)) point.positionMove = { from, start: time, end: time + duration };

    const heading = headingOf(point.target), fromHeading = headingOf(previous.displayed);
    if (heading === headingOf(previous.target)) point.headingMove = previous.headingMove;
    else if (heading !== null && fromHeading !== null && heading !== fromHeading) {
      point.headingMove = { from: fromHeading, delta: angularDelta(fromHeading, heading), start: time, end: time + duration };
    }
    point.displayed = atPosition(point.target,
      point.positionMove ? from : nextTarget, point.headingMove ? fromHeading : heading);
    return point;
  }

  function advance(point, time) {
    const target = point.target.geometry.coordinates;
    let coordinates = target, heading = headingOf(point.target);
    const position = point.positionMove;
    if (position) {
      if (time >= position.end) point.positionMove = null;
      else {
        const progress = Math.max(0, (time - position.start) / (position.end - position.start));
        const [longitude, latitude] = position.from;
        const interpolated = longitude + angularDelta(longitude, target[0]) * progress;
        coordinates = [((interpolated + 540) % 360) - 180, latitude + (target[1] - latitude) * progress];
      }
    }
    const rotation = point.headingMove;
    if (rotation) {
      if (time >= rotation.end) point.headingMove = null;
      else {
        const progress = Math.max(0, (time - rotation.start) / (rotation.end - rotation.start));
        heading = (rotation.from + rotation.delta * progress + 360) % 360;
      }
    }
    point.displayed = atPosition(point.target, coordinates, heading);
  }

  function create({ onFrame, now = () => root.performance?.now() ?? Date.now(),
    requestFrame = root.requestAnimationFrame?.bind(root), cancelFrame = root.cancelAnimationFrame?.bind(root),
    document = root.document, matchMedia = root.matchMedia?.bind(root),
    headingProperty = "heading", typeProperty = "vehicleType" }) {
    if (typeof onFrame !== "function") throw new TypeError("An animation frame callback is required");
    const preference = matchMedia?.("(prefers-reduced-motion: reduce)");
    let data = null, points = new Map(), slots = [], moving = [], pending = null, lastFrameAt = -Infinity, disposed = false;
    const canAnimate = () => typeof requestFrame === "function" && typeof cancelFrame === "function"
      && document?.hidden !== true && preference?.matches !== true;

    function cancelPending() {
      if (pending !== null) cancelFrame(pending);
      pending = null;
    }

    function finishMoves() {
      for (const point of moving) {
        point.positionMove = point.headingMove = null;
        point.displayed = point.target;
      }
      moving = [];
      cancelPending();
    }

    function publish(time) {
      lastFrameAt = time;
      const features = slots.map((point, index) => point?.displayed ?? data.features[index]);
      const collection = features.some((feature, index) => feature !== data.features[index]) ? { ...data, features } : data;
      try { onFrame(collection); }
      catch (error) { finishMoves(); throw error; }
    }

    function schedule() {
      if (!disposed && moving.length && pending === null) pending = requestFrame(tick);
    }

    function tick() {
      pending = null;
      if (disposed || !moving.length) return;
      const time = now();
      if (!canAnimate()) {
        finishMoves();
        publish(time);
        return;
      }
      if (time - lastFrameAt >= FRAME_MS) {
        for (const point of moving) advance(point, time);
        moving = moving.filter(point => point.positionMove || point.headingMove);
        publish(time);
      }
      schedule();
    }

    function prepare(collection) {
      if (disposed || !points.size || collection?.type !== "FeatureCollection" || !Array.isArray(collection.features)
        || collection.features.length > MAX_FEATURES) return collection;
      let features = null;
      const seen = new Set();
      for (const [index, feature] of collection.features.entries()) {
        const id = identity(feature);
        if (id === undefined || seen.has(id)) continue;
        seen.add(id);
        const previous = points.get(id);
        if (!compatiblePoint(feature, previous, typeProperty) || !(timeOf(feature) < previous.latestObserved)) continue;
        // Keep the newer GPS course before the host chooses a directed or
        // neutral sprite. An older observation cannot change that choice.
        features ??= collection.features.slice();
        features[index] = keepNewerFix(feature, previous.target, headingProperty);
      }
      return features ? { ...collection, features } : collection;
    }

    function update(collection, durationMs) {
      if (disposed) return;
      const time = now();
      const duration = Number.isFinite(durationMs) && canAnimate() ? Math.min(MAX_DURATION_MS, Math.max(0, durationMs)) : 0;
      const oldPoints = points;
      data = collection;
      points = new Map();
      slots = [];
      moving = [];
      // A source larger than the motion budget still gets the full snapshot.
      if (data.features.length > MAX_FEATURES) {
        cancelPending();
        lastFrameAt = time;
        onFrame(data);
        return;
      }
      for (const feature of data.features) {
        const id = identity(feature);
        const point = id === undefined || points.has(id) ? null
          : nextPoint(feature, oldPoints.get(id), time, duration, headingProperty, typeProperty);
        slots.push(point);
        if (!point) continue;
        points.set(id, point);
        if (point.positionMove || point.headingMove) moving.push(point);
      }
      if (!moving.length) cancelPending();
      publish(time);
      schedule();
    }

    function visibilityChanged() {
      if (disposed || !moving.length || canAnimate()) return;
      finishMoves();
      publish(now());
    }

    document?.addEventListener?.("visibilitychange", visibilityChanged);
    preference?.addEventListener?.("change", visibilityChanged);
    function dispose() {
      if (disposed) return;
      disposed = true;
      finishMoves();
      document?.removeEventListener?.("visibilitychange", visibilityChanged);
      preference?.removeEventListener?.("change", visibilityChanged);
      data = null;
      points.clear();
      slots = [];
    }

    return Object.freeze({ prepare, update, dispose });
  }

  root.SloiGeoJsonMotion = Object.freeze({ create });
})(typeof window !== "undefined" ? window : globalThis);
