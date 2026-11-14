import test from 'node:test';
import assert from 'node:assert/strict';
import {createApp} from '../server.mjs';
import {SessionStore} from '../store.mjs';

async function setup(t, options={}) {
  let now=1_800_000_000_000;
  const store=new SessionStore({now:()=>now,ttlMs:60_000});
  const server=createApp({store,...options});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}));
  const base=`http://127.0.0.1:${server.address().port}`;
  const call=async(path,method='GET',body,token,headers={})=>{
    const result=await fetch(base+path,{method,headers:{...(body?{'Content-Type':'application/json'}:{}),...(token?{Authorization:`Bearer ${token}`}:{ }),...headers},...(body?{body:JSON.stringify(body)}:{})});
    return {status:result.status,data:await result.json()};
  };
  const created=(await call('/v1/sessions','POST',{})).data;
  const id=created.session.id, driver=created.driverToken, code=created.session.inviteCode;
  const join=async()=> (await call('/v1/invitations/redeem','POST',{code})).data.passengerToken;
  const share=async passenger=>{
    const result=await call(`/v1/sessions/${id}/passenger-location`,'PUT',{consent:true,mode:'example'},passenger);
    if(result.status !== 200)return result;
    for(let i=0;i<20;i++) {
      const ready=await call(`/v1/sessions/${id}`,'GET',null,passenger);
      if(ready.data.route?.status !== 'calculating')return ready;
    }
    throw new Error('Calculation did not complete');
  };
  return {call,id,driver,code,join,share,store,base,advance:ms=>{now+=ms;}};
}
test('create is waiting with no invented passenger position',async t=>{
  const x=await setup(t);const r=await x.call(`/v1/sessions/${x.id}`,'GET',null,x.driver);
  assert.equal(r.status,200);assert.equal(r.data.status,'waiting');assert.equal(r.data.passenger,null);assert.deepEqual(r.data.candidates,[]);
  assert.equal(r.data.driverHash,undefined);assert.equal(r.data.driverToken,undefined);
});
test('invitation is single use and passenger never receives driver credentials',async t=>{
  const x=await setup(t);const passenger=await x.join();assert.ok(passenger);
  const again=await x.call('/v1/invitations/redeem','POST',{code:x.code});assert.equal(again.status,404);
  const read=await x.call(`/v1/sessions/${x.id}`,'GET',null,passenger);assert.equal(read.data.inviteCode,undefined);
});
test('example sharing requires consent and refuses arbitrary coordinates',async t=>{
  const x=await setup(t);const passenger=await x.join();
  assert.equal((await x.call(`/v1/sessions/${x.id}/passenger-location`,'PUT',{mode:'example',consent:false},passenger)).status,400);
  assert.equal((await x.call(`/v1/sessions/${x.id}/passenger-location`,'PUT',{mode:'example',consent:true,latitude:37},passenger)).status,400);
  assert.equal((await x.call(`/v1/sessions/${x.id}/passenger-location`,'PUT',{mode:'live',consent:true,point:{latitude:37,longitude:127}},passenger)).status,400);
  assert.equal((await x.call(`/v1/sessions/${x.id}`,'GET',null,x.driver)).data.status,'waiting');
});

test('location checker is separately served with outbound connections blocked and demo geolocation disabled',async t=>{
  const x=await setup(t);
  const page=await fetch(x.base+'/location-check');assert.equal(page.status,200);
  assert.equal(page.headers.get('permissions-policy'),'geolocation=(self)');
  assert.ok(page.headers.get('content-security-policy').includes("connect-src 'none'"));
  const html=await page.text();assert.ok(html.includes('location-start'));assert.ok(html.includes('차량이나 서버에는 위치를 보내지 않아요'));
  const home=await fetch(x.base+'/');assert.equal(home.headers.get('permissions-policy'),'geolocation=()');
  for(const path of ['/location-check.mjs','/browser-location.mjs','/shared/location-policy.mjs']) {
    const asset=await fetch(x.base+path);assert.equal(asset.status,200);assert.ok(asset.headers.get('content-type').includes('javascript'));
  }
});
test('passenger share appears in vehicle session, selection and navigation are separate',async t=>{
  const x=await setup(t), passenger=await x.join();await x.share(passenger);
  const current=(await x.call(`/v1/sessions/${x.id}`,'GET',null,x.driver)).data;
  assert.equal(current.status,'active');assert.equal(current.passenger.location.isExample,true);
  const selected=await x.call(`/v1/sessions/${x.id}/selection`,'PUT',{candidateId:'b',expectedVersion:current.version},x.driver);
  assert.equal(selected.status,200);assert.equal(selected.data.selection.navigationStatus,'pending');
  await x.call(`/v1/sessions/${x.id}/navigation`,'PUT',{selectionId:selected.data.selection.id,status:'confirmed'},x.driver);
  const seen=(await x.call(`/v1/sessions/${x.id}`,'GET',null,passenger)).data;
  assert.equal(seen.selection.candidateId,'b');assert.equal(seen.selection.navigationStatus,'confirmed');
});
test('passenger cannot select or claim navigation success; driver cannot share location',async t=>{
  const x=await setup(t), passenger=await x.join();await x.share(passenger);
  assert.equal((await x.call(`/v1/sessions/${x.id}/selection`,'PUT',{candidateId:'a',expectedVersion:3},passenger)).status,403);
  assert.equal((await x.call(`/v1/sessions/${x.id}/navigation`,'PUT',{selectionId:'fake',status:'confirmed'},passenger)).status,403);
  assert.equal((await x.share(x.driver)).status,403);
});
test('expired session denies reads and wipes positions and candidates',async t=>{
  const x=await setup(t), passenger=await x.join();await x.share(passenger);x.advance(60_000);
  assert.equal((await x.call(`/v1/sessions/${x.id}`,'GET',null,x.driver)).status,410);
  const tomb=x.store.sessions.get(x.id);assert.equal(tomb.passenger,null);assert.deepEqual(tomb.candidates,[]);assert.equal(tomb.selection,null);
  assert.equal((await x.share(passenger)).status,410);
});
test('passenger withdrawal stops both roles immediately and prevents reuse',async t=>{
  const x=await setup(t), passenger=await x.join();await x.share(passenger);
  assert.equal((await x.call(`/v1/sessions/${x.id}`,'DELETE',null,passenger)).status,200);
  for(const token of [x.driver,passenger])assert.equal((await x.call(`/v1/sessions/${x.id}`,'GET',null,token)).status,410);
  assert.equal(x.store.sessions.get(x.id).passenger,null);
});
test('stale selection version rejected and restricted candidate rejected',async t=>{
  const x=await setup(t), passenger=await x.join();const active=(await x.share(passenger)).data;
  assert.equal((await x.call(`/v1/sessions/${x.id}/selection`,'PUT',{candidateId:'a',expectedVersion:1},x.driver)).status,409);
  assert.equal((await x.call(`/v1/sessions/${x.id}/selection`,'PUT',{candidateId:'e',expectedVersion:active.version},x.driver)).status,400);
});
test('old navigation callback cannot overwrite a newer selection',async t=>{
  const x=await setup(t), passenger=await x.join();const active=(await x.share(passenger)).data;
  const one=(await x.call(`/v1/sessions/${x.id}/selection`,'PUT',{candidateId:'a',expectedVersion:active.version},x.driver)).data;
  const two=(await x.call(`/v1/sessions/${x.id}/selection`,'PUT',{candidateId:'b',expectedVersion:one.version},x.driver)).data;
  assert.equal((await x.call(`/v1/sessions/${x.id}/navigation`,'PUT',{selectionId:one.selection.id,status:'confirmed'},x.driver)).status,409);
  assert.equal((await x.call(`/v1/sessions/${x.id}/navigation`,'PUT',{selectionId:two.selection.id,status:'failed'},x.driver)).data.selection.navigationStatus,'failed');
});
test('unknown token and another session token cannot read positions',async t=>{
  const x=await setup(t);const other=(await x.call('/v1/sessions','POST',{})).data;
  assert.equal((await x.call(`/v1/sessions/${x.id}`)).status,401);
  assert.equal((await x.call(`/v1/sessions/${x.id}`,'GET',null,other.driverToken)).status,403);
});
test('cross origin and malformed JSON are rejected',async t=>{
  const x=await setup(t);
  assert.equal((await x.call('/v1/sessions','POST',{},null,{Origin:'https://unrelated.example'})).status,403);
  assert.equal((await fetch(x.base+'/v1/sessions',{method:'POST',headers:{'Content-Type':'application/json'},body:'{'})).status,400);
  assert.equal((await fetch(x.base+'/v1/sessions',{method:'POST',body:'{}'})).status,415);
});
test('invitation attempts are limited',async t=>{
  const x=await setup(t,{rateLimit:2});await x.call('/v1/invitations/redeem','POST',{code:'000000000000'});
  assert.equal((await x.call('/v1/invitations/redeem','POST',{code:'000000000000'})).status,429);
});
test('route refresh HTTP endpoint enforces driver access, cooldown and version',async t=>{
  const x=await setup(t),passenger=await x.join();
  const active=(await x.share(passenger)).data;
  const path=`/v1/sessions/${x.id}/route-refresh`;
  assert.equal((await x.call(path,'PUT',{expectedVersion:active.version},passenger)).status,403);
  assert.equal((await x.call(path,'PUT',{expectedVersion:active.version},x.driver)).status,429);
  x.advance(10_000);
  assert.equal((await x.call(path,'PUT',{expectedVersion:active.version-1},x.driver)).status,409);
  const refreshed=await x.call(path,'PUT',{expectedVersion:active.version},x.driver);
  assert.equal(refreshed.status,202);
  assert.equal(refreshed.data.route.status,'calculating');
  assert.deepEqual(refreshed.data.candidates,[]);
  assert.equal(refreshed.data.route.attemptsRemaining,3);
});
test('driver can set an example destination before sharing and change it with version and cooldown guards',async t=>{
 const x=await setup(t),passenger=await x.join();let s=(await x.call(`/v1/sessions/${x.id}`,'GET',null,x.driver)).data;
 const path=`/v1/sessions/${x.id}/destination`;
 const body=()=>({expectedVersion:s.version,destinationId:'yangjae'});
 assert.equal((await x.call(path,'PUT',body(),passenger)).status,403);
 assert.equal((await x.call(path,'PUT',{...body(),latitude:37},x.driver)).status,400);
 let changed=await x.call(path,'PUT',body(),x.driver);assert.equal(changed.status,202);assert.equal(changed.data.destination.id,'yangjae');
 s=(await x.share(passenger)).data;assert.equal(s.route.destinationName,'예제 목적지 · 양재역 주변');
 assert.deepEqual(s.candidates.map(c=>c.detourSeconds),[270,45,120]);
 assert.equal((await x.call(path,'PUT',{expectedVersion:s.version,destinationId:'maebong'},x.driver)).status,429);
 x.advance(10_000);
 assert.equal((await x.call(path,'PUT',{expectedVersion:s.version-1,destinationId:'maebong'},x.driver)).status,409);
 changed=await x.call(path,'PUT',{expectedVersion:s.version,destinationId:'maebong'},x.driver);
 assert.equal(changed.status,202);assert.deepEqual(changed.data.candidates,[]);assert.equal(changed.data.selection,null);
 assert.equal(changed.data.route.status,'calculating');assert.equal(changed.data.destination.id,'maebong');
});
test('validated example location lifetime limits result freshness to thirty seconds',async t=>{
 const x=await setup(t),passenger=await x.join();const ready=(await x.share(passenger)).data;
 assert.equal(ready.route.validUntil-ready.route.requestedAt,30_000);
 x.advance(30_000);const stale=(await x.call(`/v1/sessions/${x.id}`,'GET',null,x.driver)).data;
 assert.equal(stale.route.status,'stale');assert.deepEqual(stale.candidates,[]);
});
