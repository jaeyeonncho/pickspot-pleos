// Local instrumentation fixture only. Never imported by an application launcher or hosting bundle.
import {SessionStore} from '../../server/store.mjs';
import {createLiveApp} from '../../server/live-http.mjs';
import {CandidateCatalog} from '../../server/catalog/repository.mjs';
import {exampleTrip} from '../../server/routing/example.mjs';
import {FixtureRoutes} from '../../server/routing/fixture.mjs';

export function vehicleHttpsFixture(tls) {
  const trip=exampleTrip(),fixture=new FixtureRoutes();
  const catalog=new CandidateCatalog({schemaVersion:1,region:'로컬 자동 검사 전용',entries:trip.candidates.map(c=>({
    id:c.id,name:`검사 후보 ${c.id}`,address:'실제 장소 아님',vehiclePoint:c.point,walkingPoint:c.point,
    sources:[{publisher:'검사',url:'https://example.test/catalog',checkedOn:'2026-01-01',asOf:null,fact:'실제 장소가 아닌 검사 자료'}],
    review:{status:'reviewed',generalVehiclePickup:'confirmed',meetingConnection:'connected',dataUse:'permitted',
      checkedOn:'2026-01-01',validUntil:'2030-01-01',conditions:'실제 장소가 아닌 검사 자료'},openQuestions:[]
  }))});
  const store=new SessionStore({locationMode:'live',candidateCatalog:catalog});
  let fixtureCalls=0,batches=0,httpRequests=0;
  // Match the live boundary's provider contract using authored totals, never a TMAP client.
  const provider={source:'tmap',synthetic:false,
    route:input=>{fixtureCalls++;return fixture.route(input);},
    prepareBatch:async count=>{if(count!==7)throw new Error('FIXTURE_BATCH_MISMATCH');batches++;return provider;}};
  const server=createLiveApp({tls,publicOrigin:'https://localhost:18443',driverKey:'p'.repeat(43),store,
    routeProvider:provider,vehiclePairing:{processingRegion:'로컬 자동 검사 전용',candidateIds:['a','b','c']}});
  server.on('request',()=>{httpRequests++;});
  return {server,summary:()=>({httpRequests,fixtureCalls,batches,externalProviderCalls:0,locationReads:0,navigationRequests:0,activeRouteJobs:store.routeJobs.size})};
}
