import {readFile, lstat} from 'node:fs/promises';
import {parseEnv} from 'node:util';
import {fileURLToPath} from 'node:url';
import {dailyCallLimit,FileCallBudget} from './routing/call-budget.mjs';
import {dirname,join} from 'node:path';

// Read only the local configuration; never call a provider or echo file contents.
export async function checkSetup({envPath = new URL('../.env.local', import.meta.url),now=Date.now} = {}) {
  const result = {readyForExampleApiTest:false, externalRequests:0, keyStatus:'missing',
    checks:[], nextAction:'로컬 .env.local의 TMAP_APP_KEY에 앱 키를 입력하세요.',
    notCheckedByThisCommand:['TMAP 인증·자동차/보행자 권한', '계정별 한도·요금', '실제 경로 응답']};
  const fail = (code, message) => {
    result.checks.push({code, ok:false}); result.nextAction=message; return result;
  };
  let info, contents;
  try {
    info=await lstat(envPath);
    if (!info.isFile() || info.isSymbolicLink() || info.size>16_384) {
      return fail('ENV_FILE_INVALID','16KB 이하의 일반 .env.local 파일을 사용하세요.');
    }
    contents=await readFile(envPath,'utf8');
  } catch (error) {
    return fail(error?.code==='ENOENT'?'ENV_FILE_MISSING':'ENV_FILE_UNREADABLE',
      '.env.example을 .env.local로 복사하고 로컬 편집기에서 앱 키를 입력하세요.');
  }
  // Duplicate entries are ambiguous to a person editing the file, even if Node picks one.
  const assignments=contents.split(/\r?\n/).filter(line=>/^\s*(?:export\s+)?TMAP_APP_KEY\s*=/.test(line));
  if (assignments.length>1) return fail('KEY_DUPLICATED','TMAP_APP_KEY 항목을 하나만 남겨 주세요.');
  let key, env;
  try { env=parseEnv(contents); key=env.TMAP_APP_KEY; }
  catch { return fail('ENV_PARSE_FAILED','.env.local 형식을 확인하세요.'); }
  if (!key?.trim()) return fail('KEY_MISSING',result.nextAction);
  if (/[\s\u0000-\u001f\u007f]/.test(key) || /^(?:your[-_ ]?(?:tmap[-_]?)?(?:app[-_]?)?key|replace[-_]?me|example|여기에.*|발급.*)$/i.test(key)) {
    result.keyStatus='invalid';
    return fail('KEY_FORMAT_INVALID','예시 문구 대신 발급된 키를 공백·줄바꿈 없이 입력하세요.');
  }
  result.keyStatus='present';
  result.checks.push({code:'KEY_PRESENT',ok:true});
  if ((info.mode & 0o077)!==0) return fail('ENV_PERMISSIONS','이 파일을 현재 사용자만 읽고 쓸 수 있도록 권한을 600으로 설정하세요.');
  result.checks.push({code:'ENV_PRIVATE',ok:true});
  const limits=contents.split(/\r?\n/).filter(line=>/^\s*(?:export\s+)?TMAP_DAILY_CALL_LIMIT\s*=/.test(line));
  if (limits.length>1) return fail('BUDGET_DUPLICATED','TMAP_DAILY_CALL_LIMIT 항목을 하나만 남겨 주세요.');
  try { result.dailyCallLimit=dailyCallLimit(env.TMAP_DAILY_CALL_LIMIT); }
  catch { return fail('BUDGET_INVALID','TMAP_DAILY_CALL_LIMIT에 0부터 9999999까지의 정수를 입력하세요.'); }
  if (result.dailyCallLimit===0) return fail('BUDGET_DISABLED','실제 호출은 차단되어 있어요. 계정 한도·요금을 확인한 뒤 TMAP_DAILY_CALL_LIMIT에 허용할 일간 호출 횟수를 설정하세요.');
  result.checks.push({code:'BUDGET_CONFIGURED',ok:true});
  result.configurationReady=true;
  try {
    const root=dirname(envPath instanceof URL?fileURLToPath(envPath):envPath);
    result.localBudget=await new FileCallBudget({filePath:join(root,'server','.state','tmap-calls.json'),limit:result.dailyCallLimit,now}).status();
  }catch{return fail('BUDGET_STATE_UNAVAILABLE','로컬 호출 기록을 확인할 수 없어 검사를 중지했어요. 기록을 초기화하지 말고 파일·시각 설정을 확인하세요.');}
  if(result.localBudget.remaining<7)return fail('BUDGET_INSUFFICIENT','후보 3곳을 비교할 7회분이 남아 있지 않아요. 추가 호출 없이 중지합니다. 로컬 한도가 갱신된 뒤 다시 확인하세요.');
  result.checks.push({code:'BUDGET_AVAILABLE',ok:true});
  result.readyForExampleApiTest=true;
  result.nextAction='키 형식과 로컬 호출 잔여량 확인 완료. 고정 예제 좌표로 최대 7회 API 검사를 진행할 수 있어요. 잔여량은 조회 시점 기준이며 TMAP 계정 전체 사용량·인증 상태를 조회한 것은 아닙니다.';
  return result;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const report=await checkSetup();
    console.log(JSON.stringify(report,null,2));
    if (!report.readyForExampleApiTest) process.exitCode=1;
  } catch {
    console.error(JSON.stringify({error:'SETUP_CHECK_FAILED', externalRequests:0}));
    process.exitCode=1;
  }
}
