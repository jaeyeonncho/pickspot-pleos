import test from 'node:test';
import assert from 'node:assert/strict';
import {TripInput} from '../routing/trip-input.mjs';
import {exampleTripInput} from '../routing/example.mjs';
import {FixtureRoutes} from '../routing/fixture.mjs';
import {estimatePickupRoutes} from '../routing/estimate.mjs';
const error=code=>e=>e.code===code;
function setup() {
  let at=1_800_000_000_000,tick=0;
  const input=new TripInput({now:()=>at,monotonic:()=>tick});
  return {input,trip:()=>exampleTripInput(at),advance:ms=>{at+=ms;tick+=ms;},wall:ms=>{at+=ms;},elapsed:ms=>{tick+=ms;}};
}
function deferredProvider() {
  let signal,start;
  const started=new Promise(resolve=>{start=resolve;});
  const state={source:'test',synthetic:true,started,route:request=>{
    signal=request.signal;start();
    return new Promise(done=>{state.finish=()=>done({distanceMeters:10,durationSeconds:20});});
  }};
  Object.defineProperty(state,'signal',{get:()=>signal});return state;
}
test('valid example input calculates without fabricating GPS accuracy or leaking coordinates',async()=>{
  const x=setup(),original=x.trip(),revision=x.input.replace(original);
  original.destination.point.latitude=0; original.candidates[0].point.latitude=0;
  const result=await x.input.calculate({provider:new FixtureRoutes()});
  assert.equal(result.candidates.length,3);assert.equal(result.providerCalls,7);
  assert.equal(result.inputRevision,revision);assert.equal(result.inputMode,'example');
  assert.equal(result.inputValidUntil,1_800_000_030_000);
  assert.equal(JSON.stringify(result).includes('latitude'),false);x.input.clear();
});
test('missing destination, consent, invalid coordinates and duplicate candidates are refused',()=>{
  const x=setup();
  for(const mutate of [t=>delete t.destination,t=>t.driver.consent=false,t=>t.passenger.consent=false,
    t=>t.driver.point.latitude=91,t=>t.candidates.push(t.candidates[0]),t=>t.candidates[1].id='a']) {
    const trip=x.trip();mutate(trip);assert.throws(()=>x.input.replace(trip));
  }
});
test('freshness boundary, future skew and timestamps are validated',()=>{
  const x=setup();
  for(const mutate of [t=>t.driver.observedAt-=30_000,t=>t.passenger.observedAt+=5_001,
    t=>t.driver.observedAt='1800000000000',t=>t.expiresAt-=900_000]) {
    const trip=x.trip();mutate(trip);assert.throws(()=>x.input.replace(trip));
  }
  const trip=x.trip();trip.driver.observedAt+=5_000;x.input.replace(trip);
});
test('live inputs require measured accuracy and correct sources for both participants',()=>{
  const x=setup(),trip=x.trip();trip.mode='live';trip.drivePreference='recommended';trip.routeObservedAt=trip.driver.observedAt;
  trip.driver.source='vehicle';trip.passenger.source='browser';
  for(const accuracy of [null,0,-1,101,NaN,'10']) {
    trip.driver.accuracyMeters=accuracy;trip.passenger.accuracyMeters=10;
    assert.throws(()=>x.input.replace(trip),error('LOCATION_ACCURACY_REQUIRED'));
  }
  trip.driver.accuracyMeters=10;trip.passenger.accuracyMeters=null;
  assert.throws(()=>x.input.replace(trip),error('LOCATION_ACCURACY_REQUIRED'));
  trip.passenger.accuracyMeters=10;trip.driver.source='example';
  assert.throws(()=>x.input.replace(trip),error('LOCATION_SOURCE_MISMATCH'));
  trip.driver.source='vehicle';x.input.replace(trip);
});
test('live input cannot be combined with synthetic route totals',async()=>{
  const x=setup(),trip=x.trip();trip.mode='live';trip.drivePreference='recommended';trip.routeObservedAt=trip.driver.observedAt;
  Object.assign(trip.driver,{source:'vehicle',accuracyMeters:10});
  Object.assign(trip.passenger,{source:'browser',accuracyMeters:10});x.input.replace(trip);
  await assert.rejects(x.input.calculate({provider:new FixtureRoutes()}),error('LIVE_PROVIDER_REQUIRED'));
});
test('elapsed time rejects stale inputs even when wall clock has not advanced',async()=>{
  const x=setup();x.input.replace(x.trip());x.elapsed(30_000);
  await assert.rejects(x.input.calculate({provider:new FixtureRoutes()}),error('LOCATION_STALE'));
});
test('backwards clock invalidates freshness instead of extending it',async()=>{
  const x=setup();x.input.replace(x.trip());x.wall(-1);
  await assert.rejects(x.input.calculate({provider:new FixtureRoutes()}),error('INVALID_CLOCK'));
});
test('input replacement immediately aborts an uncooperative old calculation',async()=>{
  const x=setup(),provider=deferredProvider();x.input.replace(x.trip());
  const pending=x.input.calculate({provider});const rejected=assert.rejects(pending,error('TRIP_INPUT_CHANGED'));
  await provider.started;const newer=x.trip();newer.destination.point.longitude+=0.01;x.input.replace(newer);
  await rejected;assert.equal(provider.signal.aborted,true);provider.finish();
});
test('permission withdrawal clears input and rejects late result',async()=>{
  const x=setup(),provider=deferredProvider();x.input.replace(x.trip());
  const pending=x.input.calculate({provider});const rejected=assert.rejects(pending,error('TRIP_INPUT_CHANGED'));
  await provider.started;const revoked=x.trip();revoked.passenger.consent=false;
  assert.throws(()=>x.input.replace(revoked),error('LOCATION_CONSENT_REQUIRED'));
  await rejected;provider.finish();
  await assert.rejects(x.input.calculate({provider:new FixtureRoutes()}),error('TRIP_INPUT_CHANGED'));
});
test('clear cancels work and removes usable positions until a new input is supplied',async()=>{
  const x=setup(),provider=deferredProvider();x.input.replace(x.trip());
  const pending=x.input.calculate({provider});const rejected=assert.rejects(pending,error('TRIP_INPUT_CHANGED'));
  await provider.started;x.input.clear();await rejected;provider.finish();
  await assert.rejects(x.input.calculate({provider:new FixtureRoutes()}),error('TRIP_INPUT_CHANGED'));
  x.input.replace(x.trip());assert.equal((await x.input.calculate({provider:new FixtureRoutes()})).candidates.length,3);
});
test('stale fix during a response discards the whole result and stops further calls',async()=>{
  const x=setup();x.input.replace(x.trip());let calls=0;
  const provider={source:'test',synthetic:true,route:async()=>{
    calls++;x.advance(30_000);return {distanceMeters:1,durationSeconds:1};
  }};
  await assert.rejects(x.input.calculate({provider}),error('LOCATION_STALE'));assert.equal(calls,1);
});
test('freshness deadline cancels a hanging adapter without waiting for the batch timeout',async()=>{
  const x=setup(),trip=x.trip();trip.driver.observedAt-=29_980;x.input.replace(trip);
  const provider=deferredProvider();
  await assert.rejects(x.input.calculate({provider,timeoutMs:1000}),error('LOCATION_STALE'));
  assert.equal(provider.signal.aborted,true);provider.finish();
});
test('user cancellation remains distinct and blocks already cancelled inputs',async()=>{
  const x=setup(),provider=deferredProvider(),controller=new AbortController();x.input.replace(x.trip());
  const pending=x.input.calculate({provider,signal:controller.signal});const rejected=assert.rejects(pending,error('ROUTE_CANCELLED'));
  await provider.started;controller.abort();await rejected;provider.finish();
  await assert.rejects(x.input.calculate({provider,signal:controller.signal}),error('ROUTE_CANCELLED'));
});
test('batch deadline works even when a route adapter ignores its abort signal',async()=>{
  const provider=deferredProvider(),trip=exampleTripInput();
  const raw={driver:trip.driver.point,passenger:trip.passenger.point,destination:trip.destination.point,candidates:trip.candidates};
  await assert.rejects(estimatePickupRoutes(raw,{provider,timeoutMs:10}),error('ROUTE_BATCH_TIMEOUT'));
  assert.equal(provider.signal.aborted,true);provider.finish();
});

test('a second calculation cancels the first without cancelling the replacement',async()=>{
  const x=setup(),old=deferredProvider();x.input.replace(x.trip());
  const pending=x.input.calculate({provider:old});const rejected=assert.rejects(pending,error('ROUTE_CANCELLED'));
  await old.started;const result=await x.input.calculate({provider:new FixtureRoutes()});
  await rejected;old.finish();assert.equal(result.candidates.length,3);
});
test('expiry limits validity and invalid provider cannot invoke routes',async()=>{
  const x=setup(),trip=x.trip();trip.expiresAt-=890_000;x.input.replace(trip);
  const result=await x.input.calculate({provider:new FixtureRoutes()});
  assert.equal(result.inputValidUntil,1_800_000_010_000);
  await assert.rejects(x.input.calculate({provider:{source:'x',synthetic:true}}),error('INVALID_ROUTE_PROVIDER'));
  x.advance(10_000);await assert.rejects(x.input.calculate({provider:new FixtureRoutes()}),error('LOCATION_STALE'));
});
