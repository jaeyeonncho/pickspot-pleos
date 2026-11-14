import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,chmod,symlink,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import https from 'node:https';
import {routingConfiguration,createRoutingOptions} from '../routing-config.mjs';
import {checkRoutingSetup,routingSetupError} from '../check-routing-setup.mjs';
import {prepareRoutingServer} from '../routing-server.mjs';
const exec=promisify(execFile);
let certDir,tls;
before(async()=>{
  certDir=await mkdtemp(join(tmpdir(),'pickspot-routing-cert-'));
  const key=join(certDir,'key.pem'),cert=join(certDir,'cert.pem');
  await exec('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',key,'-out',cert,'-days','1','-subj','/CN=localhost','-addext','subjectAltName=DNS:localhost']);
  tls={key:await readFile(key),cert:await readFile(cert)};
});
after(async()=>{await rm(certDir,{recursive:true,force:true});});
async function setup(t) {
  const dir=await mkdtemp(join(tmpdir(),'pickspot-routing-config-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const envPath=join(dir,'.env.routing.local'),sourcePath=join(dir,'.env.provider'),catalogPath=join(dir,'catalog.json');
  await writeFile(join(dir,'key.pem'),tls.key,{mode:0o600});await writeFile(join(dir,'cert.pem'),tls.cert);
  const env={PICKSPOT_ROUTING_MODE:'direct-tls',PICKSPOT_PUBLIC_ORIGIN:'https://localhost',PICKSPOT_PROCESSING_REGION:'검사 지역',
    PICKSPOT_DRIVER_KEY:'d'.repeat(43),PICKSPOT_TLS_CERT_FILE:'cert.pem',PICKSPOT_TLS_KEY_FILE:'key.pem',PICKSPOT_SHARE_PORT:'8443',
    PICKSPOT_BIND_ADDRESS:'127.0.0.1',PICKSPOT_CANDIDATE_FILE:'catalog.json',PICKSPOT_CANDIDATE_IDS:'reviewed-test',PICKSPOT_TMAP_ENV_FILE:'.env.provider'};
  const raw={schemaVersion:1,region:'검사 자료',entries:[{id:'reviewed-test',name:'검사 후보',address:'실제 장소 아님',
    vehiclePoint:{latitude:37.4859,longitude:127.0348},walkingPoint:{latitude:37.4859,longitude:127.0348},
    sources:[{publisher:'검사',url:'https://example.test/source',checkedOn:'2026-01-01',asOf:null,fact:'고정 검사 자료'}],
    review:{status:'reviewed',generalVehiclePickup:'confirmed',meetingConnection:'connected',dataUse:'permitted',checkedOn:'2026-01-01',validUntil:'2030-01-01',conditions:'검사 전용'},openQuestions:[]}]};
  const writeEnv=async(value=env)=>{await writeFile(envPath,Object.entries(value).map(([k,v])=>`${k}=${v}`).join('\n')+'\n',{mode:0o600});await chmod(envPath,0o600);};
  const writeSource=async(text='TMAP_APP_KEY=provider-test-secret\nTMAP_DAILY_CALL_LIMIT=7\nUNRELATED_SECRET=do-not-copy\n')=>{await writeFile(sourcePath,text,{mode:0o600});await chmod(sourcePath,0o600);};
  const writeCatalog=async(value=raw)=>writeFile(catalogPath,JSON.stringify(value));
  await writeEnv();await writeSource();await writeCatalog();
  return {dir,envPath,env,sourcePath,catalogPath,raw,writeEnv,writeSource,writeCatalog};
}
test('missing profile reports research readiness without revealing paths or opening a server',async t=>{
  const x=await setup(t);const result=await checkRoutingSetup({envPath:join(x.dir,'not-present')});
  assert.equal(result.configurationReady,false);assert.equal(result.code,'ROUTING_ENV_MISSING');assert.equal(result.externalRequests,0);assert.equal(result.listenerOpened,false);
  assert.equal(result.catalog.source,'project-default');assert.equal(result.catalog.registered,3);assert.equal(result.catalog.eligible,0);
  assert.ok(!JSON.stringify(result).includes(x.dir));
});
test('valid setup only reads the shared ledger and returns no secrets, paths or coordinates',async t=>{
  const x=await setup(t),config=await routingConfiguration({envPath:x.envPath});
  let before;try{before=await readFile(config.budget.filePath);}catch(error){if(error.code!=='ENOENT')throw error;}
  const report=await checkRoutingSetup({envPath:x.envPath});
  assert.equal(report.configurationReady,true);assert.equal(report.budget.batchCalls,3);assert.equal(report.budget.advisory,true);
  assert.equal(report.scope,'loopback');assert.equal(report.catalog.selected,1);assert.equal(report.providerRequests,0);
  const serialized=JSON.stringify(report);
  for(const secret of ['provider-test-secret','do-not-copy','d'.repeat(43),x.dir,'latitude','longitude','BEGIN PRIVATE KEY'])assert.ok(!serialized.includes(secret));
  let after;try{after=await readFile(config.budget.filePath);}catch(error){if(error.code!=='ENOENT')throw error;}
  assert.deepEqual(after,before);assert.equal(config.appKey,'provider-test-secret');assert.equal(config.UNRELATED_SECRET,undefined);
});
test('profile denies symlinks, public permissions, duplicate fields and misspelled fields',async t=>{
  const x=await setup(t);const link=join(x.dir,'linked-env');await symlink(x.envPath,link);
  await assert.rejects(routingConfiguration({envPath:link}),/ROUTING_ENV_UNREADABLE/);
  await chmod(x.envPath,0o644);await assert.rejects(routingConfiguration({envPath:x.envPath}),/ROUTING_ENV_PERMISSIONS/);
  await x.writeEnv();await writeFile(x.envPath,(await readFile(x.envPath,'utf8'))+'PICKSPOT_CANDIDATE_IDS=other\n');
  await assert.rejects(routingConfiguration({envPath:x.envPath}),/ROUTING_ENV_DUPLICATED/);
  await x.writeEnv({...x.env,TMAP_APP_KEY:'wrong-place'});await assert.rejects(routingConfiguration({envPath:x.envPath}),/ROUTING_ENV_UNKNOWN_FIELD/);
});
test('provider settings are explicit, private, bounded and do not inherit process secrets',async t=>{
  const x=await setup(t);
  await chmod(x.sourcePath,0o644);await assert.rejects(routingConfiguration({envPath:x.envPath}),/TMAP_ENV_PERMISSIONS/);
  await x.writeSource('TMAP_APP_KEY=one\nTMAP_APP_KEY=two\nTMAP_DAILY_CALL_LIMIT=7\n');await assert.rejects(routingConfiguration({envPath:x.envPath}),/TMAP_ENV_DUPLICATED/);
  await x.writeSource('TMAP_DAILY_CALL_LIMIT=7\n');await assert.rejects(routingConfiguration({envPath:x.envPath}),/TMAP_KEY_REQUIRED/);
  await x.writeSource('x'.repeat(16385));await assert.rejects(routingConfiguration({envPath:x.envPath}),/TMAP_ENV_INVALID/);
});
test('daily limit is never raised and must fit the selected full batch',async t=>{
  const x=await setup(t);
  for(const limit of ['0','2','bad']){
    await x.writeSource(`TMAP_APP_KEY=test\nTMAP_DAILY_CALL_LIMIT=${limit}\n`);
    await assert.rejects(routingConfiguration({envPath:x.envPath}),new RegExp(limit==='bad'?'ROUTE_BUDGET_CONFIG_INVALID':'ROUTE_BATCH_BUDGET_REQUIRED'));
  }
});
test('missing mode, region, candidate IDs and provider reference fail before opening anything',async t=>{
  const x=await setup(t);
  for(const [field,value,error] of [['PICKSPOT_ROUTING_MODE','render-free','ROUTING_MODE_REQUIRED'],['PICKSPOT_PROCESSING_REGION','','PROCESSING_REGION_REQUIRED'],
    ['PICKSPOT_CANDIDATE_IDS','a,a','CANDIDATE_IDS_REQUIRED'],['PICKSPOT_CANDIDATE_IDS','','CANDIDATE_IDS_REQUIRED'],['PICKSPOT_TMAP_ENV_FILE','','TMAP_ENV_REQUIRED']]){
    await x.writeEnv({...x.env,[field]:value});const report=await checkRoutingSetup({envPath:x.envPath});assert.equal(report.configurationReady,false);assert.equal(report.code,error);
  }
});
test('unreviewed, expired and malformed catalogs never become executable options',async t=>{
  const x=await setup(t);x.raw.entries[0].review.status='pending';await x.writeCatalog();
  await assert.rejects(prepareRoutingServer({envPath:x.envPath}),/CANDIDATE_NOT_REVIEWED/);
  x.raw.entries[0].review.status='reviewed';x.raw.entries[0].review.validUntil='2026-01-02';await x.writeCatalog();
  await assert.rejects(routingConfiguration({envPath:x.envPath}),/CANDIDATE_NOT_REVIEWED/);
  await writeFile(x.catalogPath,'{');await assert.rejects(routingConfiguration({envPath:x.envPath}),/INVALID_CANDIDATE_CATALOG/);
});
test('configuration cannot bypass certificate identity or private-key file permissions',async t=>{
  const x=await setup(t);await x.writeEnv({...x.env,PICKSPOT_PUBLIC_ORIGIN:'https://different.example.test'});
  assert.equal((await checkRoutingSetup({envPath:x.envPath})).code,'TLS_CERTIFICATE_HOST_MISMATCH');
  await x.writeEnv();await chmod(join(x.dir,'key.pem'),0o644);
  assert.equal((await checkRoutingSetup({envPath:x.envPath})).code,'TLS_KEY_MUST_BE_PRIVATE');
});
test('options recheck candidate expiry and construction cannot eagerly call a provider',async t=>{
  const x=await setup(t),config=await routingConfiguration({envPath:x.envPath});let calls=0;
  const options=createRoutingOptions(config,{fetchImpl:()=>{calls++;throw new Error('unexpected');}});assert.equal(calls,0);options.store.dispose();
  assert.throws(()=>createRoutingOptions(config,{now:()=>config.selection.validUntil}),e=>e.code==='CANDIDATE_REVIEW_EXPIRED');
});
test('prepared server connects pairing and passenger disclosure over verified local TLS without provider requests',async t=>{
  const x=await setup(t);let calls=0;
  const prepared=await prepareRoutingServer({envPath:x.envPath,fetchImpl:()=>{calls++;throw new Error('no external calls');}});
  const server=prepared.server;assert.equal(server.listening,false);assert.equal(prepared.host,'127.0.0.1');assert.equal(prepared.port,8443);
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}));
  const request=(path,method='GET',body,token)=>new Promise((resolve,reject)=>{
    const bytes=body===undefined?undefined:JSON.stringify(body);
    const req=https.request({hostname:'127.0.0.1',port:server.address().port,servername:'localhost',ca:tls.cert,path,method,
      headers:{Host:'localhost',Origin:'https://localhost',...(bytes?{'Content-Type':'application/json'}:{}),...(token?{Authorization:`Bearer ${token}`}:{})}},res=>{
      const parts=[];res.on('data',part=>parts.push(part));res.on('end',()=>resolve({status:res.statusCode,value:JSON.parse(Buffer.concat(parts).toString())}));
    });req.on('error',reject);req.end(bytes);
  });
  const health=(await request('/health')).value;assert.equal(health.passengerRoutingConsent,true);assert.equal(health.vehiclePairing,true);assert.equal(health.routeReady,false);
  const made=(await request('/v1/sessions','POST',{},x.env.PICKSPOT_DRIVER_KEY)).value;
  const joined=(await request('/v1/invitations/redeem','POST',{code:made.session.inviteCode})).value;
  const disclosure=(await request(`/v1/sessions/${made.session.id}/routing-disclosure`,'GET',undefined,joined.passengerToken)).value;
  assert.equal(disclosure.processingRegion,'검사 지역');assert.equal(disclosure.origin,'https://localhost');
  const pairing=await request('/v1/vehicle-pairings','POST',{});assert.equal(pairing.status,201);assert.equal(calls,0);
});
test('CLI requires an explicit action and sanitizes unknown error messages',async()=>{
  for(const args of [[],['--unknown'],['--serve','--check']]){
    const result=await exec(process.execPath,['server/routing-server.mjs',...args],{cwd:new URL('../..',import.meta.url),env:{...process.env,TMAP_APP_KEY:'never-output'}}).then(()=>null,error=>error);
    assert.equal(result.code,1);assert.match(result.stderr,/EXPLICIT_ROUTING_MODE_REQUIRED/);assert.ok(!result.stderr.includes('never-output'));
  }
  assert.deepEqual(routingSetupError(new Error('provider-secret /private/path')),{code:'ROUTING_SETUP_FAILED',message:'경로 서버 설정을 확인하지 못했어요. 비밀 값은 출력하지 않았어요.'});
});
