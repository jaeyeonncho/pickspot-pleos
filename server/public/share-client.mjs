import {readRoutingDisclosure} from './routing-consent.mjs';
const terminal=error=>[401,403,404,410].includes(error?.status);
const uuid=value=>typeof value==='string'&&/^[a-f0-9-]{36}$/i.test(value);
export function restoreShare(raw,now=Date.now()) {
  try {
    const value=JSON.parse(raw);
    if(!uuid(value?.id)||! /^[A-Za-z0-9_-]{43}$/.test(value.token)||!Number.isSafeInteger(value.expiresAt)||value.expiresAt<=now)return null;
    if(value.stopId!=null&&!uuid(value.stopId))return null;
    return {id:value.id,token:value.token,expiresAt:value.expiresAt,stopId:value.stopId??null};
  }catch{return null;}
}

// Coordinates stay only in the one-slot in-memory queue; only stop intent is persisted.
// A connection failure stops capture. Reconnection retries withdrawal, never consent/fixes.
export class ShareClient {
  #state=Object.freeze({status:'idle',validUntil:null,confirmedAt:null}); #generation=0; #grant=null; #sequence=0;
  #routingProvider=null; #disclosure=null;
  #queue=null; #sending=false; #timer=null; #request=null; #stopping=null; #stopId=null; #lastSent=0;
  constructor({api,credentials,save=()=>{},now=Date.now,newId=()=>crypto.randomUUID(),onChange=()=>{},onSession=()=>{},stopCapture=()=>{},
    setTimeoutImpl=(fn,ms)=>setTimeout(fn,ms),clearTimeoutImpl=id=>clearTimeout(id),minIntervalMs=3000}={}) {
    Object.assign(this,{api,credentials:{id:credentials?.id,token:credentials?.token,expiresAt:credentials?.expiresAt},save,now,newId,onChange,onSession,stopCapture,setTimeoutImpl,clearTimeoutImpl,minIntervalMs});
    this.#stopId=credentials?.stopId??null;
    if(this.#stopId)this.#state=Object.freeze({status:'stop-pending',validUntil:null});
  }
  get state(){return this.#state;}
  #publish(status,validUntil=null,confirmedAt=null){this.#state=Object.freeze({status,validUntil,confirmedAt,routingProvider:this.#routingProvider});this.onChange(this.#state);}
  #persist(){try{this.save({...this.credentials,stopId:this.#stopId});}catch{/* memory-only; reload always revokes */}}
  #clear() {
    this.#generation++;this.#routingProvider=null;this.#grant=null;this.#queue=null;
    this.#request?.abort();this.#request=null;
    if(this.#timer!==null){this.clearTimeoutImpl(this.#timer);this.#timer=null;}
    this.stopCapture();
  }
  #closed(){this.#clear();this.#stopId=null;try{this.save(null);}catch{}this.#publish('closed');}
  async restore() {
    if(this.#stopId)return this.stop();
    // A reload may have interrupted an acknowledged grant or pending request.
    // Revoke it before offering a new explicit start; never silently resume capture.
    return this.stop();
  }
  async loadRoutingDisclosure() {
    const generation=this.#generation;this.#disclosure=null;
    try {
      const value=await this.api.routingDisclosure();
      if(generation!==this.#generation||this.#state.status==='closed')return null;
      this.#disclosure=readRoutingDisclosure(value,this.api.origin,this.credentials.expiresAt,this.now());
      return this.#disclosure;
    }catch{return null;}
  }
  async start({consent=false,routingConsent=false,disclosureId=null}={}) {
    if(typeof routingConsent!=='boolean'||(!routingConsent&&disclosureId!==null))return false;
    if(routingConsent&&(!this.#disclosure||disclosureId!==this.#disclosure.id))return false;
    if(consent!==true||this.#stopId||!['idle','stopped'].includes(this.#state.status))return false;
    if(this.credentials.expiresAt<=this.now()){this.#closed();return false;}
    const generation=++this.#generation;this.#publish('starting');
    try {
      if(routingConsent){
        const current=readRoutingDisclosure(await this.api.routingDisclosure(),this.api.origin,this.credentials.expiresAt,this.now());
        if(generation!==this.#generation)return false;
        if(current.id!==disclosureId||!this.#disclosure||['version','origin','processingRegion','expiresAt'].some(key=>current[key]!==this.#disclosure[key]))throw new Error('ROUTING_DISCLOSURE_CHANGED');
      }
      const session=await this.api.read();
      if(generation!==this.#generation)return false;
      if(session.isDemo!==false||!Number.isSafeInteger(session.locationShare?.revision))throw new Error('INVALID_SESSION');
      const grant=await this.api.grant({consent:true,expectedRevision:session.locationShare.revision,...(routingConsent?{routingProvider:'tmap',routingDisclosureId:disclosureId}:{})});
      if(generation!==this.#generation)return false;
      if(!uuid(grant.grantId)||grant.status!=='waiting'||(grant.routingProvider??null)!==(routingConsent?'tmap':null))throw new Error('INVALID_GRANT');
      this.#routingProvider=routingConsent?'tmap':null;this.#grant=grant.grantId;this.#sequence=0;this.#lastSent=0;this.#publish('waiting');return true;
    }catch(error){if(generation===this.#generation){if(terminal(error))this.#closed();else await this.stop();}return false;}
  }
  push(fix) {
    if(!this.#grant||this.#stopId||!['waiting','sharing','sending'].includes(this.#state.status))return;
    if(!fix||fix.validUntil<=this.now()||fix.source!=='browser'||fix.consent!==true){void this.stop();return;}
    // Explicit allowlist; don't copy client consent/provenance into the wire payload.
    this.#queue={point:{latitude:fix.point.latitude,longitude:fix.point.longitude},observedAt:fix.observedAt,accuracyMeters:fix.accuracyMeters};
    this.#drain();
  }
  #drain() {
    if(this.#sending||this.#timer!==null||!this.#queue||!this.#grant||this.#stopId)return;
    const remaining=this.minIntervalMs-(this.now()-this.#lastSent);
    if(remaining>0){this.#timer=this.setTimeoutImpl(()=>{this.#timer=null;this.#drain();},remaining);return;}
    const fix=this.#queue;this.#queue=null;
    if(this.now()-fix.observedAt>=30000){void this.stop();return;}
    const generation=this.#generation,grantId=this.#grant,sequence=++this.#sequence;
    const controller=new AbortController();this.#request=controller;this.#sending=true;this.#lastSent=this.now();
    this.#publish('sending',this.#state.validUntil,this.#state.confirmedAt);
    this.api.update({...fix,grantId,sequence},{signal:controller.signal}).then(result=>{
      if(generation!==this.#generation)return;
      if((result.routingProvider??null)!==this.#routingProvider||result.status!=='ready'||result.grantId!==grantId||result.sequence!==sequence||!Number.isSafeInteger(result.validUntil)||result.validUntil<=this.now())throw new Error('INVALID_ACK');
      this.#publish('sharing',result.validUntil,this.now());
    }).catch(error=>{
      if(generation!==this.#generation)return;
      if(terminal(error))this.#closed();else void this.stop();
    }).finally(()=>{this.#sending=false;if(this.#request===controller)this.#request=null;this.#drain();});
  }
  stop({keepalive=false}={}) {
    if(this.#state.status==='closed')return Promise.resolve();
    if(!this.#stopId)this.#stopId=this.newId();
    this.#persist();this.#clear();this.#publish('stop-pending');
    if(this.#stopping)return this.#stopping;
    const stopId=this.#stopId;
    this.#stopping=Promise.resolve().then(()=>this.api.withdraw({operationId:stopId},{keepalive})).then(result=>{
      if(this.#stopId!==stopId)return;
      if(result.status!=='withdrawn'||result.grantId!==null)throw new Error('INVALID_WITHDRAWAL_ACK');
      this.#stopId=null;this.#persist();this.#publish('stopped');
    }).catch(error=>{if(terminal(error))this.#closed();else this.#publish('stop-pending');})
      .finally(()=>{this.#stopping=null;});
    return this.#stopping;
  }
  async check() {
    if(this.credentials.expiresAt<=this.now()){this.#closed();return;}
    if(this.#stopId){await this.stop();return;}
    if(this.#state.status==='closed')return;
    try {
      const generation=this.#generation,session=await this.api.read();
      if(generation!==this.#generation)return;
      this.onSession(session);
      if(this.#grant&&((session.locationShare?.routingProvider??null)!==this.#routingProvider||session.locationShare?.grantId!==this.#grant||['stale','invalid','clock-invalid','withdrawn'].includes(session.locationShare?.status)))await this.stop();
      else if(this.#state.validUntil!==null&&this.#state.validUntil<=this.now())await this.stop();
    }catch(error){if(terminal(error))this.#closed();else await this.stop();}
  }
}

export function shareView(state,now=Date.now()) {
  const labels={idle:['위치 공유를 준비해요','동의하고 시작하면 이 픽업에만 위치를 전달해요.'],
    starting:['공유 동의를 확인하고 있어요','확인이 끝나면 위치 수신을 시작해요.'],waiting:['새 위치를 기다리고 있어요','위치를 받으면 이 픽업의 서버에 전달해요.'],
    sending:['새 위치를 전달하고 있어요','서버의 수신 확인을 기다려요.'],sharing:['위치가 전달됐어요','현재는 위치 공유만 확인할 수 있어요. 픽업 경로 계산은 아직 연결 전이에요.'],
    'stop-pending':['수집을 멈췄어요 · 서버 확인 중','이 기기의 위치는 지웠어요. 연결되면 서버 삭제를 다시 확인해요. 서버에 남은 위치도 최대 30초 뒤 만료돼요.'],
    stopped:['위치 공유를 멈췄어요','서버의 위치 삭제를 확인했어요. 다시 공유하려면 동의하고 시작해 주세요.'],
    closed:['픽업이 끝났어요','위치 수집을 멈췄어요. 새로운 코드로 다시 참여할 수 있어요.']};
  let [title,copy]=labels[state.status]??labels.idle;
  const acknowledged=['sharing','sending'].includes(state.status)&&Number.isSafeInteger(state.confirmedAt);
  const activeSharing=acknowledged&&state.confirmedAt<=now&&Number.isSafeInteger(state.validUntil)&&state.validUntil>now;
  let freshness='';
  if(activeSharing){
    title='위치 공유 중';copy='현재는 위치 공유만 확인할 수 있어요. 픽업 경로 계산은 아직 연결 전이에요.';
    const seconds=Math.floor((now-state.confirmedAt)/1000);
    freshness=seconds===0?'방금 갱신':`${seconds}초 전 갱신`;
  }else if(acknowledged){
    title='새 위치 확인이 필요해요';copy='마지막 위치의 유효시간이 지났거나 기기 시간이 바뀌었어요. 공유 상태를 확인하고 있어요.';
  }
  if(state.routingProvider==='tmap'&&['waiting','sharing','sending'].includes(state.status))copy='차량에서 비교를 요청하면 현재 위치를 TMAP 경로 계산에 사용할 수 있어요. 원하면 경로 동의와 위치 공유를 함께 중지할 수 있어요.';
  return {title,copy,freshness,activeSharing,canStart:['idle','stopped'].includes(state.status),canStop:!['idle','stopped','closed'].includes(state.status)};
}
