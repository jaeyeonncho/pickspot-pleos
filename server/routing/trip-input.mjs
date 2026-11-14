import {RouteError, point, routePoint, routeWaypoints, MAX_ROUTE_WAYPOINTS, pickupCandidates, checkAbort, abortable} from './contract.mjs';
import {estimatePickupRoutes} from './estimate.mjs';
import {routeContextExpiry} from './route-context.mjs';
import {LOCATION_POLICY} from '../shared/location-policy.mjs';
import {drivePreference,requireDrivePreference} from './drive-preference.mjs';
export {LOCATION_POLICY} from '../shared/location-policy.mjs';

const fail = code => { throw new RouteError(code); };
const timestamp = value => Number.isSafeInteger(value) && value > 0;
const freeze = value => {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
};

function normalize(input, at) {
  if (!timestamp(at)) fail('INVALID_CLOCK');
  if (!input || !['example','live'].includes(input.mode)) fail('INVALID_INPUT_MODE');
  if (!timestamp(input.expiresAt) || input.expiresAt <= at) fail('TRIP_EXPIRED');
  if (!input.destination) fail('DESTINATION_REQUIRED');
  const name=input.destination.name;
  if (typeof name !== 'string' || !name.trim() || name.length>100 || /[\u0000-\u001f\u007f]/.test(name)) fail('INVALID_DESTINATION');
  let validUntil=input.expiresAt;
  const location = (fix,role) => {
    if (!fix || fix.consent !== true) fail('LOCATION_CONSENT_REQUIRED');
    const source=input.mode==='example'?'example':role==='driver'?'vehicle':'browser';
    if (fix.source !== source) fail('LOCATION_SOURCE_MISMATCH');
    const p=point(fix.point);
    if (!timestamp(fix.observedAt) || fix.observedAt-at>LOCATION_POLICY.futureToleranceMs) fail('INVALID_LOCATION_TIME');
    const age=Math.max(0,at-fix.observedAt);
    if (age>=LOCATION_POLICY.maxAgeMs) fail('LOCATION_STALE');
    if (input.mode==='live' && (!Number.isFinite(fix.accuracyMeters) || fix.accuracyMeters<=0 || fix.accuracyMeters>LOCATION_POLICY.maxAccuracyMeters)) {
      fail('LOCATION_ACCURACY_REQUIRED');
    }
    validUntil=Math.min(validUntil,at+LOCATION_POLICY.maxAgeMs-age);
    return p;
  };
  const driver=location(input.driver,'driver'),passenger=location(input.passenger,'passenger');
  const candidates=pickupCandidates(input.candidates);
  // An omitted live itinerary is unknown, not evidence that the driver has no stops.
  if (input.mode==='live' && input.waypoints===undefined) fail('ORIGINAL_WAYPOINTS_REQUIRED');
  const routeValidUntil=routeContextExpiry(input.routeObservedAt,at,{required:input.mode==='live'});
  const expiryIssue=routeValidUntil!==null && routeValidUntil<validUntil ? 'ROUTE_CONTEXT_STALE' : 'LOCATION_STALE';
  if(routeValidUntil!==null)validUntil=Math.min(validUntil,routeValidUntil);
  const preference=drivePreference(input.drivePreference,{required:input.mode==='live'});
  return freeze({mode:input.mode,destinationName:name.trim(),validUntil,expiryIssue,
    trip:{driver,passenger,drivePreference:preference,destination:routePoint(input.destination.point),
      waypoints:routeWaypoints(input.waypoints, MAX_ROUTE_WAYPOINTS - 1),candidates}});
}

// Domain boundary shared by internal callers and the opt-in authenticated TLS endpoint.
// Every replacement invalidates prior work, including a replacement that fails validation.
export class TripInput {
  #value=null; #revision=0; #job=null; #acceptedAt=0; #acceptedTick=0;
  constructor({now=Date.now, monotonic=()=>performance.now()}={}) { this.now=now; this.monotonic=monotonic; }
  clear() {
    this.#revision++; this.#value=null;
    this.#job?.abort(); this.#job=null;
  }
  replace(input) {
    this.clear();
    const at=this.now(),tick=this.monotonic();
    if (!Number.isFinite(tick)) fail('INVALID_CLOCK');
    const value=normalize(input,at);
    this.#value=value; this.#acceptedAt=at; this.#acceptedTick=tick;
    return this.#revision;
  }
  #current(revision) {
    if (!this.#value || revision!==this.#revision) fail('TRIP_INPUT_CHANGED');
    const at=this.now(),elapsed=this.monotonic()-this.#acceptedTick;
    if (!timestamp(at) || !Number.isFinite(elapsed) || elapsed<0 || at<this.#acceptedAt) fail('INVALID_CLOCK');
    if (Math.max(at,this.#acceptedAt+elapsed)>=this.#value.validUntil) fail(this.#value.expiryIssue);
    return this.#value;
  }
  async calculate({provider,signal,timeoutMs=15_000}={}) {
    checkAbort(signal);
    if (!provider || typeof provider.route!=='function' || typeof provider.source!=='string' || typeof provider.synthetic!=='boolean') fail('INVALID_ROUTE_PROVIDER');
    const revision=this.#revision,value=this.#current(revision);
    if (value.mode==='live' && provider?.synthetic!==false) fail('LIVE_PROVIDER_REQUIRED');
    this.#job?.abort();
    const job=new AbortController(); this.#job=job;
    const onAbort=()=>job.abort();signal?.addEventListener('abort',onAbort,{once:true});
    let invalidation=null;
    const guard=()=>{
      try { this.#current(revision); }
      catch(error) { invalidation=error; job.abort(); throw error; }
    };
    // Stop slow requests/reservations at the earliest location, route or session deadline.
    const deadline=setTimeout(()=>{
      invalidation=new RouteError(value.expiryIssue); job.abort();
    }, Math.max(0,value.validUntil-Math.max(this.now(),this.#acceptedAt+this.monotonic()-this.#acceptedTick)));
    let prepared;
    const eligibleCount=value.trip.candidates.filter(c=>c.curbStatus!=='restricted').length;
    const batch=async(signal)=>{
      if(!prepared)prepared=Promise.resolve().then(()=>provider.prepareBatch
        ?provider.prepareBatch(1+2*eligibleCount,{signal}):provider);
      const active=await abortable(()=>prepared,signal);
      if(!active||typeof active.route!=='function'||active.source!==provider.source||active.synthetic!==provider.synthetic)fail('INVALID_ROUTE_PROVIDER');
      if(value.trip.waypoints.length && !(Number.isSafeInteger(active.maxWaypoints) && active.maxWaypoints >= value.trip.waypoints.length + 1))fail('ROUTE_WAYPOINTS_UNSUPPORTED');
      requireDrivePreference(active,value.trip.drivePreference);
      return active;
    };
    const guardedProvider={source:provider.source,synthetic:provider.synthetic,maxWaypoints:provider.maxWaypoints,drivePreferences:provider.drivePreferences,route:async request=>{
      guard();const active=await batch(request.signal);guard();checkAbort(job.signal);
      const result=await active.route(request);guard();return result;
    }};
    try {
      const result=await estimatePickupRoutes(value.trip,{provider:guardedProvider,signal:job.signal,now:this.now,timeoutMs});
      guard();checkAbort(job.signal);
      return {...result,inputRevision:revision,inputMode:value.mode,inputValidUntil:value.validUntil,
        destinationName:value.destinationName};
    } catch(error) {
      if (signal?.aborted) throw new RouteError('ROUTE_CANCELLED');
      if (!this.#value || this.#revision!==revision) throw new RouteError('TRIP_INPUT_CHANGED');
      if (invalidation) throw invalidation;
      throw error;
    } finally {
      clearTimeout(deadline); signal?.removeEventListener('abort',onAbort);
      if(this.#job===job)this.#job=null;
    }
  }
}
