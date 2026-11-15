import {pairingView,pairingCode} from './view.mjs';
import {consoleView} from './view.mjs';
const $=id=>document.getElementById(id);
const text=(id,value)=>{if($(id).textContent!==value)$(id).textContent=value;};
let state=null,token=null,busy=false,reading=false,localConnected=false,lastLink=null,revision=0;
const notice=value=>{$('notice').hidden=!value;text('notice',value);};
function render() {
  const view=consoleView(localConnected?state:{...state,connected:false});
  text('mode',state?.mode?.includes('demo')?'가상 화면 검사 · 실제 픽업 아님':'이 Mac에서만 관리');
  if(state?.mode?.includes('demo'))notice(state.mode==='pairing-demo'?'가상 차량 연결 화면 검사 · 검사 코드는 ABCD EF12 3456이에요. 실제 차량·휴대폰·외부 서버에 연결하지 않아요.':'가상 화면 검사입니다. 수신·중지 상태는 예제이며 휴대폰이나 외부 서버에 연결하지 않아요.');
  text('status-title',view.title);text('status-copy',view.copy);text('freshness',view.freshness);
  $('create').hidden=!view.canCreate;$('create').disabled=busy||!localConnected;
  $('end').hidden=!view.canEnd;$('end').disabled=busy||!localConnected;text('end',view.endLabel);
  $('invitation').hidden=!view.invitation;
  const link=view.invitation?.url??'';
  if(link!==lastLink){$('invite-link').value=link;$('copy-result').textContent='';lastLink=link;}
  text('invite-code',view.invitation?.inviteCode.match(/.{1,4}/g)?.join(' ')??'');
  text('remaining',view.remaining===null?'':`링크 만료까지 ${Math.floor(view.remaining/60)}분 ${view.remaining%60}초`);
  $('copy').disabled=busy||!view.canCopy||!localConnected;
  const pairing=['routing','pairing-demo'].includes(state?.mode);
  $('vehicle-panel').hidden=!pairing;
  text('routing-note',pairing?'경로 비교는 차량과 동승자의 별도 동의 후에만 TMAP에 전달해요.':'실제 위치 공유 여부는 휴대폰에서 직접 선택하며, TMAP으로 보내지 않아요.');
  const pair=pairingView(state,localConnected);
  text('vehicle-title',pair.title);text('vehicle-status',pair.copy);
  $('vehicle-form').hidden=!pair.showForm;
  $('vehicle-approve').disabled=busy||!pair.canAct||!pairingCode($('vehicle-code').value);
  $('vehicle-revoke').disabled=busy||!pair.canAct;

}
async function request(path,method='GET',body={}) {
  const result=await fetch(path,{method,cache:'no-store',redirect:'error',signal:AbortSignal.timeout(65_000),
    ...(method==='POST'?{headers:{'Content-Type':'application/json','X-Pickspot-Console':token??''},body:JSON.stringify(body)}:{})});
  if(!result.ok)throw new Error('CONSOLE_REQUEST_FAILED');
  return result.json();
}
async function refresh() {
  if(reading||busy||document.hidden)return;
  reading=true;const epoch=revision;
  try {
    const result=await request('/api/state');
    if(busy||epoch!==revision)return; // A response started before an action must not overwrite its UI state.
    state=result.state;token=result.consoleToken;localConnected=true;if(!state.mode.includes('demo'))notice('');
  }catch {if(!busy&&epoch===revision){localConnected=false;notice('Mac의 관리 화면 연결을 확인해 주세요. 터미널 창이 켜져 있어야 해요.');}}
  finally{reading=false;render();}
}
async function act(path,body={}) {
  if(busy||!localConnected)return;
  busy=true;revision++;
  if(!path.startsWith('/api/vehicle/'))state={...state,phase:path==='/api/create'?'creating':'ending',canCreate:false,canEnd:false};
  else {$('vehicle-code').value='';state={...state,pairingStatus:'working'};}
  notice('');render();
  try {state=(await request(path,'POST',body)).state;localConnected=true;}
  catch {localConnected=false;notice('처리 결과를 확인하고 있어요. 같은 작업을 반복하지 말고 잠시 기다려 주세요.');}
  finally{busy=false;render();void refresh();}
}
$('create').addEventListener('click',()=>void act('/api/create'));
$('end').addEventListener('click',()=>void act('/api/end'));
$('copy').addEventListener('click',async()=>{
  const view=consoleView(state);if(!localConnected||!view.canCopy)return;
  const link=view.invitation.url;
  try {await navigator.clipboard.writeText(link);if(lastLink===link)$('copy-result').textContent='참가 링크를 복사했어요. 휴대폰으로 보내 주세요.';}
  catch {if(lastLink===link){$('invite-link').focus();$('invite-link').select();$('copy-result').textContent='링크를 선택했어요. ⌘C로 복사해 주세요.';}}
});
document.addEventListener('visibilitychange',()=>{if(!document.hidden)void refresh();});
window.addEventListener('online',()=>void refresh());
setInterval(()=>void refresh(),3000);setInterval(render,1000);void refresh();

$('vehicle-code').addEventListener('input',render);
$('vehicle-approve').addEventListener('click',()=>{
  const code=pairingCode($('vehicle-code').value);
  if(code&&pairingView(state,localConnected).canAct)void act('/api/vehicle/approve',{code});
});
$('vehicle-revoke').addEventListener('click',()=>{if(pairingView(state,localConnected).canAct)void act('/api/vehicle/revoke');});
