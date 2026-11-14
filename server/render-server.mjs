import {createLiveApp} from './live-http.mjs';
import {renderSharingConfig} from './render-config.mjs';
try {
  const config=renderSharingConfig();const server=createLiveApp(config);
  server.on('error',()=>{console.error('RENDER_SERVER_START_FAILED');process.exitCode=1;});
  server.listen(config.port,config.host,()=>console.log('픽스팟 공유 테스트 서버 준비 완료. 실제 경로 계산은 비활성 상태입니다.'));
  const shutdown=()=>{server.close(()=>process.exit(0));setTimeout(()=>server.closeAllConnections(),2000).unref();};
  process.once('SIGINT',shutdown);process.once('SIGTERM',shutdown);
}catch(error){
  const allowed=new Set(['RENDER_FREE_REQUIRED','RENDER_ORIGIN_REQUIRED','DRIVER_KEY_REQUIRED','INVALID_PORT','SINGLE_INSTANCE_REQUIRED','SHARING_ONLY_DEPLOYMENT']);
  console.error(allowed.has(error.message)?error.message:'RENDER_SETUP_FAILED');process.exitCode=1;
}
