import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,chmod,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {checkSharingSetup} from '../check-sharing-setup.mjs';
import {sharingConfig} from '../sharing-config.mjs';
const exec=promisify(execFile);
async function directory(t) {const dir=await mkdtemp(join(tmpdir(),'pickspot-sharing-check-'));t.after(()=>rm(dir,{recursive:true,force:true}));return dir;}
test('missing, public and duplicate environment files give a redacted offline report',async t=>{
  const dir=await directory(t),envPath=join(dir,'.env.sharing.local'),secret='secret-not-for-output';
  assert.equal((await checkSharingSetup({envPath})).code,'ENV_FILE_MISSING');
  await writeFile(envPath,`PICKSPOT_DRIVER_KEY=${secret}\n`,{mode:0o644});
  assert.equal((await checkSharingSetup({envPath})).code,'ENV_PERMISSIONS');await chmod(envPath,0o600);
  await writeFile(envPath,`PICKSPOT_DRIVER_KEY=${secret}\nPICKSPOT_DRIVER_KEY=second\n`);
  const report=await checkSharingSetup({envPath});assert.equal(report.code,'ENV_DUPLICATED');
  assert.equal(report.externalRequests,0);assert.ok(!JSON.stringify(report).includes(secret));
});
test('offline HTTPS check validates matching keys and reports mismatch without key contents',async t=>{
  const dir=await directory(t),envPath=join(dir,'.env.sharing.local'),cert=join(dir,'cert.pem'),key=join(dir,'key.pem'),wrong=join(dir,'wrong.pem');
  await exec('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',key,'-out',cert,'-days','1','-subj','/CN=localhost','-addext','subjectAltName=DNS:localhost']);
  await exec('openssl',['genpkey','-algorithm','RSA','-pkeyopt','rsa_keygen_bits:2048','-out',wrong]);
  await chmod(key,0o600);await chmod(wrong,0o600);
  const driverKey='z'.repeat(43),env={PICKSPOT_PUBLIC_ORIGIN:'https://localhost',PICKSPOT_TLS_CERT_FILE:cert,PICKSPOT_TLS_KEY_FILE:key,PICKSPOT_DRIVER_KEY:driverKey};
  await writeFile(envPath,`PICKSPOT_PUBLIC_ORIGIN=https://localhost\nPICKSPOT_TLS_CERT_FILE=cert.pem\nPICKSPOT_TLS_KEY_FILE=key.pem\nPICKSPOT_DRIVER_KEY=${driverKey}\n`,{mode:0o600});
  const report=await checkSharingSetup({envPath});assert.equal(report.configurationReady,true);assert.equal(report.scope,'loopback');assert.equal(report.externalRequests,0);
  assert.ok(!JSON.stringify(report).includes(driverKey));assert.ok(!JSON.stringify(report).includes('BEGIN PRIVATE'));
  await assert.rejects(sharingConfig({...env,PICKSPOT_TLS_KEY_FILE:wrong}),e=>e.message==='TLS_KEY_CERTIFICATE_MISMATCH');
  await writeFile(wrong,'invalid private key');await assert.rejects(sharingConfig({...env,PICKSPOT_TLS_KEY_FILE:wrong}),e=>e.message==='INVALID_TLS_PRIVATE_KEY');
});
