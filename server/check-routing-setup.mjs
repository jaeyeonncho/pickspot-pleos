import {fileURLToPath} from 'node:url';
import {routingConfiguration,loadRoutingCatalog} from './routing-config.mjs';
const messages={
  ROUTING_ENV_MISSING:'경로 서버 전용 설정이 아직 없어요. .env.routing.example에 필요한 항목을 정리해 뒀어요.',
  ROUTING_ENV_INVALID:'경로 서버 설정 파일 형식을 확인해 주세요.',ROUTING_ENV_UNREADABLE:'경로 서버 설정은 일반 파일로 준비해 주세요.',
  ROUTING_ENV_PERMISSIONS:'경로 서버 설정은 현재 사용자만 읽도록 권한 600으로 준비해 주세요.',
  ROUTING_ENV_DUPLICATED:'같은 경로 서버 설정을 중복 입력하지 마세요.',
  ROUTING_ENV_UNKNOWN_FIELD:'경로 서버 설정에 알 수 없는 항목이 있어요. 예제의 항목 이름을 확인해 주세요.',
  ROUTING_MODE_REQUIRED:'경로 서버 모드는 direct-tls를 명시해야 해요.',PROCESSING_REGION_REQUIRED:'실제 서버의 처리 지역을 명시해 주세요.',
  CANDIDATE_IDS_REQUIRED:'검토한 후보 ID 1~3곳을 중복 없이 선택해 주세요.',CANDIDATE_NOT_REVIEWED:'선택한 후보 자료의 검토가 아직 완료되지 않았어요.',
  INVALID_CANDIDATE_CATALOG:'후보 자료 형식이 올바르지 않아요.',ROUTING_CATALOG_MISSING:'설정한 후보 자료 파일이 없어요.',
  ROUTING_CATALOG_INVALID:'후보 자료는 2MB 이하 일반 JSON 파일이어야 해요.',ROUTING_CATALOG_UNREADABLE:'후보 자료 파일을 읽을 수 없어요.',
  TMAP_ENV_REQUIRED:'기존 TMAP 설정 파일의 위치를 명시해 주세요. 키를 앱이나 채팅으로 옮기지 마세요.',
  TMAP_ENV_MISSING:'지정한 TMAP 설정 파일이 없어요.',TMAP_ENV_INVALID:'TMAP 설정 파일 형식을 확인해 주세요.',
  TMAP_ENV_UNREADABLE:'TMAP 설정은 읽을 수 있는 일반 파일로 준비해 주세요.',TMAP_ENV_PERMISSIONS:'TMAP 설정 파일은 현재 사용자만 읽도록 준비해 주세요.',
  TMAP_ENV_DUPLICATED:'TMAP 키/한도 설정이 중복돼 있어요.',TMAP_KEY_REQUIRED:'지정한 파일에 유효한 TMAP 키가 필요해요.',
  ROUTE_BUDGET_CONFIG_INVALID:'TMAP 일간 호출 한도 형식을 확인해 주세요.',ROUTE_BATCH_BUDGET_REQUIRED:'일간 한도가 선택한 후보 1회 비교분보다 작아요. 한도를 자동으로 올리지 않아요.',
  ROUTE_BUDGET_UNAVAILABLE:'기존 호출 기록을 읽을 수 없어요. 기록을 삭제하거나 초기화하지 않았어요.',ROUTE_BUDGET_CLOCK_INVALID:'시각과 기존 호출 기록의 날짜를 확인해 주세요.',
  HTTPS_ORIGIN_REQUIRED:'경로 서버의 고정 HTTPS 주소가 필요해요.',DRIVER_KEY_REQUIRED:'경로 서버 전용 만남 생성 키를 서버에 준비해야 해요.',
  INVALID_PORT:'서버 포트는 1~65535의 정수여야 해요.',INVALID_BIND_ADDRESS:'허용된 서버 수신 주소를 사용해 주세요.',
  TLS_FILES_REQUIRED:'직접 TLS 인증서와 개인 키 파일이 필요해요.',INVALID_TLS_FILE:'TLS 파일 형식/크기를 확인해 주세요.',
  TLS_KEY_MUST_BE_PRIVATE:'TLS 개인 키는 현재 사용자만 읽도록 준비해 주세요.',TLS_FILES_UNREADABLE:'TLS 파일을 읽을 수 없어요.',
  INVALID_TLS_CERTIFICATE:'인증서 파일 형식을 확인해 주세요.',INVALID_TLS_PRIVATE_KEY:'개인 키 파일 형식을 확인해 주세요.',
  TLS_KEY_CERTIFICATE_MISMATCH:'인증서와 개인 키가 같은 쌍이어야 해요.',TLS_CERTIFICATE_EXPIRED_OR_NOT_YET_VALID:'인증서 유효기간과 컴퓨터 시각을 확인해 주세요.',
  TLS_CERTIFICATE_HOST_MISMATCH:'HTTPS 주소와 인증서의 호스트 이름이 달라요.',CANDIDATE_REVIEW_EXPIRED:'후보 검토 유효기간이 끝났어요.',CANDIDATE_CATALOG_CHANGED:'후보 자료가 바뀌어 재검사가 필요해요.'
};
export function routingSetupError(error){const code=Object.hasOwn(messages,error?.message)?error.message:'ROUTING_SETUP_FAILED';return {code,message:messages[code]??'경로 서버 설정을 확인하지 못했어요. 비밀 값은 출력하지 않았어요.'};}
// A configuration check is not proof of public reachability, trust chain or provider entitlement.
export async function checkRoutingSetup(options={}) {
  const report={configurationReady:false,externalRequests:0,providerRequests:0,listenerOpened:false,
    notChecked:['인증서 신뢰 체인·DNS·외부 접속','공급자 계정의 실제 권한·잔여량','실제 Android/휴대폰 전체 연결','장소 현장 이용 조건의 사실 여부']};
  try {
    const config=await routingConfiguration(options);
    return {...report,configurationReady:true,scope:['127.0.0.1','::1'].includes(config.host)?'loopback':'all-interfaces',
      catalog:{source:'configured',registered:config.audit.entries.length,eligible:config.audit.entries.filter(e=>e.eligible).length,selected:config.candidateIds.length},
      budget:{...config.budgetStatus,batchCalls:config.batchCalls,batchAvailable:config.budgetStatus.remaining>=config.batchCalls},
      message:'설정 형식과 후보 검토 조건을 통과했어요. 서버는 시작하지 않았고 실제 API도 호출하지 않았어요.'};
  }catch(error){
    // Report the project's public research data separately when private setup is missing.
    let catalog;
    try {const {audit}=await loadRoutingCatalog(undefined,{now:options.now?.()??Date.now()});catalog={source:'project-default',registered:audit.entries.length,eligible:audit.entries.filter(e=>e.eligible).length};}catch{catalog={source:'project-default',unavailable:true};}
    return {...report,...routingSetupError(error),catalog};
  }
}
if(process.argv[1]===fileURLToPath(import.meta.url)) {
  const result=await checkRoutingSetup();console.log(JSON.stringify(result,null,2));if(!result.configurationReady)process.exitCode=1;
}
