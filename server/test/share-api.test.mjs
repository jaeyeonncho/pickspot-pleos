import test from 'node:test';
import assert from 'node:assert/strict';
import {ShareApi} from '../public/share-api.mjs';
import {sharingConfig} from '../sharing-config.mjs';

test('browser fetch keeps its native receiver and credentials stay in the authorization header',async()=>{
  const previous=globalThis.fetch;const seen=[];
  globalThis.fetch=function(url,options){assert.equal(this,globalThis);seen.push({url,options});return Promise.resolve(new Response(JSON.stringify({status:'withdrawn'})));};
  try {
    const api=new ShareApi({origin:'https://sharing.example',credentials:{id:'session',token:'private-test-token'}});
    await api.withdraw({operationId:'test-id'},{keepalive:true});
    assert.equal(seen[0].url,'https://sharing.example/v1/sessions/session/location-consent');
    assert.equal(seen[0].options.headers.Authorization,'Bearer private-test-token');assert.equal(seen[0].options.keepalive,true);
    assert.equal(seen[0].options.redirect,'error');assert.equal(seen[0].options.cache,'no-store');
    assert.ok(!seen[0].options.body.includes('private-test-token'));
  }finally{globalThis.fetch=previous;}
});
test('HTTP errors expose only status and code, not raw provider response bodies',async()=>{
  const api=new ShareApi({origin:'https://sharing.example',credentials:{id:'session',token:'test'},
    fetchImpl:async()=>new Response(JSON.stringify({error:'LOCATION_GRANT_CHANGED',details:'private detail'}),{status:409})});
  await assert.rejects(api.read(),e=>e.status===409&&e.code==='LOCATION_GRANT_CHANGED'&&e.message==='SHARING_REQUEST_FAILED'&&!JSON.stringify(e).includes('private detail'));
});
test('network timeout and external cancellation both abort in-flight transport',async()=>{
  const fetchImpl=(_url,{signal})=>new Promise((_,reject)=>{if(signal.aborted)reject(new Error('aborted'));else signal.addEventListener('abort',()=>reject(new Error('aborted')),{once:true});});
  const api=new ShareApi({origin:'https://sharing.example',credentials:{id:'session',token:'test'},timeoutMs:10,fetchImpl});
  await assert.rejects(api.read(),/aborted/);
  const controller=new AbortController();const read=api.read({signal:controller.signal});controller.abort();await assert.rejects(read,/aborted/);
});
test('incomplete or invalid sharing deployment settings cannot start a real server',async()=>{
  await assert.rejects(sharingConfig({}),/HTTPS_ORIGIN_REQUIRED/);
  await assert.rejects(sharingConfig({PICKSPOT_PUBLIC_ORIGIN:'https://sharing.example'}),/DRIVER_KEY_REQUIRED/);
  const env={PICKSPOT_PUBLIC_ORIGIN:'https://sharing.example',PICKSPOT_DRIVER_KEY:'a'.repeat(43)};
  await assert.rejects(sharingConfig({...env,PICKSPOT_SHARE_PORT:'0'}),/INVALID_PORT/);
  await assert.rejects(sharingConfig({...env,PICKSPOT_BIND_ADDRESS:'untrusted-host'}),/INVALID_BIND_ADDRESS/);
  await assert.rejects(sharingConfig(env),/TLS_FILES_REQUIRED/);
});
