import {readFile} from 'node:fs/promises';
import {auditCatalog} from './catalog.mjs';
const labels={VEHICLE_ENTRANCE_MISSING:'차량 입구 좌표',WALKING_ENTRANCE_MISSING:'보행 입구 좌표',REVIEW_INCOMPLETE:'검토 완료',PICKUP_USE_UNCONFIRMED:'일반 차량 만남 공간 확인',MEETING_CONNECTION_UNCONFIRMED:'두 입구 사이 만남 연결',DATA_USE_UNCONFIRMED:'자료 이용 조건',REVIEW_OUT_OF_DATE:'확인일과 유효기간',OPERATING_CONDITIONS_MISSING:'운영·출입 조건',OPEN_QUESTIONS:'미해결 조사 항목',SOURCE_DATE_INVALID:'출처 기준일'};
try {
  const raw=JSON.parse(await readFile(new URL('./yangjae-maebong.json',import.meta.url),'utf8'));
  const result=auditCatalog(raw);
  console.log(`${result.region} 후보 자료 검사 · 외부 API 호출 없음`);
  console.log(`등록 ${result.entries.length}곳 / 계산에 사용할 수 있는 자료 ${result.entries.filter(e=>e.eligible).length}곳`);
  for(const e of result.entries)console.log(`- ${e.name}: ${e.eligible?'자료 검토 완료':e.reasons.map(code=>labels[code]).join(', ')+' 필요'}`);
  console.log('자료 검토 완료는 현장의 승하차 허가나 현재 운영을 자동 보증하지 않습니다.');
}catch{console.error('후보 자료 형식에 오류가 있어요. CANDIDATE_DATA.md의 입력 계약을 확인해 주세요.');process.exitCode=1;}
