import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {createLiveApp} from '../live-http.mjs';
import {checkHostedSharing} from '../../scripts/check-hosted-sharing.mjs';
test('hosted verification exercises authenticated sharing with a fixed point and ends the meeting without exposing credentials',async t=>{
  const origin='https://test.onrender.com',key='k'.repeat(43);
  const server=createLiveApp({publicOrigin:origin,driverKey:key,proxyMode:'render-free'});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}));
  let creates=0;
  const fetchImpl=async(url,options)=>new Promise((resolve,reject)=>{
    const parsed=new URL(url);assert.equal(parsed.origin,origin);assert.equal(options.redirect,'error');
    if(parsed.pathname==='/v1/sessions')creates++;
    const req=http.request({hostname:'127.0.0.1',port:server.address().port,path:parsed.pathname,method:options.method,
      headers:{host:parsed.host,'x-forwarded-proto':'https',...options.headers,...(options.body?{'content-length':Buffer.byteLength(options.body)}:{})},signal:options.signal},res=>{
      const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.on('end',()=>resolve(new Response(Buffer.concat(chunks),{status:res.statusCode,headers:res.headers})));
    });req.on('error',reject);req.end(options.body);
  });
  const result=await checkHostedSharing({origin,driverKey:key,fetchImpl});
  assert.equal(result.passed,true,JSON.stringify(result));assert.equal(result.cleanupConfirmed,true);assert.equal(result.checks.length,5);assert.equal(creates,2);
  assert.ok(!JSON.stringify(result).includes(key));assert.ok(!JSON.stringify(result).includes('latitude'));
});
