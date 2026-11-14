import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {vehicleHttpsFixture} from './testing/vehicle-https-fixture.mjs';

// Only an explicitly selected emulator and synthetic fixtures. No env file is read.
const exec=promisify(execFile),root=fileURLToPath(new URL('../',import.meta.url));
if(process.argv.slice(2).join(' ')!=='--fixed-examples') {
  console.error('EXPLICIT_FIXED_EXAMPLES_REQUIRED');process.exit(1);
}
const adb=process.env.ANDROID_HOME?join(process.env.ANDROID_HOME,'platform-tools/adb'):'adb';
const call=(args,options={})=>exec(adb,['-s','emulator-5554',...args],{timeout:15000,maxBuffer:1024*1024,...options});
let dir,fixture,targetUser,reverse=false,staged=false;let stage='emulator';
try {
  const hardware=(await call(['shell','getprop','ro.hardware'])).stdout.trim();
  if(!['ranchu','goldfish'].includes(hardware))throw new Error('EMULATOR_REQUIRED');
  const user=(await call(['shell','am','get-current-user'])).stdout.trim();
  if(!/^\d+$/.test(user))throw new Error('USER_REQUIRED');
  targetUser=user;
  const runAs=['shell','run-as','dev.pickspot.app','--user',user];
  await call([...runAs,'pwd']);
  if((await call(['reverse','--list'])).stdout.includes('tcp:18443'))throw new Error('PROBE_PORT_ALREADY_FORWARDED');
  stage='certificate';dir=await mkdtemp(join(tmpdir(),'pickspot-vehicle-https-'));
  const key=join(dir,'key.pem'),cert=join(dir,'cert.pem');
  await exec('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',key,'-out',cert,'-days','1',
    '-subj','/CN=localhost','-addext','subjectAltName=DNS:localhost'],{timeout:15000});
  fixture=vehicleHttpsFixture({key:await readFile(key),cert:await readFile(cert)});
  stage='listen';await new Promise((resolve,reject)=>{fixture.server.once('error',reject);fixture.server.listen(18443,'127.0.0.1',resolve);});
  stage='probe-install';await call(['install','--user',user,'-r',join(root,'artifacts/pickspot-trip-probe.apk')],{timeout:30000});
  await call(['push',cert,'/data/local/tmp/pickspot-routing-probe-cert.pem']);staged=true;
  await call([...runAs,'cp','/data/local/tmp/pickspot-routing-probe-cert.pem','cache/routing-probe-cert.pem']);
  await call(['reverse','--no-rebind','tcp:18443','tcp:18443']);reverse=true;
  stage='instrumentation';
  const {stdout}=await call(['shell','am','instrument','--user',user,'-w','-e','fixed_examples','true','-e','mode','vehicle-https',
    'dev.pickspot.app.test/dev.pickspot.app.probe.TripProbeInstrumentation'],{timeout:90000});
  // Instrumentation writes only named checks/aggregates. Do not persist raw adb output on failure.
  const start=stdout.indexOf('{'),end=stdout.lastIndexOf('}');
  const result=JSON.parse(stdout.slice(start,end+1));
  const counters=fixture.summary();
  const passed=result.passed===true&&Array.isArray(result.checks)&&result.checks.length===18&&
    counters.fixtureCalls===7&&counters.batches===1&&counters.activeRouteJobs===0;
  const output={passed,kind:'emulator-loopback-https-fixed-fixtures',android:result,server:counters};
  const day=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Seoul',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date()).replaceAll('-','');
  await writeFile(join(root,`artifacts/vehicle-https-${day}.json`),JSON.stringify(output,null,2)+'\n');
  console.log(JSON.stringify(output,null,2));if(!passed)process.exitCode=1;
} catch(error) {
  console.error(JSON.stringify({passed:false,stage,failure:error.name}));process.exitCode=1;
} finally {
  if(reverse)await call(['reverse','--remove','tcp:18443']).catch(()=>{});
  if(staged)await call(['shell','rm','-f','/data/local/tmp/pickspot-routing-probe-cert.pem']).catch(()=>{});
  // The instrumentation also deletes its certificate; this covers early termination.
  if(staged&&targetUser)await call(['shell','run-as','dev.pickspot.app','--user',targetUser,'rm','-f','cache/routing-probe-cert.pem']).catch(()=>{});
  if(fixture?.server.listening)await new Promise(resolve=>{fixture.server.close(resolve);fixture.server.closeAllConnections();});
  if(dir)await rm(dir,{recursive:true,force:true});
}
