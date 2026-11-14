import test from 'node:test';
import assert from 'node:assert/strict';
import {setImmediate as nextTurn} from 'node:timers/promises';
import {BrowserLocation} from '../public/browser-location.mjs';
import {ShareClient} from '../public/share-client.mjs';
// Browser timer functions reject application objects as receivers. Node's normal
// timers do not, so injected fake timers alone missed this browser-only failure.
function nativeLike(callback){return function(...args){if(this!==undefined&&this!==globalThis)throw new TypeError('Illegal invocation');return callback(...args);};}
test('default browser polling timers preserve the platform receiver on start and cleanup',t=>{
  let watched=0,cleared=0;
  t.mock.method(globalThis,'setInterval',nativeLike(()=>17));
  t.mock.method(globalThis,'clearInterval',nativeLike(id=>{assert.equal(id,17);cleared++;}));
  const capture=new BrowserLocation({secure:true,geolocation:{watchPosition(){watched++;return 0;},clearWatch(){}}});
  capture.start({consent:true});assert.equal(watched,1);assert.equal(capture.snapshot().status,'requesting');
  capture.stop();assert.equal(cleared,1);assert.equal(capture.snapshot().active,false);
});
test('default browser send scheduling and cancellation preserve the platform receiver',async t=>{
  let scheduled=0,cleared=0;
  t.mock.method(globalThis,'setTimeout',nativeLike(()=>{scheduled++;return 18;}));
  t.mock.method(globalThis,'clearTimeout',nativeLike(id=>{assert.equal(id,18);cleared++;}));
  const id='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  const client=new ShareClient({credentials:{id,token:'test',expiresAt:Date.now()+60000},api:{
    read:async()=>({isDemo:false,locationShare:{revision:0}}),grant:async()=>({status:'waiting',grantId:id}),
    update:async input=>({status:'ready',grantId:id,sequence:input.sequence,validUntil:Date.now()+30000}),
    withdraw:async()=>({status:'withdrawn',grantId:null})}});
  await client.start({consent:true});
  const fix=()=>({point:{latitude:37.4859,longitude:127.0348},observedAt:Date.now(),accuracyMeters:12,source:'browser',consent:true,validUntil:Date.now()+30000});
  client.push(fix());await nextTurn();client.push(fix());assert.equal(scheduled,1);
  await client.stop();assert.equal(cleared,1);assert.equal(client.state.status,'stopped');
});
