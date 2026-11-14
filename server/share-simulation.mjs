import {createLiveApp} from './live-http.mjs';
const port=Number(process.env.PICKSPOT_SHARE_PORT??8790);
const server=createLiveApp({simulation:true,sharedRecommendations:true});
server.on('error',()=>{console.error('공유 시뮬레이션 서버를 시작하지 못했습니다.');process.exitCode=1;});
server.listen(port,'127.0.0.1',()=>console.log(`공유 시뮬레이션: http://127.0.0.1:${port}/driver (고정 가상 좌표만 사용)`));
