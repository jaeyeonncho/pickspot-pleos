import { randomBytes, randomUUID, createHash, timingSafeEqual } from 'node:crypto';
import {exampleDestinations} from './routing/example.mjs';
import { exampleLocation } from './demo.mjs';
import {createExampleRouteCalculator, routeCandidates, routeFailure} from './session-routing.mjs';
import {PassengerLocation} from './passenger-location.mjs';
import {ApiError} from './api-error.mjs';
import {TripInput} from './routing/trip-input.mjs';
import {RouteError} from './routing/contract.mjs';
export {ApiError} from './api-error.mjs';

const fail = (status, code) => { throw new ApiError(status, code); };
const token = () => randomBytes(32).toString('base64url');
const hash = value => createHash('sha256').update(value).digest();
const matches = (value, digest) => typeof value === 'string' && digest && timingSafeEqual(hash(value), digest);

export class SessionStore {
  constructor({ now = Date.now, monotonic = ()=>performance.now(), locationMode = 'example', routingMode='fixture', ttlMs = 15 * 60_000, maxSessions = 100, calculateRoutes = createExampleRouteCalculator(), routeTtlMs = 120_000, routeCooldownMs = 10_000, maxRouteAttempts = 5, candidateCatalog = null } = {}) {
    if(!['example','live'].includes(locationMode))fail(400,'INVALID_LOCATION_MODE');
    Object.defineProperty(this,'locationMode',{value:locationMode,enumerable:true});
    if(!['fixture','tmap-example','sharing-fixture'].includes(routingMode)||(routingMode==='tmap-example'&&locationMode!=='example')||
      (routingMode==='sharing-fixture'&&locationMode!=='live'))fail(400,'INVALID_ROUTING_MODE');
    Object.defineProperty(this,'routingMode',{value:routingMode,enumerable:true});
    this.candidateCatalog=candidateCatalog;
    this.monotonic=monotonic;this.liveLocations=new Map();
    this.now = now; this.ttlMs = ttlMs; this.maxSessions = maxSessions;
    this.sessions = new Map(); this.routeJobs = new Map();
    this.calculateRoutes = calculateRoutes; this.routeTtlMs = routeTtlMs;
    this.routeCooldownMs = routeCooldownMs; this.maxRouteAttempts = maxRouteAttempts;
  }
  sweep() {
    for (const [id, session] of this.sessions) {
      if(this.liveLocations.get(id)?.snapshot().status==='expired')this.close(session,'expired');
      if (this.now() >= session.expiresAt && !['expired','ended'].includes(session.status)) this.close(session, 'expired');
      if (session.route?.status === 'ready' && this.now() >= session.route.validUntil) {
        session.candidates = []; session.selection = null;
        session.route = {...session.route,status:'stale'}; session.version++;
      }
      // Short-lived tombstones retain only hashed access credentials, never positions/candidates.
      if (this.now() >= session.expiresAt + 60_000) {this.sessions.delete(id);this.liveLocations.delete(id);}
    }
  }
  close(session, status = 'ended') {
    this.liveLocations.get(session.id)?.close();this.liveLocations.delete(session.id);
    this.routeJobs.get(session.id)?.abort(); this.routeJobs.delete(session.id);
    session.route = null; session.sharedRecommendation = null; session.status = status; session.passenger = null; session.candidates = [];
    session.selection = null; session.inviteCode = null; session.version++;
  }
  create() {
    this.sweep();
    if (this.sessions.size >= this.maxSessions) fail(429, 'SESSION_LIMIT');
    const driverToken = token();
    let inviteCode;
    do { inviteCode = randomBytes(6).toString('hex').toUpperCase(); }
    while ([...this.sessions.values()].some(s => s.inviteCode === inviteCode));
    const session = { id: randomUUID(), status: 'waiting', version: 1,
      expiresAt: this.now() + this.ttlMs, driverHash: hash(driverToken), passengerHash: null,
      inviteCode, passenger: null, candidates: [], selection: null, destinationId:"maebong", route:null, routeAttempts:0, lastRouteAt:null };
    if(this.locationMode==='live')this.liveLocations.set(session.id,new PassengerLocation({expiresAt:session.expiresAt,
      now:this.now,monotonic:this.monotonic,onChange:()=>{
        this.routeJobs.get(session.id)?.abort();this.routeJobs.delete(session.id);
        session.candidates=[];session.selection=null;session.route=null;session.sharedRecommendation=null;session.version++;
      }}));
    this.sessions.set(session.id, session);
    return { session: this.view(session, 'driver'), driverToken };
  }
  redeem(code) {
    this.sweep();
    if (typeof code !== 'string' || !/^[A-F0-9]{12}$/.test(code)) fail(400, 'INVALID_INVITATION');
    const session = [...this.sessions.values()].find(s => s.inviteCode === code);
    if (!session || ['ended','expired'].includes(session.status)) fail(404, 'INVALID_INVITATION');
    const passengerToken = token();
    session.passengerHash = hash(passengerToken); session.inviteCode = null; session.version++;
    return { session: this.view(session, 'passenger'), passengerToken };
  }
  authenticate(id, value) {
    this.sweep();
    const session = this.sessions.get(id);
    if (!session) fail(404, 'SESSION_NOT_FOUND');
    const role = matches(value, session.driverHash) ? 'driver' : matches(value, session.passengerHash) ? 'passenger' : matches(value,session.vehicleHash) ? 'vehicle' : null;
    if (!role) fail(403, 'ACCESS_DENIED');
    if (['ended','expired'].includes(session.status)) fail(410, session.status === 'expired' ? 'SESSION_EXPIRED' : 'SESSION_ENDED');
    return { session, role };
  }
  view(session, role) {
    if(this.locationMode==='live') {
      const locationShare=this.liveLocations.get(session.id)?.snapshot(role==='passenger')??null;
      return {id:session.id,status:session.status,version:session.version,expiresAt:session.expiresAt,isDemo:false,
        passenger:null,candidates:[],selection:null,route:null,destination:null,destinationOptions:[],locationShare,
        ...(this.routingMode==='sharing-fixture'?{sharedRecommendation:structuredClone(session.sharedRecommendation??null)}:{}),
        ...(role==='driver'?{inviteCode:session.inviteCode,vehicleConnected:Boolean(session.vehicleHash)}:{})};
    }
    return structuredClone({ id:session.id, status:session.status, version:session.version,
      expiresAt:session.expiresAt, isDemo:true, passenger:session.passenger,
      candidates:session.candidates, selection:session.selection, route:session.route,
      destination:{id:session.destinationId,name:exampleDestinations.find(d=>d.id===session.destinationId).name},
      destinationOptions:role==='driver'?exampleDestinations.map(({id,name})=>({id,name})):[],
      ...(role === 'driver' ? { inviteCode:session.inviteCode } : {}) });
  }
  read(id, value) { const {session,role} = this.authenticate(id,value); return this.view(session,role); }
  #liveLocation(id,value,roleRequired) {
    const {session,role}=this.authenticate(id,value);
    if(!(roleRequired==='route-driver'?['driver','vehicle'].includes(role):role===roleRequired))fail(403,['driver','route-driver'].includes(roleRequired)?'DRIVER_ONLY':'PASSENGER_ONLY');
    if(this.locationMode!=='live')fail(409,'LIVE_LOCATION_SESSION_REQUIRED');
    return this.liveLocations.get(session.id);
  }
  // Owner-approved vehicle access has a separate credential and can never create/end meetings.
  #ownerVehicleSession(id,value) {
    const {session,role}=this.authenticate(id,value);
    if(role!=='driver')fail(403,'OWNER_ONLY');
    if(this.locationMode!=='live')fail(409,'LIVE_LOCATION_SESSION_REQUIRED');
    return session;
  }
  #invalidateVehicle(session) {
    this.routeJobs.get(session.id)?.abort();this.routeJobs.delete(session.id);
    session.vehicleHash=null;session.vehicleLinkPending=false;
    session.vehicleLinkRevision=(session.vehicleLinkRevision??0)+1;session.version++;
  }
  approveVehicle(id,value) {
    const session=this.#ownerVehicleSession(id,value);this.#invalidateVehicle(session);
    session.vehicleLinkPending=true;
    return {id:session.id,revision:session.vehicleLinkRevision,expiresAt:session.expiresAt};
  }
  claimVehicle(id,revision) {
    this.sweep();const session=this.sessions.get(id);
    if(!session||['ended','expired'].includes(session.status))fail(410,'VEHICLE_APPROVAL_CLOSED');
    if(this.locationMode!=='live'||!session.vehicleLinkPending||session.vehicleLinkRevision!==revision)fail(409,'VEHICLE_APPROVAL_CHANGED');
    const vehicleToken=token();session.vehicleHash=hash(vehicleToken);session.vehicleLinkPending=false;session.version++;
    return {session:this.view(session,'vehicle'),vehicleToken,capabilities:['read-session','compare-routes']};
  }
  cancelVehicleApproval(id,revision) {
    const session=this.sessions.get(id);
    if(session?.vehicleLinkPending&&session.vehicleLinkRevision===revision)this.#invalidateVehicle(session);
  }
  revokeVehicle(id,value) {this.#invalidateVehicle(this.#ownerVehicleSession(id,value));return {status:'disconnected'};}
  grantLocation(id,value,input) {return this.#liveLocation(id,value,'passenger').grant(input);}
  updateLocation(id,value,input,{simulation=false}={}) {
    const location=this.#liveLocation(id,value,'passenger');
    const snapshot=location.receive(input,{simulation:simulation||this.routingMode==='sharing-fixture'});
    if(this.routingMode==='sharing-fixture')this.beginSharedExample(this.sessions.get(id),snapshot);
    return snapshot;
  }
  beginSharedExample(session,snapshot) {
    if(this.routingMode!=='sharing-fixture')fail(409,'SIMULATION_ROUTES_ONLY');
    const controller=new AbortController();this.routeJobs.set(session.id,controller);
    const revision=snapshot.revision;
    session.sharedRecommendation={status:'calculating',source:'synthetic-fixture',synthetic:true,inputMode:'example',
      referenceOnly:true,validUntil:snapshot.validUntil,candidates:[]};
    session.version++;
    const current=()=>{
      this.sweep();
      const location=this.liveLocations.get(session.id)?.snapshot();
      return !controller.signal.aborted&&this.sessions.get(session.id)===session&&
        location?.status==='ready'&&location.revision===revision;
    };
    // Deliberately independent of calculateRoutes: this simulation can never use TMAP.
    Promise.resolve().then(()=>createExampleRouteCalculator()({signal:controller.signal,now:this.now})).then(report=>{
      if(!current())return;
      session.sharedRecommendation={status:'ready',source:'synthetic-fixture',synthetic:true,inputMode:'example',referenceOnly:true,
        validUntil:Math.min(session.expiresAt,snapshot.validUntil,report.inputValidUntil),
        candidates:routeCandidates(report).map(({point,...candidate})=>candidate)};
      session.version++;
    }).catch(()=>{
      if(current()){session.sharedRecommendation={...session.sharedRecommendation,status:'failed',candidates:[]};session.version++;}
    }).finally(()=>{if(this.routeJobs.get(session.id)===controller)this.routeJobs.delete(session.id);});
  }
  withdrawLocation(id,value,input) {return this.#liveLocation(id,value,'passenger').withdraw(input);}
  livePassengerInput(id,value) {return this.#liveLocation(id,value,'driver').input();}
  async calculateLiveRoutes(id,value,trip,{provider,signal}={}) {
    const location=this.#liveLocation(id,value,'route-driver');
    const {session}=this.authenticate(id,value);
    if(signal?.aborted)throw new RouteError('ROUTE_CANCELLED');
    if(!provider||provider.synthetic!==false)throw new RouteError('LIVE_PROVIDER_REQUIRED');
    // Changing a trip first cancels old work, including when new inputs are invalid.
    this.routeJobs.get(id)?.abort();this.routeJobs.delete(id);
    const passenger=location.input();
    if(!passenger.fix)throw new RouteError('PASSENGER_LOCATION_REQUIRED');
    if(passenger.routingProvider!==provider.source||trip?.driver?.routingProvider!==provider.source)throw new RouteError('ROUTING_CONSENT_REQUIRED');
    if(typeof provider.prepareBatch!=='function')throw new RouteError('ROUTE_BUDGET_REQUIRED');
    if(!this.candidateCatalog)throw new RouteError('CANDIDATE_CATALOG_REQUIRED');
    if(Object.hasOwn(trip??{},'candidates'))throw new RouteError('CATALOG_CANDIDATE_IDS_REQUIRED');
    const selection=this.candidateCatalog.select(trip?.candidateIds,{now:this.now()});
    const input=new TripInput({now:this.now,monotonic:this.monotonic});
    try {
      input.replace({mode:'live',expiresAt:Math.min(session.expiresAt,selection.validUntil),driver:trip?.driver,passenger:passenger.fix,
        destination:trip?.destination,waypoints:trip?.waypoints,drivePreference:trip?.drivePreference,routeObservedAt:trip?.routeObservedAt,candidates:selection.candidates});
    }catch(error){input.clear();throw error;}
    if(session.routeAttempts>=this.maxRouteAttempts){input.clear();fail(429,'ROUTE_ATTEMPT_LIMIT');}
    if(session.lastRouteAt!==null&&this.now()-session.lastRouteAt<this.routeCooldownMs){input.clear();fail(429,'ROUTE_COOLDOWN');}
    session.routeAttempts++;session.lastRouteAt=this.now();session.version++;
    const version=session.version,controller=new AbortController();this.routeJobs.set(id,controller);
    let catalogChanged=false;
    const unwatch=this.candidateCatalog.onChange(()=>{catalogChanged=true;controller.abort();});
    const abort=()=>controller.abort();signal?.addEventListener('abort',abort,{once:true});
    try {
      const report=await input.calculate({provider,signal:controller.signal});
      this.sweep();
      if(controller.signal.aborted||this.sessions.get(id)!==session||session.version!==version||location.input().revision!==passenger.revision)throw new RouteError('TRIP_INPUT_CHANGED');
      this.candidateCatalog.assertCurrent(selection,{now:this.now()});
      // Source and operating conditions travel with totals; personal coordinates do not.
      return {...report,sessionVersion:version,passengerRevision:passenger.revision,
        catalogRevision:selection.revision,candidateProvenance:selection.provenance};
    }catch(error){
      if(catalogChanged)throw new RouteError('CANDIDATE_CATALOG_CHANGED');
      throw error;
    }finally {
      unwatch();signal?.removeEventListener('abort',abort);input.clear();
      if(this.routeJobs.get(id)===controller)this.routeJobs.delete(id);
    }
  }
  requireExample() {if(this.locationMode!=='example')fail(409,'EXAMPLE_SESSION_REQUIRED');}
  shareExample(id, value, input) {
    const {session,role} = this.authenticate(id,value);
    this.requireExample();
    if (role !== 'passenger') fail(403, 'PASSENGER_ONLY');
    if (input.consent !== true || input.mode !== 'example') fail(400, 'EXAMPLE_CONSENT_REQUIRED');
    // Deliberately never accept precise user coordinates in this local-demo endpoint.
    if (Object.keys(input).some(k => !['consent','mode'].includes(k))) fail(400, 'EXAMPLE_ONLY');
    if (session.status !== 'active') {
      session.passenger = { name:'동승자', location:{...exampleLocation, observedAt:this.now(), isExample:true} };
      session.status = 'active'; this.beginRoutes(session);
    }
    return this.view(session,role);
  }
  refreshRoutes(id, value, input) {
    const {session,role} = this.authenticate(id,value);
    this.requireExample();
    if (role !== 'driver') fail(403,'DRIVER_ONLY');
    if (Object.keys(input).some(k=>k !== 'expectedVersion')) fail(400,'EXAMPLE_ONLY');
    if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion !== session.version) fail(409,'VERSION_CONFLICT');
    if (session.status !== 'active') fail(409,'PASSENGER_NOT_READY');
    if (session.route?.status === 'calculating' || session.selection?.navigationStatus === 'pending') fail(409,'REQUEST_IN_PROGRESS');
    if (session.routeAttempts >= this.maxRouteAttempts) fail(429,'ROUTE_ATTEMPT_LIMIT');
    if (session.lastRouteAt !== null && this.now() - session.lastRouteAt < this.routeCooldownMs) fail(429,'ROUTE_COOLDOWN');
    this.beginRoutes(session);
    return this.view(session,role);
  }
  changeDestination(id,value,input) {
    const {session,role}=this.authenticate(id,value);
    this.requireExample();
    if(role!=='driver')fail(403,'DRIVER_ONLY');
    if(Object.keys(input).some(k=>!['expectedVersion','destinationId'].includes(k)) || !exampleDestinations.some(d=>d.id===input.destinationId))fail(400,'EXAMPLE_DESTINATION_ONLY');
    if(!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion!==session.version)fail(409,'VERSION_CONFLICT');
    if(session.selection?.navigationStatus==='pending')fail(409,'REQUEST_IN_PROGRESS');
    if(input.destinationId===session.destinationId)return this.view(session,role);
    if(session.status==='active') {
      if(session.routeAttempts>=this.maxRouteAttempts)fail(429,'ROUTE_ATTEMPT_LIMIT');
      if(session.lastRouteAt!==null && this.now()-session.lastRouteAt<this.routeCooldownMs)fail(429,'ROUTE_COOLDOWN');
    }
    session.destinationId=input.destinationId;
    session.candidates=[];session.selection=null;
    if(session.status==='active')this.beginRoutes(session);else session.version++;
    return this.view(session,role);
  }
  beginRoutes(session) {
    this.requireExample();
    this.routeJobs.get(session.id)?.abort();
    const controller = new AbortController(); this.routeJobs.set(session.id,controller);
    const generation = randomUUID();
    session.routeAttempts++; session.lastRouteAt = this.now();
    session.candidates = []; session.selection = null;
    session.route = {status:'calculating',generation,source:this.routingMode==='tmap-example'?'tmap':'synthetic-fixture',synthetic:this.routingMode!=='tmap-example',inputMode:'example',referenceOnly:true,issue:null,
      destinationName:exampleDestinations.find(d=>d.id===session.destinationId).name,requestedAt:this.now(),completedAt:null,validUntil:null,
      retryAt:this.now()+this.routeCooldownMs,attemptsRemaining:this.maxRouteAttempts-session.routeAttempts,error:null};
    session.version++;
    const current = () => {
      this.sweep();
      return !controller.signal.aborted && this.sessions.get(session.id) === session &&
        session.status === 'active' && session.route?.generation === generation;
    };
    Promise.resolve().then(()=>this.calculateRoutes({signal:controller.signal,destinationId:session.destinationId,now:this.now})).then(report=>{
      if (!current()) return;
      // Routing source is explicit; a real response still uses fixed example inputs.
      if (report.synthetic !== session.route.synthetic || report.source !== session.route.source ||
        report.inputMode!=='example'||report.referenceOnly!==true||report.destinationName!==session.route.destinationName||
        !Number.isSafeInteger(report.inputValidUntil)||report.inputValidUntil<=this.now())throw new Error('Invalid route report');
      const candidates = routeCandidates(report);
      session.candidates = candidates;
      session.route = {...session.route,status:candidates.length ? 'ready' : 'failed',
        completedAt:this.now(),validUntil:Math.min(session.expiresAt,this.now()+this.routeTtlMs,report.inputValidUntil ?? Infinity),
        issue:candidates.length?null:'unavailable',error:candidates.length ? null : 'NO_ROUTE_CANDIDATES',excludedCount:report.excluded.length};
      session.version++;
    }).catch(error=>{
      if (!current()) return;
      session.candidates = []; session.selection = null;
      const issue=routeFailure(error instanceof RouteError?error.code:null);
      // Further requests require fixing configuration or a fresh daily allowance.
      if(['limit','configuration'].includes(issue))session.routeAttempts=this.maxRouteAttempts;
      session.route = {...session.route,status:'failed',issue,error:'ROUTE_CALCULATION_FAILED',completedAt:this.now(),
        attemptsRemaining:this.maxRouteAttempts-session.routeAttempts};
      session.version++;
    }).finally(()=>{
      if (this.routeJobs.get(session.id) === controller) this.routeJobs.delete(session.id);
    });
  }
  dispose() {
    for(const session of this.sessions.values())this.close(session);
    this.sessions.clear();this.liveLocations.clear();
    for (const controller of this.routeJobs.values()) controller.abort();
    this.routeJobs.clear();
  }
  select(id, value, input, {previewOnly=false}={}) {
    const {session,role} = this.authenticate(id,value);
    this.requireExample();
    if (role !== 'driver') fail(403, 'DRIVER_ONLY');
    if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion !== session.version) fail(409, 'VERSION_CONFLICT');
    if (session.status !== 'active') fail(409, 'PASSENGER_NOT_READY');
    if (session.route?.status !== 'ready') fail(409, 'ROUTES_NOT_READY');
    if(previewOnly&&session.selection?.navigationStatus==='pending')fail(409,'REQUEST_IN_PROGRESS');
    const candidate = session.candidates.find(c => c.id === input.candidateId && c.curbStatus !== 'restricted');
    if (!candidate) fail(400, 'INVALID_CANDIDATE');
    session.selection = { id:randomUUID(), candidateId:candidate.id, navigationStatus:previewOnly?'not-requested':'pending' };
    session.version++;
    return this.view(session,role);
  }
  report(id, value, input) {
    const {session,role} = this.authenticate(id,value);
    this.requireExample();
    if (role !== 'driver') fail(403, 'DRIVER_ONLY');
    if (!session.selection || input.selectionId !== session.selection.id) fail(409, 'SELECTION_CHANGED');
    if (!['confirmed','failed'].includes(input.status)) fail(400, 'INVALID_NAVIGATION_STATUS');
    if (session.selection.navigationStatus !== 'pending' && session.selection.navigationStatus !== input.status) fail(409,'STATUS_ALREADY_FINAL');
    if (session.selection.navigationStatus !== input.status) { session.selection.navigationStatus = input.status; session.version++; }
    return this.view(session,role);
  }
  end(id, value) { const {session,role} = this.authenticate(id,value); if(role==='vehicle')fail(403,'OWNER_OR_PASSENGER_REQUIRED');this.close(session); }
}
