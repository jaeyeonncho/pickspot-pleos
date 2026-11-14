import test from 'node:test';
import assert from 'node:assert/strict';
import {createTmapBatchProvider} from '../routing/batch-provider.mjs';
import {TripInput} from '../routing/trip-input.mjs';
import {exampleTripInput} from '../routing/example.mjs';
import {RouteError} from '../routing/contract.mjs';
const summary=()=>new Response(JSON.stringify({type:'FeatureCollection',features:[{properties:{totalTime:60,totalDistance:100}}]}));
const settle=()=>new Promise(resolve=>setImmediate(resolve));
function setup({budget}={}) {
  let calls=0;const reservations=[];
  const provider=createTmapBatchProvider({appKey:'test-key-not-real',budget:budget??{consume(){},async reserve(count){reservations.push(count);}},fetchImpl:async()=>{calls++;return summary();}});
  const input=new TripInput();const value=exampleTripInput(Date.now());
  value.candidates=value.candidates.slice(0,2);input.replace(value);
  return {provider,input,value,reservations,calls:()=>calls};
}
test('two-candidate comparison reserves exactly five calls once before dispatch',async()=>{
  const x=setup();try{const result=await x.input.calculate({provider:x.provider});assert.equal(result.providerCalls,5);assert.deepEqual(x.reservations,[5]);assert.equal(x.calls(),5);}finally{x.input.clear();}
});
test('insufficient complete batch budget makes zero upstream calls',async()=>{
  const x=setup({budget:{consume(){},reserve:async()=>{throw new RouteError('ROUTE_BUDGET_EXCEEDED');}}});
  try{await assert.rejects(x.input.calculate({provider:x.provider}),e=>e.code==='ROUTE_BUDGET_EXCEEDED');assert.equal(x.calls(),0);}finally{x.input.clear();}
});
test('batch deadline cancels a pending reservation and late approval never dispatches',async()=>{
  let release,signal;const x=setup({budget:{consume(){},reserve:(_,options)=>{signal=options.signal;return new Promise(resolve=>release=resolve);}}});
  try{
    await assert.rejects(x.input.calculate({provider:x.provider,timeoutMs:10}),e=>e.code==='ROUTE_BATCH_TIMEOUT');
    assert.equal(signal.aborted,true);release();await settle();assert.equal(x.calls(),0);
  }finally{x.input.clear();}
});
test('each lease has its own allowance and direct unreserved routing is rejected',async()=>{
  const x=setup(),point=x.value.driver.point,request={mode:'drive',origin:point,destination:point};
  assert.throws(()=>x.provider.route(request),e=>e.code==='ROUTE_BATCH_REQUIRED');
  const one=await x.provider.prepareBatch(1),two=await x.provider.prepareBatch(1);
  await one.route(request);await assert.rejects(one.route(request),e=>e.code==='ROUTE_BUDGET_EXCEEDED');
  await two.route(request);assert.equal(x.calls(),2);assert.deepEqual(x.reservations,[1,1]);x.input.clear();
});
test('invalid trip and already-cancelled requests cannot reserve calls',async()=>{
  const x=setup();x.input.clear();await assert.rejects(x.input.calculate({provider:x.provider}),e=>e.code==='TRIP_INPUT_CHANGED');
  const c=new AbortController();c.abort();await assert.rejects(x.provider.prepareBatch(5,{signal:c.signal}),e=>e.code==='ROUTE_CANCELLED');
  assert.deepEqual(x.reservations,[]);assert.equal(x.calls(),0);
});
