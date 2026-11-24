import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {fileURLToPath} from 'node:url';
const source=name=>fs.readFileSync(fileURLToPath(new URL(`../app/src/main/assets/${name}`,import.meta.url)),'utf8');
const plain=value=>JSON.parse(JSON.stringify(value));
const AT=Date.parse('2026-11-17T13:22:37Z');
const vehicle=(id,type='bus',route='49',time='2026-11-17T13:22:29Z',longitude=30.33)=>({VehicleId:id,RouteId:1278,Location:{Longitude:longitude,Latitude:59.93},TransportType:type,RouteShortName:route,Direction:341,RouteDirection:0,DateTime:time});
const response=(data,status=200,headers={})=>new Response(JSON.stringify(data),{status,headers:{'content-type':'application/json','date':new Date(AT).toUTCString(),...headers}});
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const flush=async()=>{for(let i=0;i<20;i++)await tick();};
function harness(fetch, canvasLabels=false) {
  let now=AT,nextId=0;
  const timers=new Map(),visibility=new Set(),requests=[];
  class Clock extends Date { static now(){return now;} }
  const document={hidden:false,addEventListener(type,fn){assert.equal(type,'visibilitychange');visibility.add(fn);},removeEventListener(type,fn){visibility.delete(fn);}};
  if(canvasLabels)document.createElement=type=>{
    assert.equal(type,'canvas');const context={measureText:text=>({width:text.length*7}),scale(){},beginPath(){},moveTo(){},lineTo(){},quadraticCurveTo(){},fill(){},fillText(){},getImageData:()=>({data:new Uint8Array(4),width:1,height:1})};
    return {getContext:kind=>{assert.equal(kind,'2d');return context;}};
  };
  const window={document,fetch:async(url,options)=>{requests.push({url,options});return fetch(url,options,requests.length);}};
  const sandbox={window,Date:Clock,AbortController,URL,URLSearchParams,TextDecoder,TextEncoder,console,
    setTimeout(fn,delay){const id=++nextId;timers.set(id,{fn,time:now+delay,delay});return id;},clearTimeout(id){timers.delete(id);}};
  vm.createContext(sandbox);
  for(const file of ['layer-runtime.js','module-host.js','modules/live-transport.js'])vm.runInContext(source(file),sandbox);
  const layers=new Map([['selected-location',{id:'selected-location'}]]),sources=new Map(),images=new Map(),moves=new Set();
  const map={bounds:[[30.31,59.92],[30.345,59.94]],zoom:15,
    getCenter:()=>({lng:30.33,lat:59.93}),getZoom(){return this.zoom;},
    getBounds(){const b=this.bounds;return {getWest:()=>b[0][0],getSouth:()=>b[0][1],getEast:()=>b[1][0],getNorth:()=>b[1][1]};},
    addSource(id,spec){assert(!sources.has(id));sources.set(id,{...spec,setData(data){this.data=data;}});},getSource:id=>sources.get(id),removeSource:id=>sources.delete(id),
    addLayer(layer,anchor){assert.equal(anchor,'selected-location');assert(!layers.has(layer.id));layers.set(layer.id,layer);},getLayer:id=>layers.get(id),removeLayer:id=>layers.delete(id),
    setPaintProperty(id,key,value){layers.get(id).paint[key]=value;},on(type,fn){assert.equal(type,'moveend');moves.add(fn);},off(_type,fn){moves.delete(fn);},move(){for(const fn of moves)fn();}};
  if(canvasLabels)Object.assign(map,{hasImage:id=>images.has(id),addImage(id,image){assert(!images.has(id));images.set(id,image);},removeImage:id=>images.delete(id)});
  const host=new window.SloiModules.Host({map});window.SloiLiveTransport.register(host);
  return {api:window.SloiLiveTransport,host,map,sources,layers,images,requests,timers,visibility,document,
    async advance(ms){const target=now+ms;for(let attempts=0;attempts<100;attempts++){const due=[...timers].filter(([,t])=>t.time<=target).sort((a,b)=>a[1].time-b[1].time)[0];if(!due)break;now=due[1].time;timers.delete(due[0]);due[1].fn();await flush();}now=target;await flush();},
    async hide(value){document.hidden=value;for(const fn of [...visibility])fn();await flush();},
    data(type='bus'){return sources.get(`module-spb-live:${type}-source`)?.data;}};
}

// The real module starts silently disabled and respects the official NE/SW bbox.
let h=harness(async()=>response([vehicle(1)]));
assert.equal(h.requests.length,0);assert.equal(h.host.get('spb-live').enabled,false);
await h.host.enable('spb-live');
assert.equal(h.host.get('spb-live').status,'ready');assert.equal(h.requests.length,1);
let request=new URL(h.requests[0].url);
assert.equal(request.pathname,'/api/visary/geometry/vehicle');assert.equal(request.searchParams.get('bbox'),'30.34500,59.94000,30.31000,59.92000');
assert.equal(request.searchParams.get('transport'),'bus,tram,trolley');assert.equal(h.requests[0].options.cache,'no-store');
assert.equal(h.sources.size,3);assert.equal(h.layers.size,13);assert.equal(h.data().features[0].properties.name,'49 · Автобус');
assert.equal(h.data().features[0].properties.label,'49');assert.equal(h.data().features[0].properties.color,'#b76c18');
assert.equal(h.data().features[0].properties.kind,'vehicle');assert.equal(h.data().features[0].properties.timeConfirmed,true);
assert.equal(h.data().features[0].properties.statusText,'Позиция от 16:22:29 · Получено 16:22:37 · Курс 341°');
assert.equal(h.layers.get('module-spb-live:bus-label').layout['text-field'][1][1],'label');
assert.equal(h.layers.get('module-spb-live:bus-point').minzoom,12);
assert.equal(h.layers.get('module-spb-live:bus-label').minzoom,13);
assert.deepEqual(plain(h.layers.get('module-spb-live:bus-point').paint['circle-opacity']),['*',1,['min',1,['max',0,['to-number',['get','opacity'],1]]]]);
await h.advance(15999);assert.equal(h.requests.length,1);
await h.advance(1);assert.equal(h.requests.length,2,'Positions are re-fetched, not cached for five minutes');
await h.host.configure('spb-live',{route:'4а',tram:false,trolley:false});
request=new URL(h.requests.at(-1).url);assert.equal(request.searchParams.get('transport'),'bus');assert.equal(h.data().features.length,0,'A route filter cannot leak another route');
await h.host.configure('spb-live',{bus:false});assert.equal(h.data().features.length,0);const count=h.requests.length;
await h.advance(64000);assert.equal(h.requests.length,count,'All types off must not poll');h.host.dispose();assert.equal(h.layers.size,1);assert.equal(h.visibility.size,0);

// Clock-anomalous data remains unconfirmed, and a stale record is not revived
// merely because it arrived in the same successful HTTP response as fresh ones.
h=harness(async()=>response([]));
const bounds=[[30.31,59.92],[30.345,59.94]],types=['bus','tram','trolley'];
let parsed=h.api.normalizeVehicles([
  vehicle(1,'bus','49','2026-11-17T16:22:29Z'),vehicle(2,'trolley','17','2026-11-17T16:00:33Z'),
  vehicle(3,'tram','3','2026-11-17T16:21:00Z'),vehicle(4,'subway','1'),vehicle(5,'bus','49','2026-11-17T16:22:29Z',40),
  vehicle(1,'bus','49','2026-11-17T16:22:29Z'),
],{bounds,types,receivedAt:AT,referenceTime:AT});
assert.equal(parsed.bus.features.length,1);assert.equal(parsed.trolley.features.length,0,'25-minute-old trolley must not look current');
assert.equal(parsed.bus.features[0].properties.timeConfirmed,false);assert.match(parsed.bus.features[0].properties.statusText,/не подтверждено/);
assert.equal(parsed.tram.features[0].properties.opacity,.4);
parsed=h.api.normalizeVehicles([vehicle(1,'bus','4А'),vehicle(2,'bus','49')],{bounds,types,route:'4а',receivedAt:AT});
assert.equal(parsed.bus.features.length,1);assert.equal(parsed.bus.features[0].properties.route,'4А');
parsed=h.api.normalizeVehicles([vehicle(1,'bus','49',''),vehicle(2,'bus','49','2026-11-17T18:22:29Z'),vehicle(3,'bus','49','2026-11-17T12:00:00Z')],{bounds,types,receivedAt:AT});
assert.equal(parsed.bus.features.length,2);assert(parsed.bus.features.every(f=>f.properties.timeConfirmed===false));
assert.equal(h.api.viewport({zoom:11,bounds}),null);assert.equal(h.api.viewport({zoom:15,bounds:[[-1,50],[0,51]]}),null);
assert.throws(()=>h.api.normalizeVehicles({}, {bounds,types,receivedAt:AT}),/несовместимый/);h.host.dispose();

// Saved sets select typed route numbers, not destinations or substrings, and
// retain their own colors even when two transport modes share a number.
h=harness(async()=>response([]));
const routes=[{type:'bus',number:' 49 ',color:'#1565C0'},{type:'tram',number:'49',color:'#B3261E'},
  {type:'trolley',number:'17',color:'#006C4C'},{type:'bus',number:'4а',color:'#7D5260'},
  {type:'bus',number:'1',color:'#8051AA'}];
const normalizedRoutes=h.api.normalizeRoutes(routes);
assert.deepEqual(plain(normalizedRoutes),routes.map(item=>({...item,number:item.number.trim(),color:item.color.toLowerCase()})));
assert(Object.isFrozen(normalizedRoutes));assert(normalizedRoutes.every(Object.isFrozen));
assert.equal(h.api.normalizeRoutes(null),null);assert.deepEqual(plain(h.api.normalizeRoutes([])),[]);
assert.equal(h.api.parseRoutes(''),null);assert.deepEqual(plain(h.api.parseRoutes('[]')),[]);
assert.deepEqual(plain(h.api.parseRoutes(JSON.stringify(routes))),plain(normalizedRoutes));
parsed=h.api.normalizeVehicles([vehicle(1,'bus','49'),vehicle(2,'tram','49'),vehicle(3,'trolley','49'),
  vehicle(4,'bus','149'),vehicle(5,'trolley','17'),vehicle(6,'bus','4А'),vehicle(7,'bus','1')],
  {bounds,types,route:'ignored legacy filter',routes,receivedAt:AT});
assert.deepEqual(plain(parsed.bus.features.map(f=>[f.properties.label,f.properties.color,f.properties.name])),
  [['49','#1565c0','49 · Автобус'],['4А','#7d5260','4А · Автобус'],['1','#8051aa','1 · Автобус']]);
assert.deepEqual(plain(parsed.tram.features.map(f=>[f.properties.label,f.properties.color])),[['49','#b3261e']]);
assert.deepEqual(plain(parsed.trolley.features.map(f=>f.properties.label)),['17']);
parsed=h.api.normalizeVehicles([vehicle(1)],{bounds,types,routes:[],receivedAt:AT});
assert.equal(parsed.bus.features.length,0,'An explicitly empty set cannot reveal all routes');
parsed=h.api.normalizeVehicles([vehicle(1,'bus','49','2026-11-17T12:00:00Z')],{bounds,types,routes,receivedAt:AT});
assert.equal(parsed.bus.features.length,0,'Preset membership does not revive stale positions');
for(const malformed of [undefined,{},'49',Array(21).fill(routes[0]),[null],[{...routes[0],type:'subway'}],
  [{...routes[0],number:''}],[{...routes[0],number:'1234567890123'}],[{...routes[0],number:'49\n'}],
  [{...routes[0],color:'red'}],[{...routes[0],color:'#fff'}],[{...routes[0],extra:'unexpected'}],
  [routes[0],{...routes[0],number:'49'}],[{...routes[0],number:'4а'},{...routes[0],number:'4А'}]]){
  assert.throws(()=>h.api.normalizeRoutes(malformed),undefined,`Reject malformed preset ${JSON.stringify(malformed)}`);
}
for(const malformed of [null,[],{},'null','{}','{broken','x'.repeat(8193)]) assert.throws(()=>h.api.parseRoutes(malformed));
h.host.dispose();

// An active set determines the queried modes independently of stale legacy
// checkboxes, shares the three owned sources, and never polls an empty set.
h=harness(async()=>response([vehicle(1,'bus','49'),vehicle(2,'tram','49'),vehicle(3,'trolley','17'),vehicle(4,'bus','149')]),true);
await h.host.configure('spb-live',{bus:false,tram:false,trolley:false,route:'irrelevant overlong legacy number',routes:JSON.stringify(routes)});
await h.host.enable('spb-live');
assert.equal(h.host.get('spb-live').status,'ready');assert.equal(h.sources.size,3);
assert.equal(new URL(h.requests[0].url).searchParams.get('transport'),'bus,tram,trolley');
assert.equal(h.data().features.length,1);assert.equal(h.data('tram').features.length,1);assert.equal(h.data('trolley').features.length,1);
assert.equal(h.data().features[0].properties.color,'#1565c0');
assert.equal(h.data().features[0].properties.__moduleColor,'#1565c0');
assert.deepEqual(plain(h.layers.get('module-spb-live:bus-point').paint['circle-color']),['coalesce',['get','__moduleColor'],'#b76c18']);
assert.deepEqual([...h.host.entry('spb-live').session.labelImages.keys()].sort(),['#006c4c|17','#1565c0|49','#b3261e|49']);
assert.equal(h.images.size,3,'Only the three visible route badges are allocated');
const firstColorImages=new Map(h.images);
await h.host.configure('spb-live',{routes:JSON.stringify([{type:'bus',number:'49',color:'#ff8800'}])});
assert.equal(new URL(h.requests.at(-1).url).searchParams.get('transport'),'bus');
assert.equal(h.data().features[0].properties.color,'#ff8800');assert.equal(h.data('tram').features.length,0);
assert.deepEqual([...h.host.entry('spb-live').session.labelImages.keys()],['#ff8800|49']);
assert.equal(h.images.size,1);assert([...firstColorImages].every(([id,image])=>h.images.get(id)!==image));
await h.host.configure('spb-live',{routes:'[]'});const emptyRequests=h.requests.length;
assert.equal(h.images.size,0);await h.advance(64000);assert.equal(h.requests.length,emptyRequests);
await h.host.configure('spb-live',{routes:'',bus:true,route:'49'});assert.equal(h.data().features.length,1);
assert.equal(h.data().features[0].properties.color,'#b76c18','Leaving a preset restores legacy type colors');
await h.host.configure('spb-live',{routes:'null'});assert.equal(h.host.get('spb-live').status,'error');
assert.equal(h.sources.size,0);assert.equal(h.images.size,0);assert.equal(h.timers.size,0);assert.equal(h.visibility.size,0);h.host.dispose();

let resolveOldPreset,oldPresetSignal;
h=harness(async(_url,options,n)=>{
  if(n===1){oldPresetSignal=options.signal;return new Promise(resolve=>{resolveOldPreset=resolve;});}
  return response([vehicle(2,'bus','1'),vehicle(3,'bus','49')]);
},true);
await h.host.configure('spb-live',{routes:JSON.stringify([{type:'bus',number:'49',color:'#1565c0'}])});
const oldPresetEnable=h.host.enable('spb-live');await flush();
await h.host.configure('spb-live',{routes:JSON.stringify([{type:'bus',number:'1',color:'#aa2255'}])});
assert.equal(oldPresetSignal.aborted,true);assert.equal(h.data().features.length,1);
assert.equal(h.data().features[0].properties.label,'1');assert.equal(h.data().features[0].properties.color,'#aa2255');
resolveOldPreset(response([vehicle(1,'bus','49')]));await oldPresetEnable;await flush();
assert.equal(h.data().features[0].properties.label,'1','An old preset reply cannot resurrect its numbers or colors');
assert.equal([...h.timers.values()].filter(timer=>timer.delay===16000).length,1);h.host.dispose();

// An aborted in-flight viewport reply can neither overwrite the newer view nor
// create a second polling loop. Cleanup owns all timers/listeners/sources.
let resolveOld,oldSignal;
h=harness(async(_url,options,n)=>{
  if(n===2){oldSignal=options.signal;return new Promise(resolve=>{resolveOld=resolve;});}
  return response([vehicle(n,'bus','49',new Date(AT+n*16000-1000).toISOString(),n===3?30.34:30.33)]);
});
await h.host.enable('spb-live');await h.advance(16000);assert.equal(h.requests.length,2);
h.map.bounds=[[30.335,59.92],[30.35,59.94]];h.map.move();await h.advance(120);assert.equal(oldSignal.aborted,true);assert.equal(h.requests.length,3);
assert.equal(h.data().features[0].geometry.coordinates[0],30.34);
resolveOld(response([vehicle(999)]));await flush();assert.equal(h.data().features[0].geometry.coordinates[0],30.34);
assert.equal([...h.timers.values()].filter(t=>t.delay===16000).length,1);
await h.hide(true);assert.equal(h.data().features.length,0);const hiddenCount=h.requests.length;
await h.advance(64000);assert.equal(h.requests.length,hiddenCount);
await h.hide(false);assert.equal(h.requests.length,hiddenCount+1);
await h.host.setSuspended(true);assert.equal(h.sources.size,0);const suspendedCount=h.requests.length;
await h.advance(64000);assert.equal(h.requests.length,suspendedCount);
await h.host.setSuspended(false);assert.equal(h.requests.length,suspendedCount+1);
h.host.disable('spb-live');assert.equal(h.sources.size,0);assert.equal(h.visibility.size,0);assert.equal(h.timers.size,0);h.host.dispose();

// A mid-session outage removes old positions while the layer stays enabled.
// Persistent failures maintain one poll timer and the next fresh reply clears the warning.
const state = h => h.host.get('spb-live');
function expectRetry(h) {
  assert.equal(state(h).enabled,true);
  assert.equal(state(h).status,'ready');
  assert.equal(state(h).error,null);
  assert.match(state(h).warning,/Повторим автоматически/);
  assert.equal(h.sources.size,3);
  assert.equal(h.data().features.length,0);
  assert.deepEqual([...h.timers.values()].map(timer=>timer.delay),[16000]);
}
h=harness(async(_u,_o,n)=>n===1 || n===4 ? response([vehicle(n)]) : response({},503));
await h.host.enable('spb-live');
assert.equal(h.data().features[0].properties.vehicleId,'1');
await h.advance(16000);
expectRetry(h);
await h.advance(15999);
assert.equal(h.requests.length,2);
await h.advance(1);
assert.equal(h.requests.length,3);
expectRetry(h);
await h.advance(16000);
assert.equal(h.requests.length,4);
assert.equal(h.data().features[0].properties.vehicleId,'4');
assert.equal(state(h).warning,null);
h.host.dispose();

// Recoverable statuses, fetch rejection and interrupted stream reads also work
// at startup, before the module has received a position.
for (const firstFailure of [
  ...[408,425,429,503].map(status=>()=>response({},status)),
  ()=>{throw new TypeError('Failed to fetch');},
  ()=>new Response(new ReadableStream({start(controller){controller.error(new TypeError('Connection reset'));}})),
]) {
  h=harness(async(_u,_o,n)=>n===1 ? firstFailure() : response([vehicle(n)]));
  await h.host.enable('spb-live');
  expectRetry(h);
  await h.advance(16000);
  assert.equal(h.requests.length,2);
  assert.equal(h.data().features[0].properties.vehicleId,'2');
  assert.equal(state(h).warning,null);
  h.host.dispose();
}
h=harness(async(_u,{signal},n)=>n===1
  ? new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}))
  : response([vehicle(n)]));
const timedOutEnable=h.host.enable('spb-live');
await flush();
await h.advance(7999);
assert.equal(state(h).status,'loading');
assert.equal(h.requests[0].options.signal.aborted,false);
await h.advance(1);
await timedOutEnable;
assert.equal(h.requests[0].options.signal.aborted,true);
expectRetry(h);
await h.advance(16000);
assert.equal(h.requests.length,2);
assert.equal(state(h).warning,null);
h.host.dispose();

// Waiting retries stop when the layer or view no longer calls for live data.
for (const stop of [
  h=>h.hide(true),
  h=>h.host.setSuspended(true),
  h=>h.host.disable('spb-live'),
  async h=>{h.map.zoom=11;h.map.move();await h.advance(120);},
  async h=>{h.map.bounds=[[-1,50],[0,51]];h.map.move();await h.advance(120);},
  h=>h.host.configure('spb-live',{routes:'[]'}),
]) {
  h=harness(async()=>response({},503));
  await h.host.enable('spb-live');
  expectRetry(h);
  await stop(h);
  assert.equal(h.timers.size,0);
  assert.equal(state(h).warning,null);
  await h.advance(64000);
  assert.equal(h.requests.length,1);
  h.host.dispose();
}

// Old in-flight retry results cannot change the warning or markers of a new preset.
let rejectOldRetry;
h=harness(async(_u,_o,n)=>{
  if(n===1)return response({},503);
  if(n===2)return new Promise((_resolve,reject)=>{rejectOldRetry=reject;});
  return response([vehicle(n,'bus','1')]);
});
await h.host.enable('spb-live');
await h.advance(16000);
await h.host.configure('spb-live',{routes:JSON.stringify([{type:'bus',number:'1',color:'#aa2255'}])});
assert.equal(h.requests[1].options.signal.aborted,true);
assert.equal(h.data().features[0].properties.label,'1');
assert.equal(state(h).warning,null);
rejectOldRetry(new TypeError('Late network failure'));
await flush();
assert.equal(h.data().features[0].properties.label,'1');
assert.equal(state(h).warning,null);
assert.deepEqual([...h.timers.values()].map(timer=>timer.delay),[16000]);
h.host.dispose();

// Ignore a failure for a viewport that was left before moveend fired.
let failOldView;
h=harness(async(_u,_o,n)=>n===2 ? new Promise(resolve=>{failOldView=resolve;}) : response([vehicle(n,'bus','49',undefined,30.34)]));
await h.host.enable('spb-live');
await h.advance(16000);
h.map.bounds=[[30.335,59.92],[30.35,59.94]];
h.map.move();
failOldView(response({},503));
await flush();
assert.equal(h.data().features[0].properties.vehicleId,'1');
assert.equal(state(h).warning,null);
await h.advance(120);
assert.equal(h.data().features[0].properties.vehicleId,'3');
assert.deepEqual([...h.timers.values()].map(timer=>timer.delay),[16000]);
h.host.dispose();

// Permanent HTTP errors and incompatible responses still stop the module.
h=harness(async(_u,_o,n)=>n===2 ? response({},403) : response([vehicle(n)]));
await h.host.enable('spb-live');
await h.advance(16000);
assert.equal(state(h).status,'error');
assert.match(state(h).error,/403/);
assert.equal(h.sources.size,0);
assert.equal(h.timers.size,0);
await h.host.enable('spb-live');
assert.equal(h.data().features[0].properties.vehicleId,'3');
h.host.dispose();
for(const make of [()=>response({},404),()=>new Response('{broken'),()=>response({}),()=>new Response('x',{headers:{'content-length':String(3*1024*1024)}}),()=>new Response('x'.repeat(2*1024*1024+1))]){
  h=harness(async()=>make());await h.host.enable('spb-live');assert.equal(h.host.get('spb-live').status,'error');assert.equal(h.sources.size,0);assert.equal(h.timers.size,0);assert.equal(h.visibility.size,0);h.host.dispose();
}

// Label rasterization has a hard texture budget, reuses live names and releases
// old viewport labels instead of accumulating texture/cleanup objects forever.
h=harness(async()=>response([]),true);let labelContext;
const labels=prefix=>({type:'FeatureCollection',features:Array.from({length:200},(_,i)=>({type:'Feature',properties:{label:`${prefix}${i}`},geometry:{type:'Point',coordinates:[30.33,59.93]}}))});
const badgeManifest={id:'badges',apiVersion:1,version:'1',title:'Badges',capabilities:['geojson'],defaults:{}};
h.host.register(badgeManifest,ctx=>{labelContext=ctx;ctx.setGeoJson('points',labels('A'),{pointLabel:'label'});});
await h.host.enable('badges');assert.equal(h.images.size,128);assert.equal(h.host.get('badges').status,'ready');
let labelled=h.sources.get('module-badges:points-source').data.features.filter(f=>f.properties.__moduleLabelImage);
assert.equal(labelled.length,128);assert.equal(h.layers.get('module-badges:points-label').layout['icon-image'][1],'__moduleLabelImage');
const cleanupCount=h.host.entry('badges').session.cleanups.length, oldIds=[...h.images.keys()];
labelContext.setGeoJson('points',labels('B'),{pointLabel:'label'});
assert.equal(h.images.size,128);assert(oldIds.every(id=>!h.images.has(id)));assert.equal(h.host.entry('badges').session.cleanups.length,cleanupCount);
labelContext.setGeoJson('points',{type:'FeatureCollection',features:[]},{pointLabel:'label'});assert.equal(h.images.size,0);
labelContext.setGeoJson('points',labels('C'),{pointLabel:'label'});h.host.disable('badges');assert.equal(h.images.size,0);assert.equal(h.layers.size,1);h.host.dispose();
h=harness(async()=>response([]),true);const foreign={foreign:true};h.images.set('module-badges:label-0',foreign);
h.host.register(badgeManifest,ctx=>ctx.setGeoJson('points',{type:'FeatureCollection',features:[labels('D').features[0]]},{pointLabel:'label'}));
await h.host.enable('badges');h.host.disable('badges');assert.equal(h.images.get('module-badges:label-0'),foreign);h.host.dispose();
for(const options of [{pointLabel:['get','x']},{pointRadius:17},{pointOpacity:'x;code'}]){
  h=harness(async()=>response([]),true);h.host.register(badgeManifest,ctx=>ctx.setGeoJson('points',labels('X'),options));
  await h.host.enable('badges');assert.equal(h.host.get('badges').status,'error');assert.equal(h.sources.size,0);assert.equal(h.images.size,0);h.host.dispose();
}

console.log('Live transport OK: feed contract, typed presets, 16s polling and outage recovery, viewport cancellation, clock safety, permanent errors, cleanup and bounded data');
