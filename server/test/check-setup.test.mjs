import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm,chmod,symlink,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {checkSetup} from '../check-setup.mjs';
import {FileCallBudget} from '../routing/call-budget.mjs';
async function fixture(t,text) {
  const dir=await mkdtemp(join(tmpdir(),'pickspot-setup-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const envPath=join(dir,'.env.local');
  if (text!==undefined) await writeFile(envPath,text,{mode:0o600});
  return {envPath,dir};
}
test('missing and blank key produce actionable setup failures',async t=>{
  const x=await fixture(t);
  assert.equal((await checkSetup(x)).checks[0].code,'ENV_FILE_MISSING');
  await writeFile(x.envPath,'TMAP_APP_KEY=\n',{mode:0o600});
  assert.equal((await checkSetup(x)).checks[0].code,'KEY_MISSING');
});

test('setup reports remaining local allowance without consuming or resetting it',async t=>{
  const x=await fixture(t,'TMAP_APP_KEY=test-key\nTMAP_DAILY_CALL_LIMIT=7\n');
  const now=()=>Date.parse('2026-11-14T00:00:00Z');
  const filePath=join(x.dir,'server','.state','tmap-calls.json');
  const budget=new FileCallBudget({filePath,limit:7,now});await budget.consume();
  const before=await readFile(filePath,'utf8');
  const report=await checkSetup({...x,now});
  assert.equal(report.configurationReady,true);assert.equal(report.readyForExampleApiTest,false);
  assert.equal(report.localBudget.remaining,6);assert.equal(report.checks.at(-1).code,'BUDGET_INSUFFICIENT');
  assert.equal(await readFile(filePath,'utf8'),before);assert.equal(report.externalRequests,0);
  const tomorrow=await checkSetup({...x,now:()=>now()+86400000});
  assert.equal(tomorrow.readyForExampleApiTest,true);assert.equal(tomorrow.localBudget.remaining,7);
  assert.equal(await readFile(filePath,'utf8'),before);
});
test('corrupt budget state is not presented as usable configuration',async t=>{
  const x=await fixture(t,'TMAP_APP_KEY=test-key\nTMAP_DAILY_CALL_LIMIT=7\n');
  const filePath=join(x.dir,'server','.state','tmap-calls.json');
  await new FileCallBudget({filePath,limit:7}).consume();await writeFile(filePath,'bad private state');
  const report=await checkSetup(x);
  assert.equal(report.readyForExampleApiTest,false);assert.equal(report.checks.at(-1).code,'BUDGET_STATE_UNAVAILABLE');
  assert.equal(JSON.stringify(report).includes('bad private state'),false);
});
test('configured key and unrelated secrets never appear in the report',async t=>{
  const key='test-private-api-secret-123';
  const x=await fixture(t,`TMAP_APP_KEY="${key}"\nOTHER_SECRET=also-private\nTMAP_DAILY_CALL_LIMIT=14\n`);
  const report=await checkSetup(x);
  assert.equal(report.readyForExampleApiTest,true);
  assert.equal(report.externalRequests,0);
  assert.equal(report.notCheckedByThisCommand.length,3);
  for(const secret of [key,'also-private',x.envPath]) assert.equal(JSON.stringify(report).includes(secret),false);
});
test('invalid, multiline and duplicate keys fail without echoing values',async t=>{
  const x=await fixture(t,'');
  for(const contents of ['TMAP_APP_KEY=your_app_key','TMAP_APP_KEY="one\ntwo"','TMAP_APP_KEY=one\nexport TMAP_APP_KEY=two']) {
    await writeFile(x.envPath,contents);
    const report=await checkSetup(x);
    assert.equal(report.readyForExampleApiTest,false);
    assert.equal(JSON.stringify(report).includes('one'),false);
  }
});
test('shared file permissions, oversize files and symlinks are refused',async t=>{
  const x=await fixture(t,'TMAP_APP_KEY=test-private-secret');
  await chmod(x.envPath,0o644);
  assert.equal((await checkSetup(x)).checks.at(-1).code,'ENV_PERMISSIONS');
  await writeFile(x.envPath,'x'.repeat(16385));
  assert.equal((await checkSetup(x)).checks[0].code,'ENV_FILE_INVALID');
  const linked=join(x.dir,'link');await symlink(x.envPath,linked);
  assert.equal((await checkSetup({envPath:linked})).checks[0].code,'ENV_FILE_INVALID');
});

test('setup requires an explicit positive daily cap and rejects ambiguous values without echoing them',async t=>{
  const x=await fixture(t,'');
  for(const [setting,expected] of [['','BUDGET_DISABLED'],['TMAP_DAILY_CALL_LIMIT=0','BUDGET_DISABLED'],
    ['TMAP_DAILY_CALL_LIMIT=private-invalid','BUDGET_INVALID'],
    ['TMAP_DAILY_CALL_LIMIT=7\nexport TMAP_DAILY_CALL_LIMIT=14','BUDGET_DUPLICATED']]) {
    await writeFile(x.envPath,`TMAP_APP_KEY=test-private-secret\n${setting}\n`);
    const report=await checkSetup(x);
    assert.equal(report.readyForExampleApiTest,false);
    assert.equal(report.checks.at(-1).code,expected);
    assert.ok(!JSON.stringify(report).includes('private'));
    assert.equal(report.externalRequests,0);
  }
});
