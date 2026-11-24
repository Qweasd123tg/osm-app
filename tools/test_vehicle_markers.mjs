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
const sandbox={window:{document},AbortController,TextEncoder,setTimeout,clearTimeout};vm.createContext(sandbox);
for(const file of ['layer-runtime.js','vehicle-markers.js','module-host.js'])vm.runInContext(asset(file),sandbox);
const {Host,limits}=sandbox.window.SloiModules,renderer=sandbox.window.SloiVehicleMarkers;
const directed=renderer.body('#123456',true),round=renderer.body('#123456',false);
assert(directed.calls.some(call=>call[0]==='moveTo'&&call[1]===20&&call[2]===1),'North-facing tip');
assert(!round.calls.some(call=>call[0]==='moveTo'),'Unknown direction is a circle');
assert.equal(new Set(['bus','tram','trolley'].map(type=>JSON.stringify(renderer.icon(type).calls))).size,3);
assert.equal(renderer.foreground('#ffffff'),'#1f2937');assert.equal(renderer.foreground('#000000'),'#ffffff');
assert.throws(()=>renderer.body('red',true));assert.throws(()=>renderer.icon('subway'));
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
assert.equal(base.layout['icon-rotation-alignment'],'map');assert.equal(base.layout['icon-pitch-alignment'],'map');assert.equal(icon.layout['icon-rotation-alignment'],'viewport');assert.equal(icon.layout['icon-rotate'],0);
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
render([feature(90)]);host.disable('caps');assert.equal(images.size,1);assert.equal(sources.size,0);assert.equal(layers.size,0);
assert.throws(()=>render([feature(0)]),{name:'AbortError'});host.dispose();
console.log('Vehicle sprites OK: north tip/neutral circle, three glyphs, true map heading/upright icon, opacity/colors, bounded shared textures, heading reuse, overflow visibility and owned cleanup');
