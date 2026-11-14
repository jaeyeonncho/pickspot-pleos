import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
const files=new Map([['/',['./index.html','text/html']],['/browser-location.mjs',['../../public/browser-location.mjs','text/javascript']],['/routing-consent.mjs',['../../public/routing-consent.mjs','text/javascript']],['/shared/routing-consent-policy.mjs',['../../shared/routing-consent-policy.mjs','text/javascript']],['/share-client.mjs',['../../public/share-client.mjs','text/javascript']],['/shared/location-policy.mjs',['../../shared/location-policy.mjs','text/javascript']]]);
createServer(async(req,res)=>{
 const file=files.get(req.url);if(!file){res.writeHead(404);res.end();return;}
 res.writeHead(200,{'Content-Type':file[1]+'; charset=utf-8','Cache-Control':'no-store','Permissions-Policy':'geolocation=()'});
 res.end(await readFile(new URL(file[0],import.meta.url)));
}).listen(8792,'127.0.0.1',()=>console.log('브라우저 실행 검사: http://127.0.0.1:8792/'));
