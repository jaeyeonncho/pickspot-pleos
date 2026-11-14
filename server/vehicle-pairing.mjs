import {randomBytes,randomUUID,createHash,timingSafeEqual} from 'node:crypto';
import {ApiError} from './api-error.mjs';
const fail=(status,code)=>{throw new ApiError(status,code);};
const digest=value=>createHash('sha256').update(value).digest();

/** Two-minute device-initiated authorization. Codes only approve a pending device;
 * receiving the vehicle credential requires the separate 256-bit device secret. */
export class VehiclePairings {
  constructor({store,now=Date.now,monotonic=()=>performance.now(),maximum=100}={}) {
    this.store=store;this.now=now;this.monotonic=monotonic;this.maximum=maximum;this.tickets=new Map();
  }
  #expired(ticket) {
    const at=this.now(),tick=this.monotonic();
    // Fail closed on rollback, not just when the final wall-clock deadline passes.
    const invalid=!Number.isSafeInteger(at)||!Number.isFinite(tick)||at<ticket.lastAt||tick<ticket.lastTick;
    ticket.lastAt=at;ticket.lastTick=tick;
    return invalid||Math.max(at,ticket.createdAt+tick-ticket.createdTick)>=ticket.expiresAt;
  }
  #close(ticket) {
    if(ticket.approval)this.store.cancelVehicleApproval(ticket.approval.id,ticket.approval.revision);
    ticket.code=null;ticket.approval=null;ticket.status='closed';
  }
  sweep() {
    for(const [id,ticket] of this.tickets){if(this.#expired(ticket)){this.#close(ticket);this.tickets.delete(id);}}
  }
  create() {
    this.sweep();if(this.tickets.size>=this.maximum)fail(429,'PAIRING_LIMIT');
    const at=this.now(),tick=this.monotonic();
    if(!Number.isSafeInteger(at)||at<=0||!Number.isFinite(tick)||tick<0)fail(503,'PAIRING_CLOCK_INVALID');
    const deviceToken=randomBytes(32).toString('base64url');let code;
    do{code=randomBytes(6).toString('hex').toUpperCase();}while([...this.tickets.values()].some(t=>t.code===code));
    const ticket={id:randomUUID(),code,deviceHash:digest(deviceToken),status:'pending',approval:null,
      createdAt:at,createdTick:tick,lastAt:at,lastTick:tick,expiresAt:at+120000};
    this.tickets.set(ticket.id,ticket);
    return {id:ticket.id,code,deviceToken,expiresAt:ticket.expiresAt,pollAfterMs:3000};
  }
  #authenticate(id,secret) {
    const ticket=this.tickets.get(id);
    if(!ticket||typeof secret!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(secret)||!timingSafeEqual(digest(secret),ticket.deviceHash))fail(403,'PAIRING_ACCESS_DENIED');
    if(this.#expired(ticket)){this.#close(ticket);this.tickets.delete(id);fail(410,'PAIRING_EXPIRED');}
    if(ticket.status==='closed')fail(410,'PAIRING_CLOSED');
    return ticket;
  }
  approve(sessionId,ownerToken,code) {
    // Authenticate ownership before looking up a public code.
    const {role}=this.store.authenticate(sessionId,ownerToken);if(role!=='driver')fail(403,'OWNER_ONLY');
    this.sweep();
    if(typeof code!=='string'||!/^[A-F0-9]{12}$/.test(code))fail(400,'INVALID_PAIRING_CODE');
    const ticket=[...this.tickets.values()].find(t=>t.code===code&&t.status==='pending');
    if(!ticket)fail(404,'INVALID_PAIRING_CODE');
    ticket.approval=this.store.approveVehicle(sessionId,ownerToken);ticket.status='approved';ticket.code=null;
    ticket.expiresAt=Math.min(ticket.expiresAt,ticket.approval.expiresAt);
    return {status:'approved',expiresAt:ticket.expiresAt};
  }
  claim(id,secret,prepare) {
    const ticket=this.#authenticate(id,secret);
    if(ticket.status==='pending')return {status:'pending',expiresAt:ticket.expiresAt,pollAfterMs:3000};
    if(ticket.status==='claimed')fail(409,'PAIRING_ALREADY_CLAIMED');
    try {
      // Review configuration before minting credentials. No plaintext vehicle secret is stored here.
      const metadata=prepare();
      const grant=this.store.claimVehicle(ticket.approval.id,ticket.approval.revision);
      ticket.status='claimed';ticket.approval=null;
      return {status:'connected',...grant,origin:metadata.origin,processingRegion:metadata.processingRegion,candidateIds:[...metadata.candidateIds]};
    }catch(error){this.#close(ticket);throw error;}
  }
  cancel(id,secret) {const ticket=this.#authenticate(id,secret);if(ticket.status==='claimed')fail(409,'PAIRING_ALREADY_CLAIMED');this.#close(ticket);return {status:'cancelled'};}
  dispose(){for(const ticket of this.tickets.values())this.#close(ticket);this.tickets.clear();}
}
