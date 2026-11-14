import test from 'node:test';
import assert from 'node:assert/strict';
import {RouteError} from '../routing/contract.mjs';
import {TmapRoutes,parseTmapSummary} from '../routing/tmap.mjs';
import {estimatePickupRoutes} from '../routing/estimate.mjs';
import {exampleTrip} from '../routing/example.mjs';
import {FixtureRoutes} from '../routing/fixture.mjs';
import {preview} from '../route-preview.mjs';

// Adapter unit tests use a fake budget and fake transport; integration tests use a real ledger.
const budget = {consume() {}};
const ok = (distance=900,seconds=120) => ({type:'FeatureCollection',features:[
  {type:'Feature',properties:{totalDistance:distance,totalTime:seconds}},
  {type:'Feature',properties:{distance:25,time:10}}]});
const json = value => new Response(JSON.stringify(value),{headers:{'Content-Type':'application/json'}});
const code = value => e => e instanceof RouteError && e.code === value;
const trip = exampleTrip();
const request = {mode:'drive',origin:trip.driver,destination:trip.destination};
const pendingFetch = (_url,{signal}) => new Promise((_resolve,reject) => {
  signal.addEventListener('abort',()=>reject(new Error('internal details')),{once:true});
});

test('TMAP uses correct lon/lat, header-only key, one via and identical drive options',async()=>{
  const calls=[];
  const p=new TmapRoutes({budget,appKey:'test-key',fetchImpl:async(url,options)=>{calls.push({url,options});return json(ok());}});
  assert.deepEqual(await p.route(request),{distanceMeters:900,durationSeconds:120});
  await p.route({...request,via:trip.candidates[0].point});
  await p.route({mode:'walk',origin:trip.passenger,destination:trip.candidates[0].point});
  const [base,via,walk]=calls.map(c=>JSON.parse(c.options.body));
  assert.equal(calls[0].url,'https://apis.openapi.sk.com/tmap/routes?version=1');
  assert.equal(calls[2].url,'https://apis.openapi.sk.com/tmap/routes/pedestrian?version=1');
  assert.equal(base.startX,127.0300);assert.equal(base.startY,37.4840);
  assert.equal(via.passList,'127.03636666,37.48544722');
  const {passList,...withoutVia}=via; assert.deepEqual(base,withoutVia);
  assert.equal(walk.startX,trip.passenger.longitude);assert.equal(walk.endX,trip.candidates[0].point.longitude);
  assert.equal(decodeURIComponent(walk.startName),'출발');assert.equal(walk.totalValue,undefined);
  for(const c of calls){assert.equal(c.options.redirect,'error');assert.equal(c.options.headers.appKey,'test-key');assert.ok(!c.url.includes('test-key'));assert.ok(!c.options.body.includes('test-key'));}
});

test('missing keys and invalid inputs never make a request',async()=>{
  assert.throws(()=>new TmapRoutes(),code('TMAP_KEY_REQUIRED'));
  let calls=0;const p=new TmapRoutes({budget,appKey:'test',fetchImpl:async()=>{calls++;return json(ok());}});
  for(const r of [{...request,mode:'bike'},{...request,origin:{latitude:NaN,longitude:1}},{...request,origin:{latitude:91,longitude:1}},{...request,mode:'walk',via:trip.driver}]) await assert.rejects(p.route(r),RouteError);
  assert.equal(calls,0);
});

test('route parser rejects missing, negative, string, fractional, ambiguous and error totals',()=>{
  for(const data of [{},ok(-1,5),ok(1,-1),ok('1',2),ok(2,1.1),ok(1,Number.MAX_SAFE_INTEGER+1),{...ok(),error:{}},
    {type:'FeatureCollection',features:[{properties:{distance:1,time:2}}]},
    {type:'FeatureCollection',features:[...ok().features,...ok().features]}]) assert.throws(()=>parseTmapSummary(data),code('INVALID_ROUTE_RESPONSE'));
  assert.deepEqual(parseTmapSummary(ok(0,0)),{distanceMeters:0,durationSeconds:0});
});

test('auth, quota and upstream failures are sanitized and never automatically retried',async()=>{
  for(const [status,expected] of [[401,'ROUTE_AUTH_FAILED'],[403,'ROUTE_AUTH_FAILED'],[429,'ROUTE_QUOTA_EXCEEDED'],[500,'ROUTE_PROVIDER_ERROR'],[400,'ROUTE_PROVIDER_ERROR']]) {
    let calls=0;const p=new TmapRoutes({budget,appKey:'secret',fetchImpl:async()=>{calls++;return new Response('secret, precise location',{status});}});
    await assert.rejects(p.route(request),e=>{assert.equal(e.message,expected);return true;});assert.equal(calls,1);
  }
});

test('unparseable JSON and oversized body are rejected',async()=>{
  for(const [response,expected] of [[new Response('{'),'INVALID_ROUTE_RESPONSE'],[new Response('x'.repeat(2_000_001)),'ROUTE_RESPONSE_TOO_LARGE'],[new Response('x',{headers:{'Content-Length':'2000001'}}),'ROUTE_RESPONSE_TOO_LARGE']]){
    const p=new TmapRoutes({budget,appKey:'test',fetchImpl:async()=>response});await assert.rejects(p.route(request),code(expected));
  }
});

test('network failures do not reveal upstream text',async()=>{
  const p=new TmapRoutes({budget,appKey:'secret',fetchImpl:async()=>{throw new Error('secret key and coordinates');}});
  await assert.rejects(p.route(request),e=>e.message==='ROUTE_NETWORK_ERROR');
});

test('request timeout aborts the provider fetch',async()=>{
  const p=new TmapRoutes({budget,appKey:'test',fetchImpl:pendingFetch,timeoutMs:10});
  await assert.rejects(p.route(request),code('ROUTE_TIMEOUT'));
});

test('cancellation aborts in-flight requests and blocks already cancelled requests',async()=>{
  const c=new AbortController();let calls=0;let started;const dispatched=new Promise(resolve=>{started=resolve;});
  const p=new TmapRoutes({budget,appKey:'test',fetchImpl:(...args)=>{calls++;started();return pendingFetch(...args);}});
  const pending=p.route({...request,signal:c.signal});await dispatched;c.abort();
  await assert.rejects(pending,code('ROUTE_CANCELLED'));
  await assert.rejects(p.route({...request,signal:c.signal}),code('ROUTE_CANCELLED'));assert.equal(calls,1);
});

test('example calculation compares via route to original destination baseline with seven calls',async()=>{
  const result=await estimatePickupRoutes(exampleTrip(),{provider:new FixtureRoutes(),now:()=>1234});
  assert.equal(result.providerCalls,7);assert.equal(result.baselineDriveSeconds,600);
  assert.equal(result.referenceOnly,true);assert.equal(result.synthetic,true);assert.equal(result.source,'synthetic-fixture');
  assert.deepEqual(result.candidates.map(c=>[c.walkSeconds,c.detourSeconds]),[[240,120],[120,300],[420,45]]);
  assert.ok(result.candidates.every(c=>c.curbStatus==='unknown'&&c.warnings.includes('CURB_UNVERIFIED')));
});

test('destination required, max three candidates, valid unique IDs and points validated before calls',async()=>{
  let calls=0;const provider={source:'fake',synthetic:true,route:async()=>{calls++;return {distanceMeters:1,durationSeconds:1};}};
  const invalid=[{...exampleTrip(),destination:null},{...exampleTrip(),candidates:[]},{...exampleTrip(),candidates:[...trip.candidates,trip.candidates[0]]},
    {...exampleTrip(),candidates:[trip.candidates[0],trip.candidates[0]]},
    {...exampleTrip(),candidates:[{...trip.candidates[0],point:{latitude:1,longitude:200}}]}];
  for(const input of invalid) await assert.rejects(estimatePickupRoutes(input,{provider}),RouteError);
  assert.equal(calls,0);
});

test('restricted candidates are excluded without a route call',async()=>{
  const input=exampleTrip();input.candidates=input.candidates.map(c=>({...c,curbStatus:'restricted'}));
  const result=await estimatePickupRoutes(input,{provider:new FixtureRoutes()});
  assert.equal(result.providerCalls,0);assert.equal(result.baselineDriveSeconds,null);assert.equal(result.excluded.length,3);
});

test('baseline failure returns no misleading detours',async()=>{
  const provider={source:'fake',synthetic:true,route:async()=>{throw new RouteError('ROUTE_TIMEOUT');}};
  await assert.rejects(estimatePickupRoutes(exampleTrip(),{provider}),code('ROUTE_TIMEOUT'));
});

test('a failed candidate is omitted without replacing it with demo values',async()=>{
  const fixture=new FixtureRoutes();const provider={source:'fake',synthetic:false,route:async r=>{
    if(r.mode==='walk'&&r.destination.latitude===trip.candidates[1].point.latitude)throw new RouteError('INVALID_ROUTE_RESPONSE');
    return fixture.route(r);
  }};
  const result=await estimatePickupRoutes(exampleTrip(),{provider});
  assert.deepEqual(result.candidates.map(c=>c.id),['a','c']);assert.equal(result.providerCalls,6);
  assert.deepEqual(result.excluded,[{id:'b',reason:'INVALID_ROUTE_RESPONSE'}]);assert.equal(result.synthetic,false);
});

test('quota failure midway fails whole batch and stops remaining paid calls',async()=>{
  let calls=0;const provider={source:'fake',synthetic:false,route:async()=>{
    if(++calls===3)throw new RouteError('ROUTE_QUOTA_EXCEEDED');return {distanceMeters:1,durationSeconds:1};
  }};
  await assert.rejects(estimatePickupRoutes(exampleTrip(),{provider}),code('ROUTE_QUOTA_EXCEEDED'));assert.equal(calls,3);
});

test('negative difference is clamped but raw value and warning remain',async()=>{
  const provider={source:'fake',synthetic:true,route:async r=>({distanceMeters:10,durationSeconds:r.via?80:100})};
  const result=await estimatePickupRoutes(exampleTrip(),{provider});
  for(const c of result.candidates){assert.equal(c.detourSeconds,0);assert.equal(c.rawDeltaSeconds,-20);assert.ok(c.warnings.includes('ROUTE_COMPARISON_VARIATION'));}
});

test('in-flight input mutations cannot mix old and new destinations or candidates',async()=>{
  const input=exampleTrip(),seen=[];const fixture=new FixtureRoutes();
  const provider={source:'fake',synthetic:true,route:async r=>{
    seen.push(structuredClone({destination:r.destination,via:r.via}));
    if(seen.length===1){input.destination.latitude=1;input.candidates[0].point.latitude=1;input.candidates[1].curbStatus='restricted';}
    return fixture.route(r);
  }};
  const result=await estimatePickupRoutes(input,{provider});assert.equal(result.candidates.length,3);
  assert.equal(seen[2].destination.latitude,trip.destination.latitude);assert.equal(seen[2].via.latitude,trip.candidates[0].point.latitude);
});

test('batch deadline aborts provider and never returns partial results',async()=>{
  const provider=new TmapRoutes({budget,appKey:'test',fetchImpl:pendingFetch,timeoutMs:1000});
  await assert.rejects(estimatePickupRoutes(exampleTrip(),{provider,timeoutMs:10}),code('ROUTE_BATCH_TIMEOUT'));
});

test('batch user cancellation stays distinct from timeout',async()=>{
  const controller=new AbortController();const provider=new TmapRoutes({budget,appKey:'test',fetchImpl:pendingFetch});
  const pending=estimatePickupRoutes(exampleTrip(),{provider,signal:controller.signal});controller.abort();
  await assert.rejects(pending,code('ROUTE_CANCELLED'));
});

test('CLI defaults to synthetic offline data even if key exists; live is explicit and never falls back',async()=>{
  let calls=0;const fetchImpl=async()=>{calls++;throw new Error('network');};
  assert.equal((await preview({env:{TMAP_APP_KEY:'secret'},fetchImpl})).synthetic,true);assert.equal(calls,0);
  await assert.rejects(preview({args:['--live'],fetchImpl}),code('USE_NO_FLAGS_OR_LIVE_EXAMPLE_ONLY'));
  await assert.rejects(preview({args:['--live','--example-only'],env:{},fetchImpl}),code('TMAP_KEY_REQUIRED'));assert.equal(calls,0);
  await assert.rejects(preview({args:['--live','--example-only'],env:{TMAP_APP_KEY:'secret'},fetchImpl,budget}),code('ROUTE_NETWORK_ERROR'));assert.equal(calls,1);
});

test('live preview maps successful provider totals and does not label them synthetic',async()=>{
  let calls=0;const result=await preview({args:['--live','--example-only'],env:{TMAP_APP_KEY:'test'},budget,fetchImpl:async()=>{calls++;return json(ok());}});
  assert.equal(calls,7);assert.equal(result.source,'tmap');assert.equal(result.synthetic,false);assert.equal(result.referenceOnly,true);
});
