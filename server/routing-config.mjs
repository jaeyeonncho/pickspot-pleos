import {open,constants} from 'node:fs/promises';
import {parseEnv} from 'node:util';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {sharingConfig} from './sharing-config.mjs';
import {CandidateCatalog} from './catalog/repository.mjs';
import {auditCatalog} from './catalog/catalog.mjs';
import {dailyCallLimit,FileCallBudget} from './routing/call-budget.mjs';
import {createTmapBatchProvider} from './routing/batch-provider.mjs';
import {SessionStore} from './store.mjs';

const PROFILE_KEYS=['PICKSPOT_ROUTING_MODE','PICKSPOT_PUBLIC_ORIGIN','PICKSPOT_TLS_CERT_FILE','PICKSPOT_TLS_KEY_FILE',
  'PICKSPOT_DRIVER_KEY','PICKSPOT_SHARE_PORT','PICKSPOT_BIND_ADDRESS','PICKSPOT_PROCESSING_REGION',
  'PICKSPOT_CANDIDATE_FILE','PICKSPOT_CANDIDATE_IDS','PICKSPOT_TMAP_ENV_FILE'];
export const DEFAULT_ROUTING_ENV=new URL('../.env.routing.local',import.meta.url);
export const DEFAULT_CATALOG=new URL('./catalog/yangjae-maebong.json',import.meta.url);
const fail=code=>{throw new Error(code);};
const absolute=path=>path instanceof URL?fileURLToPath(path):resolve(path);
async function readBounded(path,{privateFile=false,maxBytes=16384,kind='ROUTING_ENV'}={}) {
  let file;
  try {
    file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
    const stat=await file.stat();
    if(!stat.isFile()||stat.size>maxBytes)fail(`${kind}_INVALID`);
    if(privateFile&&(stat.mode&0o077))fail(`${kind}_PERMISSIONS`);
    const buffer=Buffer.alloc(maxBytes+1);let count=0;
    while(count<buffer.length){const {bytesRead}=await file.read(buffer,count,buffer.length-count,null);if(!bytesRead)break;count+=bytesRead;}
    if(count>maxBytes)fail(`${kind}_INVALID`);
    return buffer.subarray(0,count).toString('utf8');
  }catch(error){
    if(error?.message?.startsWith(kind+'_'))throw error;
    fail(error?.code==='ENOENT'?`${kind}_MISSING`:`${kind}_UNREADABLE`);
  }finally{await file?.close();}
}
async function privateEnv(path,keys,kind,{strict=false}={}) {
  const contents=await readBounded(path,{privateFile:true,kind});let env;
  try{env=parseEnv(contents);}catch{fail(`${kind}_INVALID`);}
  for(const key of keys){
    if(contents.split(/\r?\n/).filter(line=>new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=`).test(line)).length>1)fail(`${kind}_DUPLICATED`);
  }
  if(strict&&Object.keys(env).some(key=>!keys.includes(key)))fail(`${kind}_UNKNOWN_FIELD`);
  return Object.fromEntries(keys.filter(key=>env[key]!==undefined).map(key=>[key,env[key]]));
}
export async function loadRoutingCatalog(path=DEFAULT_CATALOG,{now=Date.now()}={}) {
  let raw;try{raw=JSON.parse(await readBounded(path,{maxBytes:2_000_000,kind:'ROUTING_CATALOG'}));}
  catch(error){if(error.message?.startsWith('ROUTING_CATALOG_'))throw error;fail('INVALID_CANDIDATE_CATALOG');}
  return {catalog:new CandidateCatalog(raw),audit:auditCatalog(raw,{now})};
}

/** Reads and validates only. No listener, external request, ledger reservation or secret output. */
export async function routingConfiguration({envPath=DEFAULT_ROUTING_ENV,now=Date.now}={}) {
  const env=await privateEnv(envPath,PROFILE_KEYS,'ROUTING_ENV',{strict:true});
  if(env.PICKSPOT_ROUTING_MODE!=='direct-tls')fail('ROUTING_MODE_REQUIRED');
  const region=env.PICKSPOT_PROCESSING_REGION;
  if(typeof region!=='string'||!region.trim()||region.length>100||/[\u0000-\u001f\u007f]/.test(region))fail('PROCESSING_REGION_REQUIRED');
  const ids=(env.PICKSPOT_CANDIDATE_IDS??'').split(',').map(s=>s.trim());
  if(ids.length<1||ids.length>3||new Set(ids).size!==ids.length||!ids.every(id=>/^[a-zA-Z0-9_-]{1,40}$/.test(id)))fail('CANDIDATE_IDS_REQUIRED');
  if(!env.PICKSPOT_TMAP_ENV_FILE)fail('TMAP_ENV_REQUIRED');
  const base=dirname(absolute(envPath));
  for(const key of ['PICKSPOT_TLS_CERT_FILE','PICKSPOT_TLS_KEY_FILE'])if(env[key])env[key]=resolve(base,env[key]);
  const tlsConfig=await sharingConfig(env);
  const {catalog,audit}=await loadRoutingCatalog(env.PICKSPOT_CANDIDATE_FILE?resolve(base,env.PICKSPOT_CANDIDATE_FILE):DEFAULT_CATALOG,{now:now()});
  const selected=catalog.select(ids,{now:now()});
  // Reuse the existing TMAP settings explicitly; never merge the whole environment.
  const tmap=await privateEnv(resolve(base,env.PICKSPOT_TMAP_ENV_FILE),['TMAP_APP_KEY','TMAP_DAILY_CALL_LIMIT'],'TMAP_ENV');
  if(typeof tmap.TMAP_APP_KEY!=='string'||!tmap.TMAP_APP_KEY.trim()||/[\r\n]/.test(tmap.TMAP_APP_KEY))fail('TMAP_KEY_REQUIRED');
  const limit=dailyCallLimit(tmap.TMAP_DAILY_CALL_LIMIT);
  const batchCalls=1+2*ids.length;
  if(limit<batchCalls)fail('ROUTE_BATCH_BUDGET_REQUIRED');
  // Intentionally the same project ledger used by the existing example server.
  // There is no per-profile override that could silently reset its accounting.
  const budget=new FileCallBudget({limit,now});
  const budgetStatus=await budget.status();
  return {...tlsConfig,processingRegion:region,candidateIds:ids,catalog,selection:selected,audit,
    appKey:tmap.TMAP_APP_KEY.trim(),limit,budget,budgetStatus,batchCalls};
}

/** Only the explicit server entry point invokes this after validation. No eager TMAP call. */
export function createRoutingOptions(config,{fetchImpl=fetch,now=Date.now}={}) {
  config.catalog.assertCurrent(config.selection,{now:now()});
  const store=new SessionStore({locationMode:'live',candidateCatalog:config.catalog,now});
  try {
    const routeProvider=createTmapBatchProvider({appKey:config.appKey,limit:config.limit,budget:config.budget,fetchImpl});
    return {tls:config.tls,publicOrigin:config.publicOrigin,driverKey:config.driverKey,store,routeProvider,
      vehiclePairing:{processingRegion:config.processingRegion,candidateIds:config.candidateIds},
      routingDisclosure:{processingRegion:config.processingRegion},now};
  }catch(error){store.dispose();throw error;}
}
