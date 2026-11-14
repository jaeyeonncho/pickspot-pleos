// Local operator state. Only allowlisted summaries leave this boundary.
export class SharingConsole {
  #client=null; #invitation=null; #phase='idle'; #share='not-sharing'; #available=false;
  #pairingAvailable=false; #vehicleConnected=null; #pairingStatus='idle';
  #connected=true; #checkedAt=null; #lastPoll=-Infinity; #pending=null; #closing=false;
  constructor({createClient,now=Date.now,mode='remote'}) {this.createClient=createClient;this.now=now;this.mode=mode;}
  view() {
    const invitation=this.#invitation;
    return {mode:this.mode,phase:this.#phase,locationShare:this.#share,connected:this.#connected,
      checkedAt:this.#checkedAt,expiresAt:invitation?.expiresAt??null,
      invitation:this.#phase==='active'&&this.#connected&&this.#available&&invitation?.expiresAt>this.now()?{...invitation}:null,
      pairingAvailable:this.#pairingAvailable,vehicleConnected:this.#vehicleConnected,pairingStatus:this.#pairingStatus,
      canPair:!this.#closing&&!this.#pending&&this.#pairingAvailable&&this.#phase==='active'&&this.#connected&&
        invitation?.expiresAt>this.now()&&this.#checkedAt<=this.now()&&this.now()-this.#checkedAt<10000,
      canCreate:!this.#closing&&['idle','ended','expired','configuration-error'].includes(this.#phase),
      canEnd:!this.#closing&&['active','end-unknown'].includes(this.#phase)};
  }
  async create() {
    if(!this.view().canCreate)throw new Error('CREATE_NOT_AVAILABLE');
    this.#pairingAvailable=false;this.#vehicleConnected=null;this.#pairingStatus='idle';
    this.#phase='creating';this.#share='not-sharing';this.#invitation=null;this.#available=false;
    this.#checkedAt=null;this.#connected=true;this.#lastPoll=-Infinity;
    const work=(async()=>{
      try {
        try {this.#client=await this.createClient();}
        catch {this.#phase='configuration-error';this.#connected=false;return;}
        const value=await this.#client.create();
        if(!/^[A-F0-9]{12}$/.test(value?.inviteCode??'')||typeof value.url!=='string'||
          !Number.isSafeInteger(value.expiresAt)||value.expiresAt<=this.now())throw new Error('INVALID_INVITATION');
        const url=new URL(value.url);
        if(url.protocol!=='https:'||url.username||url.password||url.pathname!=='/'||url.search||
          url.hash!==`#join=${value.inviteCode}`)throw new Error('INVALID_INVITATION');
        this.#invitation={url:value.url,inviteCode:value.inviteCode,expiresAt:value.expiresAt};
        this.#phase='active';this.#available=true;this.#checkedAt=this.now();
      }catch {
        // Do not repeat a creation whose remote outcome is unknown.
        this.#phase='create-unknown';this.#connected=false;this.#available=false;
      }
    })();
    this.#pending=work;await work;if(this.#pending===work)this.#pending=null;return this.view();
  }
  async refresh() {
    if(this.#closing||this.#pending||!['active','end-unknown'].includes(this.#phase))return this.view();
    const at=this.now();if(at>=this.#lastPoll&&at-this.#lastPoll<3_000)return this.view();
    this.#lastPoll=at;
    const work=(async()=>{
      try {
        const value=await this.#client.status();
        if(['ended','expired'].includes(value.status)) {
          this.#phase=value.status;this.#client=null;this.#invitation=null;this.#available=false;
          this.#share='closed';
        }else {
          this.#pairingAvailable=value.pairingAvailable===true;this.#vehicleConnected=value.vehicleConnected===true;
          this.#available=value.invitationAvailable===true;
          this.#share=['not-sharing','ready','stale','withdrawn','expired','waiting','invalid','closed','clock-invalid'].includes(value.locationShare)?value.locationShare:'unknown';
        }
        this.#connected=true;this.#checkedAt=this.now();
      }catch {this.#connected=false;this.#share='unknown';this.#available=false;this.#vehicleConnected=null;}
    })();
    this.#pending=work;await work;if(this.#pending===work)this.#pending=null;return this.view();
  }
  async vehicleAction(code=null) {
    if(!this.view().canPair)throw new Error('PAIRING_NOT_AVAILABLE');
    if(code!==null&&(typeof code!=='string'||!/^[A-F0-9]{12}$/.test(code)))throw new Error('INVALID_PAIRING_CODE');
    this.#pairingStatus='working';
    const work=(async()=>{
      try {
        const value=code===null?await this.#client.revokeVehicle():await this.#client.approveVehicle(code);
        if(value?.status!==(code===null?'disconnected':'approved'))throw new Error('INVALID_PAIRING_RESPONSE');
        this.#pairingStatus=value.status;this.#vehicleConnected=false;
      }catch {this.#pairingStatus='unknown';this.#vehicleConnected=null;}
      this.#lastPoll=-Infinity;
    })();
    this.#pending=work;await work;if(this.#pending===work)this.#pending=null;return this.view();
  }
  async end() {
    // An explicit end waits for the current read; it cannot race a new create.
    if(!['active','end-unknown'].includes(this.#phase)||!this.#client)throw new Error('END_NOT_AVAILABLE');
    this.#phase='ending';this.#available=false;
    const previous=this.#pending;
    const work=(async()=>{
      await previous;
      if(!this.#client)return; // The preceding read already confirmed closure.
      try {
        const result=await this.#client.end();
        if(!['ended','expired'].includes(result.status))throw new Error('INVALID_END');
        this.#phase=result.status;this.#client=null;this.#invitation=null;this.#share='closed';
        this.#connected=true;this.#checkedAt=this.now();
      }catch {this.#phase='end-unknown';this.#connected=false;this.#share='unknown';}
    })();
    this.#pending=work;await work;if(this.#pending===work)this.#pending=null;return this.view();
  }
  async close() {
    this.#closing=true;await this.#pending;
    if(['active','end-unknown'].includes(this.#phase))await this.end();
    return this.view();
  }
}
