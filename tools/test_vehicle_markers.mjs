import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const asset=name=>fs.readFileSync(new URL(`../app/src/main/assets/${name}`,import.meta.url),'utf8');
const plain=value=>JSON.parse(JSON.stringify(value));
const document={createElement(tag){
  assert.equal(tag,'canvas');const calls=[];
  const context=new Proxy({getImageData:()=>({width:80,height:80,data:new Uint8Array(4),calls:[...calls]}),measureText:text=>({width:text.length*7})},
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
  if (type === 'metro-plain') continue;
  assert(renderer.icon(type).calls.some(([method,path,rule]) =>
    method==='fill' && path?.data===d && rule===symbol.paths[0].fillRule));
}
assert.equal(symbols.get('constructor'),null);
assert.equal(new Set(Object.keys(references).map(type=>symbols.get(type).paths[0].d)).size,5);
const directed=renderer.body('#123456',true),round=renderer.body('#123456',false);
const circle = round.calls.find(([method]) => method === 'arc');
assert.deepEqual(circle, ['arc', renderer.size / 2, renderer.size / 2, 13.5, 0, Math.PI * 2], 'The badge is centered on the GPS fix');
assert.deepEqual(directed.calls.slice(0, round.calls.length), round.calls, 'Heading does not change the shape of the circle');
assert(!round.calls.some(([method]) => method === 'moveTo'), 'Unknown direction draws only a circle');
const arrow = directed.calls.slice(round.calls.length);
assert.deepEqual(arrow.filter(([method]) => ['beginPath', 'moveTo', 'lineTo', 'closePath'].includes(method)), [
  ['beginPath'], ['moveTo', 20, .9], ['lineTo', 23.9, 4.6], ['lineTo', 16.1, 4.6], ['closePath'],
], 'The north-facing arrow is drawn in a separate path');
const circleStroke = round.calls.find(([method]) => method === 'lineWidth')[1];
const arrowStroke = arrow.find(([method]) => method === 'lineWidth')[1];
assert(20 - circle[3] - circleStroke / 2 - (4.6 + arrowStroke / 2) > .5, 'Space between the stroked shapes stays transparent');
assert.equal(new Set(['bus','tram','trolley'].map(type=>JSON.stringify(renderer.icon(type).calls))).size,3);
const metroGlyph = renderer.icon('metro', '#1f2937').calls;
assert.deepEqual(metroGlyph.find(([method])=>method==='arc'), ['arc',20,20,9.5,0,Math.PI*2]);
assert.deepEqual(metroGlyph.filter(([method])=>method==='fillStyle'), [['fillStyle','#ffffff'],['fillStyle','#000000']]);
assert.deepEqual(renderer.icon('metro','#ffffff').calls, metroGlyph, 'The original monochrome metro palette has no tint variants');
assert.equal(renderer.foreground('#ffffff'),'#1f2937');assert.equal(renderer.foreground('#000000'),'#ffffff');
assert.throws(()=>renderer.body('red',true));assert.throws(()=>renderer.icon('subway'));
const roundedBus = renderer.icon('bus', '#64828c', 'rounded').calls;
const plate = roundedBus.slice(0, roundedBus.findIndex(([method])=>method==='fill') + 1);
assert.deepEqual(plate[1], ['fillStyle', '#64828c']);
assert(plate.some(([method,x,y])=>method==='moveTo' && x===12 && y===8));
assert.deepEqual(plate.filter(([method])=>method==='quadraticCurveTo'), [
  ['quadraticCurveTo',31,8,31,11], ['quadraticCurveTo',31,32,28,32],
  ['quadraticCurveTo',9,32,9,29], ['quadraticCurveTo',9,8,12,8],
]);
assert(roundedBus.some(([method,color])=>method==='fillStyle' && color==='#111820'));
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

const stationOptions = { pointIcon: 'metro', pointMinZoom: 10, pointIconMinZoom: 12, pointIconSize: .65, colorProperty: 'color' };
const stations = {type:'FeatureCollection',features:[
  feature(null, 'bus', '#111111'),
  feature(null, 'bus', '#123456'),
  feature(null, 'bus', '#eeeeee'),
]};
context.setGeoJson('stations', stations, stationOptions);
const stationLayer = layers.get('module-caps:stations-point-icon');
assert.equal(layers.get('module-caps:stations-point').minzoom, 10);
assert.equal(stationLayer.minzoom, 12);
assert.equal(stationLayer.layout['icon-rotation-alignment'], 'viewport');
assert.equal(stationLayer.layout['icon-pitch-alignment'], 'viewport');
assert.equal(stationLayer.layout['icon-rotate'], 0);
const ids = sources.get('module-caps:stations-source').data.features.map(f=>f.properties.__modulePointIconImage);
assert(ids.every(Boolean));
assert.equal(new Set(ids).size, 1, 'Share the official logo across station colors');
assert.deepEqual(images.get(ids[0]).calls, metroGlyph);
assert.throws(()=>context.setGeoJson('bad', stop, {pointIcon:'unsupported'}), /пиктограмма/);
assert.throws(()=>context.setGeoJson('bad', stop, {pointIcon:'bus',pointMarker:'vehicle'}), /пиктограмма/);
assert.throws(()=>context.setGeoJson('bad', stop, {pointIcon:'bus',pointMinZoom:15,pointIconMinZoom:14}), /масштаб/);
assert.throws(()=>context.setGeoJson('bad', stop, {pointIcon:'bus',pointIconSize:1.1}), /размер/);
assert.throws(()=>context.setGeoJson('bad', stop, {pointIcon:'bus',pointIconBackground:'square'}), /фон/);
assert.throws(()=>context.setGeoJson('bad', stop, {pointIcon:'metro',pointIconBackground:'rounded'}), /фон/);
assert.throws(()=>context.setGeoJson('bad', stop, {pointIconBackground:'rounded'}), /фон/);
context.setGeoJson('stations', stations.features[2], {...stationOptions, opacity: .4});
assert.equal(stationLayer.paint['icon-opacity'], .4);
assert(images.has(ids[0]), 'Keep the emblem after a line color changes');
context.setGeoJson('stations', {type:'FeatureCollection',features:[]}, stationOptions);
assert(!images.has(ids[0]), 'Release an emblem unused by all sources');
context.setGeoJson('stations', stations, stationOptions);
const currentMetroId = sources.get('module-caps:stations-source').data.features[0].properties.__modulePointIconImage;
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
assert.equal(renderer.icon('metro'),null);
const circleOnly = context.setGeoJson('stations',stations,stationOptions);
assert(!circleOnly.layerIds.some(id=>id.endsWith('-point-icon')));
assert.equal(layers.get('module-caps:stations-point').type,'circle');
context.setGeoJson('stops',stop,roundedStopOptions);
assert.throws(()=>context.setGeoJson('stops',stop,{...roundedStopOptions,pointIconBackground:'none'}), /без перезапуска/);
assert.equal(host.get('caps').status,'error');
assert.equal(images.size,2,'Rejected layout change releases owned sprites and preserves foreign ones');
host.dispose();
console.log('Vehicle and static point sprites OK: heading, upright glyphs, contrast, zoom, bounds, shared textures and owned cleanup');
