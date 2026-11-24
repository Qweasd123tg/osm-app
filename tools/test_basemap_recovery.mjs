import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const code = fs.readFileSync(new URL('../app/src/main/assets/basemap-recovery.js', import.meta.url), 'utf8');
const ONLINE_URL = 'https://tiles.openfreemap.org/planet';
const TILE_URL = `${ONLINE_URL}/20261122_124456_pt/14/9572/4764.pbf`;
const LOCAL_URL = 'https://appassets.androidplatform.net/basemap/p-test/tilejson.json';
const SOURCE = 'openmaptiles';

function events() {
  const handlers = new Map();
  function add(type, handler) {
    if (!handlers.has(type)) handlers.set(type, new Set());
    handlers.get(type).add(handler);
  }
  function remove(type, handler) { handlers.get(type)?.delete(handler); }
  return {
    on: add, off: remove, addEventListener: add, removeEventListener: remove,
    emit(type, event = {}) { for (const handler of [...(handlers.get(type) || [])]) handler(event); },
    size() { return [...handlers.values()].reduce((count, list) => count + list.size, 0); },
  };
}

function harness({ onReload = () => {}, online = true } = {}) {
  let now = 0, sequence = 0;
  const timers = new Map(), reloads = [];
  const document = { ...events(), hidden: false };
  const window = {
    ...events(), document, navigator: { onLine: online },
    setTimeout(callback, delay) {
      const id = ++sequence;
      timers.set(id, { callback, due: now + delay });
      assert(timers.size <= 1, 'Only one retry may be scheduled');
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
  };
  const cache = { _tiles: { a: { state: 'loaded' }, b: { state: 'loaded' } } };
  const map = {
    ...events(), style: { sourceCaches: { [SOURCE]: cache } },
    bounds: [[30.32, 59.92], [30.34, 59.94]],
    getBounds() { return { toArray: () => this.bounds }; },
    getSource(id) { assert.equal(id, SOURCE); return this.source; },
    isSourceLoaded(id) { assert.equal(id, SOURCE); return true; },
    isMoving() { return false; },
  };
  function makeSource(url) {
    return {
      url, ready: true,
      serialize() { return { url: this.url }; },
      loaded() { return this.ready; },
      setUrl(next) {
        this.url = next;
        this.ready = false;
        map.emit('sourcedataloading', { sourceId: SOURCE });
        reloads.push({ time: now, source: this, url: next });
        onReload(api);
      },
    };
  }
  function fail(error = { status: 503, url: TILE_URL }, event = { sourceId: SOURCE }) {
    cache._tiles.b.state = 'errored';
    map.emit('error', { ...event, tile: cache._tiles.b, error });
  }
  function succeed() {
    map.source.ready = true;
    cache._tiles.b.state = 'loaded';
    map.emit('sourcedata', { sourceId: SOURCE });
    map.emit('idle');
  }
  function advance(ms) {
    const target = now + ms;
    for (;;) {
      const next = [...timers].sort((a, b) => a[1].due - b[1].due)[0];
      if (!next || next[1].due > target) break;
      now = next[1].due;
      timers.delete(next[0]);
      next[1].callback();
    }
    now = target;
  }
  function hide(hidden) { document.hidden = hidden; document.emit('visibilitychange'); }
  function setNetwork(online) { window.navigator.onLine = online; window.emit(online ? 'online' : 'offline'); }
  map.source = makeSource(ONLINE_URL);
  vm.runInNewContext(code, { window, URL });
  const dispose = window.SloiBasemapRecovery.install({ map, document });
  const api = { map, document, window, reloads, timers, cache, dispose, makeSource, fail, succeed, advance, hide, setNetwork };
  return api;
}

{
  const h = harness({ onReload: fixture => fixture.succeed() });
  h.fail();
  h.fail();
  h.advance(1999);
  assert.equal(h.reloads.length, 0);
  h.advance(1);
  assert.deepEqual(h.reloads, [{ time: 2000, source: h.map.source, url: ONLINE_URL }]);
  h.advance(60000);
  assert.equal(h.reloads.length, 1);
  h.fail({ name: 'TypeError', message: 'Failed to fetch' });
  h.advance(2000);
  assert.equal(h.reloads.length, 2, 'A later outage receives a fresh budget');
  h.dispose();
}

{
  const h = harness({ onReload: fixture => fixture.fail() });
  h.fail();
  h.advance(60000);
  assert.deepEqual(h.reloads.map(reload => reload.time), [2000, 8000, 23000]);
  h.map.emit('movestart');
  h.map.emit('moveend');
  h.fail();
  h.advance(60000);
  assert.equal(h.reloads.length, 3, 'A no-op movement cannot restart the budget');
  h.map.emit('movestart');
  h.map.bounds = [[30.34, 59.92], [30.36, 59.94]];
  h.map.emit('moveend');
  h.advance(2000);
  assert.equal(h.reloads.length, 4, 'A new viewport receives a fresh budget');
  h.dispose();
}

{
  const h = harness({ onReload: fixture => fixture.succeed() });
  h.fail();
  h.hide(true);
  h.advance(60000);
  assert.equal(h.reloads.length, 0);
  h.setNetwork(false);
  h.hide(false);
  h.advance(60000);
  assert.equal(h.reloads.length, 0);
  h.setNetwork(true);
  h.advance(2000);
  assert.equal(h.reloads.length, 1);

  h.fail();
  h.map.emit('movestart');
  h.advance(60000);
  assert.equal(h.reloads.length, 1);
  h.map.emit('moveend');
  h.succeed();
  h.advance(2000);
  assert.equal(h.reloads.length, 1, 'Fresh tiles can finish before a pending retry');
  h.dispose();
}

{
  const h = harness();
  h.fail();
  h.map.source.url = LOCAL_URL;
  h.map.emit('sourcedataloading', { sourceId: SOURCE });
  assert.equal(h.timers.size, 0);
  h.fail();
  h.advance(2000);
  assert.equal(h.reloads.length, 0, 'An offline package must never be refreshed by this helper');
  h.map.source = h.makeSource(ONLINE_URL);
  h.fail();
  h.map.source = h.makeSource(ONLINE_URL);
  h.advance(2000);
  assert.equal(h.reloads.length, 0, 'A pending retry must not touch a replacement source');
  h.fail();
  h.map.source.setUrl(ONLINE_URL);
  h.advance(2000);
  assert.equal(h.reloads.length, 1, 'A manual same-URL reload supersedes the pending retry');
  h.fail();
  h.map.emit('remove');
  h.advance(60000);
  assert.equal(h.reloads.length, 1);
  assert.equal(h.map.size() + h.document.size() + h.window.size() + h.timers.size, 0);
  h.dispose();
}

{
  const h = harness();
  for (const error of [{ status: 404, url: TILE_URL }, { status: 403, url: TILE_URL },
    { name: 'SyntaxError', message: 'Unexpected end of JSON input' },
    { name: 'AbortError', message: 'Failed to fetch' },
    { status: 503, url: `${ONLINE_URL}/../fonts/font.pbf` }, { status: 503, url: LOCAL_URL }]) h.fail(error);
  h.fail({ status: 503, url: TILE_URL }, { sourceId: 'spb-live' });
  h.fail({ status: 503, url: 'https://tiles.openfreemap.org.example/planet' }, {});
  h.fail({ name: 'TypeError', message: 'Failed to fetch' }, {});
  h.advance(60000);
  assert.equal(h.reloads.length, 0, 'Scoped recovery must ignore permanent and unrelated errors');

  h.fail({ status: 429, url: TILE_URL }, {});
  h.advance(2000);
  assert.equal(h.reloads.length, 1, 'A precise CDN URL can identify a tile error without a source ID');
  h.dispose();
}

{
  const h = harness({ onReload: fixture => fixture.fail(), online: false });
  h.fail();
  h.advance(60000);
  assert.equal(h.reloads.length, 0);
  h.setNetwork(true);
  h.advance(60000);
  assert.equal(h.reloads.length, 3);
  h.setNetwork(true);
  h.advance(60000);
  assert.equal(h.reloads.length, 3);
  h.setNetwork(false);
  h.setNetwork(true);
  h.advance(2000);
  assert.equal(h.reloads.length, 4, 'A real offline→online transition permits another recovery');
  h.dispose();
}

console.log('Basemap recovery OK: transient failures retry with bounded delays, healthy tiles and superseded sources cancel, offline and hidden pauses, cleanup');
