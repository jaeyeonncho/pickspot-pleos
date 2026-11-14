import {RouteError,point,pickupCandidates} from '../routing/contract.mjs';
const fail=()=>{throw new RouteError('INVALID_CANDIDATE_CATALOG');};
const text=(s,max=500)=>typeof s==='string'&&s.trim().length>0&&s.length<=max&&!/[\u0000-\u001f\u007f]/.test(s);
const date=s=>typeof s==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(s)&&Number.isFinite(Date.parse(s))&&new Date(s).toISOString().slice(0,10)===s;
const url=s=>{try{const u=new URL(s);return u.protocol==='https:'&&!u.username&&!u.password;}catch{return false;}};
const nullablePoint=p=>p===null?null:point(p);
// Human research dates are Korean calendar days, not instants at UTC midnight.
const reviewCalendar=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Seoul',year:'numeric',month:'2-digit',day:'2-digit'});
const reviewDay=at=>{
  const parts=Object.fromEntries(reviewCalendar.formatToParts(at).map(p=>[p.type,p.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
};
// Curated records only. Validation does not infer permission from a parking POI,
// a road route, or lack of a restriction record. The raw catalog is not an API.
export function validateCatalog(raw) {
  if(raw?.schemaVersion!==1||!text(raw.region,100)||!Array.isArray(raw.entries)||raw.entries.length>1000)fail();
  const ids=new Set();
  const entries=raw.entries.map(e=>{
    if(!e||!text(e.id,40)||!/^[a-zA-Z0-9_-]+$/.test(e.id)||ids.has(e.id)||!text(e.name,100)||!text(e.address,200)||
       !Array.isArray(e.sources)||!e.sources.length||!['pending','reviewed','blocked'].includes(e.review?.status)||
       !['unknown','confirmed','prohibited'].includes(e.review.generalVehiclePickup)||
       !['unknown','connected','disconnected'].includes(e.review.meetingConnection)||
       !['unverified','permitted','restricted'].includes(e.review.dataUse)||
       !(e.review.checkedOn===null||date(e.review.checkedOn))||!(e.review.validUntil===null||date(e.review.validUntil))||
       !(e.review.conditions===null||text(e.review.conditions))||!Array.isArray(e.openQuestions)||!e.openQuestions.every(s=>text(s)))fail();
    ids.add(e.id);
    const sources=e.sources.map(s=>{
      if(!s||!text(s.publisher,100)||!url(s.url)||!date(s.checkedOn)||!(s.asOf===null||date(s.asOf))||!text(s.fact))fail();
      return {publisher:s.publisher,url:s.url,checkedOn:s.checkedOn,asOf:s.asOf,fact:s.fact};
    });
    return {id:e.id,name:e.name,address:e.address,vehiclePoint:nullablePoint(e.vehiclePoint),walkingPoint:nullablePoint(e.walkingPoint),
      sources,review:{status:e.review.status,generalVehiclePickup:e.review.generalVehiclePickup,
        meetingConnection:e.review.meetingConnection,dataUse:e.review.dataUse,checkedOn:e.review.checkedOn,
        validUntil:e.review.validUntil,conditions:e.review.conditions},openQuestions:[...e.openQuestions]};
  });
  return {schemaVersion:1,region:raw.region,entries};
}
function reasonsFor(e,at,today) {
  const reasons=[];
  if(!e.vehiclePoint)reasons.push('VEHICLE_ENTRANCE_MISSING');
  if(!e.walkingPoint)reasons.push('WALKING_ENTRANCE_MISSING');
  if(e.review.status!=='reviewed')reasons.push('REVIEW_INCOMPLETE');
  if(e.review.generalVehiclePickup!=='confirmed')reasons.push('PICKUP_USE_UNCONFIRMED');
  if(e.review.meetingConnection!=='connected')reasons.push('MEETING_CONNECTION_UNCONFIRMED');
  if(e.review.dataUse!=='permitted')reasons.push('DATA_USE_UNCONFIRMED');
  const checked=Date.parse(e.review.checkedOn),until=Date.parse(e.review.validUntil);
  // validUntil is exclusive UTC midnight, stated explicitly in the authoring guide.
  if(!Number.isFinite(checked)||!Number.isFinite(until)||e.review.checkedOn>today||until<=at||until<=checked)reasons.push('REVIEW_OUT_OF_DATE');
  if(!e.review.conditions)reasons.push('OPERATING_CONDITIONS_MISSING');
  if(e.openQuestions.length)reasons.push('OPEN_QUESTIONS');
  if(e.sources.some(s=>s.checkedOn>today||(s.asOf!==null&&s.asOf>s.checkedOn)))reasons.push('SOURCE_DATE_INVALID');
  return reasons;
}
export function auditCatalog(raw,{now=Date.now()}={}) {
  if(!Number.isSafeInteger(now)||now<=0||!Number.isFinite(new Date(now).getTime()))throw new RouteError('INVALID_CLOCK');
  const catalog=validateCatalog(raw),today=reviewDay(now);
  return {region:catalog.region,checkedAt:now,entries:catalog.entries.map(e=>{
    const reasons=reasonsFor(e,now,today);return {id:e.id,name:e.name,eligible:reasons.length===0,reasons};
  })};
}
// Returns provenance alongside route inputs, so UI adapters can show evidence
// without coupling layouts to this file. Call before any paid provider request.
export function selectReviewedCandidates(raw,ids,{now=Date.now()}={}) {
  const catalog=validateCatalog(raw),audit=auditCatalog(catalog,{now});
  if(!Array.isArray(ids)||ids.length<1||ids.length>3||new Set(ids).size!==ids.length)throw new RouteError('INVALID_CANDIDATES');
  const entries=ids.map(id=>{
    const entry=catalog.entries.find(e=>e.id===id),review=audit.entries.find(e=>e.id===id);
    if(!entry||!review.eligible)throw new RouteError('CANDIDATE_NOT_REVIEWED');
    return entry;
  });
  return {candidates:pickupCandidates(entries.map(e=>({id:e.id,point:e.vehiclePoint,walkingPoint:e.walkingPoint,curbStatus:'unknown'}))),
    validUntil:Math.min(...entries.map(e=>Date.parse(e.review.validUntil))),
    provenance:entries.map(e=>({id:e.id,name:e.name,address:e.address,sources:e.sources,review:e.review}))};
}
