import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { SessionStore, ApiError } from './store.mjs';
import {createTmapExampleRouteCalculator} from './session-routing.mjs';
import {dailyCallLimit} from './routing/call-budget.mjs';

const files = new Map([
  ['/', ['index.html','text/html; charset=utf-8']],
  ['/app.js', ['app.js','text/javascript; charset=utf-8']],
  ['/meeting-state.mjs', ['meeting-state.mjs','text/javascript; charset=utf-8']],
  ['/recovery.mjs', ['recovery.mjs','text/javascript; charset=utf-8']],
  ['/location-check', ['location-check.html','text/html; charset=utf-8']],
  ['/location-check.mjs', ['location-check.mjs','text/javascript; charset=utf-8']],
  ['/browser-location.mjs', ['browser-location.mjs','text/javascript; charset=utf-8']],
  ['/shared/location-policy.mjs', ['../shared/location-policy.mjs','text/javascript; charset=utf-8']],
  ['/style.css', ['style.css','text/css; charset=utf-8']]
]);
async function jsonBody(req) {
  if (req.headers['content-type']?.split(';')[0] !== 'application/json') throw new ApiError(415,'JSON_REQUIRED');
  let body = ''; let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > 4096) throw new ApiError(413,'BODY_TOO_LARGE');
    body += chunk;
  }
  let data;
  try { data = JSON.parse(body); } catch { throw new ApiError(400,'INVALID_JSON'); }
  if (!data || Array.isArray(data) || typeof data !== 'object') throw new ApiError(400,'INVALID_JSON');
  return data;
}
export function createApp({store = new SessionStore(), rateLimit = 30, competitionDemo = false} = {}) {
  // Live session inputs are internal only until authenticated HTTPS transport is ready.
  if(store.locationMode!=='example')throw new ApiError(400,'LIVE_HTTP_NOT_ENABLED');
  if(competitionDemo&&store.routingMode!=='fixture')throw new ApiError(400,'COMPETITION_FIXTURE_REQUIRED');
  const requests = new Map();
  const server = createServer(async (req,res) => {
    const port = server.address().port;
    const origins = [`http://127.0.0.1:${port}`,`http://localhost:${port}`];
    res.setHeader('Cache-Control','no-store');
    res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('Referrer-Policy','no-referrer');
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    const send = (status,data) => { res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'}); res.end(JSON.stringify(data)); };
    try {
      if (![`127.0.0.1:${port}`,`localhost:${port}`].includes(req.headers.host)) throw new ApiError(403,'HOST_DENIED');
      if ((req.headers.origin && !origins.includes(req.headers.origin)) || req.headers['sec-fetch-site'] === 'cross-site') throw new ApiError(403,'ORIGIN_DENIED');
      const path = new URL(req.url,origins[0]).pathname;
      res.setHeader('Permissions-Policy',path==='/location-check'?'geolocation=(self)':'geolocation=()');
      if(path==='/location-check') res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'none'; img-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
      if (req.method === 'GET' && files.has(path)) {
        const [file,type] = files.get(path);
        const content = await readFile(new URL(`./public/${file}`,import.meta.url));
        res.writeHead(200,{'Content-Type':type}); return res.end(content);
      }
      if (req.method === 'GET' && path === '/health') return send(200,{service:'pickspot-local',version:'0.11.0',exampleOnly:true,routingMode:store.routingMode,...(competitionDemo?{competitionDemo:true}:{})});
      if (req.method === 'POST' && ['/v1/sessions','/v1/invitations/redeem'].includes(path)) {
        const key = req.socket.remoteAddress;
        const now = Date.now(); const record = requests.get(key);
        const window = record && now - record.start < 60_000 ? record : { start:now, count:0 };
        requests.set(key,window);
        if (++window.count > rateLimit) { res.setHeader('Retry-After','60'); throw new ApiError(429,'RATE_LIMIT'); }
        const data = await jsonBody(req);
        return send(201,path === '/v1/sessions' ? store.create() : store.redeem(data.code));
      }
      const match = /^\/v1\/sessions\/([a-zA-Z0-9-]+)(?:\/(passenger-location|selection|meeting-choice|navigation|route-refresh|destination))?$/.exec(path);
      if (!match) throw new ApiError(404,'NOT_FOUND');
      const [,id,action] = match;
      if(action==='meeting-choice'&&!competitionDemo)throw new ApiError(404,'NOT_FOUND');
      const token = /^Bearer ([A-Za-z0-9_-]+)$/.exec(req.headers.authorization ?? '')?.[1];
      if (!token) throw new ApiError(401,'AUTH_REQUIRED');
      if (req.method === 'GET' && !action) return send(200,store.read(id,token));
      if (req.method === 'DELETE' && !action) { store.end(id,token); return send(200,{status:'ended'}); }
      if (req.method === 'PUT') {
        const data = await jsonBody(req);
        if(action==='meeting-choice') {
          if(Object.keys(data).some(key=>!['candidateId','expectedVersion'].includes(key)))throw new ApiError(400,'INVALID_INPUT');
          return send(200,store.select(id,token,data,{previewOnly:true}));
        }
        if (action === 'passenger-location') return send(200,store.shareExample(id,token,data));
        if (action === 'selection') return send(200,store.select(id,token,data));
        if (action === 'destination') return send(202,store.changeDestination(id,token,data));
        if (action === 'route-refresh') return send(202,store.refreshRoutes(id,token,data));
        if (action === 'navigation') return send(200,store.report(id,token,data));
      }
      throw new ApiError(405,'METHOD_NOT_ALLOWED');
    } catch (error) {
      send(error instanceof ApiError ? error.status : 500,{error:error instanceof ApiError ? error.code : 'INTERNAL_ERROR'});
    }
  });
  server.requestTimeout = 10_000; server.headersTimeout = 10_000;
  const cleanup = setInterval(() => store.sweep(), 1000); cleanup.unref();
  server.on('close',()=>{clearInterval(cleanup);store.dispose();});
  return server;
}
export function configuredStore({args=[],env=process.env,fetchImpl=fetch,budget}={}) {
  if(args.length===0)return new SessionStore();
  if(args.length!==1||args[0]!=='--tmap-example')throw new ApiError(400,'INVALID_SERVER_MODE');
  const limit=dailyCallLimit(env.TMAP_DAILY_CALL_LIMIT);
  if(limit===0)throw new ApiError(400,'ROUTE_BUDGET_DISABLED');
  return new SessionStore({routingMode:'tmap-example',calculateRoutes:createTmapExampleRouteCalculator({
    appKey:env.TMAP_APP_KEY,limit,fetchImpl,...(budget?{budget}:{})})});
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
  const port = Number(process.env.PICKSPOT_PORT ?? 8787);
  const store=configuredStore({args:process.argv.slice(2)});
  const server = createApp({store});
  server.on('error',()=>{ console.error('픽스팟 로컬 서버를 시작하지 못했습니다. 포트 사용 여부를 확인하세요.'); process.exitCode = 1; });
  server.listen(port,'127.0.0.1',()=>console.log(`픽스팟 동승자 웹: http://127.0.0.1:${port} (예제 위치 · ${store.routingMode==='tmap-example'?'TMAP 실제 경로':'오프라인 예제 경로'})`));
  }catch{console.error('서버 설정을 확인해 주세요. TMAP 모드는 앱 키와 양수 일간 한도가 필요합니다.');process.exitCode=1;}
}
