import {ROUTING_CONSENT_VERSION} from '../shared/routing-consent-policy.mjs';

// Only a same-origin, authenticated server disclosure can enable the optional choice.
export function readRoutingDisclosure(value,origin,expiresAt,now=Date.now()) {
  let url;try{url=new URL(origin);}catch{throw new Error('INVALID_ROUTING_DISCLOSURE');}
  if(url.protocol!=='https:'||url.origin!==origin||value?.origin!==origin||value?.version!==ROUTING_CONSENT_VERSION||
    value?.routingProvider!=='tmap'||typeof value.id!=='string'||!/^[a-f0-9]{64}$/.test(value.id)||
    typeof value.processingRegion!=='string'||!value.processingRegion.trim()||value.processingRegion.length>100||/[\u0000-\u001f\u007f]/.test(value.processingRegion)||
    !Number.isSafeInteger(value.expiresAt)||value.expiresAt!==expiresAt||expiresAt<=now)throw new Error('INVALID_ROUTING_DISCLOSURE');
  return Object.freeze({id:value.id,version:value.version,origin,processingRegion:value.processingRegion,routingProvider:'tmap',expiresAt});
}
export function routingConsentView(disclosure,state) {
  const allowed=state?.routingProvider==='tmap'&&!['closed','stopped','stop-pending','idle'].includes(state?.status);
  return {visible:!!disclosure,canChoose:!!disclosure&&['idle','stopped'].includes(state?.status),canWithdraw:allowed,
    title:allowed?'경로 계산에도 동의했어요':'경로 계산은 따로 선택해요',
    recipient:disclosure?`픽스팟 서버: ${disclosure.origin} · 처리 지역: ${disclosure.processingRegion}`:'',
    status:allowed?'이 만남에서 차량이 비교를 요청하면 현재 위치를 TMAP 경로 계산에 사용할 수 있어요.':'선택하지 않아도 위치 공유는 가능해요. 선택만으로 경로를 계산하지 않아요.'};
}

// Reuses the existing page's typography and controls. Never renders server HTML.
export function renderRoutingConsent(element,disclosure,state) {
  const view=routingConsentView(disclosure,state);
  element('routing-consent-panel').hidden=!view.visible;
  for(const [id,value] of [['routing-title',view.title],['routing-recipient',view.recipient],['routing-status',view.status]]) {
    if(element(id).textContent!==value)element(id).textContent=value;
  }
  element('routing-consent').disabled=!view.canChoose;
  element('routing-stop').hidden=!view.canWithdraw;
  if(['stopped','stop-pending','closed'].includes(state?.status)||!disclosure)element('routing-consent').checked=false;
}
