import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {SessionStore} from '../store.mjs';
import {createLiveApp} from '../live-http.mjs';
import {CandidateCatalog} from '../catalog/repository.mjs';
import {exampleTrip} from '../routing/example.mjs';
import {FixtureRoutes} from '../routing/fixture.mjs';
import {RouteError} from '../routing/contract.mjs';

let dir,tls;
before(async()=>{
  dir=await mkdtemp(join(tmpdir(),'pickspot-route-tls-'));
  const keyPath=join(dir,'key.pem'),certPath=join(dir,'cert.pem');
  await promisify(execFile)('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',keyPath,'-out',certPath,'-days','1','-subj','/CN=localhost','-addext','subjectAltName=DNS:localhost']);
  tls={key:await readFile(keyPath),cert:await readFile(certPath)};
});
after(async()=>{if(dir)await rm(dir,{recursive:true,force:true});});

async function setup(t,{enabled=true,passengerConsent=true,pairing=false,route,prepare}={}) {
  let at=1_800_000_000_000,calls=0,reservations=0;
  const base=exampleTrip(),fixture=new FixtureRoutes();
  const raw={schemaVersion:1,region:'자동 검사 전용',entries:base.candidates.map(c=>({
    id:c.id,name:c.id,address:'검사 주소',vehiclePoint:c.point,walkingPoint:c.point,
    sources:[{publisher:'검사',url:'https://example.test/catalog',checkedOn:'2026-01-01',asOf:null,fact:'실제 장소가 아닌 검사 자료'}],
    review:{status:'reviewed',generalVehiclePickup:'confirmed',meetingConnection:'connected',dataUse:'permitted',checkedOn:'2026-01-01',validUntil:'2030-01-01',conditions:'검사 전용'},openQuestions:[]
  }))};
  const catalog=new CandidateCatalog(raw),store=new SessionStore({locationMode:'live',candidateCatalog:catalog,now:()=>at,monotonic:()=>at});
  // Contract fake: exercises the live transport boundary with fixed examples only.
  const provider={source:'tmap',synthetic:false,route:request=>{calls++;return route?route(request):fixture.route(request);},
    prepareBatch:async(count,options)=>{reservations++;assert.equal(count,7);return prepare?prepare(count,options,provider):provider;}};
  const driverKey='a'.repeat(43);
  const server=createLiveApp({tls,publicOrigin:'https://localhost',driverKey,store,now:()=>at,...(enabled?{routeProvider:provider,routingDisclosure:{processingRegion:'검사 전용'}}:{}),vehiclePairing:pairing?{processingRegion:'검사 전용',candidateIds:base.candidates.map(c=>c.id)}:null});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}));
  const call=(path,method='GET',body,token,options={})=>new Promise((resolve,reject)=>{
    const payload=body===undefined?undefined:JSON.stringify(body);
    const request=https.request({hostname:'127.0.0.1',port:server.address().port,servername:'localhost',ca:tls.cert,path,method,signal:options.signal,
      headers:{Host:'localhost',Origin:'https://localhost',...(payload?{'Content-Type':'application/json','Content-Length':Buffer.byteLength(payload)}:{}),...(token?{Authorization:`Bearer ${token}`} :{}),...options.headers}},res=>{
      const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.on('end',()=>resolve({status:res.statusCode,data:JSON.parse(Buffer.concat(chunks).toString()),headers:res.headers}));
    });request.on('error',reject);request.end(payload);
  });
  const made=(await call('/v1/sessions','POST',{},driverKey)).data;
  const id=made.session.id,driver=made.driverToken,path=`/v1/sessions/${id}`;
  const passenger=(await call('/v1/invitations/redeem','POST',{code:made.session.inviteCode})).data.passengerToken;
  const disclosure=enabled?(await call(path+'/routing-disclosure','GET',undefined,passenger)).data:null;
  const grant=(await call(path+'/location-consent','POST',{consent:true,expectedRevision:0,...(passengerConsent&&enabled?{routingProvider:'tmap',routingDisclosureId:disclosure.id}:{})},passenger)).data;
  const update=async(sequence=1)=>(await call(path+'/passenger-location','PUT',{grantId:grant.grantId,sequence,point:base.passenger,observedAt:at,accuracyMeters:12},passenger));
  assert.equal((await update()).status,200);
  const input=async()=>({expectedVersion:(await call(path,'GET',undefined,driver)).data.version,
    driver:{point:base.driver,observedAt:at,accuracyMeters:12,source:'vehicle',consent:true,routingProvider:'tmap'},
    destination:{point:base.destination,name:'검사 목적지'},waypoints:[],routeObservedAt:at,drivePreference:'recommended',candidateIds:base.candidates.map(c=>c.id)});
  const compare=(body,token=driver,options)=>call(path+'/route-comparisons','POST',body,token,options);
  return {call,path,id,driver,passenger,disclosure,input,compare,update,store,catalog,raw,provider,advance:ms=>{at+=ms;},calls:()=>calls,reservations:()=>reservations};
}
async function eventually(predicate) {
  const until=Date.now()+2000;
  while(!predicate()){if(Date.now()>until)assert.fail('cancellation did not finish');await new Promise(resolve=>setTimeout(resolve,10));}
}

test('TLS comparison authenticates driver, uses server passenger/catalog and returns coordinate-free totals',async t=>{
  const x=await setup(t),reply=await x.compare(await x.input());
  assert.equal(reply.status,200);assert.equal(reply.data.inputMode,'live');assert.equal(reply.data.referenceOnly,true);
  assert.equal(reply.data.providerCalls,7);assert.equal(x.calls(),7);assert.equal(x.reservations(),1);
  assert.deepEqual(reply.data.candidates.map(c=>c.detourSeconds),[120,300,45]);
  assert.equal(reply.data.vehicleRouteOptionMatched,false);assert.equal(reply.headers['cache-control'],'no-store');
  const text=JSON.stringify(reply.data);for(const field of ['latitude','longitude',x.driver,x.passenger])assert.ok(!text.includes(field));
  assert.equal((await x.call(x.path,'GET',undefined,x.driver)).data.route,null);
  assert.equal(x.store.routeJobs.size,0);
});
test('route endpoint stays absent by default and cannot be enabled on simulation or Render Free',async t=>{
  const x=await setup(t,{enabled:false});assert.equal((await x.compare(await x.input())).status,404);assert.equal(x.calls(),0);
  assert.equal((await x.call('/health')).data.routeReady,false);
  for(const options of [{simulation:true},{proxyMode:'render-free'}])assert.throws(()=>createLiveApp({...options,store:x.store,routeProvider:x.provider}),e=>e.code==='DIRECT_TLS_ROUTES_ONLY');
  assert.throws(()=>createLiveApp({store:x.store,tls,publicOrigin:'https://localhost',driverKey:'a'.repeat(43),routeProvider:new FixtureRoutes()}),e=>e.code==='INVALID_LIVE_ROUTE_PROVIDER');
});
test('missing credentials, passenger, wrong origin, method and oversized bodies cannot dispatch',async t=>{
  const x=await setup(t),body=await x.input();
  assert.equal((await x.compare(body,null)).status,401);
  assert.equal((await x.compare(body,'wrong')).status,403);
  assert.equal((await x.compare(body,x.passenger)).data.error,'DRIVER_ONLY');
  assert.equal((await x.compare(body,x.driver,{headers:{Origin:'https://other.example'}})).status,403);
  assert.equal((await x.call(x.path+'/route-comparisons','GET',undefined,x.driver)).status,405);
  assert.equal((await x.compare({...body,padding:'x'.repeat(5000)})).status,413);
  assert.equal(x.calls(),0);assert.equal(x.reservations(),0);
});
test('payload cannot supply passenger, catalog coordinates, keys or nested extra fields',async t=>{
  const x=await setup(t),body=await x.input();
  for(const tampered of [
    {...body,passenger:body.driver},{...body,candidates:exampleTrip().candidates},{...body,appKey:'not-a-key'},
    {...body,driver:{...body.driver,extra:true}},{...body,driver:{...body.driver,point:{...body.driver.point,extra:true}}},
    {...body,destination:{...body.destination,extra:true}},{...body,waypoints:[{...body.driver.point,extra:true}]}
  ])assert.equal((await x.compare(tampered)).data.error,'INVALID_ROUTE_INPUT');
  assert.equal(x.calls(),0);assert.equal(x.reservations(),0);
});
test('version guard rejects a stale or replayed request before calls',async t=>{
  const x=await setup(t),body=await x.input();
  assert.equal((await x.compare({...body,expectedVersion:body.expectedVersion-1})).data.error,'VERSION_CONFLICT');
  const absent={...body};delete absent.expectedVersion;
  assert.equal((await x.compare(absent)).data.error,'VERSION_CONFLICT');
  assert.equal((await x.compare(body)).status,200);
  assert.equal((await x.compare(body)).data.error,'VERSION_CONFLICT');assert.equal(x.calls(),7);
});
test('both routing consents are required independently of ordinary location sharing',async t=>{
  const x=await setup(t,{passengerConsent:false});
  assert.equal((await x.compare(await x.input())).data.error,'ROUTING_CONSENT_REQUIRED');assert.equal(x.calls(),0);
  const y=await setup(t),body=await y.input();delete body.driver.routingProvider;
  assert.equal((await y.compare(body)).data.error,'ROUTING_CONSENT_REQUIRED');assert.equal(y.calls(),0);
  body.driver.routingProvider='tmap';body.driver.consent=false;
  assert.equal((await y.compare(body)).data.error,'LOCATION_CONSENT_REQUIRED');assert.equal(y.reservations(),0);
});
test('stale route, missing accuracy, unread stops and unreviewed catalog fail before budget reservation',async t=>{
  const x=await setup(t),body=await x.input();
  for(const [input,code] of [
    [{...body,routeObservedAt:body.routeObservedAt-30000},'ROUTE_CONTEXT_STALE'],
    [{...body,driver:{...body.driver,accuracyMeters:null}},'LOCATION_ACCURACY_REQUIRED'],
    [{...body,waypoints:undefined},'ORIGINAL_WAYPOINTS_REQUIRED'],
    [{...body,waypoints:[{latitude:0,longitude:0}]},'ROUTE_COORDINATE_UNAVAILABLE'],
    [{...body,drivePreference:undefined},'DRIVE_PREFERENCE_REQUIRED']
  ])assert.equal((await x.compare(input)).data.error,code);
  x.raw.entries[0].review.status='pending';x.catalog.replace(x.raw);
  assert.equal((await x.compare(body)).data.error,'CANDIDATE_NOT_REVIEWED');assert.equal(x.calls(),0);assert.equal(x.reservations(),0);
});
test('session cooldown and attempts remain enforced through HTTP',async t=>{
  const x=await setup(t);assert.equal((await x.compare(await x.input())).status,200);
  const cooldown=await x.compare(await x.input());assert.equal(cooldown.status,429);assert.equal(cooldown.data.error,'ROUTE_COOLDOWN');assert.equal(cooldown.headers['retry-after'],'60');
  for(let i=2;i<=5;i++){x.advance(10000);await x.update(i);assert.equal((await x.compare(await x.input())).status,200);}
  x.advance(10000);await x.update(6);assert.equal((await x.compare(await x.input())).data.error,'ROUTE_ATTEMPT_LIMIT');assert.equal(x.calls(),35);
});
test('provider errors are allowlisted and unexpected details are not returned',async t=>{
  for(const [error,code,status] of [[new RouteError('ROUTE_BUDGET_EXCEEDED'),'ROUTE_BUDGET_EXCEEDED',429],
    [new RouteError('SECRET_CREDENTIAL_AND_COORDINATE'),'ROUTE_SERVICE_ERROR',502],
    [new Error('SECRET_CREDENTIAL_AND_COORDINATE'),'ROUTE_PROVIDER_ERROR',502]]) {
    const x=await setup(t,{prepare:()=>{throw error;}});
    const reply=await x.compare(await x.input());assert.equal(reply.status,status);assert.deepEqual(reply.data,{error:code});assert.equal(x.calls(),0);
  }
});
test('partial candidate failures cannot reflect arbitrary provider error codes in a successful response',async t=>{
  let calls=0;
  const x=await setup(t,{route:()=>{
    if(++calls>1)throw new RouteError('SECRET_CREDENTIAL_AND_COORDINATE');
    return {distanceMeters:1000,durationSeconds:600};
  }});
  const reply=await x.compare(await x.input());assert.equal(reply.status,200);
  assert.equal(reply.data.excluded.length,3);
  assert.ok(reply.data.excluded.every(item=>item.reason==='ROUTE_SERVICE_ERROR'));
  assert.ok(!JSON.stringify(reply.data).includes('SECRET'));
});
test('withdrawal during a slow comparison cancels HTTP result and late provider results',async t=>{
  let started,release,signal;const dispatched=new Promise(resolve=>started=resolve);
  const x=await setup(t,{route:request=>{signal=request.signal;started();return new Promise(resolve=>release=resolve);}});
  const pending=x.compare(await x.input());await dispatched;
  assert.equal((await x.call(x.path+'/location-consent','DELETE',{},x.passenger)).status,400);
  // Valid withdrawal is deliberately not subject to the calculation limiter.
  const {randomUUID}=await import('node:crypto');
  assert.equal((await x.call(x.path+'/location-consent','DELETE',{operationId:randomUUID()},x.passenger)).status,200);
  const reply=await pending;assert.equal(reply.status,409);assert.ok(['ROUTE_CANCELLED','TRIP_INPUT_CHANGED'].includes(reply.data.error));
  assert.equal(signal.aborted,true);release({distanceMeters:1,durationSeconds:1});assert.equal(x.store.routeJobs.size,0);
});
test('client disconnect aborts work during reservation and ignores its late completion',async t=>{
  let started,release,signal;const dispatched=new Promise(resolve=>started=resolve);
  const x=await setup(t,{prepare:(count,options,provider)=>{signal=options.signal;started();return new Promise(resolve=>release=()=>resolve(provider));}});
  const controller=new AbortController(),pending=x.compare(await x.input(),x.driver,{signal:controller.signal});
  const rejected=assert.rejects(pending,e=>e.name==='AbortError');await dispatched;controller.abort();await rejected;
  await eventually(()=>signal.aborted&&x.store.routeJobs.size===0);release();await new Promise(resolve=>setImmediate(resolve));assert.equal(x.calls(),0);
});
test('new passenger position or end invalidates a running HTTP comparison',async t=>{
  for(const mutation of ['position','end']) {
    let started;const dispatched=new Promise(resolve=>started=resolve);
    const x=await setup(t,{route:()=>{started();return new Promise(()=>{});}}),pending=x.compare(await x.input());await dispatched;
    if(mutation==='position'){x.advance(1);assert.equal((await x.update(2)).status,200);}
    else assert.equal((await x.call(x.path,'DELETE',undefined,x.passenger)).status,200);
    assert.equal((await pending).status,409);assert.equal(x.store.routeJobs.size,0);assert.equal(x.calls(),1);
  }
});

test('vehicle pairing stays unavailable by default even when route endpoint is enabled',async t=>{
  const x=await setup(t);assert.equal((await x.call('/v1/vehicle-pairings','POST',{})).status,404);
  assert.equal((await x.call(x.path+'/vehicle-pairings','POST',{code:'A'.repeat(12)},x.driver)).status,404);
});
test('TLS owner-approved vehicle obtains only read and comparison access without bootstrap credentials',async t=>{
  const x=await setup(t,{pairing:true});assert.equal((await x.call('/health')).data.vehiclePairing,true);
  const created=await x.call('/v1/vehicle-pairings','POST',{});assert.equal(created.status,201);const c=created.data;
  assert.equal((await x.call(`/v1/vehicle-pairings/${c.id}/claim`,'POST',{},c.deviceToken)).status,202);
  assert.equal((await x.call(x.path+'/vehicle-pairings','POST',{code:c.code},x.passenger)).status,403);
  assert.equal((await x.call(x.path+'/vehicle-pairings','POST',{code:c.code},x.driver)).status,200);
  const grant=await x.call(`/v1/vehicle-pairings/${c.id}/claim`,'POST',{},c.deviceToken);assert.equal(grant.status,200);
  assert.equal(grant.data.origin,'https://localhost');assert.equal(grant.data.processingRegion,'검사 전용');
  const token=grant.data.vehicleToken;assert.equal(grant.data.session.inviteCode,undefined);
  assert.equal((await x.call(x.path,'GET',undefined,token)).status,200);
  assert.equal((await x.call('/v1/sessions','POST',{},token)).status,403);
  assert.equal((await x.call(x.path,'DELETE',undefined,token)).status,403);
  assert.equal((await x.call(x.path+'/vehicle-pairings','DELETE',undefined,token)).status,403);
  assert.equal((await x.call(x.path+'/location-consent','POST',{consent:true,expectedRevision:0},token)).status,403);
  assert.equal((await x.compare(await x.input(),token)).status,200);assert.equal(x.calls(),7);
  assert.equal((await x.call(`/v1/vehicle-pairings/${c.id}/claim`,'POST',{},c.deviceToken)).status,409);
  assert.equal((await x.call(x.path+'/vehicle-pairings','DELETE',undefined,x.driver)).status,200);
  assert.equal((await x.call(x.path,'GET',undefined,token)).status,403);
});
test('vehicle revocation aborts an in-flight comparison and discards late data',async t=>{
  let started,release,signal;const dispatched=new Promise(resolve=>started=resolve);
  const x=await setup(t,{pairing:true,route:r=>{signal=r.signal;started();return new Promise(resolve=>release=resolve);}});
  const c=(await x.call('/v1/vehicle-pairings','POST',{})).data;
  await x.call(x.path+'/vehicle-pairings','POST',{code:c.code},x.driver);
  const token=(await x.call(`/v1/vehicle-pairings/${c.id}/claim`,'POST',{},c.deviceToken)).data.vehicleToken;
  const pending=x.compare(await x.input(),token);await dispatched;
  assert.equal((await x.call(x.path+'/vehicle-pairings','DELETE',undefined,x.driver)).status,200);
  assert.equal((await pending).status,409);assert.equal(signal.aborted,true);assert.equal(x.store.routeJobs.size,0);
  release({distanceMeters:1,durationSeconds:1});
});
test('pairing enforces origin, strict bodies, short code possession limits and live catalog review',async t=>{
  const x=await setup(t,{pairing:true});
  assert.equal((await x.call('/v1/vehicle-pairings','POST',{},undefined,{headers:{Origin:'https://other.example'}})).status,403);
  assert.equal((await x.call('/v1/vehicle-pairings','POST',{url:'https://other.example'})).status,400);
  const c=(await x.call('/v1/vehicle-pairings','POST',{})).data;
  assert.equal((await x.call(`/v1/vehicle-pairings/${c.id}/claim`,'POST',{},c.code)).status,403);
  assert.equal((await x.call(`/v1/vehicle-pairings/${c.id}/claim`,'POST',{sessionId:x.id},c.deviceToken)).status,400);
  await x.call(x.path+'/vehicle-pairings','POST',{code:c.code},x.driver);
  x.raw.entries[0].review.status='pending';x.catalog.replace(x.raw);
  assert.equal((await x.call(`/v1/vehicle-pairings/${c.id}/claim`,'POST',{},c.deviceToken)).data.error,'CANDIDATE_NOT_REVIEWED');
  assert.equal(x.store.read(x.id,x.driver).vehicleConnected,false);assert.equal(x.calls(),0);
});
test('pairing creation rate limit never prevents owner revocation',async t=>{
  const x=await setup(t,{pairing:true});
  for(let i=0;i<10;i++)assert.equal((await x.call('/v1/vehicle-pairings','POST',{})).status,201);
  assert.equal((await x.call('/v1/vehicle-pairings','POST',{})).status,429);
  assert.equal((await x.call(x.path+'/vehicle-pairings','DELETE',undefined,x.driver)).status,200);
});

test('authenticated routing disclosure is absent in sharing-only mode and cannot authorize a hidden opt-in',async t=>{
  const x=await setup(t,{enabled:false});
  assert.equal((await x.call('/health')).data.passengerRoutingConsent,undefined);
  assert.equal((await x.call(x.path+'/routing-disclosure','GET',undefined,x.passenger)).status,404);
  const revision=(await x.call(x.path,'GET',undefined,x.passenger)).data.locationShare.revision;
  assert.equal((await x.call(x.path+'/location-consent','POST',{consent:true,expectedRevision:revision,routingProvider:'tmap'},x.passenger)).data.error,'ROUTING_CONSENT_UNAVAILABLE');
  assert.equal(x.calls(),0);
});
test('routing disclosure requires passenger access and consent binds the displayed revision',async t=>{
  const x=await setup(t,{passengerConsent:false});const endpoint=x.path+'/routing-disclosure';
  assert.equal((await x.call('/health')).data.passengerRoutingConsent,true);
  assert.equal((await x.call(endpoint)).status,401);
  assert.equal((await x.call(endpoint,'GET',undefined,x.driver)).status,403);
  assert.equal((await x.call(endpoint,'GET',undefined,x.passenger,{headers:{Origin:'https://elsewhere.test'}})).status,403);
  assert.equal((await x.call(endpoint,'POST',{},x.passenger)).status,405);
  const reply=await x.call(endpoint,'GET',undefined,x.passenger);assert.equal(reply.headers['cache-control'],'no-store');
  assert.equal(reply.data.origin,'https://localhost');assert.equal(reply.data.processingRegion,'검사 전용');assert.match(reply.data.id,/^[a-f0-9]{64}$/);
  assert.ok(!JSON.stringify(reply.data).includes(x.passenger));
  const revision=(await x.call(x.path,'GET',undefined,x.passenger)).data.locationShare.revision;
  for(const id of [undefined,'old-id'])assert.equal((await x.call(x.path+'/location-consent','POST',{consent:true,expectedRevision:revision,routingProvider:'tmap',routingDisclosureId:id},x.passenger)).data.error,'ROUTING_DISCLOSURE_CHANGED');
  assert.equal((await x.call(x.path+'/location-consent','POST',{consent:true,expectedRevision:revision,routingDisclosureId:reply.data.id},x.passenger)).status,400);
  const grant=await x.call(x.path+'/location-consent','POST',{consent:true,expectedRevision:revision,routingProvider:'tmap',routingDisclosureId:reply.data.id},x.passenger);
  assert.equal(grant.status,200);assert.equal(grant.data.routingProvider,'tmap');assert.equal(x.calls(),0);
});
test('passenger client optional consent and withdrawal cancel a live HTTPS comparison',async t=>{
  const {ShareClient}=await import('../public/share-client.mjs');const {randomUUID}=await import('node:crypto');
  let started,release,signal;const dispatched=new Promise(resolve=>started=resolve);
  const x=await setup(t,{passengerConsent:false,route:request=>{signal=request.signal;started();return new Promise(resolve=>release=resolve);}});
  const now=(await x.input()).driver.observedAt;
  const call=async(action,method='GET',body)=>{const reply=await x.call(x.path+action,method,body,x.passenger);if(reply.status!==200)throw Object.assign(new Error('TEST_HTTP_ERROR'),{status:reply.status});return reply.data;};
  const session=await call('');const saved=[];
  const api={origin:'https://localhost',routingDisclosure:()=>call('/routing-disclosure'),read:()=>call(''),
    grant:body=>call('/location-consent','POST',body),update:body=>call('/passenger-location','PUT',body),withdraw:body=>call('/location-consent','DELETE',body)};
  const client=new ShareClient({api,credentials:{id:x.id,token:x.passenger,expiresAt:session.expiresAt},now:()=>now,newId:randomUUID,save:value=>saved.push(value)});
  const disclosure=await client.loadRoutingDisclosure();assert.ok(disclosure);
  assert.equal(await client.start({consent:true,routingConsent:true,disclosureId:disclosure.id}),true);
  client.push({point:exampleTrip().passenger,observedAt:now,accuracyMeters:12,source:'browser',consent:true,validUntil:now+30000});
  await eventually(()=>client.state.status==='sharing');
  const pending=x.compare(await x.input());await dispatched;await client.stop();
  assert.equal((await pending).status,409);assert.equal(signal.aborted,true);assert.equal(x.store.routeJobs.size,0);
  assert.equal(client.state.status,'stopped');assert.equal(client.state.routingProvider,null);assert.equal(x.store.livePassengerInput(x.id,x.driver).fix,null);
  release({distanceMeters:1,durationSeconds:1});assert.ok(saved.every(value=>!JSON.stringify(value).includes('routingProvider')));
});
test('disclosure configuration cannot be enabled without direct TLS routes or disagree with vehicle region',async t=>{
  const x=await setup(t);
  assert.throws(()=>createLiveApp({tls,publicOrigin:'https://localhost',driverKey:'a'.repeat(43),store:x.store,routingDisclosure:{processingRegion:'검사'}}),e=>e.code==='DIRECT_TLS_DISCLOSURE_ONLY');
  assert.throws(()=>createLiveApp({tls,publicOrigin:'https://localhost',driverKey:'a'.repeat(43),store:x.store,routeProvider:x.provider,
    routingDisclosure:{processingRegion:'A'},vehiclePairing:{processingRegion:'B',candidateIds:['a']}}),e=>e.code==='DISCLOSURE_REGION_MISMATCH');
});
