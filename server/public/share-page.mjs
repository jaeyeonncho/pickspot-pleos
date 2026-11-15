import {renderRoutingConsent} from './routing-consent.mjs';
import {renderSharedRecommendation} from './shared-recommendation.mjs';
import {invitationCode} from './invitation-link.mjs';
import {BrowserLocation,locationView} from './browser-location.mjs';
import {ShareApi} from './share-api.mjs';
import {ShareClient,restoreShare,shareView} from './share-client.mjs';
const $=id=>document.getElementById(id),key='pickspot-live-share';
let client=null,credentials=null,simulation=false,sharedRecommendations=false,joining=false,fakeTimer=null,suppressCapture=false,renderedStatus=null,recommendationSession=null;
let linkedCode=null,invalidLink=false,serverReady=false,routingEnabled=false,routingDisclosure=null;
try{linkedCode=invitationCode(window.location.hash);}catch{invalidLink=true;}
const notice=text=>{$('notice').hidden=!text;$('notice').textContent=text;};
function showJoin() {
  $('join-panel').hidden=false;
  $('join-title').textContent=linkedCode?'이 픽업에 참가할까요?':'연결 코드를 입력해 주세요';
  $('join-help').hidden=!linkedCode;
  $('code-fields').hidden=!!linkedCode;
  $('use-code').hidden=!linkedCode;
  $('join').textContent=linkedCode?'이 픽업에 참가하기':'픽업에 참여하기';
  $('join').disabled=!serverReady||joining;
  if(linkedCode)$('code').value=linkedCode;
}
const save=value=>{credentials=value;try{value?sessionStorage.setItem(key,JSON.stringify(value)):sessionStorage.removeItem(key);}catch{}};
const capture=new BrowserLocation({geolocation:navigator.geolocation,permissions:navigator.permissions,secure:window.isSecureContext,visible:()=>!document.hidden,
  onChange:state=>{
    if(suppressCapture)return;
    if(state.fix)client?.push(state.fix);
    else if(['inaccurate','stale','invalid'].includes(state.status)||!state.active&&state.status!=='idle') {
      notice(locationView(state).copy);void client?.stop();
    }
  }});
function stopCapture(){suppressCapture=true;capture.stop();suppressCapture=false;clearInterval(fakeTimer);fakeTimer=null;}
function renderStatus(state) {
  const view=shareView(state);
  const copy=sharedRecommendations&&view.activeSharing?'가상 위치가 전달됐어요. 아래 후보는 시연용 이동시간이며 실제 픽업 경로가 아니에요.':view.copy;
  if($('share-title').textContent!==view.title)$('share-title').textContent=view.title;
  if($('share-copy').textContent!==copy)$('share-copy').textContent=copy;
  if($('share-freshness').textContent!==view.freshness)$('share-freshness').textContent=view.freshness;
  return view;
}
function render(state) {
  renderRoutingConsent($,routingDisclosure,state);
  const view=renderStatus(state);
  if(!view.activeSharing)recommendationSession=null;
  renderSharedRecommendation($('shared-recommendation'),recommendationSession);
  if(renderedStatus!==state.status&&['stopped','stop-pending','closed'].includes(state.status))$('share-consent').checked=false;
  renderedStatus=state.status;
  $('share-start').disabled=!view.canStart||!$('share-consent').checked;$('share-start').hidden=!view.canStart;
  $('share-stop').hidden=!view.canStop;
  $('sharing-panel').hidden=state.status==='closed';$('closed-panel').hidden=state.status!=='closed';
}
function attach(value,{restoring=false}={}) {
  routingDisclosure=null;$('routing-consent').checked=false;$('share-consent').checked=false;
  save(value);const api=new ShareApi({credentials:value});
  client=new ShareClient({api,credentials:value,save,onChange:render,stopCapture,onSession:session=>{recommendationSession=session;render(client.state);}});
  $('join-panel').hidden=true;$('sharing-panel').hidden=false;render(client.state);
  if(routingEnabled&&!restoring)void loadRoutingConsent(client);
}
async function loadRoutingConsent(current) {
  const value=await current.loadRoutingDisclosure();
  if(client!==current)return;
  routingDisclosure=value;$('routing-consent').checked=false;render(current.state);
  if(!value&&current.state.status!=='closed')notice('경로 계산 동의 안내를 확인하지 못했어요. 위치 공유만 시작하거나 새로고침 후 다시 확인해 주세요.');
}
function syntheticFix(){const at=Date.now();client?.push({point:{latitude:37.4859,longitude:127.0348},observedAt:at,accuracyMeters:12,source:'browser',consent:true,validUntil:at+30000});}
async function joinMeeting() {
  if(!serverReady||joining||client)return;joining=true;$('join').disabled=true;notice('');
  try {
    const code=$('code').value.toUpperCase().replace(/\s/g,'');if(!/^[A-F0-9]{12}$/.test(code))throw new Error('INVALID_CODE');
    const result=await new ShareApi().request('/v1/invitations/redeem','POST',{code});
    attach({id:result.session.id,token:result.passengerToken,expiresAt:result.session.expiresAt,stopId:null});$('code').value='';
    linkedCode=null;
    try{history.replaceState(null,'',window.location.pathname+window.location.search);}catch{}
  }catch{notice('링크나 코드가 만료됐거나 이미 사용됐을 수 있어요. 연결을 확인하고 새 링크를 받아 주세요.');}
  finally{joining=false;$('join').disabled=false;}
}
$('join-form').addEventListener('submit',event=>{event.preventDefault();void joinMeeting();});
$('use-code').addEventListener('click',()=>{if(joining)return;linkedCode=null;invalidLink=false;$('code').value='';notice('');try{history.replaceState(null,'',window.location.pathname+window.location.search);}catch{}showJoin();});
$('share-consent').addEventListener('change',()=>{if(!$('share-consent').checked&&client&&!['idle','stopped'].includes(client.state.status))void client.stop();else if(client)render(client.state);});
$('routing-consent').addEventListener('change',()=>{if(client)render(client.state);});
$('routing-stop').addEventListener('click',()=>void client?.stop());
$('share-start').addEventListener('click',async()=>{
  if(!client)return;notice('');
  const current=client,routingConsent=$('routing-consent').checked&&!!routingDisclosure;
  if(await current.start({consent:$('share-consent').checked,routingConsent,...(routingConsent?{disclosureId:routingDisclosure.id}:{})})) {
    if(document.hidden){void current.stop();return;}
    if(simulation){syntheticFix();fakeTimer=setInterval(syntheticFix,5000);}else {
      try{capture.start({consent:true});}
      catch{notice('위치 확인을 시작하지 못했어요. 공유를 중지했으니 새로고침 후 다시 시도해 주세요.');await current.stop();}
    }
  }else if(routingConsent&&client===current){
    $('routing-consent').checked=false;
    notice('경로 계산 동의를 확인하지 못했어요. 안내를 다시 확인하고 선택해 주세요. 위치는 자동으로 다시 보내지 않아요.');
    void loadRoutingConsent(current);
  }
});
$('share-stop').addEventListener('click',()=>void client?.stop());
$('another').addEventListener('click',()=>{client=null;save(null);$('closed-panel').hidden=true;showJoin();});
document.addEventListener('visibilitychange',()=>{if(document.hidden&&client)void client.stop({keepalive:true});else void client?.check();});
window.addEventListener('pagehide',()=>{if(client)void client.stop({keepalive:true});});
window.addEventListener('offline',()=>{if(client)void client.stop();});
window.addEventListener('online',()=>{if(!document.hidden)void client?.check();});
window.addEventListener('hashchange',()=>{
  try{linkedCode=invitationCode(window.location.hash);invalidLink=false;}
  catch{linkedCode=null;invalidLink=true;if(!client)showJoin();notice('참여 링크가 올바르지 않아요. 새 링크를 받거나 연결 코드를 입력해 주세요.');return;}
  if(!serverReady)return;
  if(client?.state.status==='closed'){client=null;save(null);$('closed-panel').hidden=true;$('join-panel').hidden=false;}
  if(!client){notice('');showJoin();}
  else notice('현재 참여 중인 픽업이 있어요. 픽업 종료 후 새 링크로 참여해 주세요.');
});
setInterval(()=>{if(!document.hidden)void client?.check();},5000);
setInterval(()=>{if(client)renderStatus(client.state);renderSharedRecommendation($('shared-recommendation'),recommendationSession);},1000);
try {
  const health=await new ShareApi().request('/health');
  if(health.service!=='pickspot-sharing'||typeof health.simulation!=='boolean')throw new Error('WRONG_SERVER');
  simulation=health.simulation;sharedRecommendations=health.sharedRecommendations===true;
  routingEnabled=!simulation&&health.passengerRoutingConsent===true;

  $('mode-label').textContent=simulation?'공유 흐름 시뮬레이션 · 가상 위치':'이 픽업에만 위치 공유';
  $('mode-copy').textContent=simulation?'고정 가상 위치로 공유·중지 흐름을 확인해요. 실제 기기 위치는 읽지 않아요.':'동의하면 현재 위치를 이 픽업의 서버로 전달해요. 공유는 언제든 멈출 수 있어요.';
  if(health.sharedRecommendations)$('mode-copy').textContent='고정 가상 위치를 공유하면 예제 후보를 함께 비교해요. 실제 위치·경로가 아니에요.';
  $('scope-copy').textContent=simulation?'이 시뮬레이션은 같은 컴퓨터의 서버에 고정 가상 좌표만 전달해요.':'기기 위치·측정시각·정확도를 이 픽업의 서버에 전달해요. 위치는 최대 30초간 유효하며 이후 서버가 지워요. 화면을 떠나거나 2분이 지나면 공유가 멈춰요.';
  if(!simulation&&health.hosting==='render-free')$('scope-copy').textContent='휴대폰 연결 테스트를 위해 기기 위치·측정시각·정확도를 Render에 호스팅한 픽스팟 서버로 전달해요. 위치는 메모리에서 최대 30초간 유효하며 이후 지워요. TMAP으로 보내지 않아요. 화면을 떠나거나 2분이 지나면 공유가 멈춰요.';
  if(routingEnabled){
    $('mode-copy').textContent='이 픽업에 위치를 공유하고, 원하면 경로 계산에도 따로 동의할 수 있어요.';
    $('sharing-limits').textContent='화면을 떠나거나 연결이 끊기면 수집을 멈춰요. 서버 삭제를 확인하기 전에는 다시 공유하지 않아요. 경로 비교 결과는 차량에서 확인하며 내비 안내를 자동으로 바꾸지 않아요.';
  }
  $('consent-copy').textContent=simulation?'이 픽업에 가상 위치를 공유해 볼게요.':'이 픽업을 위해 기기 위치를 서버에 공유하는 데 동의해요.';
  $('join').disabled=false;
  serverReady=true;
  let restored;try{restored=restoreShare(sessionStorage.getItem(key));}catch{}
  if(restored){attach(restored,{restoring:true});await client.restore();if(routingEnabled&&client.state.status!=='closed')await loadRoutingConsent(client);}
  if(linkedCode&&client?.state.status==='closed'){client=null;save(null);$('closed-panel').hidden=true;$('join-panel').hidden=false;}
  if(!client)showJoin();
  else if(linkedCode&&client){notice('이 브라우저에서 참여했던 픽업을 먼저 확인했어요. 픽업 종료 후 ‘다른 픽업에 참여하기’를 누르면 새 링크로 연결돼요.');}
  if(invalidLink){notice('참여 링크가 올바르지 않아요. 새 링크를 받거나 연결 코드를 입력해 주세요.');}
}catch{notice('공유 서버에 연결하지 못했어요. 서버 실행 상태를 확인하고 새로고침해 주세요.');}
