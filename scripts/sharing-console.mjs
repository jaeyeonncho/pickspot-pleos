import {open,constants} from 'node:fs/promises';
import {parseEnv} from 'node:util';
import {RemoteSharingClient} from './remote-sharing-client.mjs';
import {SharingConsole} from './sharing-console-state.mjs';
import {createSharingConsoleServer} from './sharing-console-server.mjs';

async function createRemoteClient() {
  const file=await open(new URL(routing?'../.env.route-operator.local':'../.env.remote.local',import.meta.url),constants.O_RDONLY|constants.O_NOFOLLOW);
  try {
    const stat=await file.stat();
    if(!stat.isFile()||stat.size>4096||(stat.mode&0o077))throw new Error('PRIVATE_CONFIG_REQUIRED');
    const env=parseEnv(await file.readFile('utf8'));
    return new RemoteSharingClient({origin:env.PICKSPOT_REMOTE_ORIGIN,driverKey:env.PICKSPOT_DRIVER_KEY,timeoutMs:60_000,pairingEnabled:routing});
  }finally{await file.close();}
}
const pairingDemo=process.argv.length===3&&process.argv[2]==='--pairing-demo';
const routing=process.argv.length===3&&process.argv[2]==='--routing';
const demo=process.argv.length===3&&(process.argv[2]==='--demo'||pairingDemo);
if(process.argv.length>2&&!demo&&!routing)throw new Error('USE_NO_FLAGS_DEMO_PAIRING_DEMO_OR_ROUTING');
const controller=new SharingConsole({mode:pairingDemo?'pairing-demo':demo?'demo':routing?'routing':'remote',createClient:demo?()=>{
  let reads=0,vehicle=false;
  return {create:async()=>({url:'https://example.invalid/#join=A1B2C3D4E5F6',inviteCode:'A1B2C3D4E5F6',expiresAt:Date.now()+900000}),
    status:async()=>({status:'waiting',locationShare:++reads<3?'not-sharing':reads<6?'ready':'withdrawn',invitationAvailable:reads<3,pairingAvailable:pairingDemo,vehicleConnected:vehicle}),
    approveVehicle:async code=>{if(code!=='ABCDEF123456')throw new Error('EXAMPLE_CODE_REQUIRED');vehicle=true;return {status:'approved'};},
    revokeVehicle:async()=>{vehicle=false;return {status:'disconnected'};},
    end:async()=>({status:'ended'})};
}:createRemoteClient});
const server=createSharingConsoleServer(controller);
server.on('error',()=>{console.error('관리 화면을 열지 못했어요. 같은 관리 화면이 이미 실행 중인지 확인해 주세요.');process.exitCode=1;});
server.listen(pairingDemo?8796:demo?8794:8793,'127.0.0.1',()=>console.log(`픽스팟 ${demo?'가상 화면 검사':'휴대폰 테스트 관리'}: http://127.0.0.1:${server.address().port}/\n종료하려면 Control+C를 누르세요. 이 창이 켜져 있는 동안만 관리할 수 있어요.`));
let closing=false;
async function close() {
  if(closing)return;closing=true;
  console.log('진행 중인 픽업의 종료를 확인하고 있어요.');
  try {
    const state=await controller.close();
    console.log(['create-unknown','end-unknown'].includes(state.phase)?
      '종료를 확인하지 못했어요. 휴대폰에서 공유를 중지해 주세요. 픽업과 위치는 서버의 유효기간에 따라 만료돼요.':'관리 화면을 종료했어요.');
  }finally {server.close();server.closeAllConnections();}
}
process.on('SIGINT',()=>void close());process.on('SIGTERM',()=>void close());
