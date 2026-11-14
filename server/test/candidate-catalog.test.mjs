import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {auditCatalog,validateCatalog,selectReviewedCandidates} from '../catalog/catalog.mjs';
const at=Date.parse('2026-11-14T12:00:00Z');
const pending=JSON.parse(await readFile(new URL('../catalog/yangjae-maebong.json',import.meta.url),'utf8'));
function reviewed() {
  const catalog=structuredClone(pending),e=catalog.entries[0];
  e.vehiclePoint={latitude:37.48,longitude:127.03};e.walkingPoint={latitude:37.4801,longitude:127.0301};
  // Reviewed fixtures have their own dates, independent of new real-world research.
  e.sources=[{publisher:'검사',url:'https://example.test/catalog',checkedOn:'2026-11-14',asOf:null,fact:'실제 장소가 아닌 검사 자료'}];
  e.review={status:'reviewed',generalVehiclePickup:'confirmed',meetingConnection:'connected',dataUse:'permitted',checkedOn:'2026-11-14',validUntil:'2026-11-15',conditions:'테스트 전용 조건. 실제 장소 확인 아님.'};e.openQuestions=[];
  return catalog;
}
test('checked-in pilot research cannot become route input without verified entrances and conditions',()=>{
  const audit=auditCatalog(pending,{now:at});assert.equal(audit.entries.length,3);
  for(const entry of audit.entries){assert.equal(entry.eligible,false);assert.ok(entry.reasons.includes('VEHICLE_ENTRANCE_MISSING'));}
  assert.throws(()=>selectReviewedCandidates(pending,['yangjae-parking'],{now:at}),e=>e.code==='CANDIDATE_NOT_REVIEWED');
});
test('reviewed input preserves separate entrances and provenance without asserting a designated curb',()=>{
  const raw=reviewed(),result=selectReviewedCandidates(raw,['yangjae-parking'],{now:at});
  assert.notDeepEqual(result.candidates[0].point,result.candidates[0].walkingPoint);
  assert.equal(result.candidates[0].curbStatus,'unknown');assert.equal(result.provenance[0].sources[0].asOf,null);
  assert.equal(result.validUntil,Date.parse('2026-11-15'));
  result.candidates[0].point.latitude=0;assert.equal(raw.entries[0].vehiclePoint.latitude,37.48);
});
test('a reviewed flag alone cannot bypass missing facts, restrictions or expiry',()=>{
  for(const mutate of [e=>e.vehiclePoint=null,e=>e.walkingPoint=null,e=>e.review.generalVehiclePickup='prohibited',
    e=>e.review.meetingConnection='disconnected',e=>e.review.dataUse='restricted',e=>e.review.status='blocked',
    e=>e.review.validUntil='2026-11-14',e=>e.review.checkedOn='2026-11-15',e=>e.review.conditions=null,
    e=>e.openQuestions=['미해결'],e=>e.sources[0].checkedOn='2026-11-15',e=>e.sources[0].asOf='2026-11-15']) {
    const raw=reviewed();mutate(raw.entries[0]);
    assert.throws(()=>selectReviewedCandidates(raw,['yangjae-parking'],{now:at}),e=>e.code==='CANDIDATE_NOT_REVIEWED');
  }
  assert.throws(()=>selectReviewedCandidates(reviewed(),['yangjae-parking'],{now:Date.parse('2026-11-15')}),e=>e.code==='CANDIDATE_NOT_REVIEWED');
});
test('malformed catalogs and ambiguous selections fail closed',()=>{
  for(const mutate of [r=>r.schemaVersion=2,r=>r.entries.push(r.entries[0]),r=>r.entries[0].vehiclePoint={latitude:91,longitude:127},
    r=>r.entries[0].sources[0].url='javascript:alert(1)',r=>r.entries[0].sources[0].url='https://user:password@example.test',
    r=>r.entries[0].sources[0].checkedOn='2026-02-30',r=>r.entries[0].review.generalVehiclePickup=true]) {
    const raw=reviewed();mutate(raw);assert.throws(()=>validateCatalog(raw));
  }
  for(const ids of [[],['yangjae-parking','yangjae-parking'],['unknown'],['yangjae-parking','eonju-parking']])assert.throws(()=>selectReviewedCandidates(reviewed(),ids,{now:at}));
  assert.throws(()=>auditCatalog(pending,{now:NaN}),e=>e.code==='INVALID_CLOCK');
  assert.throws(()=>auditCatalog(pending,{now:Number.MAX_SAFE_INTEGER}),e=>e.code==='INVALID_CLOCK');
});

test('Korean midnight accepts today research while still rejecting tomorrow and future source dates',()=>{
  const raw=reviewed(),e=raw.entries[0];
  e.review.checkedOn='2026-11-15';e.review.validUntil='2026-11-16';
  e.sources[0].checkedOn='2026-11-15';e.sources[0].asOf='2026-11-15';
  const before=Date.parse('2026-11-14T14:59:59.999Z'),midnight=before+1;
  const early=auditCatalog(raw,{now:before}).entries[0];
  assert.ok(early.reasons.includes('REVIEW_OUT_OF_DATE'));assert.ok(early.reasons.includes('SOURCE_DATE_INVALID'));
  assert.equal(auditCatalog(raw,{now:midnight}).entries[0].eligible,true);
  assert.equal(selectReviewedCandidates(raw,[e.id],{now:midnight}).validUntil,Date.parse('2026-11-16T00:00:00Z'));
  e.sources[0].asOf='2026-11-16';
  assert.ok(auditCatalog(raw,{now:midnight}).entries[0].reasons.includes('SOURCE_DATE_INVALID'));
  e.sources[0].asOf=null;e.sources[0].checkedOn='2026-11-16';e.review.checkedOn='2026-11-16';
  const future=auditCatalog(raw,{now:midnight}).entries[0];
  assert.ok(future.reasons.includes('REVIEW_OUT_OF_DATE'));assert.ok(future.reasons.includes('SOURCE_DATE_INVALID'));
});

test('Korean review calendar never extends the existing exclusive UTC expiry',()=>{
  const raw=reviewed(),e=raw.entries[0];e.review.checkedOn='2026-11-15';e.review.validUntil='2026-11-16';e.sources[0].checkedOn='2026-11-15';
  const expiry=Date.parse('2026-11-16T00:00:00Z');
  assert.equal(auditCatalog(raw,{now:expiry-1}).entries[0].eligible,true);
  assert.equal(auditCatalog(raw,{now:expiry}).entries[0].eligible,false);
  assert.throws(()=>selectReviewedCandidates(raw,[e.id],{now:expiry}),e=>e.code==='CANDIDATE_NOT_REVIEWED');
});
