// Render Free only: TLS is terminated by Render's edge. Free services cannot
// receive private-network requests. Paid/private ingress needs a separate review.
export function renderSharingConfig(env=process.env) {
  const fail=code=>{throw new Error(code);};
  if(env.PICKSPOT_DEPLOYMENT!=='render-free'||env.RENDER!=='true'||env.RENDER_SERVICE_TYPE!=='web')fail('RENDER_FREE_REQUIRED');
  let origin;try{origin=new URL(env.RENDER_EXTERNAL_URL);}catch{fail('RENDER_ORIGIN_REQUIRED');}
  if(origin.protocol!=='https:'||origin.origin!==env.RENDER_EXTERNAL_URL||origin.port||origin.username||origin.password||
    !/^[a-z0-9][a-z0-9-]*\.onrender\.com$/.test(origin.hostname)||origin.hostname!==env.RENDER_EXTERNAL_HOSTNAME)fail('RENDER_ORIGIN_REQUIRED');
  if(!/^[A-Za-z0-9_-]{43,128}$/.test(env.PICKSPOT_DRIVER_KEY??''))fail('DRIVER_KEY_REQUIRED');
  const port=env.PORT??'10000';
  if(!/^[1-9]\d{0,4}$/.test(port)||Number(port)>65535||['18012','18013','19099'].includes(port))fail('INVALID_PORT');
  if(env.WEB_CONCURRENCY&&env.WEB_CONCURRENCY!=='1')fail('SINGLE_INSTANCE_REQUIRED');
  if(env.TMAP_APP_KEY||env.TMAP_DAILY_CALL_LIMIT&&env.TMAP_DAILY_CALL_LIMIT!=='0')fail('SHARING_ONLY_DEPLOYMENT');
  return {publicOrigin:origin.origin,driverKey:env.PICKSPOT_DRIVER_KEY,proxyMode:'render-free',host:'0.0.0.0',port:Number(port)};
}
