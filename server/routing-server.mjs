import {fileURLToPath} from 'node:url';
import {createLiveApp} from './live-http.mjs';
import {routingConfiguration,createRoutingOptions} from './routing-config.mjs';
import {checkRoutingSetup,routingSetupError} from './check-routing-setup.mjs';

export async function prepareRoutingServer(options={}) {
  const config=await routingConfiguration(options);const appOptions=createRoutingOptions(config,options);
  let server;try{server=createLiveApp(appOptions);}catch(error){appOptions.store.dispose();throw error;}
  return {server,host:config.host,port:config.port};
}
if(process.argv[1]===fileURLToPath(import.meta.url)) {
  const args=process.argv.slice(2);
  if(args.length!==1||!['--check','--serve'].includes(args[0])){
    console.error(JSON.stringify({code:'EXPLICIT_ROUTING_MODE_REQUIRED',message:'--check는 설정만 검사하고, --serve는 검사 후 서버를 시작해요.'}));process.exitCode=1;
  }else if(args[0]==='--check'){
    const report=await checkRoutingSetup();console.log(JSON.stringify(report,null,2));if(!report.configurationReady)process.exitCode=1;
  }else {
    try {
      const {server,host,port}=await prepareRoutingServer();
      server.on('error',()=>{console.error(JSON.stringify({code:'ROUTING_LISTEN_FAILED',message:'경로 서버를 시작하지 못했어요. 수신 주소와 포트를 확인해 주세요.'}));server.close();process.exitCode=1;});
      server.listen(port,host,()=>console.log('픽스팟 직접 HTTPS 경로 서버가 시작됐어요. 차량 연결·양쪽 동의·검토 후보가 준비된 명시적 비교 요청만 계산해요.'));
      const shutdown=()=>{server.close();server.closeAllConnections();};process.once('SIGTERM',shutdown);process.once('SIGINT',shutdown);
    }catch(error){console.error(JSON.stringify(routingSetupError(error)));process.exitCode=1;}
  }
}
