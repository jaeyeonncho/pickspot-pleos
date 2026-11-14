// Loopback-only UI preview. No environment files, API keys, real GPS or route provider.
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
const assets=new Map([
  ['/style.css',['../server/public/style.css','text/css']],
  ['/routing-consent.mjs',['../server/public/routing-consent.mjs','text/javascript']],
  ['/share-client.mjs',['../server/public/share-client.mjs','text/javascript']],
  ['/shared/routing-consent-policy.mjs',['../server/shared/routing-consent-policy.mjs','text/javascript']],
  ['/preview-routing.mjs',['./passenger-routing-preview.mjs','text/javascript']]
]);
const server=createServer(async(req,res)=>{
  if(!['127.0.0.1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress)||req.headers.host!==`127.0.0.1:${server.address().port}`){res.writeHead(403);res.end();return;}
  res.setHeader('Cache-Control','no-store');res.setHeader('Permissions-Policy','geolocation=(), camera=(), microphone=()');
  res.setHeader('Content-Security-Policy',"default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'none'; img-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
  if(req.method!=='GET'){res.writeHead(405);res.end();return;}
  try {
    if(req.url==='/'){
      const html=(await readFile(new URL('../server/public/share.html',import.meta.url),'utf8')).replace('/share-page.mjs','/preview-routing.mjs').replace('픽스팟 · 위치 공유','픽스팟 · 경로 동의 예제');
      res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});res.end(html);return;
    }
    const asset=assets.get(req.url);if(!asset){res.writeHead(404);res.end();return;}
    res.writeHead(200,{'Content-Type':asset[1]+'; charset=utf-8'});res.end(await readFile(new URL(asset[0],import.meta.url)));
  }catch{res.writeHead(500);res.end();}
});
server.listen(8797,'127.0.0.1',()=>console.log('동승자 경로 동의 예제 · 외부 연결/위치 수집 없음: http://127.0.0.1:8797/'));
process.on('SIGTERM',()=>{server.close();server.closeAllConnections();});
