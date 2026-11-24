import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const code = fs.readFileSync(new URL('../app/src/main/assets/geojson-motion.js', import.meta.url), 'utf8');
const context = { window: {} };
vm.runInNewContext(code, context);
const { create } = context.window.SloiGeoJsonMotion;
const base = 30.32, lat = 59.849, epoch = Date.parse('2026-11-24T22:00:00Z');
const near = (actual, expected) => assert(Math.abs(actual - expected) < 1e-9, `${actual} should be ${expected}`);
function fix(offset, time, { id = 'bus:17', heading = 0, route = '3', sprite = 'sprite-old', receivedAt = time } = {}) {
  return Object.freeze({ type: 'Feature', id, geometry: Object.freeze({ type: 'Point', coordinates: Object.freeze([base + offset, lat]) }),
    properties: Object.freeze({ route, vehicleType: 'bus', rawTimestamp: time === null ? '' : new Date(epoch + time).toISOString(),
      receivedAt, heading, __moduleVehicleHeading: heading ?? 0, __moduleVehicleHeadingKnown: heading !== null, __moduleVehicleBodyImage: sprite,
      __moduleVehicleIconImage: `${sprite}-icon`, __moduleLabelImage: `${sprite}-label` }) });
}
const collection = (...features) => Object.freeze({ type: 'FeatureCollection', features: Object.freeze(features) });

function harness(onFrame = () => {}, options = {}) {
  let time = 0, sequence = 0;
  const frames = [], pending = new Map();
  const document = Object.assign(new EventTarget(), { hidden: false });
  const media = Object.assign(new EventTarget(), { matches: false });
  const motion = create({ ...options, onFrame(data) { frames.push(data); onFrame(data); }, now: () => time, document, matchMedia: () => media,
    requestFrame(callback) { pending.set(++sequence, callback); assert(pending.size <= 1); return sequence; },
    cancelFrame(id) { pending.delete(id); } });
  function step(at) {
    assert(at >= time);
    time = at;
    for (const [id, callback] of [...pending]) {
      pending.delete(id);
      callback(at);
    }
  }
  function update(at, data, duration = 16000) {
    assert(at >= time);
    time = at;
    motion.update(data, duration);
  }
  return { step, update, frames, motion, pending, document, media,
    latest() { return frames.at(-1); }, feature() { return frames.at(-1).features[0]; },
    longitude() { return this.feature().geometry.coordinates[0]; } };
}

// Positions and heading use real fixes. Newly decorated sprites show on the
// first transition frame and retain their IDs throughout the movement.
{
  const h = harness(), first = collection(fix(0, 0, { heading: 359 }));
  const next = collection(fix(.008, 16000, { heading: 1, sprite: 'new' }));
  h.update(0, first);
  assert.equal(h.latest(), first);
  assert.equal(h.pending.size, 0);
  h.update(16000, next, 20000);
  near(h.longitude(), base);
  assert.equal(h.feature().id, 'bus:17');
  assert.equal(h.feature().properties.__moduleVehicleBodyImage, 'new');
  assert.equal(h.feature().properties.__moduleVehicleIconImage, 'new-icon');
  assert.equal(h.feature().properties.__moduleLabelImage, 'new-label');
  assert.equal(h.feature().properties.heading, 1);
  assert.equal(h.feature().properties.__moduleVehicleHeading, 359);
  h.step(16016);
  assert.equal(h.frames.length, 2, 'RAF ticks do not upload more than 30 frames/s');
  h.step(16034);
  assert.equal(h.frames.length, 3);
  h.step(24000);
  near(h.longitude(), base + .004);
  assert.equal(h.feature().properties.heading, 1);
  near(h.feature().properties.__moduleVehicleHeading, 0);
  h.step(32000);
  assert.equal(h.latest(), next);
  assert.equal(h.pending.size, 0);
  h.step(64000);
  assert.equal(h.latest(), next, 'No movement beyond the latest fix');
  assert.equal(first.features[0].geometry.coordinates[0], base);
  assert.equal(next.features[0].properties.heading, 1);
  h.motion.dispose();
}

// An overlapping update continues from the last position sent to the map.
// Repeated or out-of-order fixes retain the original transition clock.
{
  const h = harness();
  h.update(0, collection(fix(0, 0), fix(0, 0, { id: 'to-drop' })));
  h.update(1000, collection(fix(.0004, 1000)), 1000);
  assert.equal(h.latest().features.length, 1);
  h.step(1500);
  near(h.longitude(), base + .0002);
  h.update(1600, collection(fix(.0004, 1000, { sprite: 'restyled' })), 1000);
  near(h.longitude(), base + .0002);
  assert.equal(h.feature().properties.__moduleLabelImage, 'restyled-label');
  h.step(1750);
  near(h.longitude(), base + .0003);
  h.update(1800, collection(fix(0, 0, { sprite: 'slow-response' })), 1000);
  near(h.longitude(), base + .0003);
  assert.equal(h.feature().properties.rawTimestamp, new Date(epoch + 1000).toISOString());
  assert.equal(h.feature().properties.__moduleVehicleBodyImage, 'slow-response');
  h.step(1950);
  const lastDisplayed = h.longitude();
  near(lastDisplayed, base + .00038);
  const updated = collection(fix(.00065, 2000), fix(.005, 2000, { id: 'new' }));
  h.update(1960, updated, 1000);
  near(h.longitude(), lastDisplayed);
  assert.equal(h.latest().features[1], updated.features[1]);
  h.step(2460);
  near(h.longitude(), (lastDisplayed + base + .00065) / 2);
  h.update(2470, collection());
  assert.equal(h.latest().features.length, 0);
  assert.equal(h.pending.size, 0);
  h.motion.dispose();
}

// The host decorates the prepared observation. A stale course must not turn
// the neutral sprite into an arrow, even with a custom source heading field.
{
  const h = harness(undefined, { headingProperty: 'azimuth', typeProperty: 'kind' });
  function raw(offset, time, azimuth, heading = 170, kind = 'bus') {
    const feature = fix(offset, time);
    const properties = { azimuth, heading, kind, route: '3', rawTimestamp: feature.properties.rawTimestamp, color: '#326995' };
    return Object.freeze({ ...feature, properties: Object.freeze(properties) });
  }
  function decorate(data) {
    return collection(...data.features.map(feature => {
      const direction = feature.properties.azimuth;
      const known = Number.isFinite(direction);
      const properties = { ...feature.properties, __moduleVehicleHeading: known ? direction : 0,
        __moduleVehicleHeadingKnown: known, __moduleVehicleBodyImage: known ? 'directed' : 'round' };
      // Layer validation strips null fields.
      if (!known) delete properties.azimuth;
      return { ...feature, properties };
    }));
  }
  h.update(0, decorate(collection(raw(0, 0, 359))));
  h.update(1000, decorate(collection(raw(.0002, 1000, 1, 210))), 1000);
  h.step(1500);
  assert.equal(h.feature().properties.__moduleVehicleHeading, 0);
  assert.equal(h.feature().properties.azimuth, 1);
  assert.equal(h.feature().properties.heading, 210);
  h.update(2000, decorate(collection(raw(.0004, 2000, null))), 1000);
  assert.equal(h.feature().properties.__moduleVehicleBodyImage, 'round');
  assert.equal(h.feature().properties.__moduleVehicleHeading, 0);
  assert.equal(h.feature().properties.__moduleVehicleHeadingKnown, false);

  const stale = collection(raw(.0002, 1000, 270, 130));
  const prepared = h.motion.prepare(stale);
  assert.equal(prepared.features[0].properties.heading, 130, 'An unrelated raw heading is untouched');
  assert.equal(prepared.features[0].properties.azimuth, undefined, 'The accepted fix has no course');
  assert.equal(prepared.features[0].properties.color, stale.features[0].properties.color);
  near(prepared.features[0].geometry.coordinates[0], base + .0004);
  assert.equal(stale.features[0].properties.azimuth, 270);
  h.update(2034, decorate(prepared), 1000);
  assert.equal(h.feature().properties.__moduleVehicleBodyImage, 'round');
  assert.equal(h.feature().properties.__moduleVehicleHeadingKnown, false);
  h.step(3000);
  near(h.longitude(), base + .0004);
  const differentType = collection(raw(.0002, 1000, 270, 130, 'tram'));
  assert.equal(h.motion.prepare(differentType), differentType, 'Changing the configured vehicle type starts a different track');
  h.motion.dispose();
}

// A source that corrects its timezone or cannot provide a reliable timestamp
// gets a consistent observation clock for ordering and speed checks.
{
  const h = harness();
  function adjusted(offset, rawTime, safeTime) {
    const feature = fix(offset, rawTime);
    return { ...feature, properties: { ...feature.properties,
      observationTime: safeTime === null ? '' : new Date(epoch + safeTime).toISOString() } };
  }
  h.update(0, collection(adjusted(0, 10800000, 0)));
  const corrected = collection(adjusted(.004, 16000, 16000));
  assert.equal(h.motion.prepare(corrected), corrected);
  h.update(16000, corrected);
  h.step(24000);
  near(h.longitude(), base + .002);
  const unreliable = collection(adjusted(.005, 1000, null));
  assert.equal(h.motion.prepare(unreliable), unreliable, 'An explicit unknown observation time bypasses the raw timestamp');
  h.update(32000, unreliable);
  h.step(48000);
  near(h.longitude(), base + .005);
  const stale = h.motion.prepare(collection(adjusted(.001, 12000, 12000))).features[0];
  near(stale.geometry.coordinates[0], base + .005);
  assert.equal(stale.properties.observationTime, '');
  h.motion.dispose();
}

// An implausible speed, long jump or reused ID for a different route snaps.
// Without usable GPS timestamps, the monotonic receipt interval still works.
{
  const h = harness();
  h.update(0, collection(fix(0, 0)));
  for (const [at, sample] of [[16000, fix(.05, 16000)], [16100, fix(.051, 16100)],
    [17000, fix(.0511, 17000, { route: '20' })]]) {
    h.update(at, collection(sample));
    assert.equal(h.feature(), sample);
    assert.equal(h.pending.size, 0);
  }
  h.update(18000, collection(fix(.0511, null, { route: '20' })));
  h.update(34000, collection(fix(.0541, null, { route: '20' })));
  h.step(42000);
  near(h.longitude(), base + .0526);
  h.motion.dispose();
}

// Visibility and reduced motion settle the newest fix and prevent future RAF
// work. A disposed instance cannot publish when an old callback is invoked.
{
  const h = harness(), first = collection(fix(0, 0)), second = collection(fix(.003, 16000));
  h.update(0, first);
  h.update(16000, second);
  h.step(20000);
  h.document.hidden = true;
  h.document.dispatchEvent(new Event('visibilitychange'));
  assert.equal(h.latest(), second);
  assert.equal(h.pending.size, 0);
  h.document.hidden = false;
  h.document.dispatchEvent(new Event('visibilitychange'));
  const third = collection(fix(.005, 32000));
  h.update(32000, third);
  h.media.matches = true;
  h.media.dispatchEvent(new Event('change'));
  assert.equal(h.latest(), third);
  assert.equal(h.pending.size, 0);
  const fourth = collection(fix(.006, 48000));
  h.update(48000, fourth);
  assert.equal(h.latest(), fourth);
  h.media.matches = false;
  h.update(64000, collection(fix(.007, 64000)));
  const callback = h.pending.values().next().value;
  assert.equal(typeof callback, 'function');
  h.motion.dispose();
  assert.equal(h.pending.size, 0);
  const frameCount = h.frames.length;
  callback();
  h.update(80000, first);
  assert.equal(h.frames.length, frameCount);
}

// A failing renderer stops the scheduled loop. The no-RAF build still draws
// complete snapshots even with a nonzero transition duration.
{
  let shouldThrow = false;
  const h = harness(() => { if (shouldThrow) throw new Error('source was removed'); });
  h.update(0, collection(fix(0, 0)));
  h.update(16000, collection(fix(.003, 16000)));
  shouldThrow = true;
  assert.throws(() => h.step(18000), /source was removed/);
  assert.equal(h.pending.size, 0);
  h.motion.dispose();

  let actual;
  const motion = create({ onFrame(data) { actual = data; } });
  motion.update(collection(fix(0, 0)), 16000);
  const last = collection(fix(.003, 16000));
  motion.update(last, 16000);
  assert.equal(actual, last);
  motion.dispose();
}

console.log('GeoJSON motion OK: bounded interpolation, custom and unknown heading, stale fix preparation, corrected timestamps, sprite IDs, jump limits, pause and cleanup');
