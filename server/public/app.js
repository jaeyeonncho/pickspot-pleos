import {meetingView,routeDescription} from './meeting-state.mjs';
import {ConnectionRecovery,restoreCredentials} from './recovery.mjs';
const recovery=new ConnectionRecovery();
const $ = id => document.getElementById(id);
let credentials = null, session = null, busy = false, timer = null, requestGeneration = 0;
try { credentials = restoreCredentials(sessionStorage.getItem('pickspot-passenger')); } catch { /* start fresh */ }
const show = (id,visible) => { $(id).hidden = !visible; };
const notice = text => { $('notice').textContent = text; show('notice',!!text); };
const duration = seconds => seconds == null ? '정보 없음' : seconds < 60 ? `${seconds}초` : `${Math.ceil(seconds/60)}분`;
function saveCredentials(value) {
  credentials = value;
  try { value ? sessionStorage.setItem('pickspot-passenger',JSON.stringify(value)) : sessionStorage.removeItem('pickspot-passenger'); } catch { /* memory-only fallback */ }
}
async function api(path,method='GET',body) {
  const controller = new AbortController(); const timeout = setTimeout(()=>controller.abort(),8000);
  try {
    const response = await fetch(path,{method,cache:'no-store',signal:controller.signal,
      headers:{...(body ? {'Content-Type':'application/json'} : {}),...(credentials ? {Authorization:`Bearer ${credentials.token}`} : {})},
      ...(body ? {body:JSON.stringify(body)} : {})});
    const data = await response.json();
    if (!response.ok) throw Object.assign(new Error(data.error),{status:response.status});
    return data;
  } finally { clearTimeout(timeout); }
}
function stopPoll() { clearTimeout(timer); timer = null; }
function finish(expired=false) {
  requestGeneration++; stopPoll(); saveCredentials(null); session=null;
  ['join-panel','consent-panel','meeting-panel','session-actions'].forEach(id=>show(id,false));
  $('destination-name').textContent=''; $('destination-note').textContent=''; $('walk').textContent=''; $('detour').textContent=''; $('route-summary').textContent='';
  $('ended-title').textContent = expired ? '만남이 끝났어요' : '위치 공유를 마쳤어요';
  show('ended-panel',true); notice('');
}
function render() {
  if (!session || !recovery.connected || credentials?.ending) return;
  if (session.expiresAt <= Date.now()) { finish(true); return; }
  show('join-panel',false); show('ended-panel',false); show('session-actions',true);
  const active = session.status === 'active';
  show('consent-panel',!active); show('meeting-panel',active);
  const view = meetingView(session); const {candidate,status} = view;
  show('destination',!!candidate);
  $('destination-name').textContent=''; $('destination-note').textContent=''; $('walk').textContent=''; $('detour').textContent='';
  if (candidate) {
    $('destination-name').textContent=candidate.name; $('destination-note').textContent=session.route?.synthetic===true?'만날 위치를 운전자와 함께 확인해 주세요.':candidate.note;
    $('walk').textContent=duration(candidate.walkSeconds); $('detour').textContent=duration(candidate.detourSeconds);
  }
  $('meeting-title').textContent=view.title; $('meeting-copy').textContent=view.copy;
  const route=session.route;
  show('route-summary',!!route);
  $('route-summary').textContent=route ? `${route.destinationName.replace(/^예제 목적지 · /,'')} · ${routeDescription(route)}${route.completedAt && route.status==='ready' ? ` · ${new Date(route.completedAt).toLocaleTimeString('ko-KR')} 계산` : ''}` : '';
  $('selection-step').textContent = candidate ? '만날 지점 확정됨' : '만날 지점 선택 대기';
  $('selection-step').className=candidate?'done':'';
  $('navigation-step').textContent = status === 'confirmed' ? '차량 내비 목적지 확인됨' : status === 'failed' ? '내비 설정 재확인 필요' : status === 'not-requested' ? '지점 확정 완료 · 내비 안내는 그대로예요' : '차량 내비 설정 대기';
  $('navigation-step').className=status==='confirmed'?'done':'';
  $('expiry').textContent=`이 만남은 ${new Date(session.expiresAt).toLocaleTimeString('ko-KR',{hour:'2-digit',minute:'2-digit'})}까지 유효해요.`;
}
function handleError(error) {
  if ([401,403,404,410].includes(error.status) && credentials) { finish(true); return; }
  // Never leave a potentially stale meeting point looking current after a connection failure.
  show('meeting-panel',false); show('consent-panel',false);
  recovery.failure();
  notice(credentials?.ending ? '공유 종료 요청을 확인 중이에요. 연결되면 종료를 다시 요청해요.' : error.status===429 ? '잠시 후 자동으로 다시 확인할게요.' : '연결이 끊겨 이전 정보를 숨겼어요. 자동으로 다시 연결하고 있어요.');
}
function schedule(delay=recovery.delay) { stopPoll(); if(credentials && !document.hidden) timer=setTimeout(()=>credentials?.ending?endMeeting():refresh(),delay); }
async function refresh() {
  if (!credentials || busy) return;
  if(credentials.ending){endMeeting();return;}
  busy=true; const generation=++requestGeneration;
  try {
    const value=await api(`/v1/sessions/${credentials.id}`);
    if(generation!==requestGeneration)return;
    session=value; recovery.success(); saveCredentials({...credentials,expiresAt:value.expiresAt}); notice(''); render();
  } catch(error) { if(generation===requestGeneration) {stopPoll();handleError(error);} }
  finally {busy=false;schedule();}
}
$('join-form').addEventListener('submit',async event=>{
  event.preventDefault(); if(busy)return;busy=true;$('join').disabled=true;notice(''); const generation=++requestGeneration;
  try {
    const code=$('code').value.toUpperCase().replace(/\s/g,'');
    if(!/^[A-F0-9]{12}$/.test(code)) {notice('차량 화면의 12자리 코드를 확인해 주세요.');return;}
    const result=await api('/v1/invitations/redeem','POST',{code});
    if(generation!==requestGeneration)return;
    saveCredentials({id:result.session.id,token:result.passengerToken,expiresAt:result.session.expiresAt}); session=result.session; recovery.success();
    $('code').value='';render();schedule();
  } catch(error) {notice(error.status===429?'잠시 후 다시 시도해 주세요.':'코드가 올바르지 않거나 이미 사용됐어요. 차량 화면을 확인해 주세요.');}
  finally {busy=false;$('join').disabled=false;}
});
$('consent').addEventListener('change',()=>{$('share').disabled=!$('consent').checked;});
$('share').addEventListener('click',async()=>{
  if(busy||!credentials||!$('consent').checked)return;
  busy=true;$('share').disabled=true;stopPoll(); const generation=++requestGeneration;
  try {const value=await api(`/v1/sessions/${credentials.id}/passenger-location`,'PUT',{consent:true,mode:'example'});if(generation!==requestGeneration)return;session=value;recovery.success();notice('');render();}
  catch(error){if(generation===requestGeneration)handleError(error);}
  finally{busy=false;$('share').disabled=!$('consent').checked;schedule();}
});
$('refresh').addEventListener('click',refresh);
async function endMeeting() {
  if(busy||!credentials)return;
  busy=true;stopPoll();const generation=++requestGeneration;
  try {await api(`/v1/sessions/${credentials.id}`,'DELETE');if(generation===requestGeneration)finish();}
  catch(error){if(generation===requestGeneration)handleError(error);}
  finally{busy=false;schedule();}
}
$('end').addEventListener('click',()=>{
  if(!credentials)return;
  saveCredentials({...credentials,ending:true});requestGeneration++;
  show('meeting-panel',false);show('consent-panel',false);
  notice('공유 종료를 요청하고 있어요.');
  endMeeting();
});
$('new-join').addEventListener('click',()=>{show('ended-panel',false);show('join-panel',true);$('consent').checked=false;$('share').disabled=true;$('code').focus();});
window.addEventListener('online',()=>{if(credentials&&!document.hidden)refresh();});
window.addEventListener('offline',()=>{if(credentials){handleError({});schedule();}});
document.addEventListener('visibilitychange',()=>{if(document.hidden)stopPoll();else refresh();});
setInterval(()=>{if((session?.expiresAt ?? credentials?.expiresAt ?? Infinity)<=Date.now())finish(true);else if(session?.route?.status==='ready' && session.route.validUntil<=Date.now()) {session={...session,candidates:[],selection:null,route:{...session.route,status:'stale'}};render();}},1000);
if(credentials) {show('join-panel',false);show('session-actions',true);notice(credentials.ending?'공유 종료 요청을 다시 확인하고 있어요.':'이전 만남을 다시 확인하고 있어요.');refresh();}
