import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
const asset = (name) => fs.readFileSync(fileURLToPath(new URL(`../app/src/main/assets/${name}`, import.meta.url)), 'utf8');
const sandbox = { window: {}, AbortController, TextEncoder, setTimeout, clearTimeout };
vm.createContext(sandbox);
vm.runInContext(asset('layer-runtime.js'), sandbox);
vm.runInContext(asset('module-host.js'), sandbox);
const { Host, limits } = sandbox.window.SloiModules;
const data = {type:'FeatureCollection', features:[{type:'Feature', properties:{name:'Точка'}, geometry:{type:'Point',coordinates:[30.3,59.9]}}]};
const manifest = (id) => ({id,apiVersion:1,version:'1.0.0',title:id,description:'test',capabilities:['geojson'],defaults:{opacity:.8,color:'#227755',showStops:true}});
const plain = (value) => JSON.parse(JSON.stringify(value));
function fakeMap() {
  const sources = new Map(), layers = new Map([['selected-location',{id:'selected-location'}]]), events = new Set();
  return {sources,layers,events,
    getCenter:()=>({lng:30.3,lat:59.9}), getZoom:()=>15,
    getBounds:()=>({getWest:()=>30,getEast:()=>31,getSouth:()=>59,getNorth:()=>60}),
    addSource(id,spec){assert(!sources.has(id));sources.set(id,{...spec,setData(value){this.data=value;}});},
    getSource:id=>sources.get(id),removeSource(id){assert(![...layers.values()].some(l=>l.source===id));sources.delete(id);},
    addLayer(spec,anchor){assert(!layers.has(spec.id));assert.equal(anchor,'selected-location');layers.set(spec.id,spec);},
    getLayer:id=>layers.get(id),removeLayer:id=>layers.delete(id),
    setPaintProperty(id,key,value){layers.get(id).paint[key]=value;},
    on(type,callback){assert.equal(type,'moveend');events.add(callback);},off(type,callback){events.delete(callback);},
    move(){for(const callback of events)callback();},
  };
}
const storage = {value:null,getItem(){return this.value;},setItem(key,value){assert.equal(key,'sloi-modules-state');this.value=value;}};
const map=fakeMap();let changes=0,cleaned=0,moved=0,contexts=[];
const host=new Host({map,storage,onChange:()=>changes++});
host.register(manifest('places'),ctx=>{
  contexts.push(ctx);assert(Object.isFrozen(ctx.settings));ctx.setGeoJson('points',data,ctx.settings);
  ctx.onMove(()=>moved++);return ()=>cleaned++;
});
assert.equal(host.get('places').status,'disabled');
await host.enable('places');
assert.equal(host.get('places').status,'ready');assert.equal(map.sources.size,1);assert.equal(map.layers.size,4);assert.equal(map.events.size,1);
assert.equal(contexts[0].getView().zoom,15);assert(Object.isFrozen(contexts[0].getView().bounds[0]));
map.move();map.move();map.move();
await new Promise(r=>setTimeout(r,limits.moveDebounceMs+20));assert.equal(moved,1);
contexts[0].setGeoJson('points',data,{color:'#abcdef',opacity:.3});
assert.equal(map.layers.get('module-places:points-point').paint['circle-color'],'#abcdef');
const multicolor = {type:'FeatureCollection',features:[
  {...data.features[0],properties:{color:'#BB2200'}},
  {...data.features[0],properties:{color:'invalid'}},
]};
contexts[0].setGeoJson('points',multicolor,{color:'#123456',colorProperty:'color'});
assert.deepEqual(plain(map.layers.get('module-places:points-point').paint['circle-color']),['coalesce',['get','__moduleColor'],'#123456']);
assert.deepEqual(plain(map.sources.get('module-places:points-source').data.features.map(f=>f.properties.__moduleColor)),['#bb2200','#123456']);
assert.equal(multicolor.features[0].properties.__moduleColor,undefined,'Renderer annotations cannot mutate module data');
assert.throws(()=>contexts[0].setGeoJson('points',data,{colorProperty:'color;bad'}),/поле/);
assert.throws(()=>contexts[0].setGeoJson('points',data,{pointLabelStyle:'unknown'}),/стиль/);
contexts[0].setGeoJson('points',data,{color:'#abcdef'});
assert.equal(map.layers.get('module-places:points-point').paint['circle-color'],'#abcdef','Fixed and feature styles can switch without extra layers');
assert.deepEqual(plain(host.get('places').bounds),[[30.3,59.9],[30.3,59.9]]);
contexts[0].setGeoJson('points',{type:'FeatureCollection',features:[]});
assert.equal(map.sources.get('module-places:points-source').data.features.length,0);
assert.equal(host.get('places').bounds,null);assert.equal(host.get('places').status,'ready');
contexts[0].setGeoJson('points',data);assert.equal(map.sources.size,1);
assert.deepEqual(plain(host.get('places').bounds),[[30.3,59.9],[30.3,59.9]]);
const simpleIcon = contexts[0].setGeoJson('stop',data,{pointIcon:'bus',pointMinZoom:15});
assert.deepEqual(plain(simpleIcon.layerIds),['module-places:stop-fill','module-places:stop-line','module-places:stop-point'],
  'Without sprite APIs a point icon falls back to the ordinary circle');
assert.equal(map.layers.get('module-places:stop-point').minzoom,15);
assert.equal(map.sources.get(simpleIcon.sourceId).data.features[0].properties.__modulePointIconImage,undefined);

await host.configure('places',{opacity:.4});
assert(contexts[0].signal.aborted);assert.equal(cleaned,1);assert.equal(map.sources.size,1);assert.equal(map.events.size,1);assert.equal(host.get('places').settings.opacity,.4);
await assert.rejects(host.configure('places',{unknown:1}),/настройка/);
await assert.rejects(host.configure('places',{opacity:'x'}),/тип/);
await assert.rejects(host.configure('places',JSON.parse('{"__proto__":{}}')),/запрещённое/);
await assert.rejects(host.configure('places',{color:'x'.repeat(17000)}),/лимит/);
assert.equal(map.sources.size,1);
await host.setSuspended(true);assert.equal(host.get('places').status,'paused');assert.equal(map.sources.size,0);assert.equal(map.events.size,0);
assert.throws(()=>contexts[1].setGeoJson('points',data),{name:'AbortError'});
await host.setSuspended(false);assert.equal(host.get('places').status,'ready');assert.equal(map.sources.size,1);assert.equal(map.events.size,1);
host.disable('places');assert.equal(map.sources.size,0);assert.equal(map.events.size,0);assert.equal(map.layers.size,1);
await host.configure('places',{showStops:false});assert.equal(host.get('places').status,'disabled');assert.equal(map.sources.size,0);
await host.enable('places');
const stored=JSON.parse(storage.value);assert.equal(stored.version,1);assert.equal(stored.modules.places.enabled,true);
host.dispose();assert.equal(map.sources.size,0);assert.equal(map.events.size,0);assert.equal(JSON.parse(storage.value).modules.places.enabled,true);
await assert.rejects(host.enable('places'),/закрыт/);
const restoredMap=fakeMap(),restored=new Host({map:restoredMap,storage});let restoredCalls=0;
restored.register(manifest('places'),ctx=>{restoredCalls++;assert.equal(ctx.settings.opacity,.4);assert.equal(ctx.settings.showStops,false);ctx.setGeoJson('points',data);});
assert.equal(restoredCalls,0);await restored.restore();assert.equal(restoredCalls,1);assert.equal(restoredMap.sources.size,1);restored.dispose();

// Async disable/configure: stale factories can neither attach nor report errors;
// returned late cleanup still runs exactly once.
const raceMap=fakeMap(),race=new Host({map:raceMap});let resolveOld,oldContext,lateCleanup=0;
race.register(manifest('async'),ctx=>{oldContext=ctx;ctx.setGeoJson('data',data);return new Promise(resolve=>{resolveOld=resolve;});});
const first=race.enable('async');await Promise.resolve();assert.equal(raceMap.sources.size,1);
race.disable('async');assert.equal(raceMap.sources.size,0);assert(oldContext.signal.aborted);
assert.throws(()=>oldContext.setGeoJson('late',data),{name:'AbortError'});
resolveOld(()=>lateCleanup++);await first;assert.equal(lateCleanup,1);assert.equal(race.get('async').status,'disabled');
let rejectOld,readyCtx;
race.register(manifest('switch'),ctx=>{
  if(ctx.settings.opacity===.8)return new Promise((_resolve,reject)=>{rejectOld=reject;});
  readyCtx=ctx;ctx.setGeoJson('new',data);
});
const old=race.enable('switch');await Promise.resolve();await race.configure('switch',{opacity:.2});
rejectOld(new Error('stale failure'));await old;assert.equal(race.get('switch').status,'ready');assert.equal(race.get('switch').error,null);assert(!readyCtx.signal.aborted);

// One broken module and throwing cleanup cannot take down healthy modules.
race.register(manifest('broken'),ctx=>{ctx.setGeoJson('partial',data);throw new Error('broken factory');});
await race.enable('broken');assert.equal(race.get('broken').status,'error');assert.equal(raceMap.sources.size,1);assert.equal(race.get('switch').status,'ready');
race.register(manifest('cleanup'),ctx=>{ctx.setGeoJson('data',data);return ()=>{throw new Error('cleanup failed');};});
await race.enable('cleanup');race.disable('cleanup');assert.equal(raceMap.sources.size,1);
race.register(manifest('budget'),ctx=>{for(let i=0;i<5;i++)ctx.setGeoJson(`source-${i}`,data);});
await race.enable('budget');assert.equal(race.get('budget').status,'error');assert.equal(raceMap.sources.size,1);
race.register({...manifest('denied'),capabilities:[]},ctx=>ctx.setGeoJson('data',data));await race.enable('denied');assert.equal(race.get('denied').status,'error');assert.equal(raceMap.sources.size,1);
let starts=0;
race.register(manifest('early'),()=>{starts++;});
const neverStarted=race.enable('early');race.disable('early');await neverStarted;assert.equal(starts,0);assert.equal(race.get('early').status,'disabled');
race.register(manifest('move-error'),ctx=>{ctx.setGeoJson('points',data);ctx.onMove(async()=>{throw new Error('move failed');});});
await race.enable('move-error');raceMap.move();await new Promise(r=>setTimeout(r,limits.moveDebounceMs+20));
assert.equal(race.get('move-error').status,'error');assert.equal(raceMap.events.size,0);assert.equal(race.get('switch').status,'ready');
race.dispose();assert.equal(raceMap.sources.size,0);assert.equal(raceMap.events.size,0);

// The boundary between module and local IDs must be unambiguous.
const namesMap=fakeMap(),names=new Host({map:namesMap});
names.register(manifest('a-b'),ctx=>{ctx.setGeoJson('c',data);});
names.register(manifest('a'),ctx=>{ctx.setGeoJson('b-c',data);});
await names.enable('a-b');await names.enable('a');
assert(namesMap.sources.has('module-a-b:c-source'));assert(namesMap.sources.has('module-a:b-c-source'));
names.disable('a-b');assert.equal(namesMap.sources.size,1);assert(namesMap.sources.has('module-a:b-c-source'));assert.equal(names.get('a').status,'ready');
names.dispose();assert.equal(namesMap.sources.size,0);

// Collision failure must never claim or remove preexisting map resources.
for(const conflict of ['source','layer']) {
  const collisionMap=fakeMap(),collision=new Host({map:collisionMap});
  const foreignSource={foreign:true},foreignLayer={id:'module-conflict:data-line',source:'foreign-source'};
  if(conflict==='source')collisionMap.sources.set('module-conflict:data-source',foreignSource);
  else {collisionMap.sources.set('foreign-source',foreignSource);collisionMap.layers.set(foreignLayer.id,foreignLayer);}
  collision.register(manifest('conflict'),ctx=>{ctx.setGeoJson('data',data);});
  await collision.enable('conflict');assert.equal(collision.get('conflict').status,'error');
  collision.disable('conflict');collision.dispose();
  assert.equal(collisionMap.sources.size,1);assert.equal([...collisionMap.sources.values()][0],foreignSource);
  if(conflict==='layer')assert.equal(collisionMap.layers.get(foreignLayer.id),foreignLayer);
}
// Partial setup still cleans up the source and the layers added successfully.
const partialMap=fakeMap(),partialOwner=new Host({map:partialMap});
const addLayer=partialMap.addLayer.bind(partialMap);let added=0;
partialMap.addLayer=(spec,anchor)=>{if(++added===2)throw new Error('renderer rejected second layer');addLayer(spec,anchor);};
partialOwner.register(manifest('partial'),ctx=>{ctx.setGeoJson('data',data);});
await partialOwner.enable('partial');assert.equal(partialOwner.get('partial').status,'error');
assert.equal(partialMap.sources.size,0);assert.equal(partialMap.layers.size,1);partialOwner.dispose();

// Broken storage and a corrupt saved module are isolated and observable.
const denied=new Host({map:fakeMap(),storage:{getItem(){throw new Error('denied');},setItem(){throw new Error('quota');}}});
denied.register(manifest('ok'),()=>{});await denied.restore();assert(denied.get('ok').storageWarning);await denied.enable('ok');assert.equal(denied.get('ok').status,'ready');assert(denied.get('ok').storageWarning);denied.dispose();
const partial=new Host({map:fakeMap(),storage:{getItem:()=>JSON.stringify({version:1,modules:{one:{enabled:true,settings:{opacity:'bad'}},two:{enabled:true,settings:{opacity:.7}}}})}});
partial.register(manifest('one'),()=>{}).register(manifest('two'),()=>{});await partial.restore();assert.equal(partial.get('one').enabled,false);assert(partial.get('one').error);assert.equal(partial.get('two').status,'ready');partial.dispose();
assert(changes>5);assert.equal({}.polluted,undefined);

// Native computation is a capability-gated, host-owned lease. Extensions never
// receive the native bridge or the service implementation itself.
const shadowManifest=(id='shadows')=>({id,apiVersion:1,version:'1.0.0',title:id,capabilities:['shadows'],defaults:{opacity:38}});
for(const services of [{unknown:()=>{}},{shadows:true},[]]) {
  assert.throws(()=>new Host({map:fakeMap(),services}),/сервис/);
}
assert.throws(()=>new Host({map:fakeMap()}).register({...shadowManifest(),capabilities:['native-anything']},()=>{}),/возможности/);
const leases=[], shadowStorage={value:null,getItem(){return this.value;},setItem(_key,value){this.value=value;}};
const shadowHost=new Host({map:fakeMap(),storage:shadowStorage,services:{shadows:(options,signal)=>{
  assert(Object.isFrozen(options));const lease={options,signal,cleanups:0};leases.push(lease);return()=>lease.cleanups++;
}}});
let shadowContext;
shadowHost.register(shadowManifest(),async ctx=>{
  shadowContext=ctx;
  assert.equal(ctx.AndroidHost,undefined);assert.equal(ctx.services,undefined);
  await ctx.useShadows({opacity:ctx.settings.opacity/100});
});
assert.equal(shadowHost.get('shadows').enabled,false);await shadowHost.restore();assert.equal(leases.length,0);
await shadowHost.enable('shadows');assert.equal(shadowHost.get('shadows').status,'ready');assert.equal(leases.length,1);assert.equal(leases[0].options.opacity,.38);
await shadowHost.configure('shadows',{opacity:50});assert.equal(leases[0].cleanups,1);assert(leases[0].signal.aborted);assert.equal(leases[1].options.opacity,.5);
await shadowHost.setSuspended(true);assert.equal(leases[1].cleanups,1);assert.equal(shadowHost.get('shadows').status,'paused');
await assert.rejects(shadowContext.useShadows({opacity:.3}),{name:'AbortError'});
await shadowHost.setSuspended(false);assert.equal(leases.length,3);assert.equal(shadowHost.get('shadows').status,'ready');
shadowHost.register(shadowManifest('second-shadows'),ctx=>ctx.useShadows({opacity:.3}));await shadowHost.enable('second-shadows');assert.equal(shadowHost.get('second-shadows').status,'error');assert.equal(leases.length,3);
shadowHost.disable('shadows');shadowHost.disable('shadows');assert.equal(leases[2].cleanups,1);assert(leases[2].signal.aborted);
await shadowHost.enable('second-shadows');assert.equal(shadowHost.get('second-shadows').status,'ready');assert.equal(leases.length,4);shadowHost.dispose();assert.equal(leases[3].cleanups,1);

for(const [id,capabilities,services,options,pattern]of [
  ['undeclared',[],{shadows:()=>{throw new Error('Must not invoke');}},{opacity:.3},/возможности shadows/],
  ['unavailable',['shadows'],{},{opacity:.3},/недоступен/],
  ['settings',['shadows'],{shadows:()=>{throw new Error('Must not invoke');}},{opacity:.3,date:'2026-01-01'},/настройки/],
  ['bounds',['shadows'],{shadows:()=>{throw new Error('Must not invoke');}},{opacity:.9},/настройки/],
  ['bad-cleanup',['shadows'],{shadows:()=>undefined},{opacity:.3},/функцию очистки/],
]) {
  const owner=new Host({map:fakeMap(),services});owner.register({...shadowManifest(id),capabilities},ctx=>ctx.useShadows(options));await owner.enable(id);
  assert.equal(owner.get(id).status,'error');assert.match(owner.get(id).error,pattern);assert.equal(owner.shadowOwner,null);owner.dispose();
}
// An async lease may complete after disable or fail after it has been superseded.
let resolveLease,lateLeaseCleanup=0,oldLeaseSignal;
const lateLeaseHost=new Host({map:fakeMap(),services:{shadows:(_options,signal)=>{oldLeaseSignal=signal;return new Promise(resolve=>{resolveLease=resolve;});}}});
lateLeaseHost.register(shadowManifest(),ctx=>ctx.useShadows({opacity:.38}));
const lateLeaseWork=lateLeaseHost.enable('shadows');await Promise.resolve();assert(resolveLease);lateLeaseHost.disable('shadows');assert(oldLeaseSignal.aborted);
resolveLease(()=>lateLeaseCleanup++);await lateLeaseWork;assert.equal(lateLeaseCleanup,1);assert.equal(lateLeaseHost.get('shadows').status,'disabled');lateLeaseHost.dispose();assert.equal(lateLeaseCleanup,1);
let resolveSuperseded,oldCleanup=0,newCleanup=0;
const changedLeaseHost=new Host({map:fakeMap(),services:{shadows:options=>options.opacity===.38
  ?new Promise(resolve=>{resolveSuperseded=resolve;}):()=>newCleanup++}});
changedLeaseHost.register(shadowManifest(),ctx=>ctx.useShadows({opacity:ctx.settings.opacity/100}));
const superseded=changedLeaseHost.enable('shadows');await Promise.resolve();await changedLeaseHost.configure('shadows',{opacity:50});
const currentOwner=changedLeaseHost.shadowOwner;assert(currentOwner);assert.equal(changedLeaseHost.get('shadows').status,'ready');
resolveSuperseded(()=>oldCleanup++);await superseded;assert.equal(oldCleanup,1);assert.equal(newCleanup,0);assert.equal(changedLeaseHost.shadowOwner,currentOwner);
assert.equal(changedLeaseHost.get('shadows').status,'ready');changedLeaseHost.dispose();assert.equal(oldCleanup,1);assert.equal(newCleanup,1);
let failedLeaseCleanup=0;
const failedLeaseHost=new Host({map:fakeMap(),services:{shadows:()=>()=>failedLeaseCleanup++}});
failedLeaseHost.register(shadowManifest(),async ctx=>{await ctx.useShadows({opacity:.3});throw new Error('Factory failed after acquiring service');});
await failedLeaseHost.enable('shadows');assert.equal(failedLeaseCleanup,1);assert.equal(failedLeaseHost.get('shadows').status,'error');failedLeaseHost.dispose();assert.equal(failedLeaseCleanup,1);
const restoredLeases=[];
const restoredShadowHost=new Host({map:fakeMap(),storage:{getItem:()=>JSON.stringify({version:1,modules:{shadows:{enabled:true,settings:{opacity:62}}}})},
  services:{shadows:options=>{restoredLeases.push(options);return()=>{};}}});
restoredShadowHost.register(shadowManifest(),ctx=>ctx.useShadows({opacity:ctx.settings.opacity/100}));await restoredShadowHost.restore();
assert.equal(restoredShadowHost.get('shadows').enabled,true);assert.equal(restoredLeases.length,1);assert.equal(restoredLeases[0].opacity,.62);restoredShadowHost.dispose();
console.log('Module host OK: lifecycle, ownership, async races, pause/resume, resource budgets, persistence, shadow service leases and error isolation');

const redrawMap=fakeMap(),redrawHost=new Host({map:redrawMap});let redrawStarts=0,redrawContext;
redrawHost.register(manifest('redraw'),ctx=>{redrawContext=ctx;redrawStarts++;ctx.setGeoJson('points',data,{pointMinZoom:10,pointLabelMinZoom:12,pointLabel:'name'});});
await redrawHost.refresh('redraw');assert.equal(redrawStarts,0,'Refresh cannot enable a disabled module');
await redrawHost.enable('redraw');const previousContext=redrawContext;
assert.equal(redrawMap.layers.get('module-redraw:points-point').minzoom,10);assert.equal(redrawMap.layers.get('module-redraw:points-label').minzoom,12);
assert.throws(()=>redrawContext.setGeoJson('invalid',data,{pointMinZoom:10,pointLabelMinZoom:9}),/масштаб подписей/);
await redrawHost.refresh('redraw');assert.equal(redrawStarts,2);assert(previousContext.signal.aborted);assert.equal(redrawMap.sources.size,1);
await redrawHost.setSuspended(true);await redrawHost.refresh('redraw');assert.equal(redrawStarts,2,'Refresh respects suspension');redrawHost.dispose();

// Recoverable source warnings are observable without destroying a healthy
// session. They are transient, bounded and cannot be written by stale work.
const warningMap=fakeMap(),warningStorage={getItem:()=>null,setItem(_key,value){this.value=value;}};
let warningContext,warningChanges=0,lastWarningChange;
const warningHost=new Host({map:warningMap,storage:warningStorage,onChange:(_snapshots,change)=>{warningChanges++;lastWarningChange=change;}});
warningHost.register(manifest('warning'),ctx=>{
  warningContext=ctx;ctx.setGeoJson('points',data);ctx.reportWarning('Повтор через 16 с.');
});
await warningHost.enable('warning');
assert.equal(warningHost.get('warning').status,'ready');assert.equal(warningHost.get('warning').error,null);
assert.equal(warningHost.get('warning').warning,'Повтор через 16 с.');assert.equal(warningMap.sources.size,1);
assert.deepEqual(Object.keys(JSON.parse(warningStorage.value).modules.warning).sort(),['enabled','settings'],'Warnings are not persisted');
const warned=warningChanges;warningContext.reportWarning('Повтор через 16 с.');assert.equal(warningChanges,warned);
warningContext.reportWarning('x'.repeat(800));assert.equal(warningHost.get('warning').warning.length,400);
assert.equal(lastWarningChange,'warning','Observers can update status without rebuilding focused controls');
warningContext.reportWarning(null);assert.equal(warningHost.get('warning').warning,null);assert.equal(warningMap.sources.size,1);
warningContext.reportWarning('offline');const obsoleteWarningContext=warningContext;
await warningHost.setSuspended(true);assert.equal(warningHost.get('warning').warning,null);
assert.throws(()=>obsoleteWarningContext.reportWarning('late'),{name:'AbortError'});
await warningHost.setSuspended(false);assert.equal(warningHost.get('warning').warning,'Повтор через 16 с.');
warningHost.disable('warning');assert.equal(warningHost.get('warning').warning,null);assert.equal(warningMap.sources.size,0);
warningHost.dispose();
