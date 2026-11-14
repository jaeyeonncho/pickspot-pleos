import test from 'node:test';
import assert from 'node:assert/strict';
import {TripInput} from '../routing/trip-input.mjs';
import {exampleTripInput} from '../routing/example.mjs';
import {FixtureRoutes} from '../routing/fixture.mjs';

const error=code=>value=>value.code===code;
const totals={distanceMeters:100,durationSeconds:60};
function setup(t) {
  let at=1_800_000_000_000,tick=0;
  const input=new TripInput({now:()=>at,monotonic:()=>tick});t.after(()=>input.clear());
  const trip=()=>({...exampleTripInput(at),routeObservedAt:at});
  return {input,trip,wall:ms=>at+=ms,elapsed:ms=>tick+=ms};
}

test('live input requires route observation time independently of fresh GPS',t=>{
  const x=setup(t),trip=x.trip();trip.mode='live';
  Object.assign(trip.driver,{source:'vehicle',accuracyMeters:12});
  Object.assign(trip.passenger,{source:'browser',accuracyMeters:12});
  delete trip.routeObservedAt;
  assert.throws(()=>x.input.replace(trip),error('ROUTE_CONTEXT_REQUIRED'));
  for(const stamp of [null,0,-1,'1800000000000',NaN,Infinity,1_800_000_000_000.5,1_800_000_005_001]) {
    assert.throws(()=>x.input.replace({...trip,routeObservedAt:stamp}),error('INVALID_ROUTE_TIME'));
  }
});

test('route snapshots expire at thirty seconds and accepted future skew cannot extend validity',async t=>{
  const x=setup(t),trip=x.trip();
  x.input.replace({...trip,routeObservedAt:trip.routeObservedAt-29_999});
  assert.throws(()=>x.input.replace({...trip,routeObservedAt:trip.routeObservedAt-30_000}),error('ROUTE_CONTEXT_STALE'));
  x.input.replace({...trip,routeObservedAt:trip.routeObservedAt+5_000});
  assert.equal((await x.input.calculate({provider:new FixtureRoutes()})).inputValidUntil,trip.routeObservedAt+30_000);
});

test('old route bounds result validity even when both locations are fresh',async t=>{
  const x=setup(t),trip=x.trip();trip.routeObservedAt-=20_000;x.input.replace(trip);
  const report=await x.input.calculate({provider:new FixtureRoutes()});
  assert.equal(report.inputValidUntil,trip.driver.observedAt+10_000);
  assert.ok(!JSON.stringify(report).includes('routeObservedAt'));
  assert.ok(!JSON.stringify(report).includes('latitude'));
});

test('a location or session expiry still takes precedence over a newer route',async t=>{
  for(const expiry of ['location','session']) {
    const x=setup(t),trip=x.trip();
    if(expiry==='location')trip.passenger.observedAt-=25_000;
    else trip.expiresAt=trip.driver.observedAt+5_000;
    x.input.replace(trip);
    assert.equal((await x.input.calculate({provider:new FixtureRoutes()})).inputValidUntil,trip.driver.observedAt+5_000);
    x.elapsed(5_000);
    await assert.rejects(x.input.calculate({provider:new FixtureRoutes()}),error('LOCATION_STALE'));
  }
});

test('elapsed clock expires the route without wall-clock progress and mutable input cannot refresh it',async t=>{
  const x=setup(t),trip=x.trip();trip.routeObservedAt-=20_000;x.input.replace(trip);
  trip.routeObservedAt+=20_000;x.elapsed(10_000);
  await assert.rejects(x.input.calculate({provider:new FixtureRoutes()}),error('ROUTE_CONTEXT_STALE'));
});

test('route expiry after baseline discards results and sends no candidate requests',async t=>{
  const x=setup(t),trip=x.trip();trip.routeObservedAt-=29_000;x.input.replace(trip);let calls=0;
  const provider={source:'test',synthetic:true,route:async()=>{calls++;x.elapsed(1_000);return totals;}};
  await assert.rejects(x.input.calculate({provider}),error('ROUTE_CONTEXT_STALE'));
  assert.equal(calls,1);
});

test('route deadline aborts a budget reservation and a late reservation never dispatches',async t=>{
  const x=setup(t),trip=x.trip();trip.routeObservedAt-=29_920;x.input.replace(trip);
  let release,signal,calls=0;
  const provider={source:'test',synthetic:true,route:async()=>{calls++;return totals;},
    prepareBatch:(_count,options)=>{signal=options.signal;return new Promise(resolve=>release=resolve);}};
  await assert.rejects(x.input.calculate({provider,timeoutMs:1000}),error('ROUTE_CONTEXT_STALE'));
  assert.equal(signal.aborted,true);release(provider);
  await new Promise(resolve=>setImmediate(resolve));assert.equal(calls,0);
});

test('a stale replacement route cancels old work and cannot leave old input usable',async t=>{
  const x=setup(t),trip=x.trip();x.input.replace(trip);
  let started,finish,signal;const entered=new Promise(resolve=>started=resolve);
  const provider={source:'test',synthetic:true,route:request=>{
    signal=request.signal;started();return new Promise(resolve=>finish=()=>resolve(totals));
  }};
  const pending=x.input.calculate({provider});const rejected=assert.rejects(pending,error('TRIP_INPUT_CHANGED'));
  await entered;
  assert.throws(()=>x.input.replace({...trip,routeObservedAt:trip.routeObservedAt-30_000}),error('ROUTE_CONTEXT_STALE'));
  await rejected;assert.equal(signal.aborted,true);finish();
  await assert.rejects(x.input.calculate({provider:new FixtureRoutes()}),error('TRIP_INPUT_CHANGED'));
});
