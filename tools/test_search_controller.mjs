import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source=fs.readFileSync(new URL('../app/src/main/assets/search-controller.js',import.meta.url),'utf8');
const photon={features:[{geometry:{type:'Point',coordinates:[30.3,59.9]},properties:{name:'Невский',street:'Невский проспект',housenumber:'1',city:'Петербург',country:'Россия'}}]};
const requests=[];
const context={window:{fetch:async(url,options)=>{
  requests.push({url,options});
  const zoom=new URL(url).searchParams.get('zoom');
  // The real endpoint rejects decimals including "15.0", not just fractions.
  if(zoom!==null&&!/^\d+$/.test(zoom))return new Response('{"zoom":"TYPE_CONVERSION_FAILED"}',{status:400});
  return new Response(JSON.stringify(photon));
}},URL,URLSearchParams,AbortController,TextDecoder,setTimeout,clearTimeout};
vm.createContext(context);vm.runInContext(source,context);
const api=context.window.SloiSearch;
const plain=value=>JSON.parse(JSON.stringify(value));
assert.deepEqual(plain(api.normalizePhoton(photon)),[{name:'Невский',display_name:'Невский, Невский проспект 1, Петербург, Россия',longitude:30.3,latitude:59.9}]);
assert.equal(api.normalizePhoton({features:[...photon.features,...photon.features,{geometry:{type:'Point',coordinates:[null,59.9]},properties:{name:'Bad'}}]}).length,1);
await api.webPlaces('Невский',{center:[30.3,59.9],zoom:15});
assert.equal(new URL(requests[0].url).hostname,'photon.komoot.io');
assert.equal(new URL(requests[0].url).searchParams.get('limit'),'6');
assert.equal(new URL(requests[0].url).searchParams.get('lat'),'59.9');
assert.equal(new URL(requests[0].url).searchParams.has('lang'),false,'Demo does not accept Russian lang parameter');
for(const [zoom,expected]of [[15,15],[14.781,15],[19,18],[100,18],[-10,0],[0,0],[NaN,12],[Infinity,12]]){
  await api.webPlaces('Московская',{center:[30.32,59.9],zoom});
  assert.equal(new URL(requests.at(-1).url).searchParams.get('zoom'),String(expected));
}
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const calls=[],results=[],errors=[];
let transportResolve;
const control=api.create({debounceMs:5,places:(query,{signal})=>new Promise(resolve=>calls.push({query,signal,resolve})),
  providers:()=>[{moduleId:'spb-bus',search:()=>new Promise(resolve=>transportResolve=resolve)}],
  onResults:value=>results.push(plain(value)),onError:(error,kind)=>errors.push({error,kind})});
control.input('Н');await sleep(10);assert.equal(calls.length,0);
control.compositionStart();control.input('Не');await sleep(10);assert.equal(calls.length,0);
control.compositionEnd('Нев');control.input('Невс');control.input('Невский');await sleep(12);
assert.equal(calls.length,1);assert.equal(calls[0].query,'Невский');
calls[0].resolve([{name:'Street'}]);await sleep(1);
assert.equal(results.at(-1).places[0].name,'Street','Places appear before slow transport response');
const oldTransportResolve=transportResolve;
control.input('Париж');assert(calls[0].signal.aborted);await sleep(12);
oldTransportResolve([{title:'Old route'}]);await sleep(1);assert.equal(results.at(-1).query,'Париж');assert.equal(results.at(-1).transport.length,0);
calls[1].resolve([{name:'Paris'}]);transportResolve([{title:'New route'}]);await sleep(1);
assert.equal(results.at(-1).transport[0].title,'New route');
await control.submit('Париж');assert.equal(calls.length,2,'Repeated complete query uses cache');
control.input('');await sleep(12);assert.equal(calls.length,2);assert.equal(results.at(-1).places.length,0);
control.submit('Отмена');await sleep(1);const pending=calls.at(-1);control.cancel();assert(pending.signal.aborted);
pending.resolve([{name:'Stale'}]);transportResolve([]);await sleep(1);assert.notEqual(results.at(-1).places[0]?.name,'Stale');
control.dispose();control.input('Disposed');await sleep(12);assert.equal(calls.length,3);assert.equal(errors.length,0);
const failed=api.create({places:async()=>{throw Error('Offline');},onError:(error,kind)=>errors.push({error,kind})});
await failed.submit('Невский');assert.equal(errors.at(-1).kind,'places');failed.dispose();

// A completed place response must be reusable before a slow/failing transport
// provider completes, and cached suggestions must appear in the input handler,
// before its debounce or another network request can run.
const instantResults=[],instantCalls=[];
let bias='Петербург',resolveTransport;
const instant=api.create({debounceMs:5,contextKey:()=>bias,
  places:(query,{signal})=>new Promise(resolve=>instantCalls.push({query,signal,resolve})),
  providers:()=>[{moduleId:'slow-bus',search:()=>new Promise(resolve=>resolveTransport=resolve)}],
  onResults:value=>instantResults.push(plain(value))});
instant.input('Невский');await sleep(12);
instantCalls[0].resolve([{name:'Невский проспект',display_name:'Невский проспект, Петербург',longitude:30.3,latitude:59.9}]);
await sleep(1);
instant.input('Невс');
assert.equal(instantResults.at(-1).query,'Невс');
assert.equal(instantResults.at(-1).places[0].name,'Невский проспект','Matching prefix appears synchronously');
instant.input('Пари');
assert.equal(instantResults.at(-1).places.length,0,'Unrelated old results must not be relabelled');
instant.input('Невский');
assert.equal(instantResults.at(-1).places[0].name,'Невский проспект','Place cache does not wait for transport');
await sleep(12);
assert.equal(instantCalls.length,1,'Only incomplete transport is retried, not completed Photon data');
resolveTransport([]);await sleep(1);
const beforeCache=instantCalls.length;
instant.input('НЕВСКИЙ');
assert.equal(instantResults.at(-1).places[0].name,'Невский проспект');
await sleep(12);assert.equal(instantCalls.length,beforeCache,'Exact cache bypasses debounce and providers');
bias='Москва';instant.input('Невский');
assert.equal(instantResults.at(-1).places.length,0,'Cached suggestions belong to their location bias');
await sleep(12);assert.equal(instantCalls.length,2);
instantCalls[1].resolve([]);resolveTransport([]);await sleep(1);
instant.input('Невский');assert.equal(instantResults.at(-1).places.length,0,'Authoritative cached empty result remains empty');
instant.dispose();

let partialCalls=0;
const partial=api.create({places:async()=>{partialCalls++;return[{name:'Париж'}]},
  providers:()=>[{moduleId:'failed-bus',search:async()=>{throw Error('Bus unavailable')}}]});
await partial.submit('Париж');await partial.submit('Париж');
assert.equal(partialCalls,1,'A failed module cannot invalidate a successful location response');partial.dispose();
console.log('Search controller OK: immediate context-aware exact/prefix cache, independent partial caches, debounce/IME, abort/stale suppression and Photon addresses');
