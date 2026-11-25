import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const asset=name=>fs.readFileSync(new URL(`../app/src/main/assets/${name}`,import.meta.url),'utf8');
const plain=value=>JSON.parse(JSON.stringify(value));
const document={createElement(tag){
  assert.equal(tag,'canvas');const calls=[];
  const context=new Proxy({getImageData:(_x,_y,width,height)=>({width,height,data:new Uint8Array(4),calls:[...calls]}),measureText:text=>({width:text.length*7})},
    {get(target,key){if(key in target)return target[key];return (...args)=>calls.push([key,...args]);},set(target,key,value){target[key]=value;calls.push([key,value]);return true;}});
  return {getContext:kind=>{assert.equal(kind,'2d');return context;}};
}};
class Path2D {
  constructor(data) { this.data = data; }
}
const sandbox={window:{document,Path2D},AbortController,TextEncoder,setTimeout,clearTimeout};vm.createContext(sandbox);
for(const file of ['layer-runtime.js','transport-symbols.js','vehicle-markers.js','module-host.js'])vm.runInContext(asset(file),sandbox);
const {Host,limits}=sandbox.window.SloiModules,renderer=sandbox.window.SloiVehicleMarkers;
const symbols = sandbox.window.SloiTransportSymbols;
for (const [devicePixelRatio, ratio] of [[1, 2], [2.4, 3], [3, 3], [4, 3], [NaN, 2], [Infinity, 2]]) {
  const window = { document, Path2D, devicePixelRatio, SloiTransportSymbols: symbols };
  vm.runInNewContext(asset('vehicle-markers.js'), { window });
  const dense = window.SloiVehicleMarkers;
  for (const sprite of [dense.body('#123456', true), dense.icon('bus')]) {
    assert.equal(sprite.width, 40 * ratio, 'Textures use a bounded 2× or 3× resolution');
    assert.equal(sprite.width / dense.pixelRatio, renderer.size, 'Sprite width in CSS pixels stays the same');
    assert.equal(sprite.height / dense.pixelRatio, renderer.size, 'Sprite height in CSS pixels stays the same');
  }
}
const references = {
  bus:'bus.svg', tram:'tram.svg', trolley:'trolley.svg',
  metro:'metro-spb.svg', 'metro-plain':'metro-spb-plain.svg',
};
for (const [type, file] of Object.entries(references)) {
  const svg = asset('vendor/twogis-transport/' + file);
  const [, d] = svg.match(/<path\b[^>]*\bd="([^"]+)"/);
  const symbol = symbols.get(type);
  assert(Object.isFrozen(symbol) && Object.isFrozen(symbol.viewBox) && Object.isFrozen(symbol.paths) && Object.isFrozen(symbol.paths[0]));
  const viewBox = svg.match(/viewBox="([^"]+)"/)[1].split(/\s+/).map(Number);
  assert.deepEqual(plain(symbol), {viewBox, paths:[{d,fillRule:svg.includes('fill-rule="evenodd"')?'evenodd':'nonzero'}]});
}
assert.equal(symbols.get('constructor'),null);
assert.equal(new Set(Object.keys(references).map(type=>symbols.get(type).paths[0].d)).size,5);
for (const type of ['bus','tram','trolley']) {
  const svg = asset(`vendor/twogis-transport/map-${type}.svg`);
  const [, x, y, iconGroup] = svg.match(/<g id="Icon-container-\d+" transform="translate\(([\d.]+), ([\d.]+)\)"[^>]*>([\s\S]*?)<\/g>/);
  const paths = [...iconGroup.matchAll(/<path\b[^>]*\bd="([^"]+)"[^>]*>/g)].map(([tag,d]) =>
    ({d,fillRule:tag.match(/\bfill-rule="([^"]+)"/)?.[1] || 'evenodd'}));
  const symbol = symbols.getMap(type);
  assert.deepEqual(plain(symbol), {viewBox:[-7-Number(x),-7-Number(y),44,44],paths});
  assert.deepEqual(renderer.icon(type).calls.filter(([method])=>method==='fill')
    .map(([,path,fillRule])=>({d:path.data,fillRule})), paths);
}
const directed=renderer.body('#123456',true),round=renderer.body('#123456',false);
const arrowSvg = asset('vendor/twogis-transport/map-vehicle-arrow.svg');
const groups = [...arrowSvg.matchAll(/<g\b[^>]*transform="translate\((\d+), (\d+)\)"[^>]*>([\s\S]*?)<\/g>/g)];
const polygons = groups.flatMap(([, tx, ty, group]) => group.match(/points="([^"]+)"/)[1]
  .split(' ').reduce((commands, _, index, values) => {
    if (index % 2 === 0) commands.push([index ? 'lineTo' : 'moveTo', Number(values[index])+Number(tx), Number(values[index+1])+Number(ty)]);
    return commands;
  }, []));
const circles = groups.map(([, tx, ty, group]) => {
  const [, x, y, radius] = group.match(/cx="(\d+)" cy="(\d+)" r="(\d+)"/);
  return ['arc', Number(x)+Number(tx), Number(y)+Number(ty), Number(radius), 0, Math.PI*2];
});
assert.deepEqual(directed.calls.filter(([method])=>['moveTo','lineTo'].includes(method)),polygons);
assert.deepEqual(directed.calls.filter(([method])=>method==='arc'),circles);
assert.deepEqual(round.calls.filter(([method])=>method==='arc'),circles, 'Unknown direction keeps the same circle');
assert(!round.calls.some(([method])=>method==='moveTo'));
assert.deepEqual(directed.calls.filter(([method])=>method==='strokeStyle'), [['strokeStyle','#ffffff'],['strokeStyle','#123456']]);
assert.equal(new Set(['bus','tram','trolley'].map(type=>JSON.stringify(renderer.icon(type).calls))).size,3);
const metroGlyph = renderer.icon('metro', '#1f2937').calls;
assert.deepEqual(metroGlyph.find(([method])=>method==='arc'), ['arc',20,20,9.5,0,Math.PI*2]);
assert.deepEqual(metroGlyph.filter(([method])=>method==='fillStyle'), [['fillStyle','#ffffff'],['fillStyle','#000000']]);
assert.deepEqual(renderer.icon('metro','#ffffff').calls, metroGlyph, 'The original monochrome metro palette has no tint variants');
const metroEntrance = renderer.icon('metro-plain', '#326995').calls;
assert(!metroEntrance.some(([method])=>method==='arc'), 'The entrance logo has no circular backing');
for (const [file,color] of [['map-metro-spb.svg','#005da8'],['map-metro-spb-night.svg','#326995']]) {
  const svg = asset(`vendor/twogis-transport/${file}`);
  const paths = [...svg.matchAll(/<path d="([^"]+)" fill="([^"]+)"/g)].slice(-2)
    .map(([,d,fill])=>({d,fill,fillRule:'nonzero'}));
  assert.deepEqual(plain(symbols.getMap('metro-plain',color)), {viewBox:[0,0,16,12],paths});
  const calls = renderer.icon('metro-plain',color).calls;
  assert.deepEqual(calls.filter(([method])=>method==='fill').map(([,path])=>path.data),paths.map(({d})=>d));
  assert.deepEqual(calls.filter(([method])=>method==='fillStyle').map(([,fill])=>fill),paths.map(({fill})=>fill));
  assert(calls.some(([method])=>method==='clip'));
}
assert.equal(renderer.foreground('#ffffff'),'#1f2937');assert.equal(renderer.foreground('#000000'),'#ffffff');
for (const fill of ['#1A73F0','#eb5a2b','#e9a300','#c48900']) assert.equal(renderer.foreground(fill),'#ffffff');
assert.throws(()=>renderer.body('red',true));assert.throws(()=>renderer.icon('subway'));
const roundedBus = renderer.icon('bus', '#64828c', 'rounded').calls;
const stopPaths = ['map-stop-back.svg','map-stop-bus.svg'].map(file=>asset(`vendor/twogis-transport/${file}`).match(/<path\b[^>]*\bd="([^"]+)"/)[1]);
assert.deepEqual(roundedBus.filter(([method])=>method==='fill').map(([,path])=>path.data),stopPaths);
assert.deepEqual(roundedBus.filter(([method])=>method==='fillStyle'),
  [['fillStyle','#64828c'],['fillStyle','#202122']]);
assert(renderer.icon('bus','#122132','rounded').calls.some(([method,color])=>method==='fillStyle' && color==='#ffffff'));
const sources=new Map(),layers=new Map(),images=new Map();let context;
const foreign={foreign:true};images.set('module-caps:vehicle-0',foreign);
const map={getCenter:()=>({lng:30.33,lat:59.93}),getZoom:()=>16,getBounds:()=>({getWest:()=>30,getEast:()=>31,getSouth:()=>59,getNorth:()=>60}),
  getSource:id=>sources.get(id),addSource(id,spec){sources.set(id,{...spec,setData(data){this.data=data;}});},removeSource:id=>sources.delete(id),
  getLayer:id=>layers.get(id),addLayer(spec){assert(!layers.has(spec.id));layers.set(spec.id,spec);},removeLayer:id=>layers.delete(id),
  setPaintProperty(id,key,value){layers.get(id).paint[key]=value;},
  hasImage:id=>images.has(id),getImage:id=>images.get(id),addImage(id,data,options){assert(!images.has(id));assert.equal(options.pixelRatio,2);images.set(id,data);},removeImage:id=>images.delete(id),
};
const host=new Host({map});host.register({id:'caps',apiVersion:1,version:'1',title:'Caps',capabilities:['geojson'],defaults:{}},ctx=>{context=ctx;});await host.enable('caps');
const feature=(heading,type='bus',color='#123456')=>({type:'Feature',properties:{heading,vehicleType:type,color,opacity:.65,label:'49'},geometry:{type:'Point',coordinates:[30.33,59.93]}});
const options={pointMarker:'vehicle',pointHeading:'heading',pointType:'vehicleType',color:'#654321',colorProperty:'color',pointOpacity:'opacity',pointMinZoom:12,pointLabelMinZoom:13};
const render=features=>context.setGeoJson('positions',{type:'FeatureCollection',features},options);
render([feature(0),feature(null,'tram'),feature(90,'trolley')]);
const data=()=>sources.get('module-caps:positions-source').data.features;
assert.equal(layers.get('module-caps:positions-point').type,'symbol');assert.equal(layers.get('module-caps:positions-vehicle-icon').type,'symbol');assert.equal(sources.size,1);
const base=layers.get('module-caps:positions-point'),icon=layers.get('module-caps:positions-vehicle-icon');
assert.equal(base.layout['icon-rotation-alignment'],'map');assert.equal(base.layout['icon-pitch-alignment'],'viewport');assert.equal(icon.layout['icon-rotation-alignment'],'viewport');assert.equal(icon.layout['icon-rotate'],0);
assert.deepEqual(plain(base.paint['icon-opacity']),['*',.8,['min',1,['max',0,['to-number',['get','opacity'],1]]]]);
assert.notEqual(data()[0].properties.__moduleVehicleBodyImage,data()[1].properties.__moduleVehicleBodyImage);
assert.equal(data()[0].properties.__moduleVehicleHeading,0);assert.equal(data()[2].properties.__moduleVehicleHeading,90);
assert.equal(new Set(data().map(f=>f.properties.__moduleVehicleIconImage)).size,3);
const count=images.size;
for(let heading=0;heading<360;heading+=5)render([feature(heading),feature(null,'tram'),feature(heading,'trolley')]);
assert.equal(images.size,count,'Heading changes reuse sprites instead of allocating rotated bitmaps');
assert.throws(()=>context.setGeoJson('bad',{type:'FeatureCollection',features:[]},{pointMarker:'bad'}),/маркер/);
assert.throws(()=>context.setGeoJson('bad',{type:'FeatureCollection',features:[]},{pointMarker:'vehicle',pointHeading:'x;injection'}),/поле/);
render([null,-1,360,'90'].map(h=>feature(h)));
assert(data().every(f=>f.properties.__moduleVehicleHeading===0));assert.equal(new Set(data().map(f=>f.properties.__moduleVehicleBodyImage)).size,1);
// Many imported colors cannot exhaust all marker bodies or remove foreign images.
render(Array.from({length:160},(_,i)=>feature(i%360,'bus',`#${(0x220000+i*631).toString(16).padStart(6,'0')}`)));
assert(host.entry('caps').session.vehicleImages.size<=limits.maxVehicleImages);
assert(data().every(f=>f.properties.__moduleVehicleBodyImage),'Budget overflow retains a fallback marker');
assert.equal(images.get('module-caps:vehicle-0'),foreign);
render([]);assert.equal(images.size,1);assert.equal(images.get('module-caps:vehicle-0'),foreign);
render([feature(90)]);
const stopOptions = { pointIcon: 'bus', pointMinZoom: 15, color: '#123456', colorProperty: 'color', pointOpacity: 'opacity', opacity: .6 };
const stop = feature(null);
const { layerIds } = context.setGeoJson('stops', stop, stopOptions);
const stopLayer = 'module-caps:stops-point-icon';
assert(layerIds.includes(stopLayer));
assert.equal(layers.get('module-caps:stops-point').type, 'circle');
assert.equal(layers.get('module-caps:stops-point').paint['circle-pitch-alignment'], 'viewport');
assert.equal(layers.get('module-caps:stops-point').paint['circle-pitch-scale'], 'viewport');
assert.equal(layers.get(stopLayer).minzoom, 15, 'Default icon zoom matches the point');
assert.equal(layers.get(stopLayer).layout['icon-size'], .65);
assert.deepEqual(plain(layers.get(stopLayer).paint['icon-opacity']), ['*', .6, ['min', 1, ['max', 0, ['to-number', ['get', 'opacity'], 1]]]]);
assert.equal(sources.get('module-caps:stops-source').data.features[0].properties.__modulePointIconImage,
  data()[0].properties.__moduleVehicleIconImage, 'Static bus icon reuses the existing sprite');
assert.equal(stop.properties.__modulePointIconImage, undefined, 'Input data is not mutated');
const brightStop = feature(null, 'bus', '#eeeeee');
context.setGeoJson('stops', brightStop, stopOptions);
const brightStopId = sources.get('module-caps:stops-source').data.features[0].properties.__modulePointIconImage;
assert(images.get(brightStopId).calls.some(([method,color])=>method==='fillStyle' && color==='#1f2937'));
const roundedStopOptions = { ...stopOptions, pointIconBackground: 'rounded', pointIconSize: .5 };
const roundedStops = {type:'FeatureCollection',features:[
  feature(null, 'bus', '#64828C'),
  feature(null, 'bus', '#64828c'),
  feature(null, 'bus', '#122132'),
]};
context.setGeoJson('rounded-stops', roundedStops, roundedStopOptions);
const roundedStopIds = sources.get('module-caps:rounded-stops-source').data.features.map(f=>f.properties.__modulePointIconImage);
assert(roundedStopIds.every(Boolean));
assert.equal(roundedStopIds[0], roundedStopIds[1], 'The same plate color reuses a sprite after color normalization');
assert.notEqual(roundedStopIds[0], roundedStopIds[2], 'Different plate colors retain their own images');
assert.notEqual(roundedStopIds[0], brightStopId, 'A rounded plate never replaces a transparent icon');
assert.deepEqual(images.get(roundedStopIds[0]).calls, roundedBus);
assert.equal(layers.get('module-caps:rounded-stops-point-icon').layout['icon-size'], .5);

const entranceOptions = { pointIcon: 'metro-plain', pointMinZoom: 15, pointIconSize: 1, color: '#326995' };
const entrances = {type:'FeatureCollection',features:[
  feature(null, 'bus', '#111111'),
  feature(null, 'bus', '#123456'),
  feature(null, 'bus', '#eeeeee'),
]};
context.setGeoJson('entrances', entrances, entranceOptions);
const entranceLayer = layers.get('module-caps:entrances-point-icon');
const entranceCircle = layers.get('module-caps:entrances-point');
assert.equal(entranceCircle.minzoom, 15);
assert.equal(entranceLayer.minzoom, 15);
assert.equal(entranceLayer.layout['icon-size'], 1);
assert.equal(entranceLayer.layout['icon-rotation-alignment'], 'viewport');
assert.equal(entranceLayer.layout['icon-pitch-alignment'], 'viewport');
assert.equal(entranceLayer.layout['icon-rotate'], 0);
const ids = sources.get('module-caps:entrances-source').data.features.map(f=>f.properties.__modulePointIconImage);
assert(ids.every(Boolean));
assert.equal(new Set(ids).size, 1, 'Entrances share the same blue emblem');
assert.deepEqual(images.get(ids[0]).calls, metroEntrance);
assert.deepEqual(plain(entranceCircle.paint['circle-opacity']),
  ['step', ['zoom'], .8, 15, ['case', ['==', ['get', '__modulePointIconImage'], ''], .8, 0]]);
context.setGeoJson('entrances', stop, {...entranceOptions, opacity: .4});
assert.deepEqual(plain(entranceCircle.paint['circle-stroke-opacity']),
  ['step', ['zoom'], .4, 15, ['case', ['==', ['get', '__modulePointIconImage'], ''], .4, 0]]);
assert.equal(entranceLayer.paint['icon-opacity'], .4);
assert(images.has(ids[0]), 'An opacity change keeps the same texture');
assert.throws(()=>context.setGeoJson('bad', stop, {pointIcon:'unsupported'}), /пиктограмма/);
assert.throws(()=>context.setGeoJson('bad', stop, {pointIcon:'bus',pointMarker:'vehicle'}), /пиктограмма/);
assert.throws(()=>context.setGeoJson('bad', stop, {pointIcon:'bus',pointMinZoom:15,pointIconMinZoom:14}), /масштаб/);
assert.throws(()=>context.setGeoJson('bad', stop, {pointIcon:'bus',pointIconSize:1.1}), /размер/);
assert.throws(()=>context.setGeoJson('bad', stop, {pointIcon:'bus',pointIconBackground:'square'}), /фон/);
assert.throws(()=>context.setGeoJson('bad', stop, {pointIcon:'metro',pointIconBackground:'rounded'}), /фон/);
assert.throws(()=>context.setGeoJson('bad', stop, {pointIcon:'metro-plain',pointIconBackground:'rounded'}), /фон/);
assert.throws(()=>context.setGeoJson('bad', stop, {pointIconBackground:'rounded'}), /фон/);
context.setGeoJson('entrances', {type:'FeatureCollection',features:[]}, entranceOptions);
assert(!images.has(ids[0]), 'Release an emblem unused by all sources');
context.setGeoJson('entrances', {type:'FeatureCollection',features:Array.from({length:70},(_,i)=>
  feature(null, 'bus', `#${(0x326900+i).toString(16)}`))}, {...entranceOptions, colorProperty:'color'});
const crowdedEntrances = sources.get('module-caps:entrances-source').data.features;
assert(crowdedEntrances.some(f=>f.properties.__modulePointIconImage===''), 'At the texture limit some features retain only the fallback point');
assert.equal(host.entry('caps').session.vehicleImages.size, limits.maxVehicleImages);
context.setGeoJson('entrances', entrances, entranceOptions);
const currentMetroId = sources.get('module-caps:entrances-source').data.features[0].properties.__modulePointIconImage;
render([]);
assert(images.has(sources.get('module-caps:stops-source').data.features[0].properties.__modulePointIconImage),
  'Clearing the vehicle source does not remove a sprite used by stops');
const replacement = { foreign: true };
images.set(currentMetroId, replacement);
host.disable('caps');
assert.equal(images.size,2); assert.equal(images.get(currentMetroId),replacement); assert.equal(images.get('module-caps:vehicle-0'),foreign);
assert.equal(sources.size,0);assert.equal(layers.size,0);
assert.throws(()=>render([feature(0)]),{name:'AbortError'});
sandbox.window.Path2D = undefined;
await host.enable('caps');
assert.equal(renderer.icon('metro-plain'),null);
const entranceFallback = context.setGeoJson('entrances',stop,entranceOptions);
assert(!entranceFallback.layerIds.some(id=>id.endsWith('-point-icon')));
assert.equal(layers.get('module-caps:entrances-point').type,'circle');
assert.equal(layers.get('module-caps:entrances-point').paint['circle-opacity'], .8);
context.setGeoJson('stops',stop,roundedStopOptions);
assert.throws(()=>context.setGeoJson('stops',stop,{...roundedStopOptions,pointIconBackground:'none'}), /без перезапуска/);
assert.equal(host.get('caps').status,'error');
assert.equal(images.size,2,'Rejected layout change releases owned sprites and preserves foreign ones');
host.dispose();
// A transport number and a generic badge may share text/color in one module.
// Their different sizes must never collide in the image cache.
let labelContext;
const labelHost = new Host({map});
labelHost.register({id:'label-proof',apiVersion:1,version:'1',title:'Labels',capabilities:['geojson'],defaults:{}},ctx=>{labelContext=ctx});
await labelHost.enable('label-proof');
for (const [id, style] of [['standard','badge'],['transport','vehicle']]) {
  labelContext.setGeoJson(id, {type:'FeatureCollection',features:[stop]}, {pointLabel:'label',pointLabelStyle:style,color:'#123456'});
}
const standardId=sources.get('module-label-proof:standard-source').data.features[0].properties.__moduleLabelImage;
const transportId=sources.get('module-label-proof:transport-source').data.features[0].properties.__moduleLabelImage;
assert.notEqual(standardId,transportId,'Badge style is part of the cache key');
assert.equal(labelHost.entry('label-proof').session.labelImages.size,2);
labelHost.dispose();assert.equal(sources.size,0);assert.equal(images.size,2);
console.log('Vehicle and static point sprites OK: heading, upright glyphs, contrast, zoom, bounds, shared textures and owned cleanup');
