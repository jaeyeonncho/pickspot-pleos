import {readFile,lstat} from 'node:fs/promises';
import {X509Certificate,createPrivateKey} from 'node:crypto';
import {isIP} from 'node:net';

const fail=code=>{throw new Error(code);};
async function file(path,privateFile) {
  if(typeof path!=='string'||!path)fail('TLS_FILES_REQUIRED');
  const stat=await lstat(path);
  if(!stat.isFile()||stat.isSymbolicLink()||stat.size>65536)fail('INVALID_TLS_FILE');
  if(privateFile&&(stat.mode&0o077)!==0)fail('TLS_KEY_MUST_BE_PRIVATE');
  return readFile(path);
}
export async function sharingConfig(env=process.env) {
  let origin;try{origin=new URL(env.PICKSPOT_PUBLIC_ORIGIN);}catch{fail('HTTPS_ORIGIN_REQUIRED');}
  if(origin.protocol!=='https:'||origin.origin!==env.PICKSPOT_PUBLIC_ORIGIN||origin.username||origin.password)fail('HTTPS_ORIGIN_REQUIRED');
  if(!/^[A-Za-z0-9_-]{43,128}$/.test(env.PICKSPOT_DRIVER_KEY??''))fail('DRIVER_KEY_REQUIRED');
  const portText=env.PICKSPOT_SHARE_PORT??'8443';
  if(!/^[1-9]\d{0,4}$/.test(portText)||Number(portText)>65535)fail('INVALID_PORT');
  const host=env.PICKSPOT_BIND_ADDRESS??'127.0.0.1';
  if(!['127.0.0.1','0.0.0.0','::1','::'].includes(host))fail('INVALID_BIND_ADDRESS');
  let cert,key;
  try{cert=await file(env.PICKSPOT_TLS_CERT_FILE,false);key=await file(env.PICKSPOT_TLS_KEY_FILE,true);}
  catch(error){if(['TLS_FILES_REQUIRED','INVALID_TLS_FILE','TLS_KEY_MUST_BE_PRIVATE'].includes(error.message))throw error;fail('TLS_FILES_UNREADABLE');}
  let certificate;try{certificate=new X509Certificate(cert);}catch{fail('INVALID_TLS_CERTIFICATE');}
  let privateKey;try{privateKey=createPrivateKey(key);}catch{fail('INVALID_TLS_PRIVATE_KEY');}
  if(!certificate.checkPrivateKey(privateKey))fail('TLS_KEY_CERTIFICATE_MISMATCH');
  if(Date.parse(certificate.validFrom)>Date.now()||Date.parse(certificate.validTo)<=Date.now())fail('TLS_CERTIFICATE_EXPIRED_OR_NOT_YET_VALID');
  const hostname=origin.hostname.replace(/^\[|\]$/g,'');
  if(!(isIP(hostname)?certificate.checkIP(hostname):certificate.checkHost(hostname)))fail('TLS_CERTIFICATE_HOST_MISMATCH');
  return {publicOrigin:origin.origin,driverKey:env.PICKSPOT_DRIVER_KEY,tls:{cert,key},host,port:Number(portText)};
}
