import test from 'node:test';
import assert from 'node:assert/strict';
import {get} from 'node:http';
import {SharingConsole} from '../../scripts/sharing-console-state.mjs';
import {createSharingConsoleServer} from '../../scripts/sharing-console-server.mjs';
import {consoleView} from '../../scripts/sharing-console/view.mjs';

function setup(overrides={}) {
  let now=1_800_000_000_000,creates=0,reads=0,ends=0;
  const invitation={url:'https://pickspot-test.onrender.com/#join=ABCDEF123456',inviteCode:'ABCDEF123456',expiresAt:now+900000};
  const client={create:async()=>{creates++;return {...invitation,driverToken:'never-return-this'};},
    status:async()=>{reads++;return {status:'waiting',locationShare:'ready',invitationAvailable:false,point:{latitude:37}};},
    end:async()=>{ends++;return {status:'ended'};},...overrides};
  const controller=new SharingConsole({now:()=>now,createClient:()=>client});
  return {controller,client,invitation,advance:ms=>now+=ms,now:()=>now,counts:()=>({creates,reads,ends})};
}
test('console creates, hides used invitation, observes withdrawal and ends without exposing private data',async()=>{
  const x=setup();assert.equal(x.controller.view().canCreate,true);
  const made=await x.controller.create();assert.equal(made.invitation.url,x.invitation.url);
  assert.ok(!JSON.stringify(made).includes('never-return-this'));
  const received=await x.controller.refresh();assert.equal(received.locationShare,'ready');assert.equal(received.invitation,null);
  assert.ok(!JSON.stringify(received).includes('latitude'));
  x.client.status=async()=>({status:'waiting',locationShare:'withdrawn',invitationAvailable:false});x.advance(3000);
  assert.equal((await x.controller.refresh()).locationShare,'withdrawn');
  const ended=await x.controller.end();assert.equal(ended.phase,'ended');assert.equal(ended.canCreate,true);assert.equal(ended.invitation,null);
  assert.equal((await x.controller.create()).phase,'active');
});
test('creation is single flight and ambiguous outcome never enables automatic retry',async()=>{
  let release,calls=0;
  const x=setup({create:()=>{calls++;return new Promise((_resolve,reject)=>release=()=>reject(new Error('private upstream details')));}});
  const pending=x.controller.create();await Promise.resolve();
  await assert.rejects(x.controller.create(),/CREATE_NOT_AVAILABLE/);release();
  const failed=await pending;assert.equal(failed.phase,'create-unknown');assert.equal(failed.canCreate,false);
  await assert.rejects(x.controller.create(),/CREATE_NOT_AVAILABLE/);await x.controller.refresh();assert.equal(calls,1);
  assert.ok(!JSON.stringify(failed).includes('private upstream'));
});
test('configuration failure can be retried because no creation was attempted',async()=>{
  let configured=false,created=0;
  const controller=new SharingConsole({createClient:()=>{if(!configured)throw new Error('private path and secret');return {create:async()=>{created++;throw new Error('offline');}};}});
  assert.equal((await controller.create()).phase,'configuration-error');assert.equal(controller.view().canCreate,true);assert.equal(created,0);
  configured=true;assert.equal((await controller.create()).phase,'create-unknown');assert.equal(created,1);
});
test('read failure clears stale received state and invitation; poll rate is bounded',async()=>{
  const x=setup();await x.controller.create();await x.controller.refresh();await x.controller.refresh();
  assert.equal(x.counts().reads,1);x.advance(3000);x.client.status=async()=>{throw new Error('secret');};
  const failed=await x.controller.refresh();assert.equal(failed.connected,false);assert.equal(failed.locationShare,'unknown');assert.equal(failed.invitation,null);
  assert.equal(failed.canEnd,true);
});
test('local invite expiry hides link but does not claim server termination',async()=>{
  const x=setup();await x.controller.create();x.advance(900000);
  const state=x.controller.view();assert.equal(state.invitation,null);assert.equal(state.phase,'active');assert.equal(state.canCreate,false);
  x.client.status=async()=>({status:'expired'});assert.equal((await x.controller.refresh()).phase,'expired');
});
test('end failure retains the session for an explicit retry and never creates another',async()=>{
  let attempts=0;const x=setup({end:async()=>{if(++attempts===1)throw new Error('connection');return {status:'ended'};}});
  await x.controller.create();const failed=await x.controller.end();
  assert.equal(failed.phase,'end-unknown');assert.equal(failed.canEnd,true);assert.equal(failed.canCreate,false);
  assert.equal((await x.controller.end()).phase,'ended');assert.equal(attempts,2);
});
test('end serializes behind an in-flight read and duplicate end cannot dispatch',async()=>{
  let release;const x=setup({status:()=>new Promise(resolve=>release=resolve)});await x.controller.create();
  const read=x.controller.refresh();const end=x.controller.end();
  await assert.rejects(x.controller.end(),/END_NOT_AVAILABLE/);
  assert.equal(x.counts().ends,0);release({status:'waiting',locationShare:'ready',invitationAvailable:true});
  await read;assert.equal((await end).phase,'ended');assert.equal(x.counts().ends,1);
});
test('shutdown waits for creation then attempts termination exactly once',async()=>{
  let release;const x=setup({create:()=>new Promise(resolve=>release=resolve)});
  const creation=x.controller.create();await Promise.resolve();const closing=x.controller.close();release(x.invitation);
  await creation;assert.equal((await closing).phase,'ended');assert.equal(x.counts().ends,1);assert.equal(x.controller.view().canCreate,false);
});
test('UI maintains received title across age ticks and hides stale or demo clipboard links',async()=>{
  const x=setup();const state=await x.controller.create();
  const ready={...state,locationShare:'ready'};
  assert.equal(consoleView(ready,x.now()).title,consoleView(ready,x.now()+5000).title);
  assert.equal(consoleView(ready,x.now()+5000).freshness,'5초 전 확인');
  assert.equal(consoleView(ready,x.now()+10000).invitation,null);
  assert.equal(consoleView({...state,mode:'demo'},x.now()).canCopy,false);
  assert.equal(consoleView({...state,phase:'end-unknown',connected:false},x.now()).endLabel,'만남 종료 다시 확인');
});

async function httpSetup(t) {
  const x=setup(),server=createSharingConsoleServer(x.controller);
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}));
  const origin=`http://127.0.0.1:${server.address().port}`;
  const request=(path,options={})=>fetch(origin+path,options);
  const initial=await (await request('/api/state')).json();
  const post=(path,options={})=>request(path,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json','X-Pickspot-Console':initial.consoleToken,...options.headers},body:options.body??'{}'});
  return {...x,origin,request,post};
}
test('local HTTP console requires its origin, action token and an empty body',async t=>{
  const x=await httpSetup(t);
  for(const headers of [{Origin:'https://unrelated.test'},{'X-Pickspot-Console':''},{'X-Pickspot-Console':'wrong'}, {'Content-Type':'text/plain'}]) {
    assert.ok((await x.post('/api/create',{headers})).status>=400);
  }
  assert.equal((await x.request('/api/create',{method:'POST',body:'{}'})).status,403);
  for(const body of ['null','[]','{','{"driverKey":"ignored"}'])assert.equal((await x.post('/api/create',{body})).status,400);
  assert.equal((await x.post('/api/create',{body:'x'.repeat(300)})).status,413);
  assert.equal(x.counts().creates,0);
  assert.equal((await x.post('/api/create')).status,200);assert.equal(x.counts().creates,1);
  assert.equal((await x.post('/api/create')).status,409);
  assert.equal((await x.post('/api/end')).status,200);
});
test('console rejects rebinding/cross-site reads and serves only bundled static assets',async t=>{
  const x=await httpSetup(t);
  // Node fetch rewrites Host; use the HTTP transport to actually send a rebound host.
  const rebound=await new Promise((resolve,reject)=>{
    get(x.origin+'/api/state',{headers:{Host:'evil.test'}},response=>{response.resume();resolve(response.statusCode);}).on('error',reject);
  });
  assert.equal(rebound,403);
  assert.equal((await x.request('/api/state',{headers:{Origin:'https://evil.test'}})).status,403);
  assert.equal((await x.request('/api/state',{headers:{'Sec-Fetch-Site':'cross-site'}})).status,403);
  assert.equal((await x.request('/.env.remote.local')).status,404);
  for(const path of ['/','/app.mjs','/style.css','/view.mjs']) {
    const response=await x.request(path);assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');
    assert.ok(response.headers.get('content-security-policy').includes("frame-ancestors 'none'"));
    assert.ok(response.headers.get('permissions-policy').includes('geolocation=()'));
  }
});

test('vehicle approval and revoke are explicit, serialized, and never expose upstream secrets',async()=>{
  let approve=0,revoke=0,finish;
  const x=setup({status:async()=>({status:'waiting',locationShare:'ready',pairingAvailable:true,vehicleConnected:false}),
    approveVehicle:async code=>{assert.equal(code,'ABCDEF123456');approve++;await new Promise(r=>finish=r);return {status:'approved',vehicleToken:'secret'};},
    revokeVehicle:async()=>{revoke++;return {status:'disconnected'};}});
  await x.controller.create();await x.controller.refresh();assert.equal(x.controller.view().canPair,true);
  await assert.rejects(x.controller.vehicleAction('bad'),/INVALID_PAIRING_CODE/);
  const pending=x.controller.vehicleAction('ABCDEF123456');
  await assert.rejects(x.controller.vehicleAction('ABCDEF123456'),/PAIRING_NOT_AVAILABLE/);
  assert.equal(x.controller.view().pairingStatus,'working');finish();
  const approved=await pending;assert.equal(approved.pairingStatus,'approved');assert.ok(!JSON.stringify(approved).includes('secret'));
  assert.equal((await x.controller.vehicleAction()).pairingStatus,'disconnected');assert.equal(approve,1);assert.equal(revoke,1);
});
test('vehicle approval failure never auto retries and ending waits for pending approval',async()=>{
  let finish,approvals=0;
  const x=setup({status:async()=>({status:'waiting',locationShare:'ready',pairingAvailable:true}),
    approveVehicle:async()=>{approvals++;await new Promise(r=>finish=r);throw new Error('private');}});
  await x.controller.create();await x.controller.refresh();const pending=x.controller.vehicleAction('ABCDEF123456');
  const end=x.controller.end();assert.equal(x.counts().ends,0);finish();await pending;
  assert.equal((await end).phase,'ended');assert.equal(approvals,1);assert.equal(x.counts().ends,1);
  await assert.rejects(x.controller.vehicleAction(),/PAIRING_NOT_AVAILABLE/);
});
test('vehicle controls reject stale and unsupported sessions and hide stale connection claims',async()=>{
  const {pairingView,pairingCode}=await import('../../scripts/sharing-console/view.mjs');
  assert.equal(pairingCode('abcd ef12 3456'),'ABCDEF123456');assert.equal(pairingCode('<script>'),null);
  const x=setup();await x.controller.create();await x.controller.refresh();await assert.rejects(x.controller.vehicleAction(),/PAIRING_NOT_AVAILABLE/);
  x.client.status=async()=>({status:'waiting',locationShare:'ready',pairingAvailable:true,vehicleConnected:true});x.advance(3000);
  const connected=await x.controller.refresh();assert.equal(pairingView(connected,true,x.now()).title,'차량이 연결됐어요');
  x.advance(10000);assert.equal(pairingView(connected,true,x.now()).canAct,false);
  assert.notEqual(pairingView(connected,true,x.now()).title,'차량이 연결됐어요');await assert.rejects(x.controller.vehicleAction(),/PAIRING_NOT_AVAILABLE/);
});
test('local vehicle actions require origin and token and reject unrelated body fields',async t=>{
  const x=await httpSetup(t);
  assert.equal((await x.post('/api/vehicle/approve',{headers:{'X-Pickspot-Console':''},body:'{"code":"ABCDEF123456"}'})).status,403);
  for(const body of ['{}','{"code":"bad"}','{"code":"ABCDEF123456","token":"secret"}'])assert.equal((await x.post('/api/vehicle/approve',{body})).status,400);
  assert.equal((await x.post('/api/vehicle/revoke',{body:'{"code":"ABCDEF123456"}'})).status,400);
  assert.equal((await x.post('/api/vehicle/approve',{body:'{"code":"ABCDEF123456"}'})).status,409);
});

test('pairing preview is visibly a demo and cannot copy a fake invitation',async()=>{
  const x=setup();const state=await x.controller.create();
  assert.equal(consoleView({...state,mode:'pairing-demo'},x.now()).canCopy,false);
});
