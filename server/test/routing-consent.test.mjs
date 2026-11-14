import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {SessionStore} from '../store.mjs';
import {ShareClient,restoreShare,shareView} from '../public/share-client.mjs';
import {readRoutingDisclosure,routingConsentView,renderRoutingConsent} from '../public/routing-consent.mjs';
import {routingDisclosure} from '../routing-disclosure.mjs';
const flush=()=>new Promise(resolve=>setImmediate(resolve));
function setup(t) {
  let now=1_800_000_000_000;
  const store=new SessionStore({locationMode:'live',now:()=>now,monotonic:()=>now});t.after(()=>store.dispose());
  const made=store.create(),passenger=store.redeem(made.session.inviteCode).passengerToken,id=made.session.id;
  const credentials={id,token:passenger,expiresAt:made.session.expiresAt},saved=[],calls=[];
  const metadata={...routingDisclosure('https://routing.example.test',{processingRegion:'검사 지역'}),expiresAt:credentials.expiresAt};
  const api={origin:metadata.origin,routingDisclosure:async()=>({...metadata}),read:async()=>store.read(id,passenger),
    grant:async body=>{calls.push(body);const {routingDisclosureId,...consent}=body;if(body.routingProvider==='tmap')assert.equal(routingDisclosureId,metadata.id);return store.grantLocation(id,passenger,consent);},
    update:async body=>store.updateLocation(id,passenger,body),withdraw:async body=>store.withdrawLocation(id,passenger,body)};
  let stopped=0;
  const options={api,credentials,now:()=>now,newId:randomUUID,save:value=>saved.push(value),stopCapture:()=>stopped++};
  const client=new ShareClient(options);
  const fix=()=>({point:{latitude:37.4859,longitude:127.0348},observedAt:now,accuracyMeters:12,source:'browser',consent:true,validUntil:now+30000});
  return {store,id,driver:made.driverToken,passenger,credentials,metadata,api,options,client,calls,saved,fix,stopped:()=>stopped,now:()=>now,advance:ms=>now+=ms};
}
test('disclosure binds version, origin and processing region and accepts no injected fields',()=>{
  const a=routingDisclosure('https://routing.example.test',{processingRegion:'검사 지역'});
  assert.equal(a.id,routingDisclosure(a.origin,{processingRegion:a.processingRegion}).id);
  assert.notEqual(a.id,routingDisclosure(a.origin,{processingRegion:'다른 지역'}).id);
  for(const config of [{},[],{processingRegion:'x',html:'injected'},{processingRegion:'x\n'},{processingRegion:'x'.repeat(101)}])assert.throws(()=>routingDisclosure(a.origin,config));
  const expiresAt=1_800_000_000_000;const valid={...a,expiresAt};
  assert.equal(readRoutingDisclosure({...valid,token:'ignore'},a.origin,expiresAt,expiresAt-1).token,undefined);
  for(const mutation of [{origin:'https://elsewhere.test'},{id:'wrong'},{version:'changed'},{routingProvider:'other'},{expiresAt:String(expiresAt)},{processingRegion:'x\n'}])assert.throws(()=>readRoutingDisclosure({...valid,...mutation},a.origin,expiresAt,expiresAt-1));
  assert.throws(()=>readRoutingDisclosure(valid,a.origin,expiresAt,expiresAt));
  assert.throws(()=>readRoutingDisclosure({...valid,origin:'http://localhost'},'http://localhost',expiresAt,expiresAt-1));
});
test('loading optional disclosure never grants consent or starts capture, and ordinary sharing stays separate',async t=>{
  const x=setup(t);await x.client.loadRoutingDisclosure();assert.equal(x.calls.length,0);assert.equal(x.client.state.status,'idle');
  assert.equal(await x.client.start({consent:true}),true);assert.equal(x.calls[0].routingProvider,undefined);
  assert.equal(x.calls[0].routingDisclosureId,undefined);assert.equal(x.client.state.routingProvider,null);
  x.client.push(x.fix());await flush();assert.equal(x.client.state.status,'sharing');assert.equal(x.store.livePassengerInput(x.id,x.driver).routingProvider,null);
  await x.client.stop();
});
test('routing needs separate explicit selection and the displayed disclosure before grant',async t=>{
  const x=setup(t);
  assert.equal(await x.client.start({consent:true,routingConsent:true,disclosureId:x.metadata.id}),false);
  const disclosure=await x.client.loadRoutingDisclosure();
  assert.equal(await x.client.start({consent:false,routingConsent:true,disclosureId:disclosure.id}),false);
  assert.equal(await x.client.start({consent:'true',routingConsent:true,disclosureId:disclosure.id}),false);
  assert.equal(await x.client.start({consent:true,routingConsent:true,disclosureId:'wrong'}),false);
  assert.equal(await x.client.start({consent:true,routingConsent:'true',disclosureId:disclosure.id}),false);
  assert.equal(x.calls.length,0);
  assert.equal(await x.client.start({consent:true,routingConsent:true,disclosureId:disclosure.id}),true);
  assert.equal(x.calls[0].routingProvider,'tmap');assert.equal(x.calls[0].routingDisclosureId,disclosure.id);
  x.client.push(x.fix());await flush();assert.equal(x.client.state.routingProvider,'tmap');assert.equal(x.store.livePassengerInput(x.id,x.driver).routingProvider,'tmap');
  assert.match(shareView(x.client.state,x.now()).copy,/TMAP/);await x.client.stop();
});
test('changed disclosure is rejected before any grant, including a reused id with different text',async t=>{
  for(const change of [{id:'f'.repeat(64)},{processingRegion:'변경 지역'}]){
    const x=setup(t),disclosure=await x.client.loadRoutingDisclosure();Object.assign(x.metadata,change);
    assert.equal(await x.client.start({consent:true,routingConsent:true,disclosureId:disclosure.id}),false);
    assert.equal(x.calls.length,0);assert.equal(x.client.state.status,'stopped');
  }
});
test('withdrawal clears location and route permission and a later ordinary restart cannot inherit routing',async t=>{
  const x=setup(t),disclosure=await x.client.loadRoutingDisclosure();
  await x.client.start({consent:true,routingConsent:true,disclosureId:disclosure.id});x.client.push(x.fix());await flush();
  const revision=x.store.read(x.id,x.driver).version;
  const stopping=x.client.stop();assert.equal(x.client.state.routingProvider,null);assert.equal(x.client.state.status,'stop-pending');assert.equal(x.stopped(),1);await stopping;
  const input=x.store.livePassengerInput(x.id,x.driver);assert.equal(input.routingProvider,null);assert.equal(input.fix,null);assert.ok(x.store.read(x.id,x.driver).version>revision);
  await x.client.start({consent:true});assert.equal(x.client.state.routingProvider,null);assert.equal(x.calls.at(-1).routingProvider,undefined);
  await x.client.stop();
});
test('reload never persists or restores route consent and revokes the old grant first',async t=>{
  const x=setup(t),disclosure=await x.client.loadRoutingDisclosure();
  await x.client.start({consent:true,routingConsent:true,disclosureId:disclosure.id});x.client.push(x.fix());await flush();
  const restored=new ShareClient({...x.options,credentials:{...x.credentials,routingProvider:'tmap',disclosureId:disclosure.id}});
  await restored.restore();assert.equal(x.store.livePassengerInput(x.id,x.driver).routingProvider,null);
  for(const saved of x.saved)assert.ok(!JSON.stringify(saved).match(/routingProvider|disclosureId|point|latitude/));
  const stored=restoreShare(JSON.stringify({...x.credentials,routingProvider:'tmap'}),x.now());assert.equal(stored.routingProvider,undefined);
  assert.equal(await restored.start({consent:true,routingConsent:true,disclosureId:disclosure.id}),false);
});
test('a late disclosure or late grant cannot reactivate after withdrawal',async t=>{
  const x=setup(t);let release;x.api.routingDisclosure=()=>new Promise(resolve=>release=resolve);
  const loading=x.client.loadRoutingDisclosure();await x.client.stop();release(x.metadata);assert.equal(await loading,null);
  const y=setup(t),disclosure=await y.client.loadRoutingDisclosure();let grantRelease;const grant=y.api.grant;
  y.api.grant=body=>new Promise((resolve,reject)=>grantRelease=()=>grant(body).then(resolve,reject));
  const starting=y.client.start({consent:true,routingConsent:true,disclosureId:disclosure.id});await flush();await y.client.stop();grantRelease();
  assert.equal(await starting,false);assert.equal(y.client.state.routingProvider,null);assert.equal(y.store.livePassengerInput(y.id,y.driver).routingProvider,null);
});
test('provider mismatch in a grant or upload acknowledgement stops instead of silently changing consent',async t=>{
  const x=setup(t);const grant=x.api.grant;x.api.grant=async body=>({...await grant(body),routingProvider:'tmap'});
  assert.equal(await x.client.start({consent:true}),false);assert.equal(x.client.state.status,'stopped');
  const y=setup(t),disclosure=await y.client.loadRoutingDisclosure();await y.client.start({consent:true,routingConsent:true,disclosureId:disclosure.id});
  const update=y.api.update;y.api.update=async body=>{const result=await update(body);delete result.routingProvider;return result;};
  y.client.push(y.fix());await flush();assert.equal(y.client.state.status,'stopped');assert.equal(y.store.livePassengerInput(y.id,y.driver).fix,null);
});
test('failed withdrawal blocks both consents and retry resends only the same deletion intent',async t=>{
  const x=setup(t),disclosure=await x.client.loadRoutingDisclosure();await x.client.start({consent:true,routingConsent:true,disclosureId:disclosure.id});
  const withdraw=x.api.withdraw;const requests=[];x.api.withdraw=async body=>{requests.push(body);throw new Error('offline');};await x.client.stop();
  assert.equal(await x.client.start({consent:true,routingConsent:true,disclosureId:disclosure.id}),false);
  x.api.withdraw=async body=>{requests.push(body);return withdraw(body);};await x.client.check();assert.deepEqual(requests[0],requests[1]);
  assert.equal(x.client.state.status,'stopped');assert.equal(x.calls.length,1);
});
test('optional UI defaults unchecked, locks choices while active and clears them after stop',()=>{
  const metadata={origin:'https://routing.example.test',processingRegion:'검사 지역'};
  const elements=new Map();const element=id=>{if(!elements.has(id))elements.set(id,{textContent:'',checked:false,hidden:false,disabled:false});return elements.get(id);};
  renderRoutingConsent(element,metadata,{status:'idle'});assert.equal(element('routing-consent').checked,false);assert.equal(element('routing-consent').disabled,false);assert.equal(element('routing-stop').hidden,true);
  element('routing-consent').checked=true;renderRoutingConsent(element,metadata,{status:'sharing',routingProvider:'tmap'});
  assert.equal(element('routing-consent').disabled,true);assert.equal(element('routing-stop').hidden,false);assert.match(element('routing-recipient').textContent,/https:\/\/routing.example.test/);
  renderRoutingConsent(element,metadata,{status:'stop-pending'});assert.equal(element('routing-consent').checked,false);assert.equal(element('routing-stop').hidden,true);
  renderRoutingConsent(element,null,{status:'idle'});assert.equal(element('routing-consent-panel').hidden,true);
  assert.equal(routingConsentView(metadata,{status:'sharing',routingProvider:null}).canWithdraw,false);
});
