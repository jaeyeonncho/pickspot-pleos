import {renderSharedRecommendation} from './shared-recommendation.mjs';
import {ShareApi} from './share-api.mjs';
import {invitationLink} from './invitation-link.mjs';
const $=id=>document.getElementById(id);let api=null,busy=false,recommendationSession=null,visibilityRevision=0;
const notice=text=>{$('notice').hidden=!text;$('notice').textContent=text;};
function render(session) {
  recommendationSession=session;renderSharedRecommendation($('shared-recommendation'),session);
  $('invite').hidden=!session.inviteCode;$('invite-code').textContent=session.inviteCode??'';
  if(session.inviteCode)$('invite-link').href=invitationLink(window.location.origin,session.inviteCode);
  const status=session.locationShare?.status;
  const titles={'not-sharing':'동승자 연결과 동의를 기다려요',waiting:'동승자 위치를 기다려요',ready:'가상 위치가 전달됐어요',stale:'새 위치가 필요해요',withdrawn:'동승자가 공유를 멈췄어요',invalid:'위치 정보를 다시 확인해야 해요'};
  $('driver-title').textContent=titles[status]??'공유 상태를 확인하고 있어요';
  $('driver-copy').textContent=status==='ready'?'서버가 가상 위치를 수신했어요. 실제 경로 계산은 아직 연결 전이에요.':status==='withdrawn'?'서버의 위치가 삭제됐어요. 다시 공유하려면 동승자가 동의해야 해요.':'위치 공유 상태만 확인하며 차량 내비는 바꾸지 않아요.';
}
function ended() {recommendationSession=null;renderSharedRecommendation($('shared-recommendation'),null);api=null;$('create').hidden=false;$('end').hidden=true;$('invite').hidden=true;$('invite-code').textContent='';$('driver-title').textContent='만남이 끝났어요';$('driver-copy').textContent='이 만남의 위치와 공유 권한이 제거됐어요.';}
$('create').addEventListener('click',async()=>{
  if(busy||api)return;busy=true;$('create').disabled=true;notice('');
  try{const result=await new ShareApi().request('/v1/sessions','POST',{});api=new ShareApi({credentials:{id:result.session.id,token:result.driverToken}});$('create').hidden=true;$('end').hidden=false;render(result.session);}
  catch{notice('만남을 만들지 못했어요. 연결을 확인해 주세요.');}finally{busy=false;$('create').disabled=false;}
});
$('end').addEventListener('click',async()=>{if(!api||busy)return;busy=true;try{await api.end();ended();notice('');}catch{notice('종료를 확인하지 못했어요. 연결 후 다시 눌러 주세요.');}finally{busy=false;}});
setInterval(async()=>{if(!api||busy||document.hidden)return;const current=api,revision=visibilityRevision;busy=true;try{const result=await current.read();if(api===current&&revision===visibilityRevision&&!document.hidden){render(result);notice('');}}catch(error){if([401,403,404,410].includes(error.status))ended();else{ recommendationSession=null;renderSharedRecommendation($('shared-recommendation'),null);$('driver-title').textContent='연결을 다시 확인하고 있어요';$('driver-copy').textContent='이전 위치 상태를 숨겼어요.';}}finally{busy=false;}},3000);

setInterval(()=>renderSharedRecommendation($('shared-recommendation'),recommendationSession),1000);
document.addEventListener('visibilitychange',()=>{visibilityRevision++;if(document.hidden){recommendationSession=null;renderSharedRecommendation($('shared-recommendation'),null);}});
