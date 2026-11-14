import test from 'node:test';
import assert from 'node:assert/strict';
import {SessionStore} from '../store.mjs';
import {exampleTrip} from '../routing/example.mjs';
import {CandidateCatalog} from '../catalog/repository.mjs';
import {FixtureRoutes} from '../routing/fixture.mjs';
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function setup(t,options={}) {
  let now=options.at??1_800_000_000_000;
  const base=exampleTrip();
  const raw={schemaVersion:1,region:'검사 전용 가상 자료',entries:base.candidates.map(c=>({id:c.id,name:c.id,address:'검사 주소',vehiclePoint:c.point,walkingPoint:c.point,
    sources:[{publisher:'검사 자료',url:'https://example.test/catalog',checkedOn:'2026-01-01',asOf:null,fact:'자동 검사 전용. 실제 장소 아님.'}],
    review:{status:'reviewed',generalVehiclePickup:'confirmed',meetingConnection:'connected',dataUse:'permitted',checkedOn:'2026-01-01',validUntil:'2030-01-01',conditions:'검사 전용'},openQuestions:[]}))};
  const catalog=new CandidateCatalog(raw);
  const store=new SessionStore({locationMode:'live',now:()=>now,monotonic:()=>now,candidateCatalog:catalog,...options});t.after(()=>store.dispose());
  const made=store.create(),id=made.session.id,driver=made.driverToken,passenger=store.redeem(made.session.inviteCode).passengerToken;
  const grant=store.grantLocation(id,passenger,{consent:true,expectedRevision:0,routingProvider:'tmap'});
  let sequence=0;
  const update=()=>store.updateLocation(id,passenger,{grantId:grant.grantId,sequence:++sequence,point:base.passenger,observedAt:now,accuracyMeters:12});
  const trip=()=>({driver:{point:base.driver,observedAt:now,accuracyMeters:12,source:'vehicle',consent:true,routingProvider:'tmap'},destination:{point:base.destination,name:'검사용 목적지'},waypoints:[],drivePreference:'recommended',routeObservedAt:now,candidateIds:base.candidates.map(c=>c.id)});
  const fixture=new FixtureRoutes();let calls=0;
  const provider={source:'tmap',synthetic:false,route:request=>{calls++;return fixture.route(request);}};
  const calculate=(input=trip(),p=provider)=>store.calculateLiveRoutes(id,driver,input,{provider:{...p,prepareBatch:async()=>p}});
  return {store,id,driver,passenger,update,trip,provider,calculate,catalog,raw,calls:()=>calls,advance:ms=>{now+=ms;}};
}
test('authenticated live passenger input reaches route comparison without leaking raw positions',async t=>{
  const x=setup(t);x.update();const report=await x.calculate();
  assert.equal(report.inputMode,'live');assert.equal(report.synthetic,false);assert.equal(report.providerCalls,7);
  assert.deepEqual(report.candidates.map(c=>c.detourSeconds),[120,300,45]);
  assert.ok(!JSON.stringify(report).includes('latitude'));assert.ok(!JSON.stringify(report).includes('longitude'));
  assert.equal(x.store.routeJobs.size,0);
});
test('authenticated live trip retains original stops and rejects unknown coordinates before calls',async t=>{
  const x=setup(t);x.update();const seen=[];
  const provider={source:'tmap',synthetic:false,maxWaypoints:2,route:async request=>{
    seen.push(structuredClone({waypoints:request.waypoints,via:request.via}));
    return {distanceMeters:1000,durationSeconds:600};
  }};
  const trip={...x.trip(),waypoints:[{latitude:37.488,longitude:127.0395}]};
  await assert.rejects(x.calculate({...trip,waypoints:[{latitude:0,longitude:0}]},provider),e=>e.code==='ROUTE_COORDINATE_UNAVAILABLE');
  assert.equal(seen.length,0);
  const report=await x.calculate(trip,provider);
  assert.equal(seen.length,7);assert.equal(report.originalWaypointCount,1);
  for(const index of [0,2,4,6])assert.deepEqual(seen[index].waypoints,trip.waypoints);
  assert.ok(!JSON.stringify(report).includes('127.0395'));
});
test('live trip must explicitly distinguish zero original stops from an unread itinerary',async t=>{
  const x=setup(t);x.update();const trip=x.trip();delete trip.waypoints;
  await assert.rejects(x.calculate(trip),e=>e.code==='ORIGINAL_WAYPOINTS_REQUIRED');
  assert.equal(x.calls(),0);
  assert.equal((await x.calculate({...trip,waypoints:[]})).originalWaypointCount,0);
});
test('unread or stale route is refused before session attempts and a fresh read can recover',async t=>{
  const x=setup(t);x.update();const trip=x.trip();delete trip.routeObservedAt;
  await assert.rejects(x.calculate(trip),e=>e.code==='ROUTE_CONTEXT_REQUIRED');
  await assert.rejects(x.calculate({...trip,routeObservedAt:trip.driver.observedAt-30_000}),e=>e.code==='ROUTE_CONTEXT_STALE');
  assert.equal(x.calls(),0);assert.equal(x.store.sessions.get(x.id).routeAttempts,0);
  const report=await x.calculate({...trip,routeObservedAt:trip.driver.observedAt-20_000});
  assert.equal(report.inputValidUntil,trip.driver.observedAt+10_000);assert.equal(x.calls(),7);
});
test('missing passenger, original destination and measured vehicle accuracy never call a provider',async t=>{
  const x=setup(t);await assert.rejects(x.calculate(),e=>e.code==='PASSENGER_LOCATION_REQUIRED');x.update();
  await assert.rejects(x.calculate({...x.trip(),destination:null}),e=>e.code==='DESTINATION_REQUIRED');
  const trip=x.trip();trip.driver.accuracyMeters=null;
  await assert.rejects(x.calculate(trip),e=>e.code==='LOCATION_ACCURACY_REQUIRED');assert.equal(x.calls(),0);
});
test('passenger credentials, demo store and synthetic providers cannot initiate real calculation',async t=>{
  const x=setup(t);x.update();
  await assert.rejects(x.store.calculateLiveRoutes(x.id,x.passenger,x.trip(),{provider:x.provider}),e=>e.code==='DRIVER_ONLY');
  await assert.rejects(x.calculate(x.trip(),new FixtureRoutes()),e=>e.code==='LIVE_PROVIDER_REQUIRED');assert.equal(x.calls(),0);
});
test('withdrawal aborts an uncooperative provider and late responses are discarded',async t=>{
  const x=setup(t);x.update();let release,signal;
  const provider={source:'tmap',synthetic:false,route:request=>{signal=request.signal;return new Promise(resolve=>release=resolve);}};
  const result=x.calculate(x.trip(),provider);await tick();x.store.withdrawLocation(x.id,x.passenger);
  await assert.rejects(result,e=>['ROUTE_CANCELLED','TRIP_INPUT_CHANGED'].includes(e.code));assert.equal(signal.aborted,true);
  release({distanceMeters:1,durationSeconds:1});await tick();assert.equal(x.store.routeJobs.size,0);assert.deepEqual(x.store.read(x.id,x.driver).candidates,[]);
});
test('new position and session end both invalidate in-flight calculations',async t=>{
  for(const mutation of ['update','end']) {
    const x=setup(t);x.update();const provider={source:'tmap',synthetic:false,route:()=>new Promise(()=>{})};
    const result=x.calculate(x.trip(),provider);await tick();x.advance(1);
    if(mutation==='update')x.update();else x.store.end(x.id,x.passenger);
    await assert.rejects(result,e=>['ROUTE_CANCELLED','TRIP_INPUT_CHANGED'].includes(e.code));assert.equal(x.store.routeJobs.size,0);
  }
});
test('invalid replacement trip cancels old work before refusing the new request',async t=>{
  const x=setup(t);x.update();const provider={source:'tmap',synthetic:false,route:()=>new Promise(()=>{})};
  const pending=x.calculate(x.trip(),provider);await tick();
  await assert.rejects(x.calculate({...x.trip(),destination:null}),e=>e.code==='DESTINATION_REQUIRED');
  await assert.rejects(pending,e=>['ROUTE_CANCELLED','TRIP_INPUT_CHANGED'].includes(e.code));assert.equal(x.store.routeJobs.size,0);
});
test('live route calculation enforces cooldown and per-session attempts before new API calls',async t=>{
  const x=setup(t,{maxRouteAttempts:2});x.update();await x.calculate();
  await assert.rejects(x.calculate(),e=>e.code==='ROUTE_COOLDOWN');assert.equal(x.calls(),7);
  x.advance(10000);x.update();await x.calculate();assert.equal(x.calls(),14);
  x.advance(10000);x.update();await assert.rejects(x.calculate(),e=>e.code==='ROUTE_ATTEMPT_LIMIT');assert.equal(x.calls(),14);
});
test('ageing out during a response fails the whole comparison without more calls',async t=>{
  const x=setup(t);x.update();let calls=0;const provider={source:'tmap',synthetic:false,route:async()=>{calls++;x.advance(30000);return {distanceMeters:1,durationSeconds:1};}};
  await assert.rejects(x.calculate(x.trip(),provider),e=>e.code==='LOCATION_STALE');assert.equal(calls,1);assert.equal(x.store.routeJobs.size,0);
});

test('routing requires separate provider consent from both participants and a batch-capable provider',async t=>{
  const x=setup(t);x.update();const trip=x.trip();delete trip.driver.routingProvider;
  await assert.rejects(x.calculate(trip),e=>e.code==='ROUTING_CONSENT_REQUIRED');
  await assert.rejects(x.store.calculateLiveRoutes(x.id,x.driver,x.trip(),{provider:x.provider}),e=>e.code==='ROUTE_BUDGET_REQUIRED');
  const grant=x.store.grantLocation(x.id,x.passenger,{consent:true,expectedRevision:x.store.read(x.id,x.passenger).locationShare.revision});
  const sample=x.trip().driver;
  x.store.updateLocation(x.id,x.passenger,{grantId:grant.grantId,sequence:1,point:sample.point,observedAt:sample.observedAt,accuracyMeters:12});
  await assert.rejects(x.calculate(),e=>e.code==='ROUTING_CONSENT_REQUIRED');assert.equal(x.calls(),0);
  assert.equal(x.store.read(x.id,x.passenger).locationShare.routingProvider,undefined);
});
test('live calculation only accepts reviewed server catalog IDs and carries source conditions',async t=>{
  const x=setup(t);x.update();
  await assert.rejects(x.calculate({...x.trip(),candidates:exampleTrip().candidates}),e=>e.code==='CATALOG_CANDIDATE_IDS_REQUIRED');
  const raw=structuredClone(x.raw);raw.entries[0].review.status='pending';x.catalog.replace(raw);
  await assert.rejects(x.calculate(),e=>e.code==='CANDIDATE_NOT_REVIEWED');assert.equal(x.calls(),0);
  x.catalog.replace(x.raw);const report=await x.calculate();
  assert.equal(report.candidateProvenance.length,3);assert.equal(report.candidateProvenance[0].review.conditions,'검사 전용');
  assert.equal(report.catalogRevision,3);assert.ok(!JSON.stringify(report).includes('latitude'));
});
test('catalog replacement including a malformed update aborts slow results without stale fallback',async t=>{
  for(const invalid of [false,true]) {
    const x=setup(t);x.update();let release;
    const p={source:'tmap',synthetic:false,route:()=>new Promise(resolve=>release=resolve)};
    const result=x.calculate(x.trip(),p);await tick();
    if(invalid)assert.throws(()=>x.catalog.replace({schemaVersion:2}));else x.catalog.replace(x.raw);
    await assert.rejects(result,e=>e.code==='CANDIDATE_CATALOG_CHANGED');
    release({distanceMeters:1,durationSeconds:1});await tick();assert.equal(x.store.routeJobs.size,0);
    if(invalid)await assert.rejects(x.calculate(),e=>e.code==='CANDIDATE_CATALOG_REQUIRED');
  }
});
test('catalog review expiry bounds returned validity and cancels a hanging calculation',async t=>{
  const at=Date.parse('2026-11-14T23:59:59.950Z');
  const x=setup(t,{at});x.raw.entries.forEach(e=>e.review.validUntil='2026-11-15');x.catalog.replace(x.raw);x.update();
  const report=await x.calculate();assert.equal(report.inputValidUntil,at+50);
  const y=setup(t,{at});y.raw.entries.forEach(e=>e.review.validUntil='2026-11-15');y.catalog.replace(y.raw);y.update();
  await assert.rejects(y.calculate(y.trip(),{source:'tmap',synthetic:false,route:()=>new Promise(()=>{})}),e=>e.code==='LOCATION_STALE');
  assert.equal(y.store.routeJobs.size,0);
});
test('withdrawal during budget reservation prevents dispatch even if reservation finishes late',async t=>{
  const x=setup(t);x.update();let release,signal,calls=0;
  const p={source:'tmap',synthetic:false,route:async()=>{calls++;return {distanceMeters:1,durationSeconds:1};},
    prepareBatch:(count,options)=>{assert.equal(count,7);signal=options.signal;return new Promise(resolve=>release=resolve);}};
  const result=x.store.calculateLiveRoutes(x.id,x.driver,x.trip(),{provider:p});await tick();x.store.withdrawLocation(x.id,x.passenger);
  await assert.rejects(result,e=>['TRIP_INPUT_CHANGED','ROUTE_CANCELLED'].includes(e.code));assert.equal(signal.aborted,true);
  release(p);await tick();assert.equal(calls,0);
});


test('live calculation preference reaches every vehicle request and reports no Pleos equivalence',async t=>{
  const x=setup(t);x.update();const seen=[];
  const provider={source:'tmap',synthetic:false,drivePreferences:['free-first'],route:async request=>{
    seen.push(request.drivePreference);return {distanceMeters:1000,durationSeconds:600};
  }};
  const report=await x.calculate({...x.trip(),drivePreference:'free-first'},provider);
  assert.equal(report.drivePreference,'free-first');assert.equal(report.vehicleRouteOptionMatched,false);
  assert.deepEqual(seen,['free-first',undefined,'free-first',undefined,'free-first',undefined,'free-first']);
});
test('missing or invalid live calculation preference is refused before attempts or provider calls',async t=>{
  const x=setup(t);x.update();const trip=x.trip();delete trip.drivePreference;
  await assert.rejects(x.calculate(trip),e=>e.code==='DRIVE_PREFERENCE_REQUIRED');
  await assert.rejects(x.calculate({...trip,drivePreference:'PLEOS_FASTEST'}),e=>e.code==='INVALID_DRIVE_PREFERENCE');
  assert.equal(x.calls(),0);assert.equal(x.store.sessions.get(x.id).routeAttempts,0);
});
