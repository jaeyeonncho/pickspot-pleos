import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {ShareClient,restoreShare,shareView} from '../public/share-client.mjs';
import {SessionStore} from '../store.mjs';
const flush=()=>new Promise(resolve=>setImmediate(resolve));
function setup(t) {
  let now=1_800_000_000_000;const store=new SessionStore({locationMode:'live',now:()=>now,monotonic:()=>now});t.after(()=>store.dispose());
  const made=store.create(),id=made.session.id,passenger=store.redeem(made.session.inviteCode).passengerToken;
  const credentials={id,token:passenger,expiresAt:made.session.expiresAt};const saved=[],states=[],timers=new Map();let stopped=0;
  const api={read:async()=>store.read(id,passenger),grant:async body=>store.grantLocation(id,passenger,body),
    update:async body=>store.updateLocation(id,passenger,body),withdraw:async body=>store.withdrawLocation(id,passenger,body)};
  const options={api,credentials,now:()=>now,newId:randomUUID,save:value=>saved.push(value),onChange:s=>states.push(s),stopCapture:()=>stopped++,
    setTimeoutImpl:fn=>{const id=Symbol();timers.set(id,fn);return id;},clearTimeoutImpl:id=>timers.delete(id)};
  const client=new ShareClient(options);
  const fix=()=>({point:{latitude:37.4859,longitude:127.0348},observedAt:now,accuracyMeters:12,source:'browser',consent:true,validUntil:now+30000});
  return {store,id,passenger,driver:made.driverToken,api,options,client,states,saved,timers,fix,stopped:()=>stopped,
    advance:ms=>{now+=ms;const pending=[...timers.values()];timers.clear();pending.forEach(fn=>fn());}};
}
test('explicit start and server acknowledgement are required before sharing appears',async t=>{
  const x=setup(t);assert.equal(await x.client.start(),false);assert.equal(x.client.state.status,'idle');
  assert.equal(await x.client.start({consent:true}),true);assert.equal(x.client.state.status,'waiting');
  x.client.push(x.fix());assert.equal(x.client.state.status,'sending');await flush();assert.equal(x.client.state.status,'sharing');
  assert.equal(x.store.read(x.id,x.driver).locationShare.status,'ready');
  assert.ok(!JSON.stringify(x.states).includes('37.4859'));assert.ok(!JSON.stringify(shareView(x.client.state)).includes('127.0348'));
});
test('queue coalesces rapid updates and persists no position or grant',async t=>{
  const x=setup(t);await x.client.start({consent:true});x.client.push(x.fix());await flush();
  x.advance(1);x.client.push(x.fix());x.advance(1);const newest=x.fix();x.client.push(newest);
  assert.equal(x.store.read(x.id,x.passenger).locationShare.sequence,1);
  x.advance(3000);await flush();assert.equal(x.store.read(x.id,x.passenger).locationShare.sequence,2);
  assert.equal(x.store.livePassengerInput(x.id,x.driver).fix.observedAt,newest.observedAt);
  await x.client.stop();assert.equal(x.client.state.status,'stopped');
  for(const value of x.saved)assert.ok(!JSON.stringify(value).match(/point|latitude|longitude|grantId|observedAt/));
});
test('stop clears local state immediately and a late update cannot restore sharing',async t=>{
  const x=setup(t);await x.client.start({consent:true});let release;const update=x.api.update;
  x.api.update=body=>new Promise(resolve=>{release=()=>resolve(update(body));});
  x.client.push(x.fix());const stopping=x.client.stop();assert.equal(x.client.state.status,'stop-pending');assert.ok(x.stopped()>0);
  await stopping;release();await flush();assert.equal(x.client.state.status,'stopped');assert.equal(x.store.livePassengerInput(x.id,x.driver).fix,null);
});
test('grant delayed until after stop acknowledgement cannot reactivate consent',async t=>{
  const x=setup(t);let release;const grant=x.api.grant;x.api.grant=body=>new Promise((resolve,reject)=>{release=()=>grant(body).then(resolve,reject);});
  const starting=x.client.start({consent:true});await flush();await x.client.stop();release();assert.equal(await starting,false);
  assert.equal(x.client.state.status,'stopped');assert.equal(x.store.read(x.id,x.passenger).locationShare.grantId,null);
});
test('connection failure stores stop intent, blocks restart and retries deletion without retrying a fix',async t=>{
  const x=setup(t);await x.client.start({consent:true});let updates=0,withdrawals=0;const withdraw=x.api.withdraw;
  x.api.update=async()=>{updates++;throw new Error('offline');};x.api.withdraw=async()=>{withdrawals++;throw new Error('offline');};
  x.client.push(x.fix());await flush();assert.equal(x.client.state.status,'stop-pending');assert.ok(x.saved.at(-1).stopId);
  assert.equal(await x.client.start({consent:true}),false);
  x.api.withdraw=withdraw;await x.client.check();assert.equal(x.client.state.status,'stopped');assert.equal(updates,1);assert.equal(withdrawals,1);
});
test('reload first revokes any previous consent and never resumes capture',async t=>{
  const x=setup(t);await x.client.start({consent:true});x.client.push(x.fix());await flush();
  const restored=new ShareClient(x.options);await restored.restore();assert.equal(restored.state.status,'stopped');
  assert.equal(x.store.livePassengerInput(x.id,x.driver).fix,null);assert.equal(x.stopped(),1);
});
test('stored pending stop is reused after reload and confirms deletion',async t=>{
  const x=setup(t),stopId=randomUUID();const restored=new ShareClient({...x.options,credentials:{...x.options.credentials,stopId}});
  assert.equal(restored.state.status,'stop-pending');await restored.restore();assert.equal(restored.state.status,'stopped');
  assert.equal(x.saved[0].stopId,stopId);assert.equal(x.saved.at(-1).stopId,null);
});
test('expired or closed sessions clear persisted credentials and stop capture',async t=>{
  const x=setup(t);await x.client.start({consent:true});x.store.end(x.id,x.driver);await x.client.check();
  assert.equal(x.client.state.status,'closed');assert.equal(x.saved.at(-1),null);
  const y=setup(t);y.advance(15*60000);assert.equal(await y.client.start({consent:true}),false);assert.equal(y.client.state.status,'closed');
});
test('invalid or expired acknowledgement cannot display an old position as shared',async t=>{
  const x=setup(t);await x.client.start({consent:true});x.api.update=async()=>({status:'ready',grantId:randomUUID(),sequence:1,validUntil:1});
  x.client.push(x.fix());await flush();assert.equal(x.client.state.status,'stopped');assert.equal(x.store.livePassengerInput(x.id,x.driver).fix,null);
});
test('expired queued fix is discarded and storage failure cannot prevent stop',async t=>{
  const x=setup(t);await x.client.start({consent:true});x.client.push(x.fix());await flush();x.advance(1);x.client.push(x.fix());
  x.advance(30000);await flush();assert.equal(x.client.state.status,'stopped');assert.equal(x.store.livePassengerInput(x.id,x.driver).fix,null);
  const y=setup(t);await y.client.start({consent:true});y.client.save=()=>{throw new Error('storage disabled');};await y.client.stop();assert.equal(y.client.state.status,'stopped');
});
test('restoration accepts only unexpired session metadata and never retains extra fields',()=>{
  const data={id:randomUUID(),token:'a'.repeat(43),expiresAt:Date.now()+60000,stopId:randomUUID(),point:{latitude:37},grantId:'discard'};
  const value=restoreShare(JSON.stringify(data));assert.equal(value.point,undefined);assert.equal(value.grantId,undefined);
  for(const raw of ['{',JSON.stringify({...data,expiresAt:1}),JSON.stringify({...data,stopId:'bad'}),JSON.stringify({...data,token:'bad'})])assert.equal(restoreShare(raw),null);
});

test('recurring uploads keep the acknowledged sharing display and age until the next acknowledgement',async t=>{
  const x=setup(t);await x.client.start({consent:true});x.client.push(x.fix());await flush();
  const first=x.client.state.confirmedAt,until=x.client.state.validUntil;
  const before=shareView(x.client.state,first);assert.equal(before.title,'위치 공유 중');assert.equal(before.freshness,'방금 갱신');
  let release;const update=x.api.update;x.api.update=body=>new Promise(resolve=>{release=()=>resolve(update(body));});
  x.advance(5000);x.client.push(x.fix());
  assert.equal(x.client.state.status,'sending');assert.equal(x.client.state.validUntil,until);assert.equal(x.client.state.confirmedAt,first);
  const sending=shareView(x.client.state,first+5000);
  assert.equal(sending.title,before.title);assert.equal(sending.copy,before.copy);assert.equal(sending.freshness,'5초 전 갱신');assert.equal(sending.activeSharing,true);
  release();await flush();assert.equal(x.client.state.confirmedAt,first+5000);assert.equal(shareView(x.client.state,first+5000).freshness,'방금 갱신');
});

test('expired acknowledgements and clock rollback never appear as current sharing',()=>{
  const state={status:'sending',confirmedAt:10000,validUntil:40000};
  for(const now of [40000,50000,9999]){
    const view=shareView(state,now);assert.equal(view.activeSharing,false);assert.equal(view.freshness,'');assert.notEqual(view.title,'위치 공유 중');
  }
});

test('failed recurring upload removes the success timestamp and a restart waits for a new acknowledgement',async t=>{
  const x=setup(t);await x.client.start({consent:true});x.client.push(x.fix());await flush();
  x.advance(5000);x.api.update=async()=>{throw new Error('offline');};x.client.push(x.fix());await flush();
  assert.equal(x.client.state.status,'stopped');assert.equal(x.client.state.confirmedAt,null);assert.equal(shareView(x.client.state).freshness,'');
  await x.client.start({consent:true});assert.equal(x.client.state.status,'waiting');assert.equal(shareView(x.client.state).activeSharing,false);
});
