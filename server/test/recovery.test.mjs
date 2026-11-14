import test from 'node:test';
import assert from 'node:assert/strict';
import {ConnectionRecovery,restoreCredentials} from '../public/recovery.mjs';
test('recovery backs off to 15 seconds and resets after success',()=>{
 const r=new ConnectionRecovery();assert.equal(r.connected,false);
 for(const delay of [1000,2000,4000,8000,15000,15000]){r.failure();assert.equal(r.delay,delay);assert.equal(r.connected,false);}
 r.success();assert.equal(r.connected,true);assert.equal(r.delay,3000);r.failure();assert.equal(r.delay,1000);
});
test('credentials restore only matching unexpired session data and end intent',()=>{
 const c={id:'f'.repeat(36),token:'x'.repeat(43),expiresAt:101,ending:true,extra:'not retained'};
 assert.deepEqual(restoreCredentials(JSON.stringify(c),100),{id:c.id,token:c.token,expiresAt:101,ending:true});
 assert.equal(restoreCredentials(JSON.stringify(c),101),null);
 for(const raw of ['broken','null','{}',JSON.stringify({...c,id:'../../secret'}),JSON.stringify({...c,token:'bad'})])assert.equal(restoreCredentials(raw,100),null);
});
