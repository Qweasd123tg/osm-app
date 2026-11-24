import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = fs.readFileSync(path.join(root, 'app/src/main/assets/basemap.js'), 'utf8');
const context = { window: { location: { href: 'https://appassets.androidplatform.net/assets/index.html' } }, URL };
vm.createContext(context);
new vm.Script(source, { filename: 'basemap.js' }).runInContext(context);
const api = context.window.SloiBasemap;
const plain = (value) => JSON.parse(JSON.stringify(value));
const light = api.createStyle();
const dark = api.createStyle('dark');
assert.equal(light.version, 8);
assert.deepEqual(Object.keys(light.sources), ['openmaptiles']);
assert.equal(light.sources.openmaptiles.type, 'vector');
assert.equal(light.sources.openmaptiles.url, 'https://tiles.openfreemap.org/planet');
assert.equal(light.sprite, 'https://appassets.androidplatform.net/assets/vendor/ofm-sprite');
assert.equal(light.glyphs, 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf');
assert.equal(new Set(light.layers.map((layer) => layer.id)).size, light.layers.length);
assert.ok(light.layers.length > 80);
function luminance(hex) {
  const rgb=hex.slice(1).match(/../g).map(x=>parseInt(x,16)/255).map(x=>x<=.04045?x/12.92:((x+.055)/1.055)**2.4);
  return .2126*rgb[0]+.7152*rgb[1]+.0722*rgb[2];
}
const contrast=(a,b)=>(Math.max(luminance(a),luminance(b))+.05)/(Math.min(luminance(a),luminance(b))+.05);
for(const theme of ['light','dark']) {
  const layers=api.createStyle(theme).layers;
  const ground=layers.find(l=>l.id===`base-${theme}:background`).paint['background-color'];
  const road=layers.find(l=>l.id===`base-${theme}:highway_major_inner`).paint['line-color'];
  assert(contrast(road,ground)<2.1,`${theme} roads should recede behind the selected route`);
  assert(contrast(theme==='dark'?'#f0ad4e':'#396cc4',ground)>contrast(road,ground)*1.5,'Route colors remain more prominent');
  assert.notEqual(road,'#ffffff');
}
for (const style of [light, dark]) for (const layer of style.layers) {
  assert.ok(layer.id.startsWith('base-light:') || layer.id.startsWith('base-dark:'));
  assert.notEqual(layer.type, 'raster');
  if (layer.source) assert.equal(layer.source, 'openmaptiles');
  assert.notEqual(layer['source-layer'], 'poi');
  assert.equal(layer.layout.visibility, layer.metadata['sloi:basemap-theme'] === (style === light ? 'light' : 'dark') ? 'visible' : 'none');
  if (layer.layout['text-field']?.[0] === 'coalesce') assert.deepEqual(plain(layer.layout['text-field'][1]), ['get', 'name:ru']);
}
// Returned styles are independent even when the map mutates its own style.
light.layers[0].paint['background-color'] = 'red';
light.sources.openmaptiles.url = 'https://invalid.example/';
assert.notEqual(api.createStyle().layers[0].paint['background-color'], 'red');
assert.equal(api.createStyle().sources.openmaptiles.url, 'https://tiles.openfreemap.org/planet');
const style = api.createStyle();
const hidden = style.layers.find((layer) => layer.id.startsWith('base-dark:'));
hidden.metadata['sloi:basemap-visibility'] = 'none';
style.layers.push({ id: 'custom-route', layout: { visibility: 'visible' } });
style.layers.push({ id: 'base-dark:foreign', layout: { visibility: 'none' } });
let writes = 0;
const map = {
  getStyle: () => style,
  getLayoutProperty: (id, property) => style.layers.find((layer) => layer.id === id).layout[property],
  setLayoutProperty(id, property, value) { writes++; style.layers.find((layer) => layer.id === id).layout[property] = value; },
};
api.applyTheme(map, 'dark');
assert.ok(writes > 0);
assert.equal(map.getLayoutProperty(hidden.id, 'visibility'), 'none');
assert.equal(map.getLayoutProperty('custom-route', 'visibility'), 'visible');
assert.equal(map.getLayoutProperty('base-dark:foreign', 'visibility'), 'none');
const firstWrites = writes;
api.applyTheme(map, 'dark');
assert.equal(writes, firstWrites, 'Unchanged theme must not issue paint/layout work');
api.applyTheme(map, 'light');
assert.equal(style.layers.find((layer) => layer.id.startsWith('base-light:')).layout.visibility, 'visible');
for (const suffix of ['.json', '@2x.json']) {
  const sprite = JSON.parse(fs.readFileSync(path.join(root, `app/src/main/assets/vendor/ofm-sprite${suffix}`), 'utf8'));
  assert.ok(Object.keys(sprite).length > 50);
}
for (const suffix of ['.png', '@2x.png']) {
  const png = fs.readFileSync(path.join(root, `app/src/main/assets/vendor/ofm-sprite${suffix}`));
  assert.equal(png.readUInt32BE(0), 0x89504e47);
}
console.log('Basemap OK: vector-only shared source, independent styles, owned theme groups, preserved hidden/custom layers, local sprites');
