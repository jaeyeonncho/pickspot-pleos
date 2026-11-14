import test from 'node:test';
import assert from 'node:assert/strict';
import {TmapRoutes} from '../routing/tmap.mjs';
import {createTmapBatchProvider} from '../routing/batch-provider.mjs';
import {estimatePickupRoutes} from '../routing/estimate.mjs';
import {TripInput} from '../routing/trip-input.mjs';
import {FixtureRoutes} from '../routing/fixture.mjs';
import {exampleTrip,exampleTripInput} from '../routing/example.mjs';

const stop={latitude:37.488,longitude:127.0395}; // Authored fixed test point, not a reviewed pickup location.
const code=expected=>error=>error.code===expected;
const summary={distanceMeters:1000,durationSeconds:600};
const response=()=>new Response(JSON.stringify({type:'FeatureCollection',features:[{properties:{totalDistance:1000,totalTime:600}}]}));

test('baseline preserves original stop and pickup route prepends pickup with the same destination and options',async()=>{
  const bodies=[];let consumed=0;
  const provider=new TmapRoutes({appKey:'test-only',budget:{consume(){consumed++;}},fetchImpl:async(url,options)=>{
    bodies.push({url,body:JSON.parse(options.body)});return response();
  }});
  const trip={...exampleTrip(),waypoints:[stop]};
  const report=await estimatePickupRoutes(trip,{provider});
  assert.equal(consumed,7);assert.equal(report.providerCalls,7);
  assert.equal(report.originalWaypointCount,1);assert.equal(report.pickupOrder,'before_original_waypoints');
  assert.equal(bodies[0].body.passList,'127.0395,37.488');
  for(let i=0;i<3;i++) {
    const walking=bodies[1+2*i],driving=bodies[2+2*i],pickup=trip.candidates[i].point;
    assert.ok(walking.url.includes('/pedestrian'));assert.equal(walking.body.passList,undefined);
    assert.equal(driving.body.passList,`${pickup.longitude},${pickup.latitude}_127.0395,37.488`);
    const {passList:baselineStops,...baseline}=bodies[0].body;
    const {passList:pickupStops,...comparison}=driving.body;
    assert.deepEqual(comparison,baseline);
  }
  assert.ok(!JSON.stringify(report).includes('latitude'));
  assert.ok(!JSON.stringify(report).includes('127.0395'));
});

test('zero original stops keeps legacy example results and single pickup request',async()=>{
  const report=await estimatePickupRoutes({...exampleTrip(),waypoints:[]},{provider:new FixtureRoutes()});
  assert.equal(report.originalWaypointCount,0);
  assert.deepEqual(report.candidates.map(candidate=>candidate.detourSeconds),[120,300,45]);
});

test('unsupported providers and fixed demo totals cannot silently omit original stops',async()=>{
  let calls=0;
  const provider={source:'test',synthetic:true,route:async()=>{calls++;return summary;}};
  for(const maxWaypoints of [undefined,1,1.5,'2']) {
    await assert.rejects(estimatePickupRoutes({...exampleTrip(),waypoints:[stop]},
      {provider:{...provider,maxWaypoints}}),code('ROUTE_WAYPOINTS_UNSUPPORTED'));
  }
  assert.equal(calls,0);
  await assert.rejects(new FixtureRoutes().route({mode:'drive',origin:exampleTrip().driver,
    destination:exampleTrip().destination,waypoints:[stop]}),code('ROUTE_WAYPOINTS_UNSUPPORTED'));
});

test('invalid, missing-coordinate, sparse or over-limit original stops fail before provider calls',async()=>{
  let calls=0;
  const provider={source:'test',synthetic:true,maxWaypoints:2,route:async()=>{calls++;return summary;}};
  for(const waypoints of [null,{},[null],[{latitude:0,longitude:0}],[{latitude:91,longitude:127}],
    [stop,stop],Array(1)]) {
    await assert.rejects(estimatePickupRoutes({...exampleTrip(),waypoints},{provider}));
  }
  for(const mutate of [trip=>trip.destination={latitude:0,longitude:0},trip=>trip.candidates[0].point={latitude:0,longitude:0},
    trip=>trip.candidates[0].walkingPoint={latitude:0,longitude:0}]) {
    const trip=exampleTrip();mutate(trip);await assert.rejects(estimatePickupRoutes(trip,{provider}),code('ROUTE_COORDINATE_UNAVAILABLE'));
  }
  assert.equal(calls,0);
});

test('TMAP validates stop list, combined pickup limit and walking mode before budget or transport',async()=>{
  let consumed=0,calls=0;
  const provider=new TmapRoutes({appKey:'test-only',budget:{consume(){consumed++;}},fetchImpl:async()=>{calls++;return response();}});
  const request={mode:'drive',origin:exampleTrip().driver,destination:exampleTrip().destination};
  for(const additional of [{waypoints:[stop,stop],via:stop},{waypoints:null},{waypoints:[{latitude:0,longitude:0}]},
    {mode:'walk',waypoints:[stop]},{via:{latitude:0,longitude:0}}]) {
    await assert.rejects(provider.route({...request,...additional}));
  }
  assert.equal(consumed,0);assert.equal(calls,0);
});

test('input edits while a baseline is running do not mix stop snapshots',async()=>{
  const trip={...exampleTrip(),waypoints:[{...stop}]},seen=[];
  const provider={source:'test',synthetic:true,maxWaypoints:2,route:async request=>{
    seen.push(structuredClone({waypoints:request.waypoints,via:request.via,destination:request.destination}));
    if(seen.length===1){trip.waypoints[0].latitude=1;trip.waypoints.push({latitude:2,longitude:3});}
    return summary;
  }};
  await estimatePickupRoutes(trip,{provider});
  for(const index of [0,2,4,6])assert.deepEqual(seen[index].waypoints,[stop]);
});

test('TripInput keeps ordered stops through the batch reservation and sends no additional requests',async()=>{
  const at=1_800_000_000_000,input=new TripInput({now:()=>at}),trip=exampleTripInput(at),reserved=[],bodies=[];
  trip.waypoints=[{...stop}];input.replace(trip);trip.waypoints[0].longitude=1;
  const provider=createTmapBatchProvider({appKey:'test-only',budget:{consume(){throw new Error('unreserved');},reserve:async count=>reserved.push(count)},
    fetchImpl:async(_url,options)=>{bodies.push(JSON.parse(options.body));return response();}});
  try {
    const report=await input.calculate({provider});
    assert.deepEqual(reserved,[7]);assert.equal(bodies.length,7);assert.equal(bodies[0].passList,'127.0395,37.488');
    assert.equal(report.originalWaypointCount,1);assert.equal(report.inputMode,'example');
  }finally{input.clear();}
});

test('invalid or unsupported original stops do not reserve a paid batch',async()=>{
  const at=1_800_000_000_000,input=new TripInput({now:()=>at});let reserved=0;
  const provider={source:'test',synthetic:true,route:async()=>summary,prepareBatch:async()=>{reserved++;return provider;}};
  const trip={...exampleTripInput(at),waypoints:[stop]};input.replace(trip);
  try {
    await assert.rejects(input.calculate({provider}),code('ROUTE_WAYPOINTS_UNSUPPORTED'));
    assert.throws(()=>input.replace({...trip,waypoints:[{latitude:0,longitude:0}]}),code('ROUTE_COORDINATE_UNAVAILABLE'));
    await assert.rejects(input.calculate({provider}),code('TRIP_INPUT_CHANGED'));
    assert.equal(reserved,0);
  }finally{input.clear();}
});

test('a prepared provider that loses stop support is rejected without a transport request',async()=>{
  const at=1_800_000_000_000,input=new TripInput({now:()=>at});let calls=0;
  const active={source:'test',synthetic:true,route:async()=>{calls++;return summary;}};
  input.replace({...exampleTripInput(at),waypoints:[stop]});
  try {
    await assert.rejects(input.calculate({provider:{...active,maxWaypoints:2,prepareBatch:async()=>active}}),code('ROUTE_WAYPOINTS_UNSUPPORTED'));
    assert.equal(calls,0);
  }finally{input.clear();}
});

test('replacing only the original stop cancels an in-flight comparison',async()=>{
  const at=1_800_000_000_000,input=new TripInput({now:()=>at});
  let started,finish,signal;const entered=new Promise(resolve=>started=resolve);
  const provider={source:'test',synthetic:true,maxWaypoints:2,route:request=>{
    signal=request.signal;started();return new Promise(resolve=>finish=()=>resolve(summary));
  }};
  const trip={...exampleTripInput(at),waypoints:[stop]};input.replace(trip);
  const pending=input.calculate({provider});const rejected=assert.rejects(pending,code('TRIP_INPUT_CHANGED'));
  await entered;input.replace({...trip,waypoints:[{latitude:37.50,longitude:127.05}]});
  await rejected;assert.equal(signal.aborted,true);finish();input.clear();
});
