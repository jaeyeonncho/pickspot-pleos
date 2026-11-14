import test from 'node:test';
import assert from 'node:assert/strict';
import {SessionStore,ApiError} from '../store.mjs';
import {createApp} from '../server.mjs';

const epoch=1_800_000_000_000;
const code=expected=>error=>error instanceof ApiError&&error.code===expected;
function fixture(t,options={}) {
  let now=epoch,tick=0;
  const store=new SessionStore({locationMode:'live',now:()=>now,monotonic:()=>tick,...options});
  t.after(()=>store.dispose());
  const made=store.create(),id=made.session.id,driver=made.driverToken;
  const passenger=store.redeem(made.session.inviteCode).passengerToken;
  const read=()=>store.read(id,passenger);
  const grant=()=>store.grantLocation(id,passenger,{consent:true,expectedRevision:read().locationShare.revision});
  const payload=(grantId,sequence=1,overrides={})=>({grantId,sequence,point:{latitude:37.4859,longitude:127.0348},
    observedAt:now,accuracyMeters:12,...overrides});
  const update=(grantId,sequence=1,overrides={})=>store.updateLocation(id,passenger,payload(grantId,sequence,overrides));
  return {store,id,driver,passenger,read,grant,payload,update,input:()=>store.livePassengerInput(id,driver),
    advance:ms=>{now+=ms;tick+=ms;},wall:ms=>{now+=ms;},tick:ms=>{tick+=ms;}};
}

test('live sessions start without coordinates, example destination, candidates or active consent',t=>{
  const x=fixture(t),session=x.read();
  assert.equal(session.isDemo,false);assert.equal(session.destination,null);assert.deepEqual(session.destinationOptions,[]);
  assert.equal(session.passenger,null);assert.equal(session.route,null);assert.deepEqual(session.candidates,[]);
  assert.deepEqual(session.locationShare,{status:'not-sharing',revision:0,sequence:0,validUntil:null,grantId:null});
  assert.equal(x.input().fix,null);
});

test('driver cannot grant/update/withdraw and passenger cannot obtain calculation inputs',t=>{
  const x=fixture(t),grant=x.grant();
  for(const action of [()=>x.store.grantLocation(x.id,x.driver,{consent:true,expectedRevision:grant.revision}),
    ()=>x.store.updateLocation(x.id,x.driver,x.payload(grant.grantId)),()=>x.store.withdrawLocation(x.id,x.driver)]) {
    assert.throws(action,code('PASSENGER_ONLY'));
  }
  assert.throws(()=>x.store.livePassengerInput(x.id,x.passenger),code('DRIVER_ONLY'));
  assert.throws(()=>x.store.updateLocation(x.id,'unknown',x.payload(grant.grantId)),code('ACCESS_DENIED'));
  assert.equal(x.read().locationShare.revision,grant.revision);
});

test('invitation grants only its session; cross-session tokens and grant IDs are refused',t=>{
  const x=fixture(t),grant=x.grant(),other=x.store.create();
  const otherPassenger=x.store.redeem(other.session.inviteCode).passengerToken;
  assert.throws(()=>x.store.redeem(other.session.inviteCode),code('INVALID_INVITATION'));
  assert.throws(()=>x.store.updateLocation(x.id,otherPassenger,x.payload(grant.grantId)),code('ACCESS_DENIED'));
  const otherGrant=x.store.grantLocation(other.session.id,otherPassenger,{consent:true,expectedRevision:0});
  assert.notEqual(otherGrant.grantId,grant.grantId);
  assert.throws(()=>x.store.updateLocation(other.session.id,otherPassenger,x.payload(grant.grantId)),code('LOCATION_GRANT_CHANGED'));
});

test('explicit consent and current revision are required before positions can be accepted',t=>{
  const x=fixture(t);
  assert.throws(()=>x.update('unissued'),code('LOCATION_GRANT_CHANGED'));
  for(const input of [null,{},[],{consent:false,expectedRevision:0},{consent:true,expectedRevision:0,source:'browser'}]) {
    assert.throws(()=>x.store.grantLocation(x.id,x.passenger,input),code('LOCATION_CONSENT_REQUIRED'));
  }
  assert.throws(()=>x.store.grantLocation(x.id,x.passenger,{consent:true,expectedRevision:1}),code('LOCATION_REVISION_CONFLICT'));
  x.grant();assert.throws(()=>x.store.grantLocation(x.id,x.passenger,{consent:true,expectedRevision:0}),code('LOCATION_REVISION_CONFLICT'));
});

test('accepted input is copied and provenance assigned by the server; normal views omit coordinates',t=>{
  const x=fixture(t),grant=x.grant(),body=x.payload(grant.grantId);
  const accepted=x.store.updateLocation(x.id,x.passenger,body);body.point.latitude=0;
  assert.equal(accepted.status,'ready');const input=x.input();assert.equal(input.fix.point.latitude,37.4859);
  assert.equal(input.fix.source,'browser');assert.equal(input.fix.consent,true);
  input.fix.point.longitude=0;assert.equal(x.input().fix.point.longitude,127.0348);
  for(const view of [accepted,x.read(),x.store.read(x.id,x.driver)]) {
    assert.ok(!JSON.stringify(view).includes('37.4859'));assert.ok(!JSON.stringify(view).includes('127.0348'));
  }
  assert.equal(x.store.read(x.id,x.driver).locationShare.grantId,undefined);
});

test('replayed and reordered sequence numbers cannot replace or freshen a current fix',t=>{
  const x=fixture(t),grant=x.grant();x.update(grant.grantId,2);const original=x.input();x.advance(1000);
  for(const sequence of [1,2])assert.throws(()=>x.update(grant.grantId,sequence),code('LOCATION_UPDATE_REPLAYED'));
  assert.deepEqual(x.input(),original);
  for(const sequence of [0,-1,NaN,1.1,'3',Number.MAX_SAFE_INTEGER+1])assert.throws(()=>x.update(grant.grantId,sequence),code('INVALID_LOCATION_SEQUENCE'));
  assert.deepEqual(x.input(),original);
  x.update(grant.grantId,3);assert.equal(x.input().fix.observedAt,epoch+1000);
});

test('newer invalid fix invalidates old data and consumes its sequence so it cannot be replayed',t=>{
  const x=fixture(t),grant=x.grant();x.update(grant.grantId);x.advance(1);
  assert.throws(()=>x.update(grant.grantId,2,{accuracyMeters:101}),code('LOCATION_ACCURACY_REQUIRED'));
  assert.equal(x.input().fix,null);assert.equal(x.read().locationShare.status,'invalid');
  assert.throws(()=>x.update(grant.grantId,2),code('LOCATION_UPDATE_REPLAYED'));
  x.update(grant.grantId,3);assert.equal(x.input().fix.accuracyMeters,12);
});

test('untrusted fields, malformed points, stale time and unknown accuracy never enter calculation input',t=>{
  const x=fixture(t),grant=x.grant();let sequence=0;
  const invalid=[{source:'vehicle'},{consent:true},{validUntil:epoch+999999},{mode:'live'},
    {point:null},{point:{latitude:37,longitude:127,altitude:1}},{point:{latitude:91,longitude:127}},
    {point:{latitude:37,longitude:Infinity}},{point:{latitude:'37',longitude:127}},
    {observedAt:0},{observedAt:epoch+5001},{observedAt:epoch-30000},
    ...[null,0,-1,NaN,101,'12'].map(accuracyMeters=>({accuracyMeters}))];
  for(const overrides of invalid) {
    assert.throws(()=>x.update(grant.grantId,++sequence,overrides),ApiError);
    assert.equal(x.input().fix,null);
  }
  x.update(grant.grantId,++sequence,{accuracyMeters:100,observedAt:epoch+5000});
  assert.equal(x.input().fix.validUntil,epoch+30000);
});

test('new sequence with duplicate or backward measurement time cannot prolong the previous fix',t=>{
  const x=fixture(t),grant=x.grant();x.update(grant.grantId);x.advance(1000);
  assert.throws(()=>x.update(grant.grantId,2,{observedAt:epoch}),code('LOCATION_TIME_REPLAYED'));
  assert.equal(x.input().fix,null);
  assert.throws(()=>x.update(grant.grantId,3,{observedAt:epoch-1}),code('LOCATION_TIME_REPLAYED'));
  x.update(grant.grantId,4);assert.equal(x.input().fix.observedAt,epoch+1000);
});

test('withdrawal invalidates grant, clears work and refuses delayed location and consent messages',t=>{
  const x=fixture(t),grant=x.grant();x.update(grant.grantId);
  const oldRevision=x.read().locationShare.revision;
  const controller=new AbortController();x.store.routeJobs.set(x.id,controller);
  const session=x.store.sessions.get(x.id);session.candidates=[{id:'private'}];session.selection={id:'private'};session.route={status:'calculating'};
  const ended=x.store.withdrawLocation(x.id,x.passenger);
  assert.equal(ended.status,'withdrawn');assert.equal(ended.grantId,null);assert.equal(x.input().fix,null);
  assert.equal(controller.signal.aborted,true);assert.deepEqual(session.candidates,[]);assert.equal(session.selection,null);assert.equal(session.route,null);
  assert.throws(()=>x.update(grant.grantId,2),code('LOCATION_GRANT_CHANGED'));
  assert.throws(()=>x.store.grantLocation(x.id,x.passenger,{consent:true,expectedRevision:oldRevision}),code('LOCATION_REVISION_CONFLICT'));
  assert.deepEqual(x.store.withdrawLocation(x.id,x.passenger),ended);
});

test('renewed consent has a new grant and never accepts an old in-flight update',t=>{
  const x=fixture(t),one=x.grant();x.update(one.grantId);x.store.withdrawLocation(x.id,x.passenger);
  const two=x.grant();assert.notEqual(two.grantId,one.grantId);x.advance(1);
  assert.throws(()=>x.update(one.grantId,100),code('LOCATION_GRANT_CHANGED'));
  assert.equal(x.input().fix,null);x.update(two.grantId);assert.equal(x.input().fix.observedAt,epoch+1);
});

test('a fresh fix invalidates existing work and expiry removes it without another network request',t=>{
  const x=fixture(t),grant=x.grant();const controller=new AbortController();x.store.routeJobs.set(x.id,controller);
  x.update(grant.grantId);assert.equal(controller.signal.aborted,true);
  const next=new AbortController();x.store.routeJobs.set(x.id,next);
  x.advance(30000);x.store.sweep();assert.equal(next.signal.aborted,true);
  assert.equal(x.read().locationShare.status,'stale');assert.equal(x.input().fix,null);
  x.update(grant.grantId,2);assert.equal(x.read().locationShare.status,'ready');
});

test('wall-clock rollback revokes sharing and monotonic age prevents reuse with a frozen wall clock',t=>{
  const x=fixture(t),grant=x.grant();x.update(grant.grantId);x.wall(-1);
  assert.equal(x.read().locationShare.status,'clock-invalid');assert.equal(x.read().locationShare.grantId,null);
  assert.throws(x.input,code('LOCATION_CLOCK_INVALID'));assert.throws(x.grant,code('LOCATION_CLOCK_INVALID'));
  const y=fixture(t),second=y.grant();y.update(second.grantId);y.tick(30000);
  assert.equal(y.input().fix,null);assert.equal(y.read().locationShare.status,'stale');
});

test('session expiry from either clock closes access and removes live locations',t=>{
  for(const monotonicOnly of [false,true]) {
    const x=fixture(t,{ttlMs:10000}),grant=x.grant();x.update(grant.grantId);
    assert.equal(x.input().fix.validUntil,epoch+10000);
    monotonicOnly?x.tick(10000):x.advance(10000);
    assert.throws(x.read,code('SESSION_EXPIRED'));assert.throws(()=>x.update(grant.grantId,2),code('SESSION_EXPIRED'));
    assert.equal(x.store.liveLocations.size,0);assert.equal(x.store.sessions.get(x.id).passenger,null);
  }
});

test('either participant ending the session destroys live state and blocks delayed updates',t=>{
  for(const role of ['driver','passenger']) {
    const x=fixture(t),grant=x.grant();x.update(grant.grantId);const retained=x.store.liveLocations.get(x.id);
    x.store.end(x.id,x[role]);assert.equal(x.store.liveLocations.size,0);
    assert.equal(retained.snapshot().status,'closed');assert.throws(()=>retained.input(),code('LOCATION_SESSION_CLOSED'));
    assert.throws(()=>x.update(grant.grantId,2),code('SESSION_ENDED'));
  }
});

test('dispose clears session maps, closes retained inputs and cancels pending work',t=>{
  const x=fixture(t),grant=x.grant();x.update(grant.grantId);const retained=x.store.liveLocations.get(x.id);
  const controller=new AbortController();x.store.routeJobs.set(x.id,controller);x.store.dispose();
  assert.equal(controller.signal.aborted,true);assert.equal(x.store.sessions.size,0);assert.equal(x.store.liveLocations.size,0);
  assert.equal(retained.snapshot().status,'closed');assert.throws(()=>retained.input(),code('LOCATION_SESSION_CLOSED'));
});

test('example and live sessions cannot be mixed, and current HTTP app rejects live stores',t=>{
  const x=fixture(t),grant=x.grant();
  for(const action of [()=>x.store.shareExample(x.id,x.passenger,{mode:'example',consent:true}),
    ()=>x.store.refreshRoutes(x.id,x.driver,{}),()=>x.store.changeDestination(x.id,x.driver,{}),
    ()=>x.store.select(x.id,x.driver,{}),()=>x.store.report(x.id,x.driver,{}),()=>x.store.beginRoutes(x.store.sessions.get(x.id))]) {
    assert.throws(action,code('EXAMPLE_SESSION_REQUIRED'));
  }
  assert.throws(()=>createApp({store:x.store}),code('LIVE_HTTP_NOT_ENABLED'));
  assert.throws(()=>{x.store.locationMode='example';},TypeError);
  const demo=fixture(t,{locationMode:'example'});
  assert.throws(()=>demo.store.grantLocation(demo.id,demo.passenger,{consent:true,expectedRevision:0}),code('LIVE_LOCATION_SESSION_REQUIRED'));
  assert.throws(()=>demo.store.updateLocation(demo.id,demo.passenger,x.payload(grant.grantId)),code('LIVE_LOCATION_SESSION_REQUIRED'));
  assert.equal(demo.read().isDemo,true);
});

test('provider routing consent belongs to one grant and is cleared by withdrawal or sharing-only renewal',t=>{
  const x=fixture(t);x.grant();assert.equal(x.input().routingProvider,null);
  assert.throws(()=>x.store.grantLocation(x.id,x.passenger,{consent:true,expectedRevision:x.read().locationShare.revision,routingProvider:'unknown'}),code('INVALID_ROUTING_CONSENT'));
  const consent=()=>x.store.grantLocation(x.id,x.passenger,{consent:true,expectedRevision:x.read().locationShare.revision,routingProvider:'tmap'});
  const grant=consent();x.update(grant.grantId);assert.equal(x.input().routingProvider,'tmap');
  x.store.withdrawLocation(x.id,x.passenger);assert.equal(x.input().routingProvider,null);
  consent();x.grant();assert.equal(x.input().routingProvider,null);
});
