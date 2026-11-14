import test from 'node:test';
import assert from 'node:assert/strict';
import {BrowserLocation,locationView} from '../public/browser-location.mjs';
import {LOCATION_POLICY} from '../shared/location-policy.mjs';

const epoch=1_800_000_000_000;
function fixture(options={}) {
  let now=epoch,tick=0,visible=true;
  const watches=[],cleared=[],timers=new Map(),states=[];
  const geolocation={watchPosition(success,error,settings){watches.push({success,error,settings});return watches.length-1;},
    clearWatch(id){cleared.push(id);}};
  const location=new BrowserLocation({geolocation,secure:true,visible:()=>visible,now:()=>now,monotonic:()=>tick,
    setIntervalImpl:fn=>{const id=Symbol();timers.set(id,fn);return id;},clearIntervalImpl:id=>timers.delete(id),
    onChange:s=>states.push(s),...options});
  const position=(overrides={})=>({timestamp:now,coords:{latitude:37.4859,longitude:127.0348,accuracy:12},...overrides});
  return {location,watches,cleared,timers,states,position,
    fix:overrides=>watches.at(-1).success(position(overrides)),
    advance:ms=>{now+=ms;tick+=ms;for(const fn of timers.values())fn();},
    wall:ms=>{now+=ms;},tick:ms=>{tick+=ms;},hidden:()=>{visible=false;}};
}

test('no watch starts until explicit consent; no permission, security or visibility bypass',()=>{
  for(const [options,status] of [[{},'consent-required'],[{secure:false},'insecure'],
    [{geolocation:null},'unsupported'],[{visible:()=>false},'hidden']]) {
    const x=fixture(options);assert.equal(x.watches.length,0);
    x.location.start({consent:status!=='consent-required'});
    assert.equal(x.location.snapshot().status,status);assert.equal(x.watches.length,0);assert.equal(x.timers.size,0);
  }
});

test('valid fix is copied, frozen and shaped for future TripInput use',()=>{
  const x=fixture();x.location.start({consent:true});
  assert.deepEqual(x.watches[0].settings,{enableHighAccuracy:true,maximumAge:0,timeout:12000});
  const position=x.position();x.watches[0].success(position);position.coords.latitude=0;
  const state=x.location.snapshot();
  assert.equal(state.status,'ready');assert.equal(state.fix.point.latitude,37.4859);
  assert.equal(state.fix.source,'browser');assert.equal(state.fix.consent,true);
  assert.equal(state.fix.validUntil,epoch+LOCATION_POLICY.maxAgeMs);
  assert.throws(()=>{state.fix.point.latitude=0;},TypeError);
  const view=locationView(state);assert.equal(view.accuracy,'약 12m');
  assert.ok(!JSON.stringify(view).includes('37.4859'));assert.ok(!JSON.stringify(view).includes('127.0348'));
});

test('invalid, stale and inaccurate new fixes immediately remove the old usable point',()=>{
  const invalid=[
    [{timestamp:epoch+6001},'invalid'],[{timestamp:0},'invalid'],
    [{coords:{latitude:NaN,longitude:127,accuracy:12}},'invalid'],
    [{coords:{latitude:37,longitude:181,accuracy:12}},'invalid'],
    ...[null,0,-1,101,Infinity].map(accuracy=>[{coords:{latitude:37,longitude:127,accuracy}},'inaccurate'])
  ];
  for(const [overrides,status] of invalid) {
    const x=fixture();x.location.start({consent:true});x.fix();x.advance(1);x.fix(overrides);
    assert.equal(x.location.snapshot().status,status);assert.equal(x.location.snapshot().fix,null);
  }
  const x=fixture();x.location.start({consent:true});x.fix({timestamp:epoch-30000});
  assert.equal(x.location.snapshot().status,'stale');assert.equal(x.location.snapshot().fix,null);
});

test('boundary accuracy accepted and tolerated future time cannot extend location life',()=>{
  const x=fixture();x.location.start({consent:true});
  x.fix({timestamp:epoch+5000,coords:{latitude:90,longitude:-180,accuracy:100}});
  assert.equal(x.location.snapshot().fix.validUntil,epoch+30000);
  x.advance(29999);assert.equal(x.location.snapshot().status,'ready');
  x.advance(1);assert.equal(x.location.snapshot().status,'stale');assert.equal(x.location.snapshot().fix,null);
});

test('duplicate and reordered callbacks cannot refresh a fix or resurrect expired coordinates',()=>{
  const x=fixture();x.location.start({consent:true});const original=x.position();x.fix();
  x.advance(29000);x.watches[0].success(original);x.fix({timestamp:epoch-1});
  assert.equal(x.location.snapshot().fix.validUntil,epoch+30000);
  x.advance(1000);x.watches[0].success(original);
  assert.equal(x.location.snapshot().fix,null);
  x.fix();assert.equal(x.location.snapshot().status,'ready');
});

test('stop clears watch ID zero, timers and raw fix; late callbacks cannot restore it',()=>{
  const x=fixture();x.location.start({consent:true});x.fix();x.location.stop();
  assert.deepEqual(x.cleared,[0]);assert.equal(x.timers.size,0);
  x.fix();x.watches[0].error({code:1});
  assert.deepEqual(x.location.snapshot(),{status:'stopped',active:false,fix:null});
});

test('new start rejects previous attempt callbacks and disposal permanently prevents restart',()=>{
  const x=fixture();x.location.start({consent:true});x.location.start({consent:true});
  assert.deepEqual(x.cleared,[0]);x.watches[0].success(x.position());assert.equal(x.location.snapshot().status,'requesting');
  x.fix();x.location.dispose();x.location.start({consent:true});
  assert.equal(x.watches.length,2);assert.deepEqual(x.cleared,[0,1]);assert.equal(x.location.snapshot().fix,null);
});

test('permission denied, provider timeout and unavailability clear watches and sanitize messages',()=>{
  for(const [code,status] of [[1,'denied'],[2,'unavailable'],[3,'timeout'],[99,'unavailable']]) {
    const x=fixture();x.location.start({consent:true});x.fix();
    x.watches[0].error({code,message:'private location data'});
    assert.equal(x.location.snapshot().status,status);assert.equal(x.location.snapshot().fix,null);
    assert.deepEqual(x.cleared,[0]);assert.ok(!JSON.stringify(x.states).includes('private location data'));
  }
});

test('ignored permission prompt times out even without a browser callback',()=>{
  const x=fixture();x.location.start({consent:true});x.advance(12000);
  assert.equal(x.location.snapshot().status,'timeout');assert.deepEqual(x.cleared,[0]);
  x.fix();assert.equal(x.location.snapshot().fix,null);
});

test('hidden page stops collecting and a visible page does not auto restart',()=>{
  const x=fixture();x.location.start({consent:true});x.fix();x.hidden();x.advance(250);
  assert.equal(x.location.snapshot().status,'hidden');assert.equal(x.location.snapshot().fix,null);
  x.advance(1000);assert.equal(x.watches.length,1);assert.equal(x.timers.size,0);
});

test('wall-clock rollback stops capture and monotonic aging prevents stale fix reuse',()=>{
  const x=fixture();x.location.start({consent:true});x.fix();x.wall(-1);
  assert.equal(x.location.snapshot().status,'clock-invalid');assert.equal(x.location.snapshot().fix,null);
  const y=fixture();y.location.start({consent:true});y.fix();y.tick(30000);
  assert.equal(y.location.snapshot().status,'stale');assert.equal(y.location.snapshot().fix,null);
});

test('two minute session end wipes even frequently updated locations',()=>{
  const x=fixture();x.location.start({consent:true});x.fix();
  for(let i=0;i<5;i++){x.advance(20000);x.fix();}
  assert.equal(x.location.snapshot().fix.validUntil,epoch+120000);
  x.advance(20000);assert.equal(x.location.snapshot().status,'finished');
  assert.equal(x.location.snapshot().fix,null);assert.deepEqual(x.cleared,[0]);
});

test('permission withdrawal after a fix stops capture and removes the permission listener',async()=>{
  const permission=new EventTarget();permission.state='granted';
  const x=fixture({permissions:{query:async()=>permission}});x.location.start({consent:true});x.fix();
  await new Promise(resolve=>setImmediate(resolve));
  permission.state='denied';permission.dispatchEvent(new Event('change'));
  assert.equal(x.location.snapshot().status,'denied');assert.equal(x.location.snapshot().fix,null);
  x.location.stop();permission.dispatchEvent(new Event('change'));
  assert.equal(x.location.snapshot().status,'stopped');
});

test('late permission query and unsupported Permissions API cannot revive or break collection',async()=>{
  let resolvePermission;const permission=new EventTarget();permission.state='denied';
  const x=fixture({permissions:{query:()=>new Promise(resolve=>{resolvePermission=resolve;})}});
  x.location.start({consent:true});await Promise.resolve();x.location.stop();resolvePermission(permission);
  await new Promise(resolve=>setImmediate(resolve));assert.equal(x.location.snapshot().status,'stopped');
  const y=fixture({permissions:{query:async()=>{throw new Error('unsupported');}}});y.location.start({consent:true});y.fix();
  await new Promise(resolve=>setImmediate(resolve));assert.equal(y.location.snapshot().status,'ready');
});

test('synchronous geolocation failures clean resources and blocked invocation remains actionable',()=>{
  const cleared=[];
  const x=fixture({geolocation:{watchPosition:(_success,error)=>{error({code:1});return 0;},clearWatch:id=>cleared.push(id)}});
  x.location.start({consent:true});assert.equal(x.location.snapshot().status,'denied');assert.equal(x.timers.size,0);assert.deepEqual(cleared,[0]);
  const y=fixture({geolocation:{watchPosition(){throw new Error('blocked');},clearWatch(){}}});
  y.location.start({consent:true});assert.equal(y.location.snapshot().status,'unavailable');assert.equal(y.timers.size,0);
});
