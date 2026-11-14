import {randomUUID} from 'node:crypto';
import {ApiError} from './api-error.mjs';
import {LOCATION_POLICY} from './shared/location-policy.mjs';

const fail=(status,code)=>{throw new ApiError(status,code);};
const timestamp=n=>Number.isSafeInteger(n)&&n>0;
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const only=(value,keys)=>object(value)&&Object.keys(value).every(key=>keys.includes(key));

// Authenticated-session internal boundary. Never persist coordinates or expose this
// object directly to HTTP. Source/consent are assigned here, not trusted from payloads.
export class PassengerLocation {
  #grant=null; #fix=null; #revision=0; #sequence=0; #observedAt=0; #status='not-sharing';
  #lastAt; #lastTick; #startAt; #startTick; #fixAt=0; #fixTick=0;
  #withdrawalId=null; #routingProvider=null;
  constructor({expiresAt,now=Date.now,monotonic=()=>performance.now(),onChange=()=>{}}) {
    this.now=now;this.monotonic=monotonic;this.expiresAt=expiresAt;this.onChange=onChange;
    this.#startAt=this.#lastAt=now();this.#startTick=this.#lastTick=monotonic();
    if(!timestamp(expiresAt)||!timestamp(this.#startAt)||expiresAt<=this.#startAt||!Number.isFinite(this.#startTick)) {
      fail(400,'INVALID_LOCATION_SESSION');
    }
  }
  #change(status,fix=null) {
    this.#fix=fix;this.#status=status;this.#revision++;this.onChange();
  }
  #revoke(status) {this.#routingProvider=null;this.#grant=null;this.#sequence=0;this.#observedAt=0;this.#change(status);}
  check() {
    if(['expired','closed','clock-invalid'].includes(this.#status))return;
    const at=this.now(),tick=this.monotonic();
    if(!timestamp(at)||!Number.isFinite(tick)||at<this.#lastAt||tick<this.#lastTick) {this.#revoke('clock-invalid');return;}
    this.#lastAt=at;this.#lastTick=tick;
    if(Math.max(at,this.#startAt+tick-this.#startTick)>=this.expiresAt) {this.#revoke('expired');return;}
    if(this.#fix && Math.max(at,this.#fixAt+tick-this.#fixTick)>=this.#fix.validUntil) this.#change('stale');
  }
  #open() {
    this.check();
    if(['expired','closed'].includes(this.#status))fail(410,'LOCATION_SESSION_CLOSED');
    if(this.#status==='clock-invalid')fail(409,'LOCATION_CLOCK_INVALID');
  }
  grant(input) {
    this.#open();
    if(!only(input,['consent','expectedRevision','routingProvider']) || input.consent!==true)fail(400,'LOCATION_CONSENT_REQUIRED');
    if(!Number.isSafeInteger(input.expectedRevision)||input.expectedRevision!==this.#revision)fail(409,'LOCATION_REVISION_CONFLICT');
    if(input.routingProvider!==undefined&&input.routingProvider!==null&&input.routingProvider!=='tmap')fail(400,'INVALID_ROUTING_CONSENT');
    this.#routingProvider=input.routingProvider??null;
    this.#grant=randomUUID();this.#sequence=0;this.#observedAt=0;this.#change('waiting');
    return this.snapshot(true);
  }
  receive(input,{simulation=false}={}) {
    this.#open();
    if(!this.#grant || input?.grantId!==this.#grant)fail(409,'LOCATION_GRANT_CHANGED');
    if(!Number.isSafeInteger(input.sequence)||input.sequence<1)fail(400,'INVALID_LOCATION_SEQUENCE');
    if(input.sequence<=this.#sequence)fail(409,'LOCATION_UPDATE_REPLAYED');
    // A newer but unusable update must not leave the previous point available.
    this.#sequence=input.sequence;this.#change('invalid');
    if(!only(input,['grantId','sequence','point','observedAt','accuracyMeters']) ||
      !only(input.point,['latitude','longitude']))fail(400,'INVALID_LOCATION_INPUT');
    const at=this.now(),tick=this.monotonic(),{point,observedAt,accuracyMeters}=input;
    if(simulation&&(point.latitude!==37.4859||point.longitude!==127.0348||accuracyMeters!==12))fail(400,'SIMULATION_POINT_ONLY');
    if(!Number.isFinite(point.latitude)||Math.abs(point.latitude)>90||!Number.isFinite(point.longitude)||Math.abs(point.longitude)>180)fail(400,'INVALID_LOCATION_POINT');
    if(!timestamp(observedAt)||observedAt-at>LOCATION_POLICY.futureToleranceMs)fail(400,'INVALID_LOCATION_TIME');
    if(observedAt<=this.#observedAt)fail(409,'LOCATION_TIME_REPLAYED');
    const age=Math.max(0,at-observedAt);
    if(age>=LOCATION_POLICY.maxAgeMs)fail(400,'LOCATION_STALE');
    if(!Number.isFinite(accuracyMeters)||accuracyMeters<=0||accuracyMeters>LOCATION_POLICY.maxAccuracyMeters)fail(400,'LOCATION_ACCURACY_REQUIRED');
    this.#observedAt=observedAt;this.#fixAt=at;this.#fixTick=tick;
    // The invalidation already advanced the revision and cancelled consumers above.
    this.#fix={point:{latitude:point.latitude,longitude:point.longitude},observedAt,accuracyMeters,
      source:'browser',consent:true,validUntil:Math.min(this.expiresAt,at+LOCATION_POLICY.maxAgeMs-age)};
    this.#status='ready';
    return this.snapshot(true);
  }
  withdraw(input) {
    this.#open();
    if(input!==undefined) {
      if(!only(input,['operationId'])||typeof input.operationId!=='string'||! /^[a-f0-9-]{36}$/i.test(input.operationId))fail(400,'INVALID_WITHDRAWAL');
      if(input.operationId===this.#withdrawalId)return this.snapshot(true);
      this.#withdrawalId=input.operationId;
      // Every new stop intent is a revision barrier, even when already withdrawn.
      // This rejects a grant request delayed until after the stop response.
      this.#revoke('withdrawn');
    } else if(this.#status!=='withdrawn')this.#revoke('withdrawn');
    return this.snapshot(true);
  }
  close() {if(this.#status!=='closed')this.#revoke('closed');}
  snapshot(includeGrant=false) {
    this.check();
    return {status:this.#status,revision:this.#revision,sequence:this.#sequence,
      validUntil:this.#fix?.validUntil??null,...(this.#routingProvider?{routingProvider:this.#routingProvider}:{}),...(includeGrant?{grantId:this.#grant}:{})};
  }
  input() {
    this.#open();
    return {revision:this.#revision,routingProvider:this.#routingProvider,fix:this.#fix?structuredClone(this.#fix):null};
  }
}
