import {open,constants,writeFile} from 'node:fs/promises';
import {parseEnv} from 'node:util';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {RemoteSharingClient} from './remote-sharing-client.mjs';

// Explicit, operator-invoked test. Never run during build/startup. Uses only a
// published fixed example point, never a phone/device location or a routing API.
export async function checkHostedSharing({origin,driverKey,fetchImpl=fetch}) {
  const operator=new RemoteSharingClient({origin,driverKey,fetchImpl});
  const checks=[];let created=false,ended=false;
  const require=(condition,code)=>{if(!condition)throw new Error(code);};
  const request=async(path,method='GET',body,token,requestOrigin=origin)=>{
    const response=await fetchImpl(origin+path,{method,redirect:'error',cache:'no-store',signal:AbortSignal.timeout(20000),
      headers:{Origin:requestOrigin,...(token?{Authorization:`Bearer ${token}`} :{}),...(body?{'Content-Type':'application/json'}:{})},
      ...(body?{body:JSON.stringify(body)}:{})});
    return {status:response.status,headers:response.headers,data:await response.json()};
  };
  try {
    const health=await request('/health');
    require(health.status===200&&health.data.service==='pickspot-sharing'&&health.data.hosting==='render-free'&&health.data.simulation===false&&health.data.routeReady===false,'HOSTED_MODE_MISMATCH');
    require(health.headers.get('strict-transport-security')?.includes('max-age=')&&health.headers.get('cache-control')==='no-store','HEADERS_MISSING');
    checks.push('HTTPS 접속과 공유 전용 모드');
    require((await request('/driver')).status===404,'PUBLIC_DRIVER_PAGE');
    const anonymous=await request('/v1/sessions','POST',{});
    require(anonymous.status===403&&anonymous.data.error==='DRIVER_ACCESS_DENIED','DRIVER_AUTH_FAILED');
    const cross=await request('/health','GET',undefined,undefined,'https://untrusted.example');
    require(cross.status===403&&cross.data.error==='ORIGIN_DENIED','ORIGIN_CHECK_FAILED');
    checks.push('공개 운전자 페이지 차단·생성 인증·다른 출처 차단');
    const invitation=await operator.create();created=true;
    const joined=await request('/v1/invitations/redeem','POST',{code:invitation.inviteCode});
    require(joined.status===201&&/^[a-f0-9-]{36}$/.test(joined.data.session?.id??'')&&/^[A-Za-z0-9_-]{43}$/.test(joined.data.passengerToken??''),'JOIN_FAILED');
    const path='/v1/sessions/'+joined.data.session.id,token=joined.data.passengerToken;
    const grant=await request(path+'/location-consent','POST',{consent:true,expectedRevision:joined.data.session.locationShare.revision},token);
    require(grant.status===200&&typeof grant.data.grantId==='string','GRANT_FAILED');
    const update=await request(path+'/passenger-location','PUT',{grantId:grant.data.grantId,sequence:1,
      point:{latitude:37.4859,longitude:127.0348},observedAt:Date.now(),accuracyMeters:12},token);
    require(update.status===200&&(await operator.status()).locationShare==='ready','FIX_NOT_RECEIVED');
    checks.push('고정 예제 좌표 동의·공유 수신');
    require((await request(path+'/location-consent','DELETE',{operationId:randomUUID()},token)).status===200,'WITHDRAW_FAILED');
    require((await operator.status()).locationShare==='withdrawn','WITHDRAW_NOT_CONFIRMED');
    checks.push('공유 철회·서버 삭제 상태');
    await operator.end();ended=true;
    const closed=await request(path,'GET',undefined,token);
    require(closed.status===410&&closed.data.error==='SESSION_ENDED','END_NOT_CONFIRMED');
    checks.push('픽업 종료의 동승자 반영');
    return {passed:true,checks,cleanupConfirmed:true,locationInput:'fixed-example-only',routingApiCalls:0};
  }catch{
    if(created&&!ended)try{await operator.end();ended=true;}catch{/* Session expires even if transport is unavailable. */}
    return {passed:false,checks,cleanupConfirmed:ended,locationInput:'fixed-example-only',routingApiCalls:0,
      nextAction:'응답·주소·서버 상태를 확인하세요. 원시 응답이나 인증 값은 기록하지 않았습니다.'};
  }
}

if(process.argv[1]===fileURLToPath(import.meta.url)) {
  try {
    const file=await open(new URL('../.env.remote.local',import.meta.url),constants.O_RDONLY|constants.O_NOFOLLOW);
    let env;
    try{const stat=await file.stat();if(!stat.isFile()||stat.size>4096||(stat.mode&0o077))throw new Error();env=parseEnv(await file.readFile('utf8'));}finally{await file.close();}
    const report=await checkHostedSharing({origin:env.PICKSPOT_REMOTE_ORIGIN,driverKey:env.PICKSPOT_DRIVER_KEY});
    await writeFile(new URL('../artifacts/hosted-sharing-check.json',import.meta.url),JSON.stringify({...report,checkedAt:new Date().toISOString()},null,2)+'\n');
    console.log(JSON.stringify(report,null,2));if(!report.passed)process.exitCode=1;
  }catch{console.error('원격 검사 준비에 실패했습니다. 비공개 설정 파일과 서버 상태를 확인하세요.');process.exitCode=1;}
}
