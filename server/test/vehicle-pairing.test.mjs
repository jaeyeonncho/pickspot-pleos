import test from 'node:test';
import assert from 'node:assert/strict';
import {SessionStore} from '../store.mjs';
import {VehiclePairings} from '../vehicle-pairing.mjs';
function setup(t,maximum=100){
  let at=1800000000000,tick=100000;
  const store=new SessionStore({locationMode:'live',now:()=>at,monotonic:()=>tick});
  const pairings=new VehiclePairings({store,now:()=>at,monotonic:()=>tick,maximum});
  t.after(()=>{pairings.dispose();store.dispose();});
  const made=store.create(),id=made.session.id,owner=made.driverToken,passenger=store.redeem(made.session.inviteCode).passengerToken;
  const create=()=>pairings.create();
  const approve=challenge=>pairings.approve(id,owner,challenge.code);
  const claim=challenge=>pairings.claim(challenge.id,challenge.deviceToken,()=>({origin:'https://example.test',processingRegion:'검사',candidateIds:['a']}));
  return {store,pairings,id,owner,passenger,create,approve,claim,advance:ms=>{at+=ms;tick+=ms;},wall:ms=>{at+=ms;},tick:ms=>{tick+=ms;}};
}
test('pending pairing holds only hashed device credentials and has a two minute lifetime',t=>{
  const x=setup(t),challenge=x.create();assert.match(challenge.code,/^[A-F0-9]{12}$/);assert.match(challenge.deviceToken,/^[A-Za-z0-9_-]{43}$/);
  assert.equal(challenge.expiresAt,1800000120000);assert.equal(x.claim(challenge).status,'pending');
  assert.ok(!JSON.stringify([...x.pairings.tickets.values()]).includes(challenge.deviceToken));
  assert.equal(x.store.read(x.id,x.owner).vehicleConnected,false);
});
test('only meeting owner can approve and knowing the short code cannot claim credentials',t=>{
  const x=setup(t),challenge=x.create();
  assert.throws(()=>x.pairings.approve(x.id,x.passenger,challenge.code),e=>e.code==='OWNER_ONLY');
  assert.throws(()=>x.pairings.claim(challenge.id,challenge.code,()=>({})),e=>e.code==='PAIRING_ACCESS_DENIED');
  assert.throws(()=>x.pairings.claim(challenge.id,'b'.repeat(43),()=>({})),e=>e.code==='PAIRING_ACCESS_DENIED');
  x.approve(challenge);const grant=x.claim(challenge);assert.equal(grant.status,'connected');assert.equal(grant.session.inviteCode,undefined);
  assert.equal(x.store.authenticate(x.id,grant.vehicleToken).role,'vehicle');
  assert.deepEqual(grant.capabilities,['read-session','compare-routes']);
  assert.equal(x.store.read(x.id,x.owner).vehicleConnected,true);
  assert.ok(!JSON.stringify([...x.pairings.tickets.values()]).includes(grant.vehicleToken));
});
test('claim is one shot and a spent approval code cannot authorize another vehicle',t=>{
  const x=setup(t),challenge=x.create();x.approve(challenge);x.claim(challenge);
  assert.throws(()=>x.claim(challenge),e=>e.code==='PAIRING_ALREADY_CLAIMED');
  assert.throws(()=>x.approve(challenge),e=>e.code==='INVALID_PAIRING_CODE');
  assert.throws(()=>x.pairings.cancel(challenge.id,challenge.deviceToken),e=>e.code==='PAIRING_ALREADY_CLAIMED');
});
test('vehicle credential cannot manage pairing, end meeting, or alter passenger consent',t=>{
  const x=setup(t),c=x.create();x.approve(c);const {vehicleToken}=x.claim(c);
  assert.throws(()=>x.store.livePassengerInput(x.id,vehicleToken),e=>e.code==='DRIVER_ONLY');
  assert.throws(()=>x.store.end(x.id,vehicleToken),e=>e.code==='OWNER_OR_PASSENGER_REQUIRED');
  assert.throws(()=>x.store.approveVehicle(x.id,vehicleToken),e=>e.code==='OWNER_ONLY');
  assert.throws(()=>x.store.revokeVehicle(x.id,vehicleToken),e=>e.code==='OWNER_ONLY');
  assert.throws(()=>x.store.grantLocation(x.id,vehicleToken,{consent:true,expectedRevision:0}),e=>e.code==='PASSENGER_ONLY');
  assert.throws(()=>x.store.withdrawLocation(x.id,vehicleToken),e=>e.code==='PASSENGER_ONLY');
});
test('replacement approval revokes earlier vehicle access and supersedes old pending approvals',t=>{
  const x=setup(t),first=x.create();x.approve(first);const old=x.claim(first).vehicleToken;
  const second=x.create();x.approve(second);assert.throws(()=>x.store.read(x.id,old),e=>e.code==='ACCESS_DENIED');
  const third=x.create();x.approve(third);
  assert.throws(()=>x.claim(second),e=>e.code==='VEHICLE_APPROVAL_CHANGED');
  assert.equal(x.claim(third).status,'connected');
});
test('owner revocation invalidates both pending approvals and issued access without ending meeting',t=>{
  const x=setup(t),pending=x.create();x.approve(pending);x.store.revokeVehicle(x.id,x.owner);
  assert.throws(()=>x.claim(pending),e=>e.code==='VEHICLE_APPROVAL_CHANGED');
  const next=x.create();x.approve(next);const token=x.claim(next).vehicleToken;x.store.revokeVehicle(x.id,x.owner);
  assert.throws(()=>x.store.read(x.id,token),e=>e.code==='ACCESS_DENIED');
  assert.ok(x.store.read(x.id,x.owner));assert.ok(x.store.read(x.id,x.passenger));
});
test('cancel and expiry clear pending authorization without minting a credential',t=>{
  for(const mode of ['cancel','expire','frozen-wall','rollback']){
    const x=setup(t),c=x.create();x.approve(c);
    if(mode==='cancel')x.pairings.cancel(c.id,c.deviceToken);
    if(mode==='expire')x.advance(120000);
    if(mode==='frozen-wall')x.tick(120000);
    if(mode==='rollback')x.wall(-1);
    assert.throws(()=>x.claim(c),e=>['PAIRING_CLOSED','PAIRING_EXPIRED'].includes(e.code));
    assert.equal(x.store.sessions.get(x.id).vehicleHash,null);assert.equal(x.store.sessions.get(x.id).vehicleLinkPending,false);
  }
});
test('spent ticket expiry does not revoke an already connected vehicle',t=>{
  const x=setup(t),c=x.create();x.approve(c);const token=x.claim(c).vehicleToken;
  x.advance(120000);x.pairings.sweep();assert.equal(x.pairings.tickets.size,0);assert.equal(x.store.authenticate(x.id,token).role,'vehicle');
});
test('ended meeting and review failure refuse claim and leave no usable access',t=>{
  const x=setup(t),c=x.create();x.approve(c);x.store.end(x.id,x.owner);
  assert.throws(()=>x.claim(c),e=>e.code==='VEHICLE_APPROVAL_CLOSED');
  const y=setup(t),d=y.create();y.approve(d);
  assert.throws(()=>y.pairings.claim(d.id,d.deviceToken,()=>{throw new Error('test review failed');}));
  assert.equal(y.store.sessions.get(y.id).vehicleLinkPending,false);assert.equal(y.store.read(y.id,y.owner).vehicleConnected,false);
});
test('pending cardinality is bounded and expiry makes capacity available',t=>{
  const x=setup(t,2);x.create();x.create();assert.throws(()=>x.create(),e=>e.code==='PAIRING_LIMIT');
  x.advance(120000);assert.ok(x.create());assert.equal(x.pairings.tickets.size,1);
});
test('unconnected ticket secrets cannot authenticate against a meeting',t=>{
  const x=setup(t),c=x.create();assert.throws(()=>x.store.read(x.id,c.deviceToken),e=>e.code==='ACCESS_DENIED');
  const other=x.store.create();x.approve(c);const token=x.claim(c).vehicleToken;
  assert.throws(()=>x.store.read(other.session.id,token),e=>e.code==='ACCESS_DENIED');
});
