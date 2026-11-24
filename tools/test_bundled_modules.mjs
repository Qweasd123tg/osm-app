import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
const source=fs.readFileSync(fileURLToPath(new URL('../app/src/main/assets/modules/bundled.js',import.meta.url)),'utf8');
const jsonResponse=(value)=>new Response(JSON.stringify(value),{headers:{'content-type':'application/json'}});
function load(fetch) {
  const sandbox={window:{fetch},AbortController,URL,URLSearchParams,TextDecoder,setTimeout,clearTimeout};
  vm.createContext(sandbox);vm.runInContext(source,sandbox);
  const api=sandbox.window.SloiBundledModules, definitions=new Map();
  api.register({register:(manifest,factory)=>definitions.set(manifest.id,{manifest,factory})});
  return {api,definitions};
}
const segment=(order,shape,startId='a',finishId='b')=>({Order:order,Shape:shape,
  StartStopId:startId,StartStopName:'Начало',StartStopLongitude:30.3,StartStopLatitude:59.9,
  FinishStopId:finishId,FinishStopName:'Конец',FinishStopLongitude:30.4,FinishStopLatitude:59.95});
const payload={Number:'3',Directions:[{Direction:1,Items:[segment(2,'30.4 59.95,30.5 60','b','c'),segment(1,'30.3 59.9,30.4 59.95')]},
  {Direction:2,Items:[segment(1,'30.4 59.95,30.3 59.9')]}]};
const requests=[];
const {api,definitions}=load(async(url,options)=>{requests.push({url,options});return jsonResponse(requests.length===1?[{Id:'1329',ShortName:'33'},{Id:'id/a &b',ShortName:'3'}]:payload);});
function context(definition, overrides={}) {
  const controller=new AbortController(),rendered=[],listeners=[];
  return {controller,rendered,listeners,ctx:{signal:controller.signal,settings:{...definition.manifest.defaults,...overrides},
    getView:()=>({center:[0,0],zoom:3,bounds:[[-180,-85],[180,85]]}),setGeoJson:(...args)=>rendered.push(args),onMove:callback=>listeners.push(callback)}};
}
const bus=definitions.get('spb-bus'), state=context(bus);
await bus.factory(state.ctx);
assert.equal(requests.length,2);assert.equal(requests[0].url,'https://transport.orgp.spb.ru/api/visary/operator/route');
assert.equal(requests[0].options.method,'POST');
assert.deepEqual(Object.fromEntries(new URLSearchParams(requests[0].options.body)),{skip:'0',take:'50',transportTypes:'bus',routeShortName:'3',desc:'false'});
assert.equal(requests[0].options.credentials,'omit');assert.equal(requests[0].options.redirect,'error');
assert.equal(requests[1].url,'https://transport.orgp.spb.ru/api/visary/stop/byRoute?routeId=id%2Fa%20%26b');assert.equal(requests[1].options.method,'GET');
let features=state.rendered[0][1].features;
assert.equal(features.filter(f=>f.geometry.type==='LineString').length,2);
assert.equal(features[0].properties.order,1);assert.equal(features.filter(f=>f.geometry.type==='Point').length,3);
assert.equal(state.rendered[0][2].color,'#7054aa');assert.equal(state.listeners.length,0,'Bus module never polls on move');
await bus.factory(context(bus,{stops:false,color:'#123456'}).ctx);assert.equal(requests.length,2,'Recent responses are reused without fetching on style changes');
features=api.parseRoute(payload,2,'3',false).features;assert.equal(features.length,1);assert.equal(features[0].geometry.coordinates[0][0],30.4);
assert.throws(()=>api.parseRoute(payload,3,'3',true),/направление/);
assert.throws(()=>api.parseRoute({Directions:null},1,'3',true),/несовместимый/);
assert.throws(()=>api.parseRoute({Directions:[{Direction:1,Items:[segment(1,null)]}]},1,'3',true),/геометрии/);
const mixed={Directions:[{Direction:1,Items:[segment(1,'broken'),segment(2,'30.3 59.9,30.4 59.95'),segment(3,'181 60,30 60'),segment(null,'30 59,31 59')]}]};
features=api.parseRoute(mixed,1,'3',true).features;assert.equal(features.filter(f=>f.geometry.type==='LineString').length,1);
const nullCoordinates=segment(1,'30.3 59.9,30.4 59.95');nullCoordinates.StartStopLatitude=null;
features=api.parseRoute({Directions:[{Direction:1,Items:[nullCoordinates]}]},1,'3',true).features;
assert.equal(features.filter(f=>f.geometry.type==='Point').length,1,'Null coordinates must not become zero');

// Only useful optional modules are registered; no legacy test grid remains.
assert.deepEqual([...definitions.keys()],['spb-bus']);
assert.equal(api.gridGeometry,undefined);
assert.equal(state.rendered[0][2].pointMinZoom,15,'Stops appear only at street scale');

async function failure(fetch, pattern, settings={}) {
  const loaded=load(fetch),definition=loaded.definitions.get('spb-bus'),test=context(definition,settings);
  await assert.rejects(definition.factory(test.ctx),pattern);assert.equal(test.rendered.length,0);
}
await failure(async()=>{throw new TypeError('certificate failed');},/доверие к сертификату/);
await failure(async()=>jsonResponse([{Id:'x',ShortName:'33'}]),/не найден/);
await failure(async()=>jsonResponse([{Id:'a',ShortName:'3'},{Id:'b',ShortName:'3'}]),/неоднозначен/);
await failure(async()=>new Response('{bad'),/повреждённый JSON/);
await failure(async()=>new Response('bad',{status:503}),/HTTP 503/);
await failure(async()=>new Response('x',{headers:{'content-length':String(3*1024*1024)}}),/лимит/);
await failure(async()=>new Response('x'.repeat(2*1024*1024+1)),/лимит/);
await failure(async()=>{throw new Error('Must not fetch');},/номер маршрута/,{route:'x'.repeat(13)});
let capturedSignal;
const pending=load((_url,options)=>new Promise((_resolve,reject)=>{
  capturedSignal=options.signal;options.signal.addEventListener('abort',()=>{const error=new Error('aborted');error.name='AbortError';reject(error);});
}));
const pendingDefinition=pending.definitions.get('spb-bus'),pendingState=context(pendingDefinition);
const work=pendingDefinition.factory(pendingState.ctx);pendingState.controller.abort();
await assert.rejects(work,{name:'AbortError'});assert(capturedSignal.aborted);assert.equal(pendingState.rendered.length,0);
// The optional native shadow module contains no bridge/date UI or eager work.
const shadowSandbox={window:{},AbortController,TextEncoder,setTimeout,clearTimeout};vm.createContext(shadowSandbox);
vm.runInContext(fs.readFileSync(fileURLToPath(new URL('../app/src/main/assets/modules/native-shadows.js',import.meta.url)),'utf8'),shadowSandbox);
let shadowDefinition;
shadowSandbox.window.SloiNativeShadows.register({register:(manifest,factory)=>{shadowDefinition={manifest,factory};}});
assert.equal(shadowDefinition.manifest.id,'shadows');assert.deepEqual(Array.from(shadowDefinition.manifest.capabilities),['shadows']);
assert.deepEqual(Object.keys(shadowDefinition.manifest.defaults),['opacity']);assert.equal(shadowDefinition.manifest.defaults.opacity,38);
const shadowCalls=[];await shadowDefinition.factory({settings:{opacity:38},useShadows:async options=>shadowCalls.push(options)});
assert.equal(shadowCalls.length,1);assert.equal(shadowCalls[0].opacity,.38);
for(const opacity of [9,76,NaN,Infinity,'38',null]) {
  await assert.rejects(shadowDefinition.factory({settings:{opacity},useShadows:()=>{throw new Error('Must not activate');}}),/от 10 до 75/);
}
await assert.rejects(shadowDefinition.factory({settings:{opacity:38},useShadows:async()=>{throw new Error('Native service unavailable');}}),/unavailable/);
const shadowControls=shadowSandbox.window.SloiNativeShadows.controls.shadows;
assert.equal(shadowControls.length,1);assert.equal(shadowControls[0].key,'opacity');
// The actual shadow factory obtains a host-owned lease: enabling starts it,
// and disabling aborts the lease and releases it exactly once.
vm.runInContext(fs.readFileSync(fileURLToPath(new URL('../app/src/main/assets/module-host.js',import.meta.url)),'utf8'),shadowSandbox);
let leases=0,cleanups=0,leaseSignal;
const shadowHost=new shadowSandbox.window.SloiModules.Host({map:{},services:{shadows:(options,signal)=>{
  leases++;leaseSignal=signal;assert.equal(options.opacity,.38);return()=>cleanups++;
}}});
shadowSandbox.window.SloiNativeShadows.register(shadowHost);
assert.equal(shadowHost.get('shadows').enabled,false);
assert.equal(leases,0);
await shadowHost.enable('shadows');
assert.equal(leases,1);assert.equal(shadowHost.get('shadows').status,'ready');
shadowHost.disable('shadows');
assert.equal(cleanups,1);assert.equal(leaseSignal.aborted,true);
shadowHost.dispose();assert.equal(cleanups,1);
console.log('Bundled modules OK: optional native shadow lease, route API contract, ordered geometry/stops, street-scale stops, cache, abort and network/data failures');
