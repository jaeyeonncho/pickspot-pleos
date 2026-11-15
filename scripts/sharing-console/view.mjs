export function consoleView(state,now=Date.now()) {
  const phase=state?.phase??'idle';
  const fresh=state?.connected===true&&Number.isFinite(state.checkedAt)&&now>=state.checkedAt&&now-state.checkedAt<10_000;
  const labels={idle:['휴대폰으로 연결해 볼까요?','새 픽업을 만들면 휴대폰에 보낼 참가 링크가 나타나요.'],
    creating:['참가 링크를 만들고 있어요','무료 테스트 서버가 깨어나는 데 최대 1분 정도 걸릴 수 있어요.'],
    ending:['픽업을 종료하고 있어요','서버에서 종료를 확인할 때까지 잠시 기다려 주세요.'],
    ended:['픽업이 끝났어요','서버에서 종료를 확인했어요. 새 픽업으로 다시 시험할 수 있어요.'],
    expired:['픽업이 만료됐어요','서버에서 만료를 확인했어요. 새 참가 링크를 만들어 주세요.'],
    'configuration-error':['연결 설정을 확인해 주세요','비공개 서버 설정을 읽지 못했어요. 설정을 확인한 뒤 다시 만들 수 있어요.'],
    'create-unknown':['생성 결과를 확인하지 못했어요','중복 생성을 막기 위해 다시 만들지 않아요. 설정과 서버를 확인해 주세요. 생성됐다면 픽업은 최대 15분 후 만료돼요.'],
    'end-unknown':['종료 확인이 필요해요','휴대폰에서 위치 공유를 중지해 주세요. 아래 버튼으로 서버 종료를 다시 확인할 수 있어요.']};
  let [title,copy]=labels[phase]??['연결을 확인하고 있어요','현재 상태를 확인한 뒤 안내할게요.'];
  if(phase==='active') {
    const sharing={ready:['위치가 전달됐어요','휴대폰의 최신 위치 수신을 확인했어요. 좌표는 이 관리 화면에 표시하지 않아요.'],
      withdrawn:['위치 공유가 중지됐어요','서버에서 위치 공유 철회를 확인했어요. 테스트가 끝났으면 픽업을 종료해 주세요.'],
      waiting:['새 위치를 기다리고 있어요','휴대폰에서 위치 공유와 브라우저 위치 권한을 허용해 주세요.'],
      stale:['새 위치 확인이 필요해요','이전 위치가 오래되어 현재 위치로 사용하지 않아요. 휴대폰의 공유 상태를 확인해 주세요.'],
      invalid:['사용할 수 있는 위치를 기다려요','휴대폰에서 위치 정확도와 공유 상태를 확인해 주세요.'],
      'not-sharing':state.invitation?['휴대폰에서 링크를 열어 주세요','참가 확인 후 위치 공유에 동의하면 수신 상태를 여기서 확인할 수 있어요.']:['동승자가 참가했어요','휴대폰에서 위치 공유를 시작해 주세요. 사용한 초대 링크는 숨겼어요.']};
    [title,copy]=fresh?(sharing[state.locationShare]??['공유 상태를 확인해 주세요','휴대폰 화면을 확인해 주세요.']):['서버 연결을 확인하고 있어요','이전 수신 상태와 참가 링크를 잠시 숨겼어요.'];
  }
  const remaining=Number.isFinite(state?.expiresAt)?Math.max(0,Math.ceil((state.expiresAt-now)/1000)):null;
  const invitation=phase==='active'&&fresh&&remaining>0?state.invitation:null;
  return {title,copy,invitation,remaining,canCreate:state?.canCreate===true,canEnd:state?.canEnd===true,
    canCopy:!!invitation&&!state.mode.includes('demo'),endLabel:phase==='end-unknown'?'픽업 종료 다시 확인':'픽업 종료',
    freshness:phase==='active'&&fresh?`${Math.floor((now-state.checkedAt)/1000)}초 전 확인`:''};
}

export function pairingCode(value) {
  if(typeof value!=='string')return null;
  const code=value.replace(/\s/g,'').toUpperCase();
  return /^[A-F0-9]{12}$/.test(code)?code:null;
}
export function pairingView(state,localConnected=true,now=Date.now()) {
  const fresh=localConnected&&state?.connected===true&&Number.isFinite(state.checkedAt)&&
    state.checkedAt<=now&&now-state.checkedAt<10000&&state.expiresAt>now;
  const active=state?.phase==='active';
  const canAct=active&&fresh&&state?.canPair===true;
  let title='차량 연결을 준비해요',copy='먼저 픽업을 만들어 주세요.';
  if(active){
    if(!fresh){title='차량 연결 상태를 확인하고 있어요';copy='서버 확인 후 연결을 승인하거나 해제할 수 있어요.';}
    else if(state.vehicleConnected===true){title='차량이 연결됐어요';copy='차량에서 별도로 확인한 뒤 경로를 비교할 수 있어요.';}
    else if(state.pairingStatus==='approved'){title='차량 승인을 전달했어요';copy='차량에서 연결 완료를 기다려 주세요. 코드가 만료되면 새 코드로 다시 연결해 주세요.';}
    else if(state.pairingStatus==='unknown'){title='차량 처리 결과를 확인하지 못했어요';copy='차량 화면을 확인해 주세요. 확실히 끊으려면 연결 해제를 눌러 주세요.';}
    else if(state.pairingStatus==='disconnected'){title='차량 연결을 해제했어요';copy='다시 연결하려면 차량에서 새 코드를 만들어 주세요.';}
    else {title='차량 코드를 확인해 주세요';copy='차량에 표시된 코드를 입력하고 직접 승인해 주세요.';}
    if(state.pairingStatus==='working'){title='차량 연결 요청을 처리하고 있어요';copy='처리가 끝날 때까지 잠시 기다려 주세요.';}
  }
  return {title,copy,canAct,showForm:active&&state?.pairingAvailable===true};
}
