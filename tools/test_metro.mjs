import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const code = fs.readFileSync(new URL('../app/src/main/assets/modules/metro.js', import.meta.url), 'utf8');
const snapshotText = fs.readFileSync(new URL('../app/src/main/assets/modules/metro-spb.json', import.meta.url), 'utf8');
const snapshot = JSON.parse(snapshotText);
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
function create(fetch) {
  const sandbox = { fetch, AbortController, TextDecoder, setTimeout, clearTimeout, console };
  vm.createContext(sandbox); vm.runInContext(code, sandbox);
  return sandbox.SloiMetro;
}
const response = (data = snapshotText, headers = {}) => new Response(data, { status: 200, headers });
const plain = value => JSON.parse(JSON.stringify(value));

// Check the actual shipped snapshot, including current line extensions, closed
// stations and curved source geometry. No network fixture can mask missing data.
assert.equal(Buffer.byteLength(snapshotText) < 128 * 1024, true);
assert.equal(snapshot.license, 'ODbL-1.0');
assert.deepEqual(snapshot.lines.map(line => line.stations.length), [19, 18, 12, 9, 15, 2]);
assert.equal(snapshot.lines.reduce((sum, line) => sum + line.stations.length, 0), 75);
assert.deepEqual(snapshot.lines[5].stations.map(station => station.name), ['Путиловская', 'Юго-Западная']);
assert.equal(snapshot.lines[3].stations[0].name, 'Горный институт');
assert.equal(snapshot.lines[2].stations.filter(station => station.name === 'Зенит').length, 1);
const lomonosovskaya = snapshot.lines[2].stations.find(station => station.name === 'Ломоносовская');
const proletarskaya = snapshot.lines[2].stations.find(station => station.name === 'Пролетарская');
assert.notDeepEqual(lomonosovskaya.coordinates, proletarskaya.coordinates);
assert.deepEqual(snapshot.lines.flatMap(line => line.stations).filter(station => station.closed).map(station => station.name), ['Фрунзенская', 'Парк Победы']);
assert.equal(snapshot.entrances.length, 286);
for (const line of snapshot.lines) {
  assert.match(line.relationId, /^\d+$/);
  assert.equal(line.geometry.type, 'MultiLineString');
  assert.ok(line.geometry.coordinates.flat().length > line.stations.length * 3, `line ${line.id} must preserve geographic source bends`);
  assert.ok(line.geometry.coordinates.flat().every(point => point.length === 2 && point.every(Number.isFinite)));
}

let requests = 0;
const metro = create(async (url, options) => {
  requests++;
  assert.equal(url, 'modules/metro-spb.json');
  assert.equal(options.credentials, 'omit');
  assert.equal(options.redirect, 'error');
  return response();
});
let manifest, factory;
metro.register({ register(value, activate) { manifest = value; factory = activate; } });
assert.equal(manifest.id, 'spb-metro');
assert.deepEqual(plain(manifest.defaults), { entrances: true, selectedLine: '' });
const first = await metro.catalog();
assert.equal(requests, 1);
assert.equal(first.lines.length, 6);
assert.equal(first.lines[0].stations[0].name, 'Девяткино');
assert.equal(first.lines[0].geometry, undefined, 'public UI catalog does not expose drawing payload');
assert.ok(Object.isFrozen(first) && Object.isFrozen(first.lines[0].stations[0].coordinates));
assert.equal(await metro.catalog(), first, 'one immutable cached catalog');
assert.equal(requests, 1);

async function activate(selectedLine = '', entrances = true, signal = new AbortController().signal) {
  const writes = [];
  await factory({ settings: { selectedLine, entrances }, signal, setGeoJson: (...args) => writes.push(args) });
  return writes;
}
let writes = await activate();
assert.deepEqual(writes.map(([id]) => id), ['lines', 'stations', 'entrances']);
assert.deepEqual(writes.map(([, data]) => data.features.length), [6, 75, 286]);
assert.equal(new Set(writes[0][1].features.map(item => item.properties.color)).size, 6);
assert.equal(writes[1][2].pointLabelStyle, 'text');
assert.equal(writes[1][2].colorProperty, 'color');
assert.equal(writes[1][2].pointRadius, 4);
assert.equal(writes[2][2].pointMinZoom, 15);
assert.equal(writes[1][1].features.find(item => item.properties.name === 'Парк Победы').properties.opacity, .5);
assert.equal(writes[0][1].features[5].properties.kind, 'metro_line');
writes = await activate('6', false);
assert.deepEqual(writes.map(([, data]) => data.features.length), [1, 2, 0]);
assert.equal(writes[0][1].features[0].properties.color, '#8b5a35');
assert.ok(writes[1][1].features.every(item => item.properties.line === '6' && item.properties.color === '#8b5a35'));
writes = await activate('4');
assert.equal(writes[1][1].features.length, 9);
assert.ok(writes[2][1].features.every(item => item.properties.line === '4'));
assert.equal(requests, 1, 'switching lines stays offline and uses the single cached snapshot');
await assert.rejects(activate('7'), /Выберите линию/);
await assert.rejects(activate(1), /Выберите линию/);
await assert.rejects(activate('', 'yes'), /Некорректные настройки/);
const alreadyAborted = new AbortController(); alreadyAborted.abort();
await assert.rejects(activate('', true, alreadyAborted.signal), { name: 'AbortError' });
await assert.rejects(metro.catalog({ signal: alreadyAborted.signal }), { name: 'AbortError' });

// Concurrent consumers share the local read, but closing one UI or module must
// not cancel another consumer's read or allow a stale context to write layers.
{
  const waiting = deferred(); let calls = 0, networkSignal;
  const shared = create(async (_, options) => { calls++; networkSignal = options.signal; return waiting.promise; });
  const a = new AbortController(), b = new AbortController();
  const one = shared.catalog({ signal: a.signal }), two = shared.catalog({ signal: b.signal });
  a.abort();
  await assert.rejects(one, { name: 'AbortError' });
  assert.equal(networkSignal.aborted, false);
  waiting.resolve(response());
  assert.equal((await two).lines.length, 6);
  assert.equal(calls, 1);
}
{
  let firstSignal, calls = 0;
  const waiting = deferred();
  const retry = create(async (_, options) => {
    calls++;
    if (calls > 1) return response();
    firstSignal = options.signal;
    firstSignal.addEventListener('abort', () => waiting.reject(Object.assign(new Error('cancel'), { name: 'AbortError' })), { once: true });
    return waiting.promise;
  });
  const controller = new AbortController();
  const abandoned = retry.catalog({ signal: controller.signal }); controller.abort();
  await assert.rejects(abandoned, { name: 'AbortError' });
  assert.equal(firstSignal.aborted, true);
  assert.equal((await retry.catalog()).lines.length, 6);
  assert.equal(calls, 2, 'all-cancelled load permits a fresh retry');
}
{
  const waiting = deferred();
  const stale = create(async () => waiting.promise); let activateStale;
  stale.register({ register(_, factory) { activateStale = factory; } });
  const controller = new AbortController(); let written = false;
  const result = activateStale({ settings: { selectedLine: '', entrances: true }, signal: controller.signal, setGeoJson() { written = true; } });
  controller.abort(); waiting.resolve(response());
  await assert.rejects(result, { name: 'AbortError' });
  assert.equal(written, false);
}

// Corrupt/missing local resources fail explicitly and are not cached. Bound both
// declared and streamed bytes; reject invalid schema/coordinates before host use.
{
  let calls = 0;
  const retry = create(async () => ++calls === 1 ? new Response('', { status: 404 }) : response());
  await assert.rejects(retry.catalog(), /Данные метро повреждены/);
  assert.equal((await retry.catalog()).lines.length, 6);
}
for (const body of ['{', '{}', JSON.stringify({ ...snapshot, version: 9 }), JSON.stringify({ ...snapshot, lines: snapshot.lines.slice(1) })]) {
  const broken = create(async () => response(body));
  await assert.rejects(broken.catalog(), /Данные метро повреждены/);
}
{
  const broken = structuredClone(snapshot); broken.lines[0].stations[0].coordinates = [180, 0];
  await assert.rejects(create(async () => response(JSON.stringify(broken))).catalog(), /Данные метро повреждены/);
}
{
  const broken = structuredClone(snapshot); broken.entrances[0].stationId = 'unknown';
  await assert.rejects(create(async () => response(JSON.stringify(broken))).catalog(), /Данные метро повреждены/);
}
await assert.rejects(create(async () => response(' ', { 'content-length': String(256 * 1024 + 1) })).catalog(), /Данные метро повреждены/);
await assert.rejects(create(async () => response(' '.repeat(256 * 1024 + 1))).catalog(), /Данные метро повреждены/);
await assert.rejects(create(async () => { throw new TypeError('failed fetch'); }).catalog(), /Не удалось открыть данные метро/);
console.log('metro: 6 offline line geometries, 75 ordered stations, colors, selection, entrances, shared cancellation and bounded resource validation passed');
