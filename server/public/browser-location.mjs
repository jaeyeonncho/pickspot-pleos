import {LOCATION_POLICY} from '../shared/location-policy.mjs';

const MAX_SESSION_MS = 120_000;
const FIRST_FIX_MS = 12_000;
const clockValid = n => Number.isSafeInteger(n) && n > 0;

// No network or storage. A consumer must explicitly start, and dispose on departure.
// Dependency injection keeps browser permissions and device coordinates out of tests.
export class BrowserLocation {
  #state=Object.freeze({status:'idle',active:false,fix:null});
  #watch=null; #timer=null; #generation=0; #disposed=false; #permission=null; #permissionListener=null;
  #startAt=0; #startTick=0; #fixAt=0; #fixTick=0; #lastObserved=0; #received=false;
  constructor({geolocation,permissions,secure=false,visible=()=>true,now=Date.now,
    monotonic=()=>performance.now(),setIntervalImpl=(fn,ms)=>setInterval(fn,ms),clearIntervalImpl=id=>clearInterval(id),onChange=()=>{}}={}) {
    Object.assign(this,{geolocation,permissions,secure,visible,now,monotonic,setIntervalImpl,clearIntervalImpl,onChange});
  }
  #publish(status,active,fix=null) {
    this.#state=Object.freeze({status,active,fix});
    this.onChange(this.#state);
  }
  #release() {
    this.#generation++;
    if(this.#watch!==null) {try {this.geolocation.clearWatch(this.#watch);} catch {} this.#watch=null;}
    if(this.#timer!==null) {this.clearIntervalImpl(this.#timer);this.#timer=null;}
    this.#permission?.removeEventListener('change',this.#permissionListener);
    this.#permission=null;this.#permissionListener=null;
  }
  stop(reason='stopped') { this.#release();this.#publish(reason,false); }
  dispose() {this.#disposed=true;this.stop('stopped');}
  snapshot() {this.#check();return this.#state;}
  #check() {
    if(!this.#state.active)return;
    if(!this.visible()) {this.stop('hidden');return;}
    const at=this.now(),tick=this.monotonic(),elapsed=tick-this.#startTick;
    if(!clockValid(at)||!Number.isFinite(elapsed)||elapsed<0||at<this.#startAt) {this.stop('clock-invalid');return;}
    if(Math.max(at-this.#startAt,elapsed)>=MAX_SESSION_MS) {this.stop('finished');return;}
    if(!this.#received && elapsed>=FIRST_FIX_MS) {this.stop('timeout');return;}
    const fix=this.#state.fix;
    if(fix && (at<this.#fixAt || tick<this.#fixTick)) {this.stop('clock-invalid');return;}
    if(fix && Math.max(at,this.#fixAt+tick-this.#fixTick)>=fix.validUntil) this.#publish('stale',true);
  }
  start({consent=false}={}) {
    if(this.#disposed)return;
    this.#release();
    if(consent!==true) {this.#publish('consent-required',false);return;}
    if(!this.secure) {this.#publish('insecure',false);return;}
    if(!this.visible()) {this.#publish('hidden',false);return;}
    if(!this.geolocation?.watchPosition || !this.geolocation?.clearWatch) {this.#publish('unsupported',false);return;}
    this.#startAt=this.now();this.#startTick=this.monotonic();this.#lastObserved=0;this.#received=false;
    if(!clockValid(this.#startAt)||!Number.isFinite(this.#startTick)) {this.#publish('clock-invalid',false);return;}
    const generation=this.#generation;
    this.#publish('requesting',true);
    this.#timer=this.setIntervalImpl(()=>this.#check(),250);
    try {
      const id=this.geolocation.watchPosition(position=>this.#position(generation,position),error=>{
        if(generation!==this.#generation)return;
        this.stop(error?.code===1?'denied':error?.code===3?'timeout':'unavailable');
      },{enableHighAccuracy:true,maximumAge:0,timeout:FIRST_FIX_MS});
      if(generation===this.#generation) this.#watch=id;
      else this.geolocation.clearWatch(id); // Also handles synchronous test adapters.
    } catch {if(generation===this.#generation)this.stop('unavailable');}
    // Permission monitoring is optional. watchPosition still enforces permission.
    if(generation===this.#generation && this.permissions?.query) {
      Promise.resolve().then(()=>this.permissions.query({name:'geolocation'})).then(permission=>{
        if(generation!==this.#generation)return;
        const changed=()=>{if(generation===this.#generation && permission.state==='denied')this.stop('denied');};
        this.#permission=permission;this.#permissionListener=changed;
        permission.addEventListener('change',changed);changed();
      }).catch(()=>{});
    }
  }
  #position(generation,position) {
    if(generation!==this.#generation)return;
    this.#check();
    if(generation!==this.#generation)return;
    const at=this.now(),tick=this.monotonic(),observedAt=position?.timestamp,coords=position?.coords;
    if(!clockValid(observedAt) || observedAt-at>LOCATION_POLICY.futureToleranceMs) {this.#publish('invalid',true);return;}
    // Ignore reordered/duplicate fixes; they must never extend the lifetime.
    if(observedAt<=this.#lastObserved)return;
    const age=Math.max(0,at-observedAt);
    if(age>=LOCATION_POLICY.maxAgeMs) {this.#publish('stale',true);return;}
    if(!Number.isFinite(coords?.latitude)||Math.abs(coords.latitude)>90||
      !Number.isFinite(coords?.longitude)||Math.abs(coords.longitude)>180) {this.#publish('invalid',true);return;}
    if(!Number.isFinite(coords.accuracy)||coords.accuracy<=0||coords.accuracy>LOCATION_POLICY.maxAccuracyMeters) {
      this.#publish('inaccurate',true);return;
    }
    this.#lastObserved=observedAt;this.#fixAt=at;this.#fixTick=tick;this.#received=true;
    const fix=Object.freeze({point:Object.freeze({latitude:coords.latitude,longitude:coords.longitude}),
      observedAt,accuracyMeters:coords.accuracy,source:'browser',consent:true,
      validUntil:Math.min(at+LOCATION_POLICY.maxAgeMs-age,this.#startAt+MAX_SESSION_MS)});
    this.#publish('ready',true,fix);
  }
}

export function locationView(state) {
  const messages={
    idle:['위치 확인을 시작해 볼까요?','동의한 뒤 시작하면 이 브라우저의 위치 수신 상태를 확인해요.'],
    requesting:['위치를 확인하고 있어요','브라우저의 위치 권한 안내를 확인해 주세요. 최대 12초 동안 기다려요.'],
    ready:['위치를 받아왔어요','위치는 이 화면에서만 사용해요. 차량이나 서버에는 전송하지 않아요.'],
    inaccurate:['더 정확한 위치가 필요해요','현재 위치의 오차가 크거나 정확도 정보가 없어요. 이전 위치는 숨겼어요.'],
    stale:['위치가 오래됐어요','30초 이내의 새로운 위치를 기다리고 있어요. 이전 위치는 숨겼어요.'],
    denied:['위치 권한을 확인해 주세요','권한이 거부되거나 사용할 수 없어요. 브라우저 설정을 확인한 뒤 다시 시작해 주세요.'],
    timeout:['위치를 받는 데 시간이 걸려요','위치 확인을 멈췄어요. 수신이 가능한 곳에서 다시 시작해 주세요.'],
    unavailable:['위치를 받을 수 없어요','기기의 위치 서비스와 연결 상태를 확인한 뒤 다시 시작해 주세요.'],
    invalid:['위치 정보를 확인하지 못했어요','유효한 새 위치를 기다리고 있어요. 이전 위치는 숨겼어요.'],
    hidden:['화면을 떠나 확인을 멈췄어요','이전 위치를 지웠어요. 계속하려면 다시 동의하고 시작해 주세요.'],
    stopped:['위치 확인을 멈췄어요','이 화면이 보관하던 위치를 지웠어요. 브라우저의 권한 설정은 그대로예요.'],
    finished:['위치 확인을 마쳤어요','2분이 지나 자동으로 멈추고 위치를 지웠어요. 필요하면 다시 시작해 주세요.'],
    insecure:['보안 연결이 필요해요','위치 확인은 보안 연결 또는 이 컴퓨터의 로컬 확인 화면에서 사용할 수 있어요.'],
    unsupported:['위치 확인을 지원하지 않아요','위치를 지원하는 브라우저에서 열어 주세요.'],
    'consent-required':['먼저 동의해 주세요','위치를 이 브라우저에서 확인하는 데 동의한 경우에만 시작해요.'],
    'clock-invalid':['기기의 시간을 확인해 주세요','시간이 바뀌어 위치 확인을 멈췄어요. 시간을 확인한 뒤 다시 시작해 주세요.']
  };
  const [title,copy]=messages[state.status]??messages.unavailable;
  return {title,copy,canStart:!state.active,canStop:state.active,
    accuracy:state.fix?`약 ${Math.ceil(state.fix.accuracyMeters)}m`:'',
    observedAt:state.fix?.observedAt??null};
}
