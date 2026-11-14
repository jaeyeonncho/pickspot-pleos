import test from 'node:test';
import assert from 'node:assert/strict';
import {SessionStore} from '../store.mjs';
import {createExampleRouteCalculator} from '../session-routing.mjs';
const tick=()=>new Promise(resolve=>setImmediate(resolve));
async function setup(t,options={}) {
  let time=1_800_000_000_000;
  const store=new SessionStore({now:()=>time,...options});t.after(()=>store.dispose());
  const made=store.create(), id=made.session.id, driver=made.driverToken;
  const passenger=store.redeem(made.session.inviteCode).passengerToken;
  const share=()=>store.shareExample(id,passenger,{consent:true,mode:'example'});
  const read=()=>store.read(id,driver);
  const refresh=()=>store.refreshRoutes(id,driver,{expectedVersion:read().version});
  return {store,id,driver,passenger,share,read,refresh,advance:ms=>{time+=ms;}};
}
test('share starts async calculation with empty candidates then both roles receive route metadata',async t=>{
  const x=await setup(t),first=x.share();
  assert.equal(first.route.status,'calculating');assert.equal(first.candidates.length,0);
  await tick();const done=x.read();assert.equal(done.route.status,'ready');assert.equal(done.candidates.length,3);
  assert.ok(done.version>first.version);assert.ok(done.candidates.every(c=>c.curbStatus==='unknown'));
  assert.deepEqual(x.store.read(x.id,x.passenger).route,done.route);
});
test('old version, passenger and arbitrary coordinates cannot trigger route refresh',async t=>{
  const x=await setup(t);x.share();await tick();x.advance(10_000);
  for(const [token,input,status] of [[x.passenger,{expectedVersion:x.read().version},403],
    [x.driver,{expectedVersion:1},409],[x.driver,{expectedVersion:x.read().version,latitude:37},400]]) {
    assert.throws(()=>x.store.refreshRoutes(x.id,token,input),e=>e.status===status);
  }
});
test('refresh clears old selection and candidates and has cooldown and total attempt limits',async t=>{
  const x=await setup(t,{maxRouteAttempts:2});x.share();await tick();
  assert.throws(x.refresh,e=>e.code==='ROUTE_COOLDOWN');
  x.advance(10_000);const pending=x.refresh();assert.equal(pending.route.status,'calculating');assert.equal(pending.candidates.length,0);
  assert.throws(x.refresh,e=>e.code==='REQUEST_IN_PROGRESS');await tick();x.advance(10_000);
  assert.throws(x.refresh,e=>e.code==='ROUTE_ATTEMPT_LIMIT');assert.equal(x.read().route.attemptsRemaining,0);
});
test('pending navigation blocks recomputation until report becomes final',async t=>{
  const x=await setup(t);x.share();await tick();const s=x.read();
  const chosen=x.store.select(x.id,x.driver,{candidateId:'a',expectedVersion:s.version});x.advance(10_000);
  assert.throws(x.refresh,e=>e.code==='REQUEST_IN_PROGRESS');
  x.store.report(x.id,x.driver,{selectionId:chosen.selection.id,status:'confirmed'});
  const pending=x.refresh();assert.equal(pending.selection,null);assert.equal(pending.candidates.length,0);
});
test('expired route metrics clear choices and block navigation even before periodic sweep',async t=>{
  const x=await setup(t);x.share();await tick();const ready=x.read();x.advance(120_000);
  assert.throws(()=>x.store.select(x.id,x.driver,{candidateId:'a',expectedVersion:ready.version}),e=>e.status===409);
  const stale=x.read();assert.equal(stale.route.status,'stale');assert.equal(stale.candidates.length,0);assert.equal(stale.selection,null);
  x.refresh();await tick();assert.equal(x.read().route.status,'ready');
});
test('end aborts in-flight calculation and late noncooperative result cannot restore data',async t=>{
  let resolve,signal;const x=await setup(t,{calculateRoutes:input=>{signal=input.signal;return new Promise(r=>resolve=r);}});
  x.share();await tick();x.store.end(x.id,x.passenger);assert.equal(signal.aborted,true);
  resolve(await createExampleRouteCalculator()({}));await tick();
  const s=x.store.sessions.get(x.id);assert.equal(s.route,null);assert.equal(s.passenger,null);assert.equal(s.candidates.length,0);
});
test('session expiry during calculation rejects late results and cleans job',async t=>{
  let resolve;const x=await setup(t,{ttlMs:100,calculateRoutes:()=>new Promise(r=>resolve=r)});
  x.share();await tick();x.advance(100);resolve(await createExampleRouteCalculator()({}));await tick();
  assert.throws(x.read,e=>e.status===410);assert.equal(x.store.routeJobs.size,0);
  assert.equal(x.store.sessions.get(x.id).route,null);
});
test('failure does not leave invented candidates and can be retried',async t=>{
  let fail=true;const x=await setup(t,{calculateRoutes:input=>{if(fail)throw new Error('secret');return createExampleRouteCalculator()(input);}});
  x.share();await tick();assert.equal(x.read().route.status,'failed');assert.deepEqual(x.read().candidates,[]);
  assert.ok(!JSON.stringify(x.read()).includes('secret'));fail=false;x.advance(10_000);x.refresh();await tick();assert.equal(x.read().route.status,'ready');
});
test('repeated share does not spend more route attempts',async t=>{
  const x=await setup(t);x.share();await tick();const version=x.read().version;x.share();await tick();
  assert.equal(x.read().version,version);assert.equal(x.store.sessions.get(x.id).routeAttempts,1);
});
test('non-example calculator result is rejected instead of mixed into demo session',async t=>{
  const x=await setup(t,{calculateRoutes:async()=>({synthetic:false,source:'tmap'})});x.share();await tick();
  assert.equal(x.read().route.status,'failed');assert.equal(x.read().candidates.length,0);
});
test('destination change cancels old calculation and rejects its late result',async t=>{
 let finish,oldSignal,calls=0;
 const x=await setup(t,{calculateRoutes:args=>{
   if(++calls===1){oldSignal=args.signal;return new Promise(resolve=>finish=resolve);}
   return createExampleRouteCalculator()(args);
 }});
 x.share();await tick();x.advance(10_000);
 const changed=x.store.changeDestination(x.id,x.driver,{expectedVersion:x.read().version,destinationId:'yangjae'});
 assert.equal(oldSignal.aborted,true);assert.equal(changed.candidates.length,0);
 await tick();const ready=x.read();assert.equal(ready.route.destinationName,'예제 목적지 · 양재역 주변');
 finish(await createExampleRouteCalculator()({}));await tick();assert.equal(x.read().version,ready.version);
 assert.deepEqual(x.read().candidates.map(c=>c.detourSeconds),[270,45,120]);
});
test('destination change cannot bypass pending navigation or total route attempt limit',async t=>{
 const x=await setup(t,{maxRouteAttempts:1});x.share();await tick();x.advance(10_000);
 const ready=x.read();x.store.select(x.id,x.driver,{candidateId:'a',expectedVersion:ready.version});
 const update=()=>x.store.changeDestination(x.id,x.driver,{expectedVersion:x.read().version,destinationId:'yangjae'});
 assert.throws(update,e=>e.code==='REQUEST_IN_PROGRESS');
 x.store.report(x.id,x.driver,{selectionId:x.read().selection.id,status:'failed'});
 assert.throws(update,e=>e.code==='ROUTE_ATTEMPT_LIMIT');assert.equal(x.read().destination.id,'maebong');
});
