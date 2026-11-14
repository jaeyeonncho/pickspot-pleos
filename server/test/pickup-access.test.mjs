import test from 'node:test';
import assert from 'node:assert/strict';
import {estimatePickupRoutes} from '../routing/estimate.mjs';
import {TripInput} from '../routing/trip-input.mjs';
import {exampleTrip,exampleTripInput} from '../routing/example.mjs';

const entrance = () => ({latitude:37.486,longitude:127.036});
function recorder(onCall=()=>{}) {
  const requests=[];
  return {requests,source:'test',synthetic:true,route:async request=>{
    requests.push(structuredClone({mode:request.mode,destination:request.destination,via:request.via}));
    onCall(requests.length);
    return {distanceMeters:100,durationSeconds:60};
  }};
}

test('walking entrance and vehicle approach are routed separately with unchanged call count',async()=>{
  const trip=exampleTrip();trip.candidates=trip.candidates.slice(0,1);
  trip.candidates[0].walkingPoint=entrance();
  const provider=recorder();const report=await estimatePickupRoutes(trip,{provider});
  assert.equal(report.providerCalls,3);
  assert.deepEqual(provider.requests[1].destination,entrance());
  assert.deepEqual(provider.requests[2].via,trip.candidates[0].point);
  assert.deepEqual(provider.requests[2].destination,trip.destination);
  assert.equal(report.candidates[0].curbStatus,'unknown');
  assert.ok(report.candidates[0].warnings.includes('CURB_UNVERIFIED'));
  assert.equal(JSON.stringify(report).includes('latitude'),false);
});

test('legacy candidates use their vehicle point for walking without changing fixture inputs',async()=>{
  const trip=exampleTrip(),provider=recorder();await estimatePickupRoutes(trip,{provider});
  trip.candidates.forEach((candidate,i)=>{
    assert.deepEqual(provider.requests[1+i*2].destination,candidate.point);
    assert.deepEqual(provider.requests[2+i*2].via,candidate.point);
  });
});

test('invalid explicit entrances fail the whole batch before any provider request',async()=>{
  for(const walkingPoint of [null,{}, {latitude:91,longitude:127}, {latitude:37,longitude:'127'}]) {
    const trip=exampleTrip();trip.candidates[2].walkingPoint=walkingPoint;
    const provider=recorder();
    await assert.rejects(estimatePickupRoutes(trip,{provider}),e=>e.code==='INVALID_POINT');
    assert.equal(provider.requests.length,0);
    const input=new TripInput(),timed=exampleTripInput();timed.candidates=trip.candidates;
    assert.throws(()=>input.replace(timed),e=>e.code==='INVALID_POINT');
  }
});

test('in-flight edits cannot change copied pedestrian entrances',async()=>{
  const trip=exampleTrip();trip.candidates[0].walkingPoint=entrance();
  const provider=recorder(count=>{if(count===1)trip.candidates[0].walkingPoint.latitude=1;});
  await estimatePickupRoutes(trip,{provider});
  assert.deepEqual(provider.requests[1].destination,entrance());
});

test('TripInput preserves and snapshots separate entrances through the freshness boundary',async()=>{
  const at=1_800_000_000_000,input=new TripInput({now:()=>at,monotonic:()=>0});
  const trip=exampleTripInput(at);trip.candidates[0].walkingPoint=entrance();
  input.replace(trip);trip.candidates[0].walkingPoint.latitude=1;
  const provider=recorder(),report=await input.calculate({provider});
  assert.deepEqual(provider.requests[1].destination,entrance());
  assert.deepEqual(provider.requests[2].via,trip.candidates[0].point);
  assert.equal(report.inputValidUntil,at+30_000);input.clear();
});
