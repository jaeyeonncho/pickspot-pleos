import test from 'node:test';
import assert from 'node:assert/strict';
import {drivePreference,DRIVE_PREFERENCES,TMAP_DRIVE_OPTIONS} from '../routing/drive-preference.mjs';
import {TmapRoutes} from '../routing/tmap.mjs';
import {createTmapBatchProvider} from '../routing/batch-provider.mjs';
import {estimatePickupRoutes} from '../routing/estimate.mjs';
import {TripInput} from '../routing/trip-input.mjs';
import {exampleTrip,exampleTripInput} from '../routing/example.mjs';
import {FixtureRoutes} from '../routing/fixture.mjs';

const code=expected=>error=>error.code===expected;
const totals={distanceMeters:1000,durationSeconds:600};
const response=()=>new Response(JSON.stringify({type:'FeatureCollection',features:[{properties:{totalDistance:1000,totalTime:600}}]}));
const at=1_800_000_000_000;

test('calculation preference validates explicit values without interpreting Pleos options',()=>{
  assert.equal(drivePreference(undefined),'recommended');
  assert.throws(()=>drivePreference(undefined,{required:true}),code('DRIVE_PREFERENCE_REQUIRED'));
  for(const value of [null,0,1,'0','RECOMMENDED','FASTEST',{},[],true,'recommended ', '__proto__'])
    assert.throws(()=>drivePreference(value),code('INVALID_DRIVE_PREFERENCE'));
});

test('every supported preference has the documented TMAP code and walking stays independent',async()=>{
  const bodies=[];
  const provider=new TmapRoutes({appKey:'test-only',budget:{consume(){}},fetchImpl:async(url,options)=>{
    bodies.push({url,body:JSON.parse(options.body)});return response();
  }});
  const expected={recommended:0,'free-first':1,fastest:2,beginner:3,'highway-first':4,shortest:10,'avoid-school-zones':19};
  assert.deepEqual(TMAP_DRIVE_OPTIONS,expected);
  for(const [preference,value] of Object.entries(expected)) {
    bodies.length=0;
    const report=await estimatePickupRoutes({...exampleTrip(),drivePreference:preference},{provider});
    assert.equal(report.drivePreference,preference);assert.equal(report.vehicleRouteOptionMatched,false);
    for(const index of [0,2,4,6])assert.equal(bodies[index].body.searchOption,value);
    for(const index of [1,3,5])assert.equal(bodies[index].body.searchOption,'0');
  }
});

test('invalid preferences and walking drive options fail before consumption or HTTP',async()=>{
  let calls=0,consumed=0;
  const provider=new TmapRoutes({appKey:'test-only',budget:{consume(){consumed++;}},fetchImpl:async()=>{calls++;return response();}});
  const trip=exampleTrip();
  for(const preference of [null,2,'fastest ',{searchOption:2},'RECOMMENDED']) {
    await assert.rejects(provider.route({mode:'drive',origin:trip.driver,destination:trip.destination,drivePreference:preference}),code('INVALID_DRIVE_PREFERENCE'));
  }
  await assert.rejects(provider.route({mode:'walk',origin:trip.passenger,destination:trip.destination,drivePreference:'fastest'}),code('INVALID_ROUTE_REQUEST'));
  assert.equal(calls,0);assert.equal(consumed,0);
});

test('live input requires an explicit calculation preference even with fresh GPS and itinerary',()=>{
  const input=new TripInput({now:()=>at});const trip=exampleTripInput(at);
  trip.mode='live';trip.routeObservedAt=at;
  Object.assign(trip.driver,{source:'vehicle',accuracyMeters:12});
  Object.assign(trip.passenger,{source:'browser',accuracyMeters:12});
  assert.throws(()=>input.replace(trip),code('DRIVE_PREFERENCE_REQUIRED'));
  input.replace({...trip,drivePreference:'free-first'});input.clear();
});

test('unsupported preferences do not reserve a batch or silently use fixture totals',async()=>{
  const input=new TripInput({now:()=>at});let reserved=0;
  input.replace({...exampleTripInput(at),drivePreference:'fastest'});
  const provider={source:'test',synthetic:true,route:async()=>totals,prepareBatch:async()=>{reserved++;return provider;}};
  await assert.rejects(input.calculate({provider}),code('DRIVE_PREFERENCE_UNSUPPORTED'));
  assert.equal(reserved,0);
  await assert.rejects(new FixtureRoutes().route({...exampleTrip(),mode:'drive',drivePreference:'fastest'}),code('DRIVE_PREFERENCE_UNSUPPORTED'));
  input.clear();
});

test('batch provider carries one chosen preference into all four vehicle requests',async()=>{
  const input=new TripInput({now:()=>at}),bodies=[],reservations=[];
  input.replace({...exampleTripInput(at),drivePreference:'free-first'});
  const provider=createTmapBatchProvider({appKey:'test-only',budget:{consume(){throw Error('unreserved');},reserve:async count=>reservations.push(count)},
    fetchImpl:async(_url,options)=>{bodies.push(JSON.parse(options.body));return response();}});
  const report=await input.calculate({provider});input.clear();
  assert.deepEqual(reservations,[7]);assert.equal(report.drivePreference,'free-first');
  assert.deepEqual([0,2,4,6].map(i=>bodies[i].searchOption),[1,1,1,1]);
});

test('prepared provider losing preference support cannot dispatch',async()=>{
  const input=new TripInput({now:()=>at});let calls=0;
  input.replace({...exampleTripInput(at),drivePreference:'fastest'});
  const active={source:'test',synthetic:true,route:async()=>{calls++;return totals;}};
  await assert.rejects(input.calculate({provider:{...active,drivePreferences:DRIVE_PREFERENCES,prepareBatch:async()=>active}}),code('DRIVE_PREFERENCE_UNSUPPORTED'));
  assert.equal(calls,0);input.clear();
});

test('mutation during baseline cannot change the preference used for candidate comparisons',async()=>{
  const trip={...exampleTrip(),drivePreference:'fastest'},seen=[];
  const provider={source:'test',synthetic:true,drivePreferences:DRIVE_PREFERENCES,route:async request=>{
    seen.push(request.drivePreference);trip.drivePreference='free-first';return totals;
  }};
  const report=await estimatePickupRoutes(trip,{provider});
  assert.equal(report.drivePreference,'fastest');assert.deepEqual(seen,['fastest',undefined,'fastest',undefined,'fastest',undefined,'fastest']);
});

test('replacing only preference cancels previous work including uncooperative responses',async()=>{
  const input=new TripInput({now:()=>at});let enter,finish,signal;
  const started=new Promise(resolve=>enter=resolve);
  const provider={source:'test',synthetic:true,drivePreferences:DRIVE_PREFERENCES,route:request=>{
    signal=request.signal;enter();return new Promise(resolve=>finish=()=>resolve(totals));
  }};
  const trip={...exampleTripInput(at),drivePreference:'fastest'};input.replace(trip);
  const pending=input.calculate({provider});const rejected=assert.rejects(pending,code('TRIP_INPUT_CHANGED'));
  await started;input.replace({...trip,drivePreference:'free-first'});
  await rejected;assert.equal(signal.aborted,true);finish();input.clear();
});
