import {readFile,lstat} from 'node:fs/promises';
import {parseEnv} from 'node:util';
import {fileURLToPath} from 'node:url';
import {dirname,resolve} from 'node:path';
import {sharingConfig} from './sharing-config.mjs';
const fields=['PICKSPOT_PUBLIC_ORIGIN','PICKSPOT_TLS_CERT_FILE','PICKSPOT_TLS_KEY_FILE','PICKSPOT_DRIVER_KEY','PICKSPOT_SHARE_PORT','PICKSPOT_BIND_ADDRESS'];
const guidance={
  ENV_FILE_MISSING:'.env.sharing.example을 .env.sharing.local로 복사하고 HTTPS 호스팅 정보가 준비되면 입력하세요.',
  ENV_FILE_INVALID:'환경 파일은 16KB 이하 일반 파일로 준비하세요.',ENV_FILE_UNREADABLE:'환경 파일을 읽을 수 있는지 확인하세요.',
  ENV_PERMISSIONS:'환경 파일은 현재 사용자만 접근할 수 있도록 권한을 600으로 설정하세요.',
  ENV_DUPLICATED:'공유 환경 설정의 같은 항목을 두 번 입력하지 마세요.',ENV_PARSE_FAILED:'공유 환경 파일 형식을 확인하세요.',
  HTTPS_ORIGIN_REQUIRED:'접속할 HTTPS 주소를 경로 없이 입력하세요.',DRIVER_KEY_REQUIRED:'운전자 세션 생성용 비밀 키를 서버 설정에 준비하세요. 앱이나 채팅에 넣지 마세요.',
  INVALID_PORT:'서버 포트는 1부터 65535까지 정수로 설정하세요.',INVALID_BIND_ADDRESS:'허용된 서버 바인딩 주소를 사용하세요.',
  TLS_FILES_REQUIRED:'인증서와 개인 키 파일 위치를 준비하세요.',INVALID_TLS_FILE:'인증서와 개인 키는 64KB 이하 일반 파일로 준비하세요.',
  TLS_KEY_MUST_BE_PRIVATE:'인증서 개인 키 파일은 권한을 600으로 설정하세요.',TLS_FILES_UNREADABLE:'인증서와 개인 키 파일 위치와 읽기 권한을 확인하세요.',
  INVALID_TLS_CERTIFICATE:'올바른 인증서 파일을 준비하세요.',INVALID_TLS_PRIVATE_KEY:'서버가 읽을 수 있는 PEM 개인 키를 준비하세요.',
  TLS_KEY_CERTIFICATE_MISMATCH:'인증서와 개인 키가 서로 다른 쌍이에요. 같은 발급 건의 파일을 사용하세요.',
  TLS_CERTIFICATE_EXPIRED_OR_NOT_YET_VALID:'인증서 유효기간과 컴퓨터 시각을 확인하세요.',TLS_CERTIFICATE_HOST_MISMATCH:'접속 주소와 인증서의 호스트 이름을 맞춰 주세요.'
};
// No server is opened, no key/certificate contents are returned, no DNS or network probe.
export async function checkSharingSetup({envPath=new URL('../.env.sharing.local',import.meta.url)}={}) {
  const result={configurationReady:false,externalRequests:0,checks:[],
    notChecked:['호스팅·DNS·외부 HTTPS 접속','인증서 발급기관 신뢰 체인','운전자 계정 인증','실제 휴대폰 위치 공유','실제 경로 제공자 전송 동의 화면']};
  const fail=code=>({...result,code,nextAction:guidance[code]??'공유 서버 설정을 확인하세요. 비밀 값은 출력하지 않았어요.'});
  let contents;
  try {
    const stat=await lstat(envPath);
    if(!stat.isFile()||stat.isSymbolicLink()||stat.size>16384)return fail('ENV_FILE_INVALID');
    if(stat.mode&0o077)return fail('ENV_PERMISSIONS');
    contents=await readFile(envPath,'utf8');
  }catch(e){return fail(e.code==='ENOENT'?'ENV_FILE_MISSING':'ENV_FILE_UNREADABLE');}
  result.checks.push('환경 파일 접근 권한');
  let env;try{env=parseEnv(contents);}catch{return fail('ENV_PARSE_FAILED');}
  for(const key of fields){
    const assignments=contents.split(/\r?\n/).filter(line=>new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=`).test(line));
    if(assignments.length>1)return fail('ENV_DUPLICATED');
  }
  const base=dirname(envPath instanceof URL?fileURLToPath(envPath):resolve(envPath));
  for(const field of ['PICKSPOT_TLS_CERT_FILE','PICKSPOT_TLS_KEY_FILE'])if(env[field])env[field]=resolve(base,env[field]);
  try {
    const config=await sharingConfig(env);
    result.checks.push('HTTPS 주소·포트','인증서 호스트와 유효기간','인증서와 개인 키 일치','개인 키 접근 권한','운전자 서버 키 형식');
    return {...result,configurationReady:true,scope:config.host==='127.0.0.1'||config.host==='::1'?'loopback':'all-interfaces',
      nextAction:'로컬 설정 형식 검사 완료. 서버 실행·외부 공개·휴대폰 테스트를 수행한 결과는 아니에요.'};
  }catch(e){return fail(Object.hasOwn(guidance,e.message)?e.message:'SHARING_SETUP_FAILED');}
}
if(process.argv[1]===fileURLToPath(import.meta.url)) {
  try{const report=await checkSharingSetup();console.log(JSON.stringify(report,null,2));if(!report.configurationReady)process.exitCode=1;}
  catch{console.error(JSON.stringify({configurationReady:false,externalRequests:0,code:'SHARING_SETUP_FAILED'}));process.exitCode=1;}
}
