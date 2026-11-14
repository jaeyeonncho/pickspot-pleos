import {createLiveApp} from './live-http.mjs';
import {sharingConfig} from './sharing-config.mjs';
try {
  const config=await sharingConfig();const server=createLiveApp(config);
  server.on('error',()=>{console.error('HTTPS 공유 서버를 시작하지 못했습니다. 주소·인증서·포트를 확인하세요.');process.exitCode=1;});
  server.listen(config.port,config.host,()=>console.log('픽스팟 HTTPS 공유 서버가 시작됐습니다. 위치 수신은 동승자의 명시적인 시작 후에만 가능합니다.'));
  const shutdown=()=>{server.close(()=>process.exit(0));setTimeout(()=>{server.closeAllConnections();},2000).unref();};
  process.once('SIGTERM',shutdown);process.once('SIGINT',shutdown);
}catch(error){
  const allowed=new Set(['HTTPS_ORIGIN_REQUIRED','DRIVER_KEY_REQUIRED','INVALID_PORT','INVALID_BIND_ADDRESS','TLS_FILES_REQUIRED','INVALID_TLS_FILE','TLS_KEY_MUST_BE_PRIVATE','TLS_FILES_UNREADABLE','INVALID_TLS_CERTIFICATE','TLS_CERTIFICATE_EXPIRED_OR_NOT_YET_VALID','TLS_CERTIFICATE_HOST_MISMATCH','INVALID_TLS_PRIVATE_KEY','TLS_KEY_CERTIFICATE_MISMATCH']);
  console.error(JSON.stringify({error:allowed.has(error.message)?error.message:'SHARING_SETUP_FAILED'}));process.exitCode=1;
}
