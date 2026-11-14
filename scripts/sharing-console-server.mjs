import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {randomBytes,timingSafeEqual} from 'node:crypto';

const assets=new Map([
  ['/', ['index.html','text/html']],['/app.mjs',['app.mjs','text/javascript']],
  ['/view.mjs',['view.mjs','text/javascript']],['/style.css',['style.css','text/css']]
]);
export function createSharingConsoleServer(controller) {
  const token=randomBytes(32).toString('base64url');
  const equal=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{43}$/.test(value)&&timingSafeEqual(Buffer.from(value),Buffer.from(token));
  let server;
  server=createServer(async(req,res)=>{
    res.setHeader('Cache-Control','no-store');res.setHeader('Referrer-Policy','no-referrer');
    res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Cross-Origin-Resource-Policy','same-origin');
    res.setHeader('Permissions-Policy','geolocation=(), camera=(), microphone=()');
    res.setHeader('Content-Security-Policy',"default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
    const send=(status,value)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(value));};
    try {
      const origin=`http://127.0.0.1:${server.address().port}`;
      if(!['127.0.0.1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress)||req.headers.host!==new URL(origin).host)return send(403,{error:'LOCAL_ONLY'});
      if(req.headers.origin&&req.headers.origin!==origin)return send(403,{error:'ORIGIN_DENIED'});
      const path=new URL(req.url,origin).pathname;
      const crossSite=req.headers['sec-fetch-site']&& !['same-origin','none'].includes(req.headers['sec-fetch-site']);
      if(crossSite&&!(req.method==='GET'&&path==='/'&&req.headers['sec-fetch-mode']==='navigate'&&req.headers['sec-fetch-dest']==='document'))return send(403,{error:'ORIGIN_DENIED'});
      if(req.method==='GET'&&assets.has(path)) {
        const [file,type]=assets.get(path),body=await readFile(new URL(`./sharing-console/${file}`,import.meta.url));
        res.writeHead(200,{'Content-Type':type+'; charset=utf-8'});return res.end(body);
      }
      if(req.method==='GET'&&path==='/api/state')return send(200,{consoleToken:token,state:await controller.refresh()});
      if(req.method==='POST'&&['/api/create','/api/end','/api/vehicle/approve','/api/vehicle/revoke'].includes(path)) {
        if(req.headers.origin!==origin||!equal(req.headers['x-pickspot-console']))return send(403,{error:'ACTION_DENIED'});
        if(req.headers['content-type']?.split(';')[0]!=='application/json')return send(415,{error:'JSON_REQUIRED'});
        let body='';for await(const chunk of req){body+=chunk;if(Buffer.byteLength(body)>256)return send(413,{error:'BODY_TOO_LARGE'});}
        let value;try{value=JSON.parse(body);}catch{return send(400,{error:'INVALID_INPUT'});}
        const approval=path==='/api/vehicle/approve';
        if(!value||Array.isArray(value)||typeof value!=='object'||
          (approval?(Object.keys(value).length!==1||typeof value.code!=='string'||!/^[A-F0-9]{12}$/.test(value.code)):Object.keys(value).length!==0))return send(400,{error:'INVALID_INPUT'});
        try{return send(200,{state:await (path==='/api/create'?controller.create():path==='/api/end'?controller.end():controller.vehicleAction(approval?value.code:null))});}
        catch{return send(409,{error:'ACTION_NOT_AVAILABLE'});}
      }
      return send(404,{error:'NOT_FOUND'});
    }catch {if(!res.headersSent)send(500,{error:'CONSOLE_UNAVAILABLE'});else res.end();}
  });
  server.requestTimeout=10_000;server.headersTimeout=10_000;
  return server;
}
