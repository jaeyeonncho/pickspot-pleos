// Local operator only. This file is intentionally absent from the hosting bundle.
import {invitationLink} from '../server/public/invitation-link.mjs';
export class RemoteSharingClient {
  #key; #credentials=null; #created=false;
  constructor({origin,driverKey,fetchImpl=fetch,timeoutMs=8000,pairingEnabled=false}) {
    if(typeof pairingEnabled!=='boolean')throw new Error('INVALID_PAIRING_MODE');
    let url;try{url=new URL(origin);}catch{throw new Error('INVALID_REMOTE_ORIGIN');}
    if(url.origin!==origin||url.protocol!=='https:'||url.username||url.password||(!pairingEnabled&&(url.port||
      !/^[a-z0-9][a-z0-9-]*\.onrender\.com$/.test(url.hostname))))throw new Error('INVALID_REMOTE_ORIGIN');
    if(!/^[A-Za-z0-9_-]{43,128}$/.test(driverKey??''))throw new Error('INVALID_DRIVER_KEY');
    this.pairingEnabled=pairingEnabled===true;this.origin=origin;this.fetchImpl=fetchImpl;this.timeoutMs=timeoutMs;this.#key=driverKey;
  }
  async request(path,method,token,body) {
    try {
      const response=await this.fetchImpl(this.origin+path,{method,redirect:'error',cache:'no-store',signal:AbortSignal.timeout(this.timeoutMs),
        headers:{Origin:this.origin,Authorization:`Bearer ${token}`,...(body?{'Content-Type':'application/json'}:{})},
        ...(body?{body:JSON.stringify(body)}:{})});
      if(response.status===410&&['GET','DELETE'].includes(method)) {
        const closed=await response.json();
        if(closed?.error==='SESSION_ENDED')return {status:'ended'};
        if(closed?.error==='SESSION_EXPIRED')return {status:'expired'};
      }
      if(!response.ok)throw new Error('REMOTE_REQUEST_FAILED');
      return await response.json();
    }catch{throw new Error('REMOTE_REQUEST_FAILED');}
  }
  async create() {
    if(this.#created)throw new Error('CREATE_ALREADY_ATTEMPTED');
    this.#created=true; // Never repeat an ambiguous creation after a timeout.
    let value;try{value=await this.request('/v1/sessions','POST',this.#key,{});}finally{this.#key=null;}
    const session=value?.session;
    if(!/^[a-f0-9-]{36}$/.test(session?.id??'')||!/^[A-Za-z0-9_-]{43}$/.test(value?.driverToken??'')||
      !/^[A-F0-9]{12}$/.test(session?.inviteCode??'')||!Number.isFinite(session?.expiresAt))throw new Error('INVALID_REMOTE_RESPONSE');
    this.#credentials={id:session.id,token:value.driverToken};
    return {url:invitationLink(this.origin,session.inviteCode),inviteCode:session.inviteCode,expiresAt:session.expiresAt};
  }
  async status() {
    if(!this.#credentials)throw new Error('SESSION_REQUIRED');
    const c=this.#credentials,value=await this.request('/v1/sessions/'+c.id,'GET',c.token);
    const status=['waiting','joined','active','ended','expired'].includes(value?.status)?value.status:'unknown';
    const share=['not-sharing','ready','stale','withdrawn','expired','waiting','invalid','closed','clock-invalid'].includes(value?.locationShare?.status)?value.locationShare.status:'unknown';
    return {status,locationShare:share,invitationAvailable:/^[A-F0-9]{12}$/.test(value?.inviteCode??''),...(this.pairingEnabled?{pairingAvailable:true,vehicleConnected:value?.vehicleConnected===true}:{})}; // Never forward arbitrary server fields or coordinates.
  }
  async approveVehicle(code) {
    if(!this.pairingEnabled||!this.#credentials)throw new Error('PAIRING_NOT_AVAILABLE');
    if(typeof code!=='string'||!/^[A-F0-9]{12}$/.test(code))throw new Error('INVALID_PAIRING_CODE');
    const c=this.#credentials;
    const value=await this.request(`/v1/sessions/${c.id}/vehicle-pairings`,'POST',c.token,{code});
    if(value?.status!=='approved'||!Number.isSafeInteger(value.expiresAt))throw new Error('INVALID_REMOTE_RESPONSE');
    return {status:'approved'};
  }
  async revokeVehicle() {
    if(!this.pairingEnabled||!this.#credentials)throw new Error('PAIRING_NOT_AVAILABLE');
    const c=this.#credentials;
    const value=await this.request(`/v1/sessions/${c.id}/vehicle-pairings`,'DELETE',c.token);
    if(value?.status!=='disconnected')throw new Error('INVALID_REMOTE_RESPONSE');
    return {status:'disconnected'};
  }
  async end() {
    if(!this.#credentials)throw new Error('SESSION_REQUIRED');
    const c=this.#credentials,value=await this.request('/v1/sessions/'+c.id,'DELETE',c.token);
    if(!['ended','expired'].includes(value?.status))throw new Error('INVALID_REMOTE_RESPONSE');
    this.#credentials=null;return {status:value.status};
  }
}
