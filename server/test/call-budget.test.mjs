import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, writeFile, rm, mkdir, symlink, stat, readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {FileCallBudget, dailyCallLimit} from '../routing/call-budget.mjs';
import {TmapRoutes} from '../routing/tmap.mjs';
import {RouteError} from '../routing/contract.mjs';
import {preview} from '../route-preview.mjs';
import {exampleTrip} from '../routing/example.mjs';

const exec = promisify(execFile);
const matches = code => error => error instanceof RouteError && error.code === code;
const epoch = Date.parse('2026-11-11T14:59:59Z');
const trip = exampleTrip();
const request = {mode:'drive', origin:trip.driver, destination:trip.destination};
const response = () => new Response(JSON.stringify({type:'FeatureCollection', features:[
  {properties:{totalDistance:100, totalTime:20}}
]}));
async function fixture(t, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'pickspot-budget-'));
  t.after(() => rm(dir, {recursive:true, force:true}));
  const filePath = join(dir, 'state', 'calls.json');
  const config = {filePath, limit:7, now:()=>epoch, ...options};
  return {dir, filePath, config, budget:new FileCallBudget(config),
    read:async()=>JSON.parse(await readFile(filePath, 'utf8'))};
}

test('budget settings are strict and default to no real calls', async t => {
  assert.equal(dailyCallLimit(), 0);
  assert.equal(dailyCallLimit('14'), 14);
  for (const value of ['', '01', '-1', '1.5', '1e3', ' 7', '10000000', 7, null]) {
    assert.throws(()=>dailyCallLimit(value), matches('ROUTE_BUDGET_CONFIG_INVALID'));
  }
  const x = await fixture(t, {limit:0});
  await assert.rejects(x.budget.consume(), matches('ROUTE_BUDGET_DISABLED'));
  assert.deepEqual(await readdir(x.dir), []);
  assert.throws(()=>new TmapRoutes({appKey:'test'}), matches('ROUTE_BUDGET_REQUIRED'));
});

test('reconstructed budgets retain usage and persist only private counters', async t => {
  const x = await fixture(t, {limit:2});
  assert.equal((await x.budget.consume()).remaining, 1);
  assert.equal((await new FileCallBudget(x.config).consume()).remaining, 0);
  await assert.rejects(new FileCallBudget(x.config).consume(), matches('ROUTE_BUDGET_EXCEEDED'));
  assert.deepEqual(await x.read(), {version:1, day:'2026-11-11', used:2, limit:2});
  assert.equal((await stat(x.filePath)).mode & 0o777, 0o600);
  assert.deepEqual(await readdir(join(x.dir, 'state')), ['calls.json']);
});

test('simultaneous instances cannot overrun one ledger', async t => {
  const x = await fixture(t, {limit:7});
  const results = await Promise.allSettled(Array.from({length:25}, () => new FileCallBudget(x.config).consume()));
  assert.equal(results.filter(r=>r.status==='fulfilled').length, 7);
  assert.ok(results.filter(r=>r.status==='rejected').every(r=>r.reason.code==='ROUTE_BUDGET_EXCEEDED'));
  assert.equal((await x.read()).used, 7);
});

test('separate Node processes share the cap, including after all workers exit', async t => {
  const x = await fixture(t, {limit:13});
  const moduleUrl = new URL('../routing/call-budget.mjs', import.meta.url).href;
  const code = `import {FileCallBudget} from ${JSON.stringify(moduleUrl)};
    const b=new FileCallBudget({filePath:process.argv[1],limit:13,now:()=>${epoch},lockTimeoutMs:5000});
    const results=[];for(let i=0;i<8;i++){try{await b.consume();results.push('ok');}catch(e){results.push(e.code);}}
    console.log(JSON.stringify(results));`;
  const workers = await Promise.all(Array.from({length:6}, () => exec(process.execPath,
    ['--input-type=module', '-e', code, x.filePath], {timeout:15000})));
  const results = workers.flatMap(r=>JSON.parse(r.stdout));
  assert.equal(results.filter(r=>r==='ok').length, 13);
  assert.ok(results.every(r=>r==='ok' || r==='ROUTE_BUDGET_EXCEEDED'));
  await assert.rejects(new FileCallBudget(x.config).consume(), matches('ROUTE_BUDGET_EXCEEDED'));
  assert.equal((await x.read()).used, 13);
});

test('day rollover follows Korea time and a backward calendar cannot reset usage', async t => {
  let now = epoch;
  const x = await fixture(t, {limit:1, now:()=>now});
  await x.budget.consume();
  await assert.rejects(x.budget.consume(), matches('ROUTE_BUDGET_EXCEEDED'));
  now += 1000;
  assert.deepEqual(await x.budget.consume(), {day:'2026-11-12', used:1, limit:1, remaining:0});
  now = epoch;
  await assert.rejects(x.budget.consume(), matches('ROUTE_BUDGET_CLOCK_INVALID'));
  assert.equal((await x.read()).day, '2026-11-12');
});

test('higher settings cannot raise a recorded cap that day; smaller settings take effect', async t => {
  const x = await fixture(t, {limit:3});
  await x.budget.consume();
  assert.equal((await new FileCallBudget({...x.config, limit:2}).consume()).limit, 2);
  await assert.rejects(new FileCallBudget({...x.config, limit:99}).consume(), matches('ROUTE_BUDGET_EXCEEDED'));
  await assert.rejects(new FileCallBudget({...x.config, limit:1}).consume(), matches('ROUTE_BUDGET_EXCEEDED'));
  assert.equal((await new FileCallBudget({...x.config, limit:4, now:()=>epoch+1000}).consume()).limit, 4);
});

test('corrupt, oversized, invalid-date and symlink ledgers fail closed without rewriting', async t => {
  const x = await fixture(t);
  await mkdir(join(x.dir, 'state'));
  for (const text of ['{', 'x'.repeat(1025), 'null',
    JSON.stringify({version:1, day:'2026-02-30', used:1, limit:7}),
    JSON.stringify({version:1, day:'2026-11-11', used:8, limit:7}),
    JSON.stringify({version:1, day:'2026-11-11', used:0, limit:7}),
    JSON.stringify({version:1, day:'2026-11-11', used:1, limit:7, key:'secret'})]) {
    await writeFile(x.filePath, text);
    await assert.rejects(x.budget.consume(), matches('ROUTE_BUDGET_UNAVAILABLE'));
    assert.equal(await readFile(x.filePath, 'utf8'), text);
  }
  await rm(x.filePath);
  const other = join(x.dir, 'other'); await writeFile(other, 'private'); await symlink(other, x.filePath);
  await assert.rejects(x.budget.consume(), matches('ROUTE_BUDGET_UNAVAILABLE'));
  assert.equal(await readFile(other, 'utf8'), 'private');
});

test('a leftover process lock blocks rather than being stolen or resetting the count', async t => {
  const x = await fixture(t, {lockTimeoutMs:25});
  await x.budget.consume();
  await mkdir(`${x.filePath}.lock`);
  await assert.rejects(x.budget.consume(), matches('ROUTE_BUDGET_BUSY'));
  assert.equal((await x.read()).used, 1);
  assert.equal((await stat(`${x.filePath}.lock`)).isDirectory(), true);
});

test('cancelling before admission or while waiting consumes no slot and preserves another lock', async t => {
  const x = await fixture(t);
  const cancelled = new AbortController(); cancelled.abort();
  await assert.rejects(x.budget.consume({signal:cancelled.signal}), matches('ROUTE_CANCELLED'));
  assert.deepEqual(await readdir(x.dir), []);
  await x.budget.consume(); await mkdir(`${x.filePath}.lock`);
  const waiting = new AbortController(); const pending = x.budget.consume({signal:waiting.signal});
  setTimeout(()=>waiting.abort(), 20);
  await assert.rejects(pending, matches('ROUTE_CANCELLED'));
  assert.equal((await x.read()).used, 1);
  assert.equal((await stat(`${x.filePath}.lock`)).isDirectory(), true);
});

test('failed network calls spend a slot, while invalid requests and exhaustion never dispatch', async t => {
  const x = await fixture(t, {limit:1}); let calls = 0;
  const provider = new TmapRoutes({appKey:'private-test', budget:x.budget, fetchImpl:async()=>{
    calls++; assert.equal((await x.read()).used, 1); throw new Error('private-test');
  }});
  await assert.rejects(provider.route({...request, mode:'bike'}), matches('INVALID_ROUTE_REQUEST'));
  assert.deepEqual(await readdir(x.dir), []);
  await assert.rejects(provider.route(request), matches('ROUTE_NETWORK_ERROR'));
  await assert.rejects(provider.route(request), matches('ROUTE_BUDGET_EXCEEDED'));
  assert.equal(calls, 1);
});

test('cancellation after dispatch does not refund a reserved call', async t => {
  const x = await fixture(t); let started;
  const dispatched = new Promise(resolve=>{started=resolve;});
  const provider = new TmapRoutes({appKey:'test', budget:x.budget, fetchImpl:(_url,{signal})=>new Promise((_,reject)=>{
    signal.addEventListener('abort',()=>reject(new Error('cancelled')), {once:true}); started();
  })});
  const controller = new AbortController(); const pending = provider.route({...request, signal:controller.signal});
  await dispatched; controller.abort();
  await assert.rejects(pending, matches('ROUTE_CANCELLED'));
  assert.equal((await x.read()).used, 1);
});

test('budget exhaustion during a candidate fails the complete preview, never returning partial suggestions', async t => {
  const x = await fixture(t, {limit:4}); let calls = 0;
  await assert.rejects(preview({args:['--live','--example-only'], env:{TMAP_APP_KEY:'test'}, budget:x.budget,
    fetchImpl:async()=>{calls++;return response();}}), matches('ROUTE_BUDGET_EXCEEDED'));
  assert.equal(calls, 4); assert.equal((await x.read()).used, 4);
});

test('two complete previews share their budget across new instances', async t => {
  const x = await fixture(t, {limit:7}); let calls = 0;
  const options = {args:['--live','--example-only'], env:{TMAP_APP_KEY:'test'},
    fetchImpl:async()=>{calls++;return response();}};
  assert.equal((await preview({...options, budget:x.budget})).candidates.length, 3);
  await assert.rejects(preview({...options, budget:new FileCallBudget(x.config)}), matches('ROUTE_BUDGET_EXCEEDED'));
  assert.equal(calls, 7);
});

test('default live preview is disabled even with a key, while offline mode never touches the budget', async () => {
  let calls = 0;
  const options = {env:{TMAP_APP_KEY:'private-test'}, fetchImpl:async()=>{calls++;return response();}};
  await assert.rejects(preview({...options,args:['--live','--example-only']}), matches('ROUTE_BUDGET_DISABLED'));
  await assert.rejects(preview({...options,args:['--live','--example-only'],env:{...options.env,TMAP_DAILY_CALL_LIMIT:'bad'}}), matches('ROUTE_BUDGET_CONFIG_INVALID'));
  assert.equal((await preview({...options,budget:{consume(){throw new Error('must not consume');}}})).synthetic,true);
  assert.equal(calls, 0);
});
