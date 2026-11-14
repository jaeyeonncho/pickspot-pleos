"""Export the explicit emulator render report. No private app files or location APIs."""
import json
import subprocess
import sys
from pathlib import Path

root=Path(__file__).resolve().parent.parent
raw=(root/'artifacts/sharing-render-latest.txt').read_text()
try:
    report,_=json.JSONDecoder().raw_decode(raw.split('INSTRUMENTATION_RESULT: stream=',1)[1].lstrip())
except (ValueError,IndexError):
    raise SystemExit('공유 화면 검사 결과를 읽지 못했습니다.')
if report.get('passed') is not True or report.get('refreshKeepsRowsAndLayout') is not True:
    raise SystemExit('공유 화면 검사를 통과하지 못했습니다.')
labels={'idle':'만남 만들기','invitation':'초대 대기','ready':'위치 수신','stale':'위치 만료',
        'withdrawn':'공유 중지','offline':'연결 끊김','ended':'만남 종료','restricted':'주행 제한'}
expected={f'sharing-{state}-{width}.png' for state in labels for width in (520,960)}
if set(report.get('files',[]))!=expected or len(report['files'])!=len(expected):
    raise SystemExit('예상한 화면 파일 목록과 다릅니다.')
serial=sys.argv[1]
if not serial.startswith('emulator-'):
    raise SystemExit('가상 차량 전용입니다.')
user=subprocess.check_output(['adb','-s',serial,'shell','am','get-current-user'],text=True).strip()
if not user.isdigit():raise SystemExit('현재 차량 사용자를 확인하지 못했습니다.')
output=root/'artifacts/sharing-screen-gallery';output.mkdir(exist_ok=True)
for name in sorted(expected):
    data=subprocess.check_output(['adb','-s',serial,'exec-out','run-as','dev.pickspot.app','--user',user,'cat',f'cache/{name}'])
    if not data.startswith(b'\x89PNG\r\n\x1a\n'):raise SystemExit('화면 이미지가 올바르지 않습니다.')
    (output/name).write_bytes(data)
(output/'verification.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
buttons=''.join(f'<button type="button" data-state="{state}" aria-pressed="{str(state=="ready").lower()}">{label}</button>' for state,label in labels.items())
page='''<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>픽스팟 · 공유 화면 디자인 미리보기</title>
<style>
*{box-sizing:border-box}body{margin:0;background:#0b151d;color:#edf4f6;font:16px system-ui,sans-serif}main{max-width:1160px;margin:auto;padding:32px 24px}h1{font-size:28px;margin:0 0 10px}p{color:#b1c0c8;line-height:1.6}nav{display:flex;flex-wrap:wrap;gap:8px;margin:24px 0 16px}button,select{font:inherit;color:inherit;background:#1b2b36;border:1px solid #516672;border-radius:10px;padding:12px 16px;cursor:pointer}button[aria-pressed=true]{background:#9aefd4;color:#07251d;border-color:#9aefd4}button:focus-visible,select:focus-visible,a:focus-visible{outline:3px solid #fff;outline-offset:3px}.controls{display:flex;flex-wrap:wrap;gap:16px;align-items:center}a{color:#9aefd4}figure{margin:24px 0;background:#071017;padding:16px;border:1px solid #314752;border-radius:16px}img{display:block;max-width:100%;height:auto;margin:auto}figcaption{color:#b1c0c8;padding:16px 0 0}footer{border-top:1px solid #314752;margin-top:28px;padding-top:16px;color:#b1c0c8;line-height:1.7}code{color:#d0e0e6}small{font-size:14px}noscript{display:block;padding:16px}
</style><main><h1>공유 화면 디자인 미리보기</h1>
<p>차량 앱 0.16 · 실제 Android 레이아웃 8가지 상태<br>고정 예제 렌더링입니다. 전체 앱 캡처나 실시간 공유 화면은 아닙니다.</p>
<nav aria-label="화면 상태">BUTTONS</nav>
<div class="controls"><label for="width">렌더링 폭 </label><select id="width"><option value="960">960px · 넓게</option><option value="520">520px · 좁게</option></select><a id="original" href="sharing-ready-960.png">원본 이미지 열기</a></div>
<figure><img id="screen" src="sharing-ready-960.png" width="960" alt="위치 수신 · 공유 상태 확인 3초 전과 가상 후보 비교"><figcaption id="caption" aria-live="polite">위치 수신 · 960px</figcaption></figure>
<noscript>상태 선택에는 JavaScript가 필요합니다. 같은 폴더에 16개 PNG 원본이 있습니다.</noscript>
<footer><strong>디자인 수정 위치</strong><br>배치: <code>app/src/debug/res/layout/activity_sharing.xml</code><br>문구: <code>app/src/debug/res/values/sharing_strings.xml</code><br>표시: <code>sharing/SharingScreen.kt</code><br><small>색·간격·글꼴은 기존 공통 리소스를 사용합니다. 수정 후 <code>preview-sharing.command</code>를 실행하면 이미지와 이 문서를 갱신합니다. 만남 생성·위치 수집·내비 변경·외부 API 호출은 하지 않습니다.</small></footer>
<script>
const labels=LABELS;let current='ready';const width=document.getElementById('width');
function render(){const file=`sharing-${current}-${width.value}.png`;document.getElementById('screen').src=file;document.getElementById('screen').alt=`${labels[current]} · ${width.value}px`;document.getElementById('screen').width=Number(width.value);document.getElementById('original').href=file;document.getElementById('caption').textContent=`${labels[current]} · ${width.value}px`;document.querySelectorAll('[data-state]').forEach(button=>button.setAttribute('aria-pressed',String(button.dataset.state===current)));}
document.querySelectorAll('[data-state]').forEach(button=>button.addEventListener('click',()=>{current=button.dataset.state;render();}));width.addEventListener('change',render);
</script></main></html>'''.replace('BUTTONS',buttons).replace('LABELS',json.dumps(labels,ensure_ascii=False))
(output/'index.html').write_text(page)
print('공유 화면 8가지 × 2개 폭, 갱신 시 후보 유지·배치 고정 검사 통과.')
print(f'디자인 미리보기: {output / "index.html"}')
