import test from 'node:test';
import assert from 'node:assert/strict';
import {invitationLink,invitationCode} from '../public/invitation-link.mjs';
test('invitation uses only a fragment and reads a complete code',()=>{
  const url=new URL(invitationLink('https://pickspot-test.onrender.com','ABCDEF123456'));
  assert.equal(url.pathname,'/');assert.equal(url.search,'');
  assert.equal(invitationCode(url.hash),'ABCDEF123456');
  assert.equal(invitationCode('#join=abcdef123456'),'ABCDEF123456');
  assert.equal(invitationCode(''),null);
});
test('malformed or duplicate invitation fields never become redemption inputs',()=>{
  for(const hash of ['#join=','#!ABCDEF123456','#join=ABCDEF123456&join=123456ABCDEF','#join=ABCDEF123456&redirect=https://other.test','#join=%41BCDEF123456','#join=ABCDEF1234567'])assert.throws(()=>invitationCode(hash));
  assert.throws(()=>invitationLink('javascript:alert(1)','ABCDEF123456'));
  assert.throws(()=>invitationLink('https://example.test','not-a-code'));
});
