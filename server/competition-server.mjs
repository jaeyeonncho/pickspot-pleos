import {fileURLToPath} from 'node:url';
import {createApp} from './server.mjs';
import {SessionStore} from './store.mjs';
import {FixtureRoutes} from './routing/fixture.mjs';
import {exampleTrip,exampleDestinations} from './routing/example.mjs';
import {estimatePickupRoutes} from './routing/estimate.mjs';

const DEMO_ROUTE_TTL_MS=30*60_000;
const DEMO_SESSION_TTL_MS=60*60_000;
// Authored, fixed inputs only: a presentation does not depend on GPS freshness.
// Keep this separate from TripInput and all live/TMAP freshness policies.
async function calculateCompetitionRoutes({signal,destinationId='maebong',now=Date.now}) {
  const requestedAt=now();
  const report=await estimatePickupRoutes(exampleTrip(destinationId),{
    provider:new FixtureRoutes(destinationId),signal,now});
  return {...report,inputMode:'example',inputValidUntil:requestedAt+DEMO_ROUTE_TTL_MS,
    destinationName:exampleDestinations.find(d=>d.id===destinationId).name};
}

// Explicit competition fixture: no configuration/key/catalog/budget files are read.
export function createCompetitionApp({now=Date.now}={}) {
  return createApp({store:new SessionStore({now,calculateRoutes:calculateCompetitionRoutes,routeTtlMs:DEMO_ROUTE_TTL_MS,ttlMs:DEMO_SESSION_TTL_MS}),competitionDemo:true});
}
if(process.argv[1]===fileURLToPath(import.meta.url)) {
  if(process.argv.slice(2).join(' ')!=='--serve') {
    console.error('EXPLICIT_COMPETITION_MODE_REQUIRED');process.exitCode=1;
  }else {
    const server=createCompetitionApp();
    server.on('error',()=>{console.error('공모전 시연 포트 8788을 사용할 수 없어요.');server.close();process.exitCode=1;});
    server.listen(8788,'127.0.0.1',()=>console.log('공모전 시연 웹: http://127.0.0.1:8788/ · 예제 위치·경로'));
    const stop=()=>{server.close();server.closeAllConnections();};process.once('SIGINT',stop);process.once('SIGTERM',stop);
  }
}
