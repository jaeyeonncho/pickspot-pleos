import test from 'node:test';
import assert from 'node:assert/strict';
import {createCompetitionApp} from '../competition-server.mjs';
import {createApp} from '../server.mjs';
import {SessionStore} from '../store.mjs';
import {meetingView} from '../public/meeting-state.mjs';

async function setup(t,server=createCompetitionApp()) {
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}));
  const origin=`http://127.0.0.1:${server.address().port}`;
  return async(path,method='GET',body,token)=>{
    const res=await fetch(origin+path,{method,headers:{Origin:origin,...(body?{'Content-Type':'application/json'}:{}),...(token?{Authorization:`Bearer ${token}`}:{})},
      ...(body?{body:JSON.stringify(body)}:{})});
    return {status:res.status,value:await res.json()};
  };
}
test('competition demo shares a chosen point without claiming navigation and allows repeated choices',async t=>{
  const call=await setup(t),health=(await call('/health')).value;
  assert.equal(health.competitionDemo,true);assert.equal(health.routingMode,'fixture');assert.equal(health.exampleOnly,true);
  const made=(await call('/v1/sessions','POST',{})).value,path=`/v1/sessions/${made.session.id}`;
  const joined=(await call('/v1/invitations/redeem','POST',{code:made.session.inviteCode})).value;
  const passenger=joined.passengerToken,driver=made.driverToken;
  await call(path+'/passenger-location','PUT',{consent:true,mode:'example'},passenger);
  let state;
  for(let n=0;n<20;n++) {state=(await call(path,'GET',undefined,driver)).value;if(state.route?.status==='ready')break;await new Promise(r=>setTimeout(r,10));}
  assert.equal(state.route.source,'synthetic-fixture');assert.equal(state.route.synthetic,true);assert.equal(state.candidates.length,3);
  assert.equal((await call(path+'/meeting-choice','PUT',{candidateId:'a',expectedVersion:state.version},passenger)).status,403);
  for(const id of ['a','b','c']) {
    const result=await call(path+'/meeting-choice','PUT',{candidateId:id,expectedVersion:state.version},driver);
    assert.equal(result.status,200);state=result.value;assert.equal(state.selection.navigationStatus,'not-requested');
    const view=meetingView((await call(path,'GET',undefined,passenger)).value);
    assert.equal(view.candidate.id,id);assert.equal(view.status,'not-requested');assert.match(view.copy,/같은 픽업 지점/);
  }
  assert.equal((await call(path+'/meeting-choice','PUT',{candidateId:'a',expectedVersion:1},driver)).status,409);
  // Selecting a meeting point cannot manufacture a navigation receipt.
  assert.equal((await call(path+'/navigation','PUT',{selectionId:state.selection.id,status:'confirmed'},driver)).status,409);
  assert.equal((await call(path,'DELETE',undefined,driver)).status,200);
  assert.equal((await call(path,'GET',undefined,passenger)).status,410);
});
test('ordinary example server does not expose competition choice endpoint or capability',async t=>{
  const call=await setup(t,createApp());assert.equal((await call('/health')).value.competitionDemo,undefined);
  const made=(await call('/v1/sessions','POST',{})).value;
  assert.equal((await call(`/v1/sessions/${made.session.id}/meeting-choice`,'PUT',{},made.driverToken)).status,404);
});
test('competition capability refuses a TMAP-mode store',()=>{
  const store=new SessionStore({routingMode:'tmap-example',calculateRoutes:()=>{throw new Error('never');}});
  try {assert.throws(()=>createApp({store,competitionDemo:true}),e=>e.code==='COMPETITION_FIXTURE_REQUIRED');}finally{store.dispose();}
});

async function readyExample(call) {
  const made=(await call('/v1/sessions','POST',{})).value;
  const path=`/v1/sessions/${made.session.id}`;
  const joined=(await call('/v1/invitations/redeem','POST',{code:made.session.inviteCode})).value;
  await call(path+'/passenger-location','PUT',{consent:true,mode:'example'},joined.passengerToken);
  let state;
  for(let n=0;n<20;n++) {
    state=(await call(path,'GET',undefined,made.driverToken)).value;
    if(state.route?.status==='ready')break;
    await new Promise(r=>setTimeout(r,10));
  }
  assert.equal(state.route.status,'ready');
  return {path,driver:made.driverToken,state};
}
test('competition fixed candidates survive a presentation and expire at thirty minutes',async t=>{
  let at=Date.now();const started=at;
  const call=await setup(t,createCompetitionApp({now:()=>at}));
  const {path,driver,state}=await readyExample(call);
  assert.equal(state.route.validUntil,started+30*60_000);
  at=started+30*60_000-1;
  const chosen=await call(path+'/meeting-choice','PUT',{candidateId:'b',expectedVersion:state.version},driver);
  assert.equal(chosen.status,200);assert.equal(chosen.value.selection.candidateId,'b');
  at=started+30*60_000;
  const expired=(await call(path,'GET',undefined,driver)).value;
  assert.equal(expired.route.status,'stale');assert.equal(expired.candidates.length,0);assert.equal(expired.selection,null);
});
test('competition route lifetime is capped by the meeting and ordinary example freshness is unchanged',async t=>{
  let at=Date.now();const started=at;
  const call=await setup(t,createCompetitionApp({now:()=>at}));
  const {path,driver}=await readyExample(call);
  at=started+59*60_000;
  const before=(await call(path,'GET',undefined,driver)).value;
  assert.equal((await call(path+'/route-refresh','PUT',{expectedVersion:before.version},driver)).status,202);
  let state;
  for(let n=0;n<20;n++) {
    state=(await call(path,'GET',undefined,driver)).value;
    if(state.route?.status==='ready')break;
    await new Promise(r=>setTimeout(r,10));
  }
  assert.equal(state.route.status,'ready');assert.equal(state.route.validUntil,state.expiresAt);
  at=state.expiresAt;
  assert.equal((await call(path,'GET',undefined,driver)).status,410);
  const ordinary=await setup(t,createApp({store:new SessionStore({now:()=>at})}));
  const normal=await readyExample(ordinary);
  assert.equal(normal.state.route.validUntil,at+30_000);
});
