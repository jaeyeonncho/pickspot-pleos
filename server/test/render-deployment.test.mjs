import test from 'node:test';
import http from 'node:http';
import assert from 'node:assert/strict';
import {createLiveApp} from '../live-http.mjs';
import {renderSharingConfig} from '../render-config.mjs';
const env={PICKSPOT_DEPLOYMENT:'render-free',RENDER:'true',RENDER_SERVICE_TYPE:'web',RENDER_EXTERNAL_URL:'https://pickspot-test.onrender.com',RENDER_EXTERNAL_HOSTNAME:'pickspot-test.onrender.com',PICKSPOT_DRIVER_KEY:'k'.repeat(43),PORT:'10000',WEB_CONCURRENCY:'1'};
test('managed edge mode requires explicit platform origin and sharing-only configuration',()=>{
  assert.equal(renderSharingConfig(env).proxyMode,'render-free');
  for(const change of [{RENDER:'false'},{PICKSPOT_DEPLOYMENT:'generic-proxy'},{RENDER_SERVICE_TYPE:'pserv'},{RENDER_EXTERNAL_URL:'http://pickspot-test.onrender.com'},
    {RENDER_EXTERNAL_HOSTNAME:'other.onrender.com'},{RENDER_EXTERNAL_URL:'https://user@pickspot-test.onrender.com'},
    {PICKSPOT_DRIVER_KEY:''},{WEB_CONCURRENCY:'2'},{PORT:'18012'},{TMAP_APP_KEY:'test-not-real'},{TMAP_DAILY_CALL_LIMIT:'7'}])assert.throws(()=>renderSharingConfig({...env,...change}));
  assert.throws(()=>createLiveApp({simulation:true,proxyMode:'render-free'}));
  assert.throws(()=>createLiveApp({proxyMode:'arbitrary'}));
});
test('edge transport checks HTTPS marker, origin and authentication without enabling a public driver page',async t=>{
  const config=renderSharingConfig(env),server=createLiveApp(config);
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}));
  // Local HTTP intentionally represents only the trusted edge-to-container hop.
  const call=(path,method='GET',body,token,overrides={})=>new Promise((resolve,reject)=>{
    const data=body?JSON.stringify(body):undefined;
    const req=http.request({hostname:'127.0.0.1',port:server.address().port,path,method,headers:{host:env.RENDER_EXTERNAL_HOSTNAME,origin:env.RENDER_EXTERNAL_URL,'x-forwarded-proto':'https',
      ...(data?{'content-type':'application/json','content-length':Buffer.byteLength(data)}:{}),...(token?{authorization:`Bearer ${token}`} :{}),...overrides}},res=>{
      const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(Buffer.concat(chunks).toString())}));
    });req.on('error',reject);req.end(data);
  });
  for(const marker of ['','http','https, http'])assert.equal((await call('/health','GET',null,null,{'x-forwarded-proto':marker})).status,403);
  assert.equal((await call('/health','GET',null,null,{host:'other.onrender.com'})).status,403);
  assert.equal((await call('/v1/sessions','POST',{},env.PICKSPOT_DRIVER_KEY,{origin:'https://other.example'})).status,403);
  assert.equal((await call('/v1/sessions','POST',{})).status,403);
  const made=await call('/v1/sessions','POST',{},env.PICKSPOT_DRIVER_KEY);assert.equal(made.status,201,JSON.stringify(made.body));
  assert.equal((await call('/driver')).status,404);
  const health=await call('/health');assert.equal(health.body.simulation,false);assert.equal(health.body.routeReady,false);assert.equal(health.body.hosting,'render-free');
  const joined=await call('/v1/invitations/redeem','POST',{code:made.body.session.inviteCode});
  const id=made.body.session.id,token=joined.body.passengerToken,path=`/v1/sessions/${id}`;
  const grant=await call(path+'/location-consent','POST',{consent:true,expectedRevision:0},token);
  assert.equal((await call(path+'/passenger-location','PUT',{grantId:grant.body.grantId,sequence:1,point:{latitude:37.4859,longitude:127.0348},observedAt:Date.now(),accuracyMeters:12},token)).status,200);
  const read=await call(path,'GET',null,made.body.driverToken);assert.equal(read.body.locationShare.status,'ready');assert.ok(!JSON.stringify(read.body).includes('latitude'));
  assert.equal((await call(path+'/location-consent','DELETE',{operationId:crypto.randomUUID()},token)).status,200);
  assert.equal((await call(path,'DELETE',null,made.body.driverToken)).status,200);
});
test('shared links may navigate to the public page while cross-site APIs, frames and requests with foreign Origin stay blocked',async t=>{
  const server=createLiveApp(renderSharingConfig(env));
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}));
  const call=(path='/',headers={},method='GET')=>new Promise((resolve,reject)=>{
    const req=http.request({hostname:'127.0.0.1',port:server.address().port,path,method,
      headers:{host:env.RENDER_EXTERNAL_HOSTNAME,'x-forwarded-proto':'https','sec-fetch-site':'cross-site','sec-fetch-mode':'navigate','sec-fetch-dest':'document',...headers}},res=>{
      const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.on('end',()=>resolve({status:res.statusCode,body:Buffer.concat(chunks).toString()}));
    });req.on('error',reject);req.end();
  });
  const page=await call();assert.equal(page.status,200);assert.ok(page.body.includes('연결 코드를 입력해 주세요'));
  for(const path of ['/health','/driver','/v1/sessions'])assert.equal((await call(path)).status,403);
  assert.equal((await call('/',{'sec-fetch-dest':'iframe'})).status,403);
  assert.equal((await call('/',{'sec-fetch-mode':'cors'})).status,403);
  assert.equal((await call('/',{origin:'https://other.example'})).status,403);
  assert.equal((await call('/',{},'POST')).status,403);
});
