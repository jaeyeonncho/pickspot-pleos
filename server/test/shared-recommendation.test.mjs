import test from 'node:test';
import assert from 'node:assert/strict';
import {SessionStore} from '../store.mjs';
import {createLiveApp} from '../live-http.mjs';
import {sharedRecommendationView} from '../public/shared-recommendation.mjs';
const settle=()=>new Promise(resolve=>setImmediate(resolve));
function setup(t) {
  let at=1_800_000_000_000,tick=0,upstreamCalls=0;
  const store=new SessionStore({locationMode:'live',routingMode:'sharing-fixture',now:()=>at,monotonic:()=>tick,
    calculateRoutes:async()=>{upstreamCalls++;throw new Error('Must not call configurable provider');}});
  t.after(()=>store.dispose());
  const created=store.create(),id=created.session.id,driver=created.driverToken;
  const passenger=store.redeem(created.session.inviteCode).passengerToken;
  const grant=()=>store.grantLocation(id,passenger,{consent:true,expectedRevision:store.read(id,passenger).locationShare.revision});
  const update=(grantId,sequence=1)=>store.updateLocation(id,passenger,{grantId,sequence,point:{latitude:37.4859,longitude:127.0348},observedAt:at,accuracyMeters:12});
  return {store,id,driver,passenger,grant,update,read:()=>store.read(id,driver),advance:ms=>{at+=ms;tick+=ms;},now:()=>at,calls:()=>upstreamCalls};
}
test('shared simulation creates three synthetic candidates only after consent and a valid fixed update',async t=>{
  const x=setup(t);assert.equal(x.read().sharedRecommendation,null);
  const g=x.grant();assert.equal(x.read().sharedRecommendation,null);
  x.update(g.grantId);await settle();const session=x.read(),view=sharedRecommendationView(session,x.now());
  assert.equal(view.items.length,3);assert.equal(session.sharedRecommendation.synthetic,true);
  assert.equal(x.calls(),0);assert.equal(session.candidates.length,0);
  assert.ok(!JSON.stringify(session).includes('latitude'));assert.ok(!JSON.stringify(session).includes('longitude'));
  assert.equal(session.sharedRecommendation.validUntil,x.now()+30000);
});
test('withdrawal and immediate cancellation cannot publish a late recommendation',async t=>{
  const x=setup(t),g=x.grant();x.update(g.grantId);
  x.store.withdrawLocation(x.id,x.passenger);await settle();
  assert.equal(x.read().sharedRecommendation,null);assert.equal(sharedRecommendationView(x.read(),x.now()),null);
});
test('freshness expiry clears shared candidates and requires new input',async t=>{
  const x=setup(t),g=x.grant();x.update(g.grantId);await settle();x.advance(30000);
  assert.equal(x.read().locationShare.status,'stale');assert.equal(x.read().sharedRecommendation,null);
  x.update(g.grantId,2);await settle();assert.equal(x.read().sharedRecommendation.status,'ready');
});
test('invalid newer updates discard candidates and another location is refused',async t=>{
  const x=setup(t),g=x.grant();x.update(g.grantId);await settle();x.advance(1);
  assert.throws(()=>x.store.updateLocation(x.id,x.passenger,{grantId:g.grantId,sequence:2,point:{latitude:38,longitude:127},observedAt:x.now(),accuracyMeters:12}));
  assert.equal(x.read().sharedRecommendation,null);
});
test('a delayed invalid update from an old grant cannot revoke a new sharing grant',async t=>{
  const x=setup(t),old=x.grant();x.update(old.grantId);await settle();
  x.store.withdrawLocation(x.id,x.passenger);const current=x.grant();x.advance(1);x.update(current.grantId);await settle();
  assert.throws(()=>x.store.updateLocation(x.id,x.passenger,{grantId:old.grantId,sequence:2,point:{latitude:38,longitude:127},observedAt:x.now(),accuracyMeters:12}),e=>e.code==='LOCATION_GRANT_CHANGED');
  assert.equal(x.read().sharedRecommendation.status,'ready');
});
test('end cancels pending simulation and closes both roles',async t=>{
  const x=setup(t),g=x.grant();x.update(g.grantId);x.store.end(x.id,x.driver);await settle();
  assert.throws(()=>x.read(),e=>e.status===410);assert.equal(x.store.sessions.get(x.id).sharedRecommendation,null);
});
test('simulation routing cannot be started in a real HTTPS server or mismatched store',()=>{
  assert.throws(()=>createLiveApp({sharedRecommendations:true}),e=>e.code==='SIMULATION_ROUTES_ONLY');
  const store=new SessionStore({locationMode:'live',routingMode:'sharing-fixture'});
  assert.throws(()=>createLiveApp({simulation:true,store}),e=>e.code==='ROUTING_MODE_MISMATCH');store.dispose();
});
test('display contract hides revoked, expired, non-synthetic and malformed reports',async t=>{
  const x=setup(t),g=x.grant();x.update(g.grantId);await settle();const original=x.read();
  for(const mutate of [s=>s.locationShare.status='withdrawn',s=>s.locationShare.validUntil=x.now(),
    s=>s.sharedRecommendation.validUntil=x.now(),s=>s.sharedRecommendation.synthetic=false,
    s=>s.sharedRecommendation.source='tmap',s=>s.sharedRecommendation.candidates[0].walkMeters=-1,
    s=>s.sharedRecommendation.candidates[1].id='a',s=>s.sharedRecommendation.candidates[0].curbStatus='designated']) {
    const s=structuredClone(original);mutate(s);assert.equal(sharedRecommendationView(s,x.now()),null);
  }
});
test('HTTP simulation exposes aggregates to both roles and withdrawal removes them',async t=>{
  const server=createLiveApp({simulation:true,sharedRecommendations:true});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}));
  const origin=`http://127.0.0.1:${server.address().port}`;
  const call=async(path,method='GET',body,token)=>{
    const response=await fetch(origin+path,{method,headers:{Origin:origin,...(body?{'Content-Type':'application/json'}:{}),...(token?{Authorization:`Bearer ${token}`}:{})},...(body?{body:JSON.stringify(body)}:{})});
    assert.ok(response.ok);return response.json();
  };
  assert.equal((await call('/health')).sharedRecommendations,true);
  const created=await call('/v1/sessions','POST',{}),base=`/v1/sessions/${created.session.id}`;
  const passenger=(await call('/v1/invitations/redeem','POST',{code:created.session.inviteCode})).passengerToken;
  const grant=await call(base+'/location-consent','POST',{consent:true,expectedRevision:0},passenger);
  await call(base+'/passenger-location','PUT',{grantId:grant.grantId,sequence:1,point:{latitude:37.4859,longitude:127.0348},accuracyMeters:12,observedAt:Date.now()},passenger);
  for(const token of [created.driverToken,passenger])assert.equal((await call(base,'GET',null,token)).sharedRecommendation.candidates.length,3);
  const invalid=await fetch(origin+base+'/passenger-location',{method:'PUT',headers:{Origin:origin,'Content-Type':'application/json',Authorization:`Bearer ${passenger}`},body:JSON.stringify({grantId:grant.grantId,sequence:2,point:{latitude:38,longitude:127},accuracyMeters:12,observedAt:Date.now()})});
  assert.equal(invalid.status,400);assert.equal((await invalid.json()).error,'SIMULATION_POINT_ONLY');
  assert.equal((await call(base,'GET',null,created.driverToken)).sharedRecommendation,null);
  await call(base+'/location-consent','DELETE',{operationId:crypto.randomUUID()},passenger);
  assert.equal((await call(base,'GET',null,created.driverToken)).sharedRecommendation,null);
});
