import {BrowserLocation,locationView} from './browser-location.mjs';
const $=id=>document.getElementById(id);
const consent=$('location-consent');
function render(state) {
  const view=locationView(state);
  $('location-title').textContent=view.title;$('location-copy').textContent=view.copy;
  $('location-details').hidden=!state.fix;
  $('location-accuracy').textContent=view.accuracy?`수신 정확도 ${view.accuracy}`:'';
  $('location-time').textContent=view.observedAt?`${new Date(view.observedAt).toLocaleTimeString('ko-KR')}에 받은 위치`:'';
  $('location-start').disabled=!view.canStart||!consent.checked;
  $('location-start').hidden=state.active;
  $('location-stop').hidden=!view.canStop;
}
const location=new BrowserLocation({geolocation:navigator.geolocation,permissions:navigator.permissions,
  secure:window.isSecureContext,visible:()=>!document.hidden,onChange:render});
consent.addEventListener('change',()=>{if(!consent.checked)location.stop();render(location.snapshot());});
$('location-start').addEventListener('click',()=>location.start({consent:consent.checked}));
$('location-stop').addEventListener('click',()=>{consent.checked=false;location.stop();});
document.addEventListener('visibilitychange',()=>{
  if(document.hidden){consent.checked=false;location.stop('hidden');}
});
window.addEventListener('pagehide',()=>{consent.checked=false;location.stop();});
window.addEventListener('pageshow',()=>{consent.checked=false;location.stop('idle');});
render(location.snapshot());
