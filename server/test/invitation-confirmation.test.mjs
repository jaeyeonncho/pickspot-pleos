import test from 'node:test';
import assert from 'node:assert/strict';
import {routingDisclosure} from '../routing-disclosure.mjs';
import {setImmediate as nextTurn} from 'node:timers/promises';

let run=0;
async function page(t,hash='#join=ABCDEF123456',{routing=false,storedValue=null}={}) {
  const elements=new Map(),events=new Map(),calls=[],stored=new Map();let gpsCalls=0;const expiresAt=Date.now()+60000;let revision=0,provider=null;
  if(storedValue)stored.set('pickspot-live-share',JSON.stringify({...storedValue,expiresAt}));
  const element=id=>{
    if(!elements.has(id))elements.set(id,{hidden:false,disabled:false,checked:false,value:'',textContent:'',
      listeners:new Map(),addEventListener(type,fn){this.listeners.set(type,fn);},
      querySelector(){return {replaceChildren(){}};}});
    return elements.get(id);
  };
  const location={origin:routing?'https://routing.example.test':'https://pickspot-test.onrender.com',pathname:'/',search:'',hash};
  const globals={location,window:{location,isSecureContext:true,addEventListener:(type,fn)=>events.set(type,fn)},
    document:{hidden:false,getElementById:element,addEventListener:(type,fn)=>events.set(type,fn)},
    navigator:{geolocation:{watchPosition(){gpsCalls++;},clearWatch(){}}},
    history:{replaceState(){location.hash='';}},
    sessionStorage:{getItem:key=>stored.get(key)??null,setItem:(key,value)=>stored.set(key,value),removeItem:key=>stored.delete(key)}};
  for(const [name,value] of Object.entries(globals)) {
    const old=Object.getOwnPropertyDescriptor(globalThis,name);
    Object.defineProperty(globalThis,name,{configurable:true,writable:true,value});
    t.after(()=>old?Object.defineProperty(globalThis,name,old):delete globalThis[name]);
  }
  t.mock.method(globalThis,'setInterval',()=>0);
  t.mock.method(globalThis,'clearInterval',()=>{});
  t.mock.method(globalThis,'fetch',async(url,options)=>{
    calls.push({url,method:options.method,body:options.body});
    if(url.endsWith('/health'))return Response.json({service:'pickspot-sharing',simulation:false,...(routing?{passengerRoutingConsent:true}:{})});
    if(url.endsWith('/v1/invitations/redeem'))return Response.json({session:{id:'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',expiresAt},passengerToken:'p'.repeat(43)});
    if(routing&&url.endsWith('/routing-disclosure'))return Response.json({...routingDisclosure(location.origin,{processingRegion:'검사 지역'}),expiresAt});
    if(routing&&url.endsWith('/location-consent')){
      const body=JSON.parse(options.body);
      if(options.method==='DELETE'){provider=null;revision++;return Response.json({status:'withdrawn',grantId:null});}
      provider=body.routingProvider??null;revision++;return Response.json({status:'waiting',grantId:'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',...(provider?{routingProvider:provider}:{})});
    }
    if(routing&&options.method==='GET'&&url.includes('/v1/sessions/'))return Response.json({isDemo:false,expiresAt,locationShare:{revision}});
    throw new Error('Unexpected request');
  });
  await import('../public/share-page.mjs?confirmation-test='+ ++run);
  return {element,location,calls,events,stored,gpsCalls:()=>gpsCalls,
    act:async(id,event)=>{element(id).listeners.get(event)({preventDefault(){}});await nextTurn();},
    hash:async value=>{location.hash=value;events.get('hashchange')();await nextTurn();}};
}

test('opening an invitation preserves the code until explicit participation, with location consent still separate',async t=>{
  const p=await page(t);
  assert.equal(p.calls.length,1);assert.ok(p.calls[0].url.endsWith('/health'));
  assert.equal(p.element('join-title').textContent,'이 픽업에 참가할까요?');
  assert.equal(p.element('code-fields').hidden,true);
  assert.equal(p.location.hash,'#join=ABCDEF123456');assert.equal(p.gpsCalls(),0);
  await p.act('join-form','submit');
  assert.equal(p.calls.length,2);assert.equal(JSON.parse(p.calls[1].body).code,'ABCDEF123456');
  assert.equal(p.location.hash,'');assert.equal(p.element('join-panel').hidden,true);
  assert.equal(p.element('share-consent').checked,false);assert.equal(p.element('share-start').disabled,true);assert.equal(p.gpsCalls(),0);
  await p.act('join-form','submit');assert.equal(p.calls.length,2);
});

test('changing links or returning to participation never consumes an invitation automatically',async t=>{
  const p=await page(t);
  await p.hash('#join=123456ABCDEF');
  assert.equal(p.calls.length,1);assert.equal(p.element('code').value,'123456ABCDEF');
  await p.act('another','click');assert.equal(p.calls.length,1);
  await p.act('join-form','submit');assert.equal(JSON.parse(p.calls[1].body).code,'123456ABCDEF');
});

test('switching to manual entry or an invalid link does not redeem the previous code',async t=>{
  const p=await page(t);
  await p.act('use-code','click');
  assert.equal(p.location.hash,'');assert.equal(p.element('code').value,'');assert.equal(p.element('code-fields').hidden,false);
  await p.hash('#join=invalid');assert.equal(p.calls.length,1);
  p.element('code').value='123456 abcdef';await p.act('join-form','submit');
  assert.equal(JSON.parse(p.calls[1].body).code,'123456ABCDEF');assert.equal(p.gpsCalls(),0);
});


test('page joins before loading routing disclosure and keeps both choices unchecked',async t=>{
  const p=await page(t,'#join=ABCDEF123456',{routing:true});assert.equal(p.calls.length,1);
  await p.act('join-form','submit');assert.equal(p.element('routing-consent-panel').hidden,false);
  assert.equal(p.element('share-consent').checked,false);assert.equal(p.element('routing-consent').checked,false);assert.equal(p.gpsCalls(),0);
  p.element('share-consent').checked=true;await p.act('share-consent','change');await p.act('share-start','click');
  const grant=p.calls.find(c=>c.method==='POST'&&c.url.endsWith('/location-consent'));
  assert.equal(JSON.parse(grant.body).routingProvider,undefined);assert.equal(p.gpsCalls(),1);
  await p.act('share-stop','click');
});
test('page explicitly opts in after disclosure, then withdrawal clears both choices and stops',async t=>{
  const p=await page(t,'#join=ABCDEF123456',{routing:true});await p.act('join-form','submit');
  p.element('share-consent').checked=true;p.element('routing-consent').checked=true;await p.act('routing-consent','change');
  assert.equal(p.gpsCalls(),0);assert.equal(p.calls.filter(c=>c.url.endsWith('/location-consent')).length,0);
  await p.act('share-start','click');
  const grant=JSON.parse(p.calls.find(c=>c.method==='POST'&&c.url.endsWith('/location-consent')).body);
  assert.equal(grant.routingProvider,'tmap');assert.match(grant.routingDisclosureId,/^[a-f0-9]{64}$/);
  assert.equal(p.element('routing-consent').disabled,true);assert.equal(p.element('routing-stop').hidden,false);
  await p.act('routing-stop','click');assert.equal(p.element('routing-consent').checked,false);assert.equal(p.element('share-consent').checked,false);
  assert.ok(p.calls.some(c=>c.method==='DELETE'&&c.url.endsWith('/location-consent')));
  assert.ok([...p.stored.values()].every(raw=>!raw.includes('routingProvider')&&!raw.includes('routingDisclosure')));
});
test('page restoration withdraws old consent before loading optional routing choice',async t=>{
  const p=await page(t,'',{routing:true,storedValue:{id:'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',token:'p'.repeat(43),routingProvider:'tmap'}});
  const deletion=p.calls.findIndex(c=>c.method==='DELETE'),disclosure=p.calls.findIndex(c=>c.url.endsWith('/routing-disclosure'));
  assert.ok(deletion>=0&&disclosure>deletion);assert.equal(p.element('routing-consent-panel').hidden,false);
  assert.equal(p.element('routing-consent').checked,false);assert.equal(p.element('share-consent').checked,false);assert.equal(p.gpsCalls(),0);
});


test('leaving the page revokes routing consent and reconnecting never opts back in',async t=>{
  const p=await page(t,'#join=ABCDEF123456',{routing:true});await p.act('join-form','submit');
  p.element('share-consent').checked=true;p.element('routing-consent').checked=true;await p.act('share-start','click');
  assert.equal(p.element('routing-stop').hidden,false);
  p.events.get('pagehide')();await nextTurn();
  assert.equal(p.element('routing-consent').checked,false);assert.equal(p.element('share-consent').checked,false);
  assert.ok(p.calls.some(c=>c.method==='DELETE'&&c.url.endsWith('/location-consent')));
  const grants=p.calls.filter(c=>c.method==='POST'&&c.url.endsWith('/location-consent')).length;
  p.events.get('online')();await nextTurn();
  assert.equal(p.calls.filter(c=>c.method==='POST'&&c.url.endsWith('/location-consent')).length,grants);assert.equal(p.gpsCalls(),1);
});
