import {createServer as httpServer} from 'node:http';
import {createServer as httpsServer} from 'node:https';
import {readFile} from 'node:fs/promises';
import {timingSafeEqual} from 'node:crypto';
import {SessionStore,ApiError} from './store.mjs';
import {vehicleRouteRequest,routeHttpError,routeHttpReport} from './route-http.mjs';
import {routingDisclosure as buildRoutingDisclosure} from './routing-disclosure.mjs';
import {VehiclePairings} from './vehicle-pairing.mjs';

const assets=new Map([
  ['/', ['share.html','text/html']],['/driver',['share-driver.html','text/html']],
  ['/share-page.mjs',['share-page.mjs','text/javascript']],['/share-driver.mjs',['share-driver.mjs','text/javascript']],
  ['/share-client.mjs',['share-client.mjs','text/javascript']],
  ['/invitation-link.mjs',['invitation-link.mjs','text/javascript']],
  ['/shared-recommendation.mjs',['shared-recommendation.mjs','text/javascript']],['/share-api.mjs',['share-api.mjs','text/javascript']],
  ['/routing-consent.mjs',['routing-consent.mjs','text/javascript']],
  ['/shared/routing-consent-policy.mjs',['../shared/routing-consent-policy.mjs','text/javascript']],
  ['/browser-location.mjs',['browser-location.mjs','text/javascript']],
  ['/shared/location-policy.mjs',['../shared/location-policy.mjs','text/javascript']],['/style.css',['style.css','text/css']]
]);
const fail=(status,code)=>{throw new ApiError(status,code);};
const exact=(body,keys)=>Object.keys(body).every(key=>keys.includes(key));
const sameSecret=(a,b)=>typeof a==='string'&&a.length===b.length&&timingSafeEqual(Buffer.from(a),Buffer.from(b));
async function bodyOf(req) {
  if(req.headers['content-type']?.split(';')[0]!=='application/json')fail(415,'JSON_REQUIRED');
  const chunks=[];let bytes=0;
  for await(const chunk of req){bytes+=chunk.length;if(bytes>4096)fail(413,'BODY_TOO_LARGE');chunks.push(chunk);}
  let body;try{body=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{fail(400,'INVALID_JSON');}
  if(!body||typeof body!=='object'||Array.isArray(body))fail(400,'INVALID_JSON');return body;
}

// Simulation is loopback-only and can accept only its published synthetic point.
// Real mode requires direct TLS or the explicit Render Free edge boundary, a fixed
// origin, and a private driver bootstrap key. Never enable proxy mode on an exposed VM.
export function createLiveApp({simulation=false,sharedRecommendations=false,proxyMode=null,tls,publicOrigin,driverKey,routeProvider=null,vehiclePairing=null,routingDisclosure=null,store=new SessionStore({locationMode:'live',routingMode:sharedRecommendations?'sharing-fixture':'fixture'}),now=Date.now}={}) {
  if(proxyMode!==null&&proxyMode!=='render-free')fail(400,'INVALID_PROXY_MODE');
  if(proxyMode&&(simulation||tls))fail(400,'INVALID_PROXY_MODE');
  if(sharedRecommendations&&!simulation)fail(400,'SIMULATION_ROUTES_ONLY');
  if((store.routingMode==='sharing-fixture')!==sharedRecommendations)fail(400,'ROUTING_MODE_MISMATCH');
  if(store.locationMode!=='live')fail(400,'LIVE_STORE_REQUIRED');
  // Explicit server injection only; existing launchers and Render remain sharing-only.
  if(routeProvider!==null) {
    if(simulation||proxyMode||sharedRecommendations)fail(400,'DIRECT_TLS_ROUTES_ONLY');
    if(routeProvider.source!=='tmap'||routeProvider.synthetic!==false||typeof routeProvider.route!=='function'||
      typeof routeProvider.prepareBatch!=='function')fail(400,'INVALID_LIVE_ROUTE_PROVIDER');
  }
  if(!simulation) {
    let url;try{url=new URL(publicOrigin);}catch{fail(400,'HTTPS_ORIGIN_REQUIRED');}
    if(url.protocol!=='https:'||url.origin!==publicOrigin||url.username||url.password||(!proxyMode&&(!tls?.key||!tls?.cert)))fail(400,'HTTPS_ORIGIN_REQUIRED');
    if(typeof driverKey!=='string'||!/^[A-Za-z0-9_-]{43,128}$/.test(driverKey))fail(400,'DRIVER_KEY_REQUIRED');
  }
  let pairingConfig=null;
  if(vehiclePairing!==null) {
    if(!routeProvider||simulation||proxyMode)fail(400,'PAIRING_ROUTES_REQUIRED');
    const {processingRegion,candidateIds}=vehiclePairing;
    if(typeof processingRegion!=='string'||!processingRegion.trim()||processingRegion.length>100||/[\u0000-\u001f\u007f]/.test(processingRegion)||
      !Array.isArray(candidateIds)||candidateIds.length<1||candidateIds.length>3||new Set(candidateIds).size!==candidateIds.length||
      !candidateIds.every(id=>typeof id==='string'&&/^[a-zA-Z0-9_-]{1,40}$/.test(id)))fail(400,'INVALID_PAIRING_CONFIG');
    pairingConfig={processingRegion,candidateIds:[...candidateIds]};
  }
  const disclosureConfig=routingDisclosure??(pairingConfig?{processingRegion:pairingConfig.processingRegion}:null);
  if(disclosureConfig&&(!routeProvider||simulation||proxyMode))fail(400,'DIRECT_TLS_DISCLOSURE_ONLY');
  const disclosure=disclosureConfig?buildRoutingDisclosure(publicOrigin,disclosureConfig):null;
  if(disclosure&&pairingConfig&&disclosure.processingRegion!==pairingConfig.processingRegion)fail(400,'DISCLOSURE_REGION_MISMATCH');
  const pairings=pairingConfig?new VehiclePairings({store,now}):null;
  const windows=new Map();
  const limit=(key,max,ms)=>{
    const at=now();let entry=windows.get(key);
    if(!entry||at-entry.at>=ms||at<entry.at) {entry={at,count:0};windows.set(key,entry);}
    if(++entry.count>max)fail(429,'RATE_LIMIT');
  };
  let server;
  const handler=async(req,res)=>{
    res.setHeader('Cache-Control','no-store');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    res.setHeader('Permissions-Policy',simulation?'geolocation=()':'geolocation=(self)');
    const send=(status,value)=>{if(res.destroyed||res.writableEnded)return;res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(value));};
    try {
      const origin=simulation?`http://127.0.0.1:${server.address().port}`:publicOrigin;
      if(simulation&&!['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress))fail(403,'LOOPBACK_REQUIRED');
      if(!simulation&&!req.socket.encrypted) {
        const forwardedCount=req.rawHeaders.filter((value,index)=>index%2===0&&value.toLowerCase()==='x-forwarded-proto').length;
        if(proxyMode!=='render-free'||forwardedCount!==1||req.headers['x-forwarded-proto']!=='https')fail(403,'TLS_REQUIRED');
      }
      if(!simulation)res.setHeader('Strict-Transport-Security','max-age=86400');
      if(req.headers.host!==new URL(origin).host)fail(403,'HOST_DENIED');
      const path=new URL(req.url,origin).pathname;
      // Opening the public entry page from a shared link is a cross-site top-level
      // navigation. It returns no session data. API/fetch/iframe requests remain blocked.
      const publicNavigation=req.method==='GET'&&path==='/'&&!req.headers.origin&&
        req.headers['sec-fetch-mode']==='navigate'&&req.headers['sec-fetch-dest']==='document';
      if((req.headers.origin&&req.headers.origin!==origin)||req.headers['sec-fetch-site']==='cross-site'&&!publicNavigation)fail(403,'ORIGIN_DENIED');
      if(!['GET','HEAD'].includes(req.method)&&req.headers.origin!==origin)fail(403,'ORIGIN_REQUIRED');
      if(req.method==='GET'&&path==='/health')return send(200,{service:'pickspot-sharing',simulation,locationSharing:!simulation,routeReady:false,...(disclosure?{passengerRoutingConsent:true}:{}),...(pairings?{vehiclePairing:true}:{}),...(proxyMode?{hosting:proxyMode}:{}),...(sharedRecommendations?{sharedRecommendations:true}:{})});
      if(req.method==='GET'&&assets.has(path)) {
        if(path==='/driver'&&!simulation)fail(404,'NOT_FOUND');
        const [file,type]=assets.get(path);res.writeHead(200,{'Content-Type':`${type}; charset=utf-8`});
        return res.end(await readFile(new URL(`./public/${file}`,import.meta.url)));
      }
      const bearer=/^Bearer ([A-Za-z0-9_-]+)$/.exec(req.headers.authorization??'')?.[1];
      if(path==='/v1/vehicle-pairings'||path.startsWith('/v1/vehicle-pairings/')) {
        if(!pairings)fail(404,'NOT_FOUND');
        if(path==='/v1/vehicle-pairings'&&req.method==='POST') {
          limit('pairing:create',10,60000);const body=await bodyOf(req);
          if(!exact(body,[]))fail(400,'INVALID_INPUT');return send(201,pairings.create());
        }
        const pairingMatch=/^\/v1\/vehicle-pairings\/([a-f0-9-]{36})(\/claim)?$/.exec(path);
        if(!pairingMatch)fail(404,'NOT_FOUND');if(!bearer)fail(401,'AUTH_REQUIRED');
        const [,pairingId,claim]=pairingMatch;
        if(req.method==='DELETE'&&!claim)return send(200,pairings.cancel(pairingId,bearer));
        if(req.method!=='POST'||!claim)fail(405,'METHOD_NOT_ALLOWED');
        limit('pairing:claim',120,60000);
        const body=await bodyOf(req);if(!exact(body,[]))fail(400,'INVALID_INPUT');
        try {
          const result=pairings.claim(pairingId,bearer,()=>{
            if(!store.candidateCatalog)fail(503,'CANDIDATE_CATALOG_REQUIRED');
            store.candidateCatalog.select(pairingConfig.candidateIds,{now:now()});
            return {origin:publicOrigin,processingRegion:pairingConfig.processingRegion,candidateIds:pairingConfig.candidateIds};
          });
          return send(result.status==='pending'?202:200,result);
        }catch(error){throw routeHttpError(error);}
      }
      if(req.method==='POST'&&['/v1/sessions','/v1/invitations/redeem'].includes(path)) {
        // Bound untrusted client cardinality without persisting addresses or tokens.
        limit('entry',30,60000);
        const body=await bodyOf(req);
        if(path==='/v1/sessions') {
          if(!simulation&&!sameSecret(bearer,driverKey))fail(403,'DRIVER_ACCESS_DENIED');
          if(!exact(body,[]))fail(400,'INVALID_INPUT');return send(201,store.create());
        }
        if(!exact(body,['code']))fail(400,'INVALID_INPUT');return send(201,store.redeem(body.code));
      }
      const match=/^\/v1\/sessions\/([a-f0-9-]{36})(?:\/(location-consent|passenger-location|route-comparisons|vehicle-pairings|routing-disclosure))?$/.exec(path);
      if(!match)fail(404,'NOT_FOUND');if(!bearer)fail(401,'AUTH_REQUIRED');
      const [,id,action]=match;
      const {role}=store.authenticate(id,bearer);
      if(action==='routing-disclosure') {
        if(!disclosure)fail(404,'NOT_FOUND');
        if(role!=='passenger')fail(403,'PASSENGER_ONLY');
        if(req.method!=='GET')fail(405,'METHOD_NOT_ALLOWED');
        limit(`${id}:routing-disclosure`,30,60000);
        return send(200,{...disclosure,expiresAt:store.read(id,bearer).expiresAt});
      }
      if(action==='vehicle-pairings') {
        if(!pairings)fail(404,'NOT_FOUND');if(role!=='driver')fail(403,'OWNER_ONLY');
        if(req.method==='DELETE')return send(200,store.revokeVehicle(id,bearer));
        if(req.method!=='POST')fail(405,'METHOD_NOT_ALLOWED');
        limit(`${id}:pairing:approve`,6,60000);
        const body=await bodyOf(req);if(!exact(body,['code']))fail(400,'INVALID_INPUT');
        return send(200,pairings.approve(id,bearer,body.code));
      }
      if(action==='route-comparisons') {
        if(!routeProvider)fail(404,'NOT_FOUND');
        if(req.method!=='POST')fail(405,'METHOD_NOT_ALLOWED');
        if(!['driver','vehicle'].includes(role))fail(403,'DRIVER_ONLY');
        limit(`${id}:routes`,20,60000);
        const {expectedVersion,trip}=vehicleRouteRequest(await bodyOf(req));
        if(store.read(id,bearer).version!==expectedVersion)fail(409,'VERSION_CONFLICT');
        const controller=new AbortController();
        const abort=()=>controller.abort();
        res.once('close',abort);
        if(req.aborted||res.destroyed)abort();
        try {
          const report=await store.calculateLiveRoutes(id,bearer,trip,{provider:routeProvider,signal:controller.signal});
          return send(200,routeHttpReport(report));
        }catch(error){throw routeHttpError(error);}
        finally {res.off('close',abort);}
      }
      if(req.method==='GET'&&!action) {limit(`${id}:${role}:read`,90,60000);return send(200,store.read(id,bearer));}
      // End and withdrawal are never gated by the location-update rate limiter.
      if(req.method==='DELETE'&&!action){store.end(id,bearer);return send(200,{status:'ended'});}
      if(action==='location-consent'&&req.method==='DELETE') {
        const body=await bodyOf(req);
        return send(200,store.withdrawLocation(id,bearer,body));
      }
      if(action==='location-consent'&&req.method==='POST') {
        if(role!=='passenger')fail(403,'PASSENGER_ONLY');limit(`${id}:grant`,6,60000);
        const body=await bodyOf(req);
        if(!exact(body,['consent','expectedRevision','routingProvider','routingDisclosureId']))fail(400,'INVALID_INPUT');
        if(body.routingProvider==='tmap') {
          if(!disclosure)fail(403,'ROUTING_CONSENT_UNAVAILABLE');
          if(body.routingDisclosureId!==disclosure.id)fail(409,'ROUTING_DISCLOSURE_CHANGED');
        }else if(body.routingDisclosureId!==undefined)fail(400,'INVALID_ROUTING_CONSENT');
        const {routingDisclosureId,...consent}=body;
        return send(200,store.grantLocation(id,bearer,consent));
      }
      if(action==='passenger-location'&&req.method==='PUT') {
        if(role!=='passenger')fail(403,'PASSENGER_ONLY');limit(`${id}:fix`,30,60000);
        const body=await bodyOf(req);
        return send(200,store.updateLocation(id,bearer,body,{simulation}));
      }
      fail(405,'METHOD_NOT_ALLOWED');
    }catch(error){if(error?.status===429)res.setHeader('Retry-After','60');send(error instanceof ApiError?error.status:500,{error:error instanceof ApiError?error.code:'INTERNAL_ERROR'});}
  };
  server=simulation||proxyMode?httpServer(handler):httpsServer(tls,handler);
  server.requestTimeout=10000;server.headersTimeout=10000;
  const sweep=setInterval(()=>{
    store.sweep();pairings?.sweep();for(const [key,value] of windows)if(now()-value.at>=60000)windows.delete(key);
  },1000);sweep.unref();
  server.on('close',()=>{clearInterval(sweep);pairings?.dispose();store.dispose();windows.clear();});
  return server;
}
