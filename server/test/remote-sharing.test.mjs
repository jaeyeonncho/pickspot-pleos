import test from 'node:test';
import assert from 'node:assert/strict';
import {RemoteSharingClient} from '../../scripts/remote-sharing-client.mjs';
const origin='https://pickspot-test.onrender.com',key='k'.repeat(43),token='t'.repeat(43),id='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
test('local operator keeps credentials out of returned data and ends with session authentication',async()=>{
  const calls=[],responses=[{session:{id,inviteCode:'ABCDEF123456',expiresAt:Date.now()+900000},driverToken:token},
    {status:'joined',locationShare:{status:'ready',point:{latitude:37}},driverToken:token},{status:'ended'}];
  const client=new RemoteSharingClient({origin,driverKey:key,fetchImpl:async(url,options)=>{calls.push({url,...options});return {ok:true,json:async()=>responses.shift()};}});
  const invitation=await client.create();assert.equal(invitation.inviteCode,'ABCDEF123456');
  assert.equal(invitation.url,origin+'/#join=ABCDEF123456');
  assert.equal(new URL(invitation.url).search,'');
  assert.deepEqual(await client.status(),{status:'joined',locationShare:'ready',invitationAvailable:false});
  assert.deepEqual(await client.end(),{status:'ended'});
  assert.ok(!JSON.stringify(invitation).includes(token));
  assert.equal(calls[0].headers.Authorization,'Bearer '+key);
  assert.equal(calls[2].headers.Authorization,'Bearer '+token);
  for(const call of calls){assert.equal(call.redirect,'error');assert.equal(call.headers.Origin,origin);assert.ok(!call.url.includes(token));}
  await assert.rejects(client.status(),/SESSION_REQUIRED/);
});
test('operator rejects untrusted origins and never retries ambiguous creation or exposes errors',async()=>{
  for(const value of ['http://pickspot-test.onrender.com','https://pickspot-test.onrender.com/x','https://example.test','https://user@pickspot-test.onrender.com'])assert.throws(()=>new RemoteSharingClient({origin:value,driverKey:key}));
  let requests=0;
  const client=new RemoteSharingClient({origin,driverKey:key,fetchImpl:async()=>{requests++;throw new Error(key);}});
  await assert.rejects(client.create(),e=>e.message==='REMOTE_REQUEST_FAILED');
  await assert.rejects(client.create(),/CREATE_ALREADY_ATTEMPTED/);assert.equal(requests,1);
});
test('operator keeps end credentials for an explicit retry after a failed termination',async()=>{
  let count=0;
  const client=new RemoteSharingClient({origin,driverKey:key,fetchImpl:async()=>({ok:true,json:async()=>++count===1?
    {session:{id,inviteCode:'ABCDEF123456',expiresAt:Date.now()+900000},driverToken:token}:count===2?{}:{status:'ended'}})});
  await client.create();await assert.rejects(client.end(),/INVALID_REMOTE_RESPONSE/);assert.deepEqual(await client.end(),{status:'ended'});
});
test('operator treats authenticated end and expiry responses as closed instead of a connection failure',async()=>{
  for(const error of ['SESSION_ENDED','SESSION_EXPIRED']) {
    let count=0;
    const client=new RemoteSharingClient({origin,driverKey:key,fetchImpl:async()=>++count===1?
      {ok:true,status:201,json:async()=>({session:{id,inviteCode:'ABCDEF123456',expiresAt:Date.now()+900000},driverToken:token})}:
      {ok:false,status:410,json:async()=>({error})}});
    await client.create();const expected=error==='SESSION_ENDED'?'ended':'expired';
    assert.equal((await client.status()).status,expected);assert.equal((await client.end()).status,expected);
  }
});

test('routing operator opt-in scopes approvals to owner session without forwarding secrets',async()=>{
  const calls=[];let read=false;
  const client=new RemoteSharingClient({origin:'https://routing.example.test:8443',driverKey:key,pairingEnabled:true,
    fetchImpl:async(url,options)=>{
      calls.push({url,...options});const action=url.endsWith('/vehicle-pairings');
      return {ok:true,status:200,json:async()=>action?(options.method==='POST'?{status:'approved',expiresAt:Date.now()+120000,deviceToken:'secret'}:{status:'disconnected'}):
        !read?(read=true,{session:{id,inviteCode:'ABCDEF123456',expiresAt:Date.now()+900000},driverToken:token}):{status:'waiting',vehicleConnected:true,locationShare:{status:'ready'}}};
    }});
  await client.create();const state=await client.status();assert.equal(state.pairingAvailable,true);assert.equal(state.vehicleConnected,true);
  await assert.rejects(client.approveVehicle('wrong'),/INVALID_PAIRING_CODE/);
  assert.deepEqual(await client.approveVehicle('ABCDEF123456'),{status:'approved'});
  assert.deepEqual(await client.revokeVehicle(),{status:'disconnected'});
  assert.equal(calls[2].headers.Authorization,'Bearer '+token);assert.equal(calls[2].body,'{"code":"ABCDEF123456"}');
  assert.equal(calls[3].method,'DELETE');assert.ok(calls.every(c=>!c.url.includes(token)&&c.redirect==='error'));
});
