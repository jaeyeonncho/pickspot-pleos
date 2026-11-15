import {ShareClient,shareView} from '/share-client.mjs';
import {renderRoutingConsent} from '/routing-consent.mjs';
import {ROUTING_CONSENT_VERSION} from '/shared/routing-consent-policy.mjs';
const $=id=>document.getElementById(id);
const expiresAt=Date.now()+900000,id='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',grantId='bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
let revision=0,provider=null,disclosure=null;
const api={origin:'https://example.test',
  routingDisclosure:async()=>({version:ROUTING_CONSENT_VERSION,id:'a'.repeat(64),origin:'https://example.test',processingRegion:'예제 지역 · 실제 서버 아님',routingProvider:'tmap',expiresAt}),
  read:async()=>({isDemo:false,locationShare:{revision,grantId,routingProvider:provider}}),
  grant:async body=>{revision++;provider=body.routingProvider??null;return {status:'waiting',grantId,routingProvider:provider};},
  update:async body=>({status:'ready',grantId,sequence:body.sequence,validUntil:Date.now()+30000,routingProvider:provider}),
  withdraw:async()=>{revision++;provider=null;return {status:'withdrawn',grantId:null};}};
function render(state){
  const view=shareView(state);renderRoutingConsent($,disclosure,state);
  $('share-title').textContent=view.title;$('share-copy').textContent=view.copy;$('share-freshness').textContent=view.freshness;
  if(['stop-pending','stopped','closed'].includes(state.status))$('share-consent').checked=false;
  $('share-start').hidden=!view.canStart;$('share-start').disabled=!view.canStart||!$('share-consent').checked;
  $('share-stop').hidden=!view.canStop;
}
const client=new ShareClient({api,credentials:{id,token:'p'.repeat(43),expiresAt},onChange:render});
$('join-panel').hidden=true;$('sharing-panel').hidden=false;$('mode-label').textContent='경로 동의 화면 · 예제 검사';
$('mode-copy').textContent='위치 공유와 경로 계산 동의를 따로 선택하는 화면이에요.';
$('notice').hidden=false;$('notice').textContent='예제 전용 화면입니다. 실제 위치·차량·외부 서버를 사용하지 않고, 버튼은 이 페이지의 가짜 상태만 바꿔요.';
$('scope-copy').textContent='아래 전송 안내는 제품 화면의 문구입니다. 이 예제에서는 위치를 수집하거나 보내지 않아요.';
$('consent-copy').textContent='이 픽업을 위해 기기 위치를 서버에 공유하는 데 동의해요.';
$('sharing-limits').textContent='공유와 철회는 예제 상태로만 표시해요. 새로고침하면 선택은 초기화돼요.';
$('footer-copy').textContent='브라우저 메모리만 사용하는 화면 검사 · 실제 위치/외부 전송 없음';
disclosure=await client.loadRoutingDisclosure();render(client.state);
$('share-consent').addEventListener('change',()=>{if(!$('share-consent').checked&&client.state.routingProvider)void client.stop();else render(client.state);});
$('routing-consent').addEventListener('change',()=>render(client.state));
$('share-start').addEventListener('click',async()=>{
  const routingConsent=$('routing-consent').checked;
  if(await client.start({consent:$('share-consent').checked,routingConsent,...(routingConsent?{disclosureId:disclosure.id}:{})})){
    const now=Date.now();client.push({point:{latitude:37.4859,longitude:127.0348},observedAt:now,accuracyMeters:12,source:'browser',consent:true,validUntil:now+30000});
  }
});
$('share-stop').addEventListener('click',()=>void client.stop());$('routing-stop').addEventListener('click',()=>void client.stop());
setInterval(()=>render(client.state),1000);
