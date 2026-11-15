import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {createCompetitionApp} from '../server/competition-server.mjs';
const exec=promisify(execFile),root=fileURLToPath(new URL('../',import.meta.url));
const adb=process.env.ANDROID_HOME?join(process.env.ANDROID_HOME,'platform-tools/adb'):'adb';
const device=(args,options={})=>exec(adb,['-s','emulator-5554',...args],{timeout:15000,...options});
let server,createdReverse=false,stopping=false;
async function cleanup(){
  if(stopping)return;stopping=true;
  if(createdReverse)await device(['reverse','--remove','tcp:8788']).catch(()=>{});
  if(server?.listening)await new Promise(resolve=>{server.close(resolve);server.closeAllConnections();});
}
try {
  if(!['ranchu','goldfish'].includes((await device(['shell','getprop','ro.hardware'])).stdout.trim()))throw new Error('EMULATOR_REQUIRED');
  if((await device(['shell','getprop','sys.boot_completed'])).stdout.trim()!=='1'||
      (await device(['shell','am','get-current-user'])).stdout.trim()!=='10')throw new Error('VEHICLE_BOOT_REQUIRED');
  let health;
  try{const res=await fetch('http://127.0.0.1:8788/health',{signal:AbortSignal.timeout(1500)});if(res.ok)health=await res.json();}
  catch{}
  if(health){
    if(health.service!=='pickspot-local'||health.competitionDemo!==true||health.routingMode!=='fixture'||health.exampleOnly!==true)throw new Error('COMPETITION_PORT_IN_USE');
  }else {
    server=createCompetitionApp();
    await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(8788,'127.0.0.1',resolve);});
  }
  const mappings=(await device(['reverse','--list'])).stdout.trim().split('\n').map(line=>line.trim().split(/\s+/));
  const existing=mappings.find(row=>row[1]==='tcp:8788');
  if(existing&&existing[2]!=='tcp:8788')throw new Error('COMPETITION_FORWARD_IN_USE');
  if(!existing){await device(['reverse','--no-rebind','tcp:8788','tcp:8788']);createdReverse=true;}
  await device(['install','--user','10','-r',join(root,'artifacts/pickspot-demo.apk')],{timeout:30000});
  await device(['shell','am','force-stop','--user','10','dev.pickspot.app']);
  await device(['shell','am','start','--user','10','-a','android.intent.action.MAIN','-c','android.intent.category.LAUNCHER',
    '-n','dev.pickspot.app/.MainActivity','--es','demo_scenario','competition']);
  await exec('open',['http://127.0.0.1:8788/']);
  console.log('공모전 시연을 시작했어요. 차량의 참여 코드를 웹에 입력하고 예제 위치를 공유하세요.');
  console.log('후보 비교 → 지점 선택 → Pleos 이동시간 미리보기 → 픽업 종료 순서로 보여줄 수 있어요.');
  console.log('이 창을 열어 두세요. 종료: Control+C. 실제 위치·TMAP 호출·현장 확인 없이 진행해요.');
  // Hold the terminal even if another competition launcher owns the shared server.
  const keepAlive=setInterval(()=>{},60000);
  for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>{clearInterval(keepAlive);cleanup().then(()=>process.exit(0));});
} catch(error) {
  await cleanup();
  const known={EMULATOR_REQUIRED:'Pleos 가상 차량을 먼저 실행해 주세요.',VEHICLE_BOOT_REQUIRED:'가상 차량의 부팅이 끝난 뒤 다시 실행해 주세요.',
    COMPETITION_PORT_IN_USE:'8788에 다른 서버가 있어요. 기존 서버를 바꾸지 않았어요.',COMPETITION_FORWARD_IN_USE:'8788 연결이 다른 용도로 사용 중이에요.'};
  console.error(known[error.message]??'시연을 시작하지 못했어요. 가상 차량과 빌드 상태를 확인해 주세요.');process.exitCode=1;
}
