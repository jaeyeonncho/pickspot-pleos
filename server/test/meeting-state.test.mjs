import test from 'node:test';
import assert from 'node:assert/strict';
import {meetingView} from '../public/meeting-state.mjs';
const session=()=>({candidates:[{id:'a',name:'A'}],selection:{candidateId:'a',navigationStatus:'confirmed'},route:{status:'ready',validUntil:2000}});
test('passenger sees successful navigation only while route metrics are current',()=>{
  const view=meetingView(session(),1000);assert.equal(view.candidate.name,'A');assert.equal(view.status,'confirmed');
  const expired=meetingView(session(),2000);assert.equal(expired.candidate,null);assert.equal(expired.status,null);assert.equal(expired.stale,true);
});
test('recalculation and route failures suppress a previously selected destination',()=>{
  for(const status of ['calculating','failed','stale']){
    const s=session();s.route.status=status;const view=meetingView(s,1000);assert.equal(view.candidate,null);assert.equal(view.status,null);
  }
});
test('unknown candidate or missing validity never claims navigation success',()=>{
  const s=session();s.selection.candidateId='gone';assert.equal(meetingView(s,1000).status,null);
  s.selection.candidateId='a';delete s.route.validUntil;assert.equal(meetingView(s,1000).candidate,null);
});
test('selected point and failed navigation remain distinct',()=>{
  const s=session();s.selection.navigationStatus='failed';const view=meetingView(s,1000);
  assert.equal(view.candidate.id,'a');assert.equal(view.status,'failed');assert.match(view.title,/다시 확인/);
});
