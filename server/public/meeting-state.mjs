// Pure presentation mapping, shared by browser rendering and tests.
export function routeDescription(route) {
  if(route?.source==='tmap'&&route.synthetic===false&&route.inputMode==='example')return 'TMAP 실제 경로 · 지정 위치 기준';
  if(route?.source==='synthetic-fixture'&&route.synthetic===true)return '지정 위치·고정 비교값 기준 · 실시간 교통 미반영';
  return '경로 출처 확인 필요';
}
export function routeFailureCopy(issue) {
  return {limit:'오늘 사용할 경로 조회량이 부족해요. 이전 후보는 숨겼어요.',
    configuration:'경로 서비스 연결 설정을 확인해야 해요. 이전 후보는 숨겼어요.',
    connection:'경로 서비스에 연결하지 못했어요. 잠시 후 운전자가 다시 시도할 수 있어요.'}[issue]??
    '이전 후보는 숨겼어요. 운전자가 재계산을 시도할 수 있어요.';
}
export function meetingView(session, now = Date.now()) {
  const route=session.route;
  const stale=route?.status === 'stale' || (route?.status === 'ready' && !(route.validUntil > now));
  const ready=!route || (route.status === 'ready' && !stale);
  const candidate=ready ? session.candidates.find(c=>c.id === session.selection?.candidateId) ?? null : null;
  const status=candidate ? session.selection.navigationStatus : null;
  let title='차량에서 지점을 고르고 있어요',copy='선택이 끝나면 픽업 지점이 여기에 표시돼요.';
  if(route?.status === 'calculating') {title='픽업 경로를 비교하고 있어요';copy='도보와 차량 우회시간을 계산한 뒤 후보를 표시해요.';}
  else if(stale) {title='경로를 다시 확인하고 있어요';copy='이전 계산의 유효시간이 지났어요. 운전자가 경로를 다시 계산할 수 있어요.';}
  else if(route?.status === 'failed') {title='경로를 계산하지 못했어요';copy=routeFailureCopy(route.issue);}
  else if(status === 'confirmed') {title='픽업 지점이 정해졌어요';copy='차량 내비의 목적지 설정을 확인했어요. 이동 중인지는 아직 알 수 없어요.';}
  else if(status === 'failed') {title='내비 설정을 다시 확인해 주세요';copy='지점은 선택됐지만 내비 설정을 확인하지 못했어요. 운전자가 다시 시도할 수 있어요.';}
  else if(status === 'not-requested') {title='픽업 지점이 정해졌어요';copy='차량과 같은 픽업 지점을 보고 있어요. 이 픽업 지점에서 기다려 주세요.';}
  else if(candidate) {title='차량 내비를 확인하고 있어요';copy='선택한 지점을 차량 내비에 전달하는 중이에요.';}
  return {title,copy,candidate,status,stale};
}
