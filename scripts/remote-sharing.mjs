import {open,constants} from 'node:fs/promises';
import {parseEnv} from 'node:util';
import {createInterface} from 'node:readline';
import {setTimeout as delay} from 'node:timers/promises';
import {RemoteSharingClient} from './remote-sharing-client.mjs';

let client,reader,stop=false,created=false;
const requestStop=()=>{stop=true;};
try {
  const file=await open(new URL('../.env.remote.local',import.meta.url),constants.O_RDONLY|constants.O_NOFOLLOW);
  let env;
  try {
    const stat=await file.stat();
    if(!stat.isFile()||stat.size>4096||(stat.mode&0o077))throw new Error('PRIVATE_CONFIG_REQUIRED');
    env=parseEnv(await file.readFile('utf8'));
  }finally{await file.close();}
  client=new RemoteSharingClient({origin:env.PICKSPOT_REMOTE_ORIGIN,driverKey:env.PICKSPOT_DRIVER_KEY});
  const invitation=await client.create();created=true;
  console.log(`휴대폰 주소: ${invitation.url}\n참여 코드: ${invitation.inviteCode}\n만료: ${new Date(invitation.expiresAt).toLocaleString('ko-KR')}\n공유 중지를 휴대폰에서 확인한 뒤 Enter를 누르면 픽업을 종료합니다.`);
  reader=createInterface({input:process.stdin,output:process.stdout});
  reader.on('line',requestStop);reader.on('close',requestStop);
  process.on('SIGINT',requestStop);process.on('SIGTERM',requestStop);
  let previous='';
  while(!stop&&Date.now()<invitation.expiresAt) {
    const status=await client.status(),message=JSON.stringify(status);
    if(message!==previous){
      const labels={'not-sharing':'공유 시작 전',ready:'최신 위치 수신 확인',stale:'위치가 오래됨',withdrawn:'공유 중지·위치 삭제 확인',waiting:'위치 수신 대기',invalid:'사용할 수 없는 위치',closed:'공유 종료',expired:'만료',unknown:'상태 확인 필요','clock-invalid':'기기 시간 확인 필요'};
      console.log(['ended','expired'].includes(status.status)?'픽업 종료 또는 만료 확인':labels[status.locationShare]);previous=message;
    }
    if(['ended','expired'].includes(status.status)){created=false;break;}
    await delay(3000);
  }
}catch{
  console.error('연결을 완료하지 못했어요. 비공개 설정 파일(권한 600)과 서버 상태를 확인하세요. 자동 재시도하지 않습니다.');
  process.exitCode=1;
}finally{
  if(created) {
    try{await client.end();console.log('서버에서 픽업 종료를 확인했어요.');}
    catch{console.error('서버 종료 확인에 실패했어요. 휴대폰에서 공유를 중지해 주세요. 픽업은 생성 후 최대 15분, 마지막 위치는 최대 30초 후 만료합니다.');process.exitCode=1;}
  }
  reader?.close();process.removeListener('SIGINT',requestStop);process.removeListener('SIGTERM',requestStop);
}
