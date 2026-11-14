import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import {FileCallBudget} from '../routing/call-budget.mjs';
import {SessionStore} from '../store.mjs';
import {createApp,configuredStore} from '../server.mjs';
import {createTmapExampleRouteCalculator} from '../session-routing.mjs';
import {RouteError} from '../routing/contract.mjs';
import {routeDescription,meetingView} from '../public/meeting-state.mjs';

const response=()=>new Response(JSON.stringify({type:'FeatureCollection',features:[{properties:{totalDistance:191,totalTime:146}}]}));
async function setup(t,{limit=7,fetchImpl=response}={}) {
  const dir=await mkdtemp(join(tmpdir(),'pickspot-tmap-session-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const path=join(dir,'calls.json');
  const budget=new FileCallBudget({filePath:path,limit});
  const store=configuredStore({args:['--tmap-example'],env:{TMAP_APP_KEY:'test-key',TMAP_DAILY_CALL_LIMIT:String(limit)},fetchImpl,budget});
  t.after(()=>store.dispose());
  const made=store.create(),id=made.session.id,driver=made.driverToken;
  const passenger=store.redeem(made.session.inviteCode).passengerToken;
  return {budget,store,id,driver,passenger,read:()=>store.read(id,driver),ledger:async()=>JSON.parse(await readFile(path,'utf8')),
    share:()=>store.shareExample(id,passenger,{mode:'example',consent:true})};
}
async function settled(x){
  for(let i=0;i<500;i++){
    const s=x.read();if(s.route?.status!=='calculating')return s;
    await new Promise(r=>setTimeout(r,5));
  }
  assert.fail('Calculation did not finish');
}
test('explicit TMAP example mode delivers real-source metrics, never promotes examples to live positions',async t=>{
  let calls=0;
  const x=await setup(t,{fetchImpl:async(url,options)=>{
    calls++;assert.equal(options.headers.appKey,'test-key');
    assert.ok(url.startsWith('https://apis.openapi.sk.com/tmap/routes'));
    assert.equal((await x.ledger()).used,7);return response();
  }});
  const pending=x.share();assert.equal(pending.route.source,'tmap');assert.equal(pending.candidates.length,0);
  const ready=await settled(x);
  assert.equal(calls,7);assert.equal(ready.route.status,'ready');assert.equal(ready.route.synthetic,false);
  assert.equal(ready.route.inputMode,'example');assert.equal(ready.isDemo,true);assert.equal(ready.route.referenceOnly,true);
  assert.equal(ready.candidates.length,3);assert.ok(ready.candidates.every(c=>c.walkMeters===191&&c.curbStatus==='unknown'));
  const selected=x.store.select(x.id,x.driver,{expectedVersion:ready.version,candidateId:'a'});
  x.store.report(x.id,x.driver,{selectionId:selected.selection.id,status:'confirmed'});
  assert.equal(meetingView(x.store.read(x.id,x.passenger)).status,'confirmed');
  assert.match(routeDescription(ready.route),/TMAP 실제 경로/);
  assert.equal(JSON.stringify(ready).includes('test-key'),false);
});
test('insufficient allowance rejects the entire batch before any external request',async t=>{
  let calls=0;const x=await setup(t,{fetchImpl:()=>{calls++;return response();}});
  await x.budget.consume();x.share();
  const failed=await settled(x);
  assert.equal(failed.route.status,'failed');assert.equal(failed.route.issue,'limit');
  assert.equal(failed.route.attemptsRemaining,0);assert.deepEqual(failed.candidates,[]);
  assert.equal(calls,0);assert.equal((await x.ledger()).used,1);
  assert.match(meetingView(failed).copy,/조회량이 부족/);
});
test('concurrent batches cannot split the same daily allowance',async t=>{
  let calls=0;const x=await setup(t,{fetchImpl:()=>{calls++;return response();}});
  const calculate=createTmapExampleRouteCalculator({appKey:'test-key',budget:x.budget,fetchImpl:()=>{calls++;return response();}});
  const outcomes=await Promise.allSettled([calculate(),calculate()]);
  assert.equal(outcomes.filter(r=>r.status==='fulfilled').length,1);
  assert.equal(outcomes.find(r=>r.status==='rejected').reason.code,'ROUTE_BUDGET_EXCEEDED');
  assert.equal(calls,7);assert.equal((await x.ledger()).used,7);
});
test('authentication and provider quota failures stop immediately, with no fallback or exposed body',async t=>{
  for(const [status,issue] of [[403,'configuration'],[429,'limit']]){
    let calls=0;const x=await setup(t,{fetchImpl:()=>{calls++;return new Response('private-key-provider-detail',{status});}});
    x.share();const failed=await settled(x);
    assert.equal(calls,1);assert.equal(failed.route.issue,issue);assert.equal(failed.route.attemptsRemaining,0);
    assert.deepEqual(failed.candidates,[]);assert.equal(JSON.stringify(failed).includes('private-key-provider-detail'),false);
  }
});
test('network failure is reported distinctly without automatic retries or fabricated results',async t=>{
  let calls=0;const x=await setup(t,{fetchImpl:()=>{calls++;throw new Error('secret');}});
  x.share();const failed=await settled(x);
  assert.equal(calls,1);assert.equal(failed.route.issue,'connection');assert.deepEqual(failed.candidates,[]);
  assert.equal(failed.route.attemptsRemaining,4);assert.equal((await x.ledger()).used,7);
});
test('default server stays offline even with an API key; live mode and unknown flags fail closed',()=>{
  const store=configuredStore({env:{TMAP_APP_KEY:'test-key',TMAP_DAILY_CALL_LIMIT:'7'}});
  assert.equal(store.routingMode,'fixture');store.dispose();
  for(const args of [['--live'],['--tmap-example','--live']])assert.throws(()=>configuredStore({args}));
  assert.throws(()=>configuredStore({args:['--tmap-example'],env:{TMAP_APP_KEY:'test-key'}}));
  assert.throws(()=>new SessionStore({locationMode:'live',routingMode:'tmap-example'}));
  assert.throws(()=>createTmapExampleRouteCalculator({appKey:''}),RouteError);
});
test('HTTP reports the calculation source and keeps arbitrary coordinates out of the example endpoint',async t=>{
  const x=await setup(t);const server=createApp({store:x.store});
  server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>new Promise(r=>server.close(r)));
  const base=`http://127.0.0.1:${server.address().port}`;
  const health=await(await fetch(base+'/health')).json();assert.equal(health.routingMode,'tmap-example');
  const bad=await fetch(`${base}/v1/sessions/${x.id}/passenger-location`,{method:'PUT',
    headers:{'Content-Type':'application/json',Authorization:`Bearer ${x.passenger}`},
    body:JSON.stringify({consent:true,mode:'example',latitude:37})});
  assert.equal(bad.status,400);assert.equal(x.read().route,null);
  x.share();await settled(x);
  const view=await(await fetch(`${base}/v1/sessions/${x.id}`,{headers:{Authorization:`Bearer ${x.driver}`}})).json();
  assert.equal(view.route.source,'tmap');assert.equal(view.route.inputMode,'example');assert.equal(view.candidates.length,3);
});
test('invalid reservation sizes and pre-cancelled requests cannot change the ledger',async t=>{
  const x=await setup(t);await x.budget.consume();
  for(const count of [0,8,-1,1.5,'7'])await assert.rejects(x.budget.reserve(count),e=>e.code==='ROUTE_BUDGET_CONFIG_INVALID');
  const c=new AbortController();c.abort();await assert.rejects(x.budget.reserve(1,{signal:c.signal}),e=>e.code==='ROUTE_CANCELLED');
  assert.equal((await x.ledger()).used,1);
});
