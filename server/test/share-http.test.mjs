import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,readFile,rm,chmod} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import https from 'node:https';
import {SessionStore} from '../store.mjs';
import {createLiveApp} from '../live-http.mjs';
import {sharingConfig} from '../sharing-config.mjs';
const exec=promisify(execFile);
async function setup(t) {
  const server=createLiveApp({simulation:true});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}));
  const origin=`http://127.0.0.1:${server.address().port}`;
  const call=async(path,method='GET',body,token,headers={})=>{
    const response=await fetch(origin+path,{method,headers:{Origin:origin,...(body?{'Content-Type':'application/json'}:{}),...(token?{Authorization:`Bearer ${token}`} :{}),...headers},...(body?{body:JSON.stringify(body)}:{})});
    return {status:response.status,data:await response.json(),headers:response.headers};
  };
  const created=(await call('/v1/sessions','POST',{})).data;
  const id=created.session.id,driver=created.driverToken;
  const passenger=(await call('/v1/invitations/redeem','POST',{code:created.session.inviteCode})).data.passengerToken;
  const base=`/v1/sessions/${id}`;
  const grant=async()=>{const session=(await call(base,'GET',null,passenger)).data;return (await call(base+'/location-consent','POST',{consent:true,expectedRevision:session.locationShare.revision},passenger)).data;};
  const fix=(grantId,sequence=1)=>({grantId,sequence,point:{latitude:37.4859,longitude:127.0348},observedAt:Date.now(),accuracyMeters:12});
  return {origin,call,id,base,driver,passenger,grant,fix};
}
test('simulation connects create/join/consent/update/withdraw/end without disclosing coordinates',async t=>{
  const x=await setup(t),grant=await x.grant();
  const update=await x.call(x.base+'/passenger-location','PUT',x.fix(grant.grantId),x.passenger);assert.equal(update.status,200);
  const driver=await x.call(x.base,'GET',null,x.driver);assert.equal(driver.data.locationShare.status,'ready');
  assert.ok(!JSON.stringify(driver.data).includes('37.4859'));assert.equal(driver.data.locationShare.grantId,undefined);
  const stop=await x.call(x.base+'/location-consent','DELETE',{operationId:randomUUID()},x.passenger);assert.equal(stop.data.status,'withdrawn');
  assert.equal((await x.call(x.base+'/passenger-location','PUT',x.fix(grant.grantId,2),x.passenger)).status,409);
  assert.equal((await x.call(x.base,'DELETE',null,x.driver)).status,200);
  assert.equal((await x.call(x.base,'GET',null,x.passenger)).status,410);
});
test('simulation refuses actual arbitrary coordinates and cannot use driver credentials for sharing',async t=>{
  const x=await setup(t),grant=await x.grant(),body=x.fix(grant.grantId);body.point.latitude=38;
  assert.equal((await x.call(x.base+'/passenger-location','PUT',body,x.passenger)).data.error,'SIMULATION_POINT_ONLY');
  assert.equal((await x.call(x.base+'/passenger-location','PUT',x.fix(grant.grantId),x.driver)).status,403);
  assert.equal((await x.call(x.base+'/location-consent','DELETE',{operationId:randomUUID()},x.driver)).status,403);
});
test('missing/wrong origin, cross site, unknown token and oversized payloads fail',async t=>{
  const x=await setup(t);
  assert.equal((await fetch(x.origin+'/v1/sessions',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).status,403);
  assert.equal((await x.call('/v1/sessions','POST',{},null,{Origin:'https://unrelated.example'})).status,403);
  assert.equal((await x.call('/health','GET',null,null,{'Sec-Fetch-Site':'cross-site'})).status,403);
  assert.equal((await x.call(x.base,'GET',null,'not-a-token')).status,403);
  assert.equal((await x.call(x.base+'/location-consent','POST',{consent:true,padding:'x'.repeat(5000)},x.passenger)).status,413);
});
test('update flood is limited but withdrawal still succeeds',async t=>{
  const x=await setup(t),grant=await x.grant();let response;
  for(let i=1;i<=31;i++)response=await x.call(x.base+'/passenger-location','PUT',x.fix(grant.grantId,i),x.passenger);
  assert.equal(response.status,429);assert.equal(response.headers.get('retry-after'),'60');
  assert.equal((await x.call(x.base+'/location-consent','DELETE',{operationId:randomUUID()},x.passenger)).status,200);
});
test('new stop intent creates a barrier even when already stopped; retrying one stop is idempotent',async t=>{
  const x=await setup(t),first={operationId:randomUUID()};
  const stopped=(await x.call(x.base+'/location-consent','DELETE',first,x.passenger)).data;
  const repeat=(await x.call(x.base+'/location-consent','DELETE',first,x.passenger)).data;assert.deepEqual(repeat,stopped);
  await x.call(x.base+'/location-consent','DELETE',{operationId:randomUUID()},x.passenger);
  const delayed=await x.call(x.base+'/location-consent','POST',{consent:true,expectedRevision:stopped.revision},x.passenger);
  assert.equal(delayed.status,409);assert.equal(delayed.data.error,'LOCATION_REVISION_CONFLICT');
});
test('sharing pages are explicit simulation and browser device location is denied there',async t=>{
  const x=await setup(t);const page=await fetch(x.origin+'/');assert.equal(page.headers.get('permissions-policy'),'geolocation=()');
  assert.equal((await x.call('/health')).data.simulation,true);
  for(const path of ['/driver','/share-page.mjs','/share-driver.mjs','/share-client.mjs','/invitation-link.mjs','/share-api.mjs','/browser-location.mjs','/shared/location-policy.mjs'])assert.equal((await fetch(x.origin+path)).status,200);
});
test('real mode requires TLS, fixed HTTPS origin and private driver bootstrap key',()=>{
  assert.throws(()=>createLiveApp(),e=>e.code==='HTTPS_ORIGIN_REQUIRED');
  assert.throws(()=>createLiveApp({tls:{key:'x',cert:'x'},publicOrigin:'http://localhost',driverKey:'x'.repeat(43)}),e=>e.code==='HTTPS_ORIGIN_REQUIRED');
  assert.throws(()=>createLiveApp({tls:{key:'x',cert:'x'},publicOrigin:'https://localhost/'}),e=>e.code==='HTTPS_ORIGIN_REQUIRED');
  assert.throws(()=>createLiveApp({tls:{key:'x',cert:'x'},publicOrigin:'https://localhost'}),e=>e.code==='DRIVER_KEY_REQUIRED');
  const store=new SessionStore();assert.throws(()=>createLiveApp({simulation:true,store}),e=>e.code==='LIVE_STORE_REQUIRED');store.dispose();
});
test('real TLS transport validates a trusted test certificate and accepts only authenticated driver creation',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'pickspot-tls-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const certPath=join(dir,'cert.pem'),keyPath=join(dir,'key.pem');
  await exec('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',keyPath,'-out',certPath,'-days','1','-subj','/CN=localhost','-addext','subjectAltName=DNS:localhost']);
  const cert=await readFile(certPath),key=await readFile(keyPath),driverKey='a'.repeat(43);
  await chmod(keyPath,0o600);
  const env={PICKSPOT_PUBLIC_ORIGIN:'https://localhost',PICKSPOT_TLS_CERT_FILE:certPath,PICKSPOT_TLS_KEY_FILE:keyPath,PICKSPOT_DRIVER_KEY:driverKey};
  const config=await sharingConfig(env);assert.equal(config.host,'127.0.0.1');assert.equal(config.port,8443);
  await assert.rejects(sharingConfig({...env,PICKSPOT_PUBLIC_ORIGIN:'https://wrong.example'}),e=>e.message==='TLS_CERTIFICATE_HOST_MISMATCH');
  await chmod(keyPath,0o644);await assert.rejects(sharingConfig(env),e=>e.message==='TLS_KEY_MUST_BE_PRIVATE');await chmod(keyPath,0o600);
  const server=createLiveApp({tls:{key,cert},publicOrigin:'https://localhost',driverKey});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}));
  const call=(path,method='GET',body,token)=>new Promise((resolve,reject)=>{
    const request=https.request({hostname:'127.0.0.1',port:server.address().port,servername:'localhost',ca:cert,path,method,
      headers:{Host:'localhost',Origin:'https://localhost',...(body?{'Content-Type':'application/json','Content-Length':Buffer.byteLength(JSON.stringify(body))}:{}),...(token?{Authorization:`Bearer ${token}`}:{})}},res=>{
      const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.on('end',()=>resolve({status:res.statusCode,data:JSON.parse(Buffer.concat(chunks).toString())}));});
    request.on('error',reject);request.end(body?JSON.stringify(body):undefined);
  });
  assert.equal((await call('/v1/sessions','POST',{})).status,403);
  const made=await call('/v1/sessions','POST',{},driverKey);assert.equal(made.status,201);
  const passenger=(await call('/v1/invitations/redeem','POST',{code:made.data.session.inviteCode})).data.passengerToken;
  const base=`/v1/sessions/${made.data.session.id}`;
  const grant=(await call(base+'/location-consent','POST',{consent:true,expectedRevision:0},passenger)).data;
  const accepted=await call(base+'/passenger-location','PUT',{grantId:grant.grantId,sequence:1,point:{latitude:37.4859,longitude:127.0348},observedAt:Date.now(),accuracyMeters:12},passenger);
  assert.equal(accepted.status,200);assert.equal(accepted.data.status,'ready');
  assert.equal((await call(base+'/location-consent','DELETE',{operationId:randomUUID()},passenger)).data.status,'withdrawn');
  assert.equal((await call('/health')).data.simulation,false);
});
