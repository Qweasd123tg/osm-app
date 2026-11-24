import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const code=fs.readFileSync(new URL('../app/src/main/assets/place-names.js',import.meta.url),'utf8');
const pause=ms=>new Promise(r=>setTimeout(r,ms));
const location=Object.freeze({latitude:59.93,longitude:30.36});
const label=(name='Невский проспект 12')=>({name,display_name:`${name}, Санкт-Петербург`,distance:12,source:'offline',latitude:0,longitude:0});
const photonFeature=(properties,coordinates=[location.longitude,location.latitude])=>({type:'Feature',geometry:{type:'Point',coordinates},properties});
function fixture({native=true,online=true,fetch,fastTimers=false}={}) {
  const calls=[],cancel=[],network=[];
  const window={navigator:{onLine:online},SloiOfflinePlacesRevision:'city-1',
    fetch:async(url,options)=>{network.push({url,options});return fetch?fetch(url,options):new Response(JSON.stringify({features:[]}));}};
  if(native)window.AndroidHost={reversePlaceLookup(text){calls.push(JSON.parse(text));},cancelPlaceNameLookup(id){cancel.push(id);}};
  vm.runInNewContext(code,{window,URL,URLSearchParams,AbortController,TextDecoder,Promise,Map,Date,Number,Math,Error,
    setTimeout:fastTimers?(fn,ms)=>setTimeout(fn,Math.min(ms,15)):setTimeout,clearTimeout});
  return {api:window.SloiPlaceNames,window,calls,cancel,network};
}
async function rejectsAbort(promise) {await assert.rejects(promise,e=>e.name==='AbortError');}

{
  const f=fixture(),pending=f.api.resolve(location);
  assert.deepEqual(f.calls.map(({latitude,longitude})=>({latitude,longitude})),[location]);
  f.api.onNativeResult(f.calls[0].requestId,label());
  const result=await pending;
  assert.equal(result.name,'Невский проспект 12');assert.equal(result.source,'offline');
  assert.equal('latitude' in result,false);assert.equal('longitude' in result,false);assert.equal(f.network.length,0);
  result.name='Mutated caller copy';
  assert.equal((await f.api.resolve(location)).name,'Невский проспект 12');assert.equal(f.calls.length,1);
  f.window.SloiOfflinePlacesRevision='city-2';const updated=f.api.resolve(location);
  assert.equal(f.calls.length,2);f.api.onNativeResult(f.calls[1].requestId,label('Новый адрес'));assert.equal((await updated).name,'Новый адрес');
}
{
  const f=fixture(),a=new AbortController(),b=new AbortController();
  const first=f.api.resolve(location,{signal:a.signal}),second=f.api.resolve(location,{signal:b.signal});
  assert.equal(f.calls.length,1);a.abort();await rejectsAbort(first);assert.equal(f.cancel.length,0,'one subscriber cannot cancel another');
  f.api.onNativeResult(f.calls[0].requestId,label());assert.equal((await second).name,'Невский проспект 12');
  const next={latitude:59.931,longitude:30.36},x=f.api.resolve(location),y=f.api.resolve(next);
  f.api.onNativeResult(f.calls[1].requestId,label('Вторая точка'));assert.equal((await y).name,'Вторая точка');assert.equal((await x).name,'Невский проспект 12');
}
{
  const f=fixture(),abort=new AbortController();const old=f.api.resolve(location,{signal:abort.signal});
  const oldId=f.calls[0].requestId;abort.abort();await rejectsAbort(old);assert.deepEqual(f.cancel,[oldId]);
  const fresh=f.api.resolve(location);assert.equal(f.calls.length,2);
  f.api.onNativeResult(oldId,label('Старый адрес'));
  f.api.onNativeResult(f.calls[1].requestId,label('Свежий адрес'));
  assert.equal((await fresh).name,'Свежий адрес');assert.equal((await f.api.resolve(location)).name,'Свежий адрес');
}
{
  const payload={features:[photonFeature({name:'Кофейня'}),photonFeature({name:'Бизнес',street:'Невский проспект',housenumber:'12',city:'Петербург'},[30.3603,59.93])]};
  const f=fixture({native:false,fetch:async()=>new Response(JSON.stringify(payload))});
  const result=await f.api.resolve(location);assert.equal(result.name,'Невский проспект 12');assert.equal(result.source,'photon');
  assert.equal('latitude' in result,false);assert.equal('longitude' in result,false);
  const url=new URL(f.network[0].url);assert.equal(url.pathname,'/reverse');assert.equal(url.searchParams.get('lat'),String(location.latitude));
  assert.equal(url.searchParams.get('lon'),String(location.longitude));assert.equal(url.searchParams.get('radius'),'.25');assert.equal(url.searchParams.get('lang'),'ru');
}
{
  const f=fixture({online:false}),pending=f.api.resolve(location);f.api.onNativeResult(f.calls[0].requestId,null);
  assert.equal(await pending,null);assert.equal(f.network.length,0);
  const far=fixture({native:false,fetch:async()=>new Response(JSON.stringify({features:[
    photonFeature({name:'Дальний дом',street:'Дальняя',housenumber:'100'},[30.36,59.932]),
    photonFeature({name:'Санкт-Петербург',type:'city'}),photonFeature({name:'Другой город'},[40,50])
  ]}))});assert.equal(await far.api.resolve(location),null);
}
{
  const f=fixture({fastTimers:true,fetch:async()=>new Response(JSON.stringify({features:[photonFeature({name:'Парк'})]}))});
  const result=await f.api.resolve(location);assert.equal(result.name,'Парк');assert.deepEqual(f.cancel,[f.calls[0].requestId]);assert.equal(f.network.length,1);
  f.api.onNativeResult(f.calls[0].requestId,label('Позднее имя'));assert.equal((await f.api.resolve(location)).name,'Парк');
}
{
  const f=fixture({native:false,fetch:async()=>new Response('x',{headers:{'Content-Length':String(129*1024)}})});
  assert.equal(await f.api.resolve(location),null);
  const bad=fixture({native:false,fetch:async()=>new Response('broken JSON')});assert.equal(await bad.api.resolve(location),null);
  const stalled=fixture({native:false,fetch:(url,{signal})=>new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(new Error('abort')))),fastTimers:true});
  assert.equal(await stalled.api.resolve(location),null);
}
{
  const f=fixture(),abort=new AbortController();abort.abort();await rejectsAbort(f.api.resolve(location,{signal:abort.signal}));
  await assert.rejects(f.api.resolve({latitude:90,longitude:30}));await assert.rejects(f.api.resolve({latitude:59.93,longitude:'30'}));assert.equal(f.calls.length,0);
  const pending=[];
  for(let index=0;index<9;index++)pending.push(f.api.resolve({latitude:59.93+index*.001,longitude:30.36}).then(value=>value,error=>error.name));
  assert.equal(f.calls.length,9);assert.equal(await pending[0],'AbortError');assert.equal(f.cancel.length,1);
  for(const call of f.calls.slice(1))f.api.onNativeResult(call.requestId,label());await Promise.all(pending);
}
console.log('Place names OK: offline-first labels, exact point retained, independent endpoints/shared subscribers, stale/abort/timeout safety, bounded caches and nearby Photon fallback');
