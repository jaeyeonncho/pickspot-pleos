import {TripInput} from './routing/trip-input.mjs';
import {FixtureRoutes} from './routing/fixture.mjs';
import {exampleTrip,exampleTripInput} from './routing/example.mjs';
import {createTmapBatchProvider} from './routing/batch-provider.mjs';
import {FileCallBudget} from './routing/call-budget.mjs';

// Fixed example inputs only. The default calculator never accesses the network.
export function createExampleRouteCalculator() {
  return async ({signal,destinationId='maebong',now=Date.now}) => {
    const input=new TripInput({now});
    input.replace(exampleTripInput(now(),destinationId));
    try { return await input.calculate({provider:new FixtureRoutes(destinationId),signal}); }
    finally { input.clear(); }
  };
}
export function createTmapExampleRouteCalculator({appKey,limit=0,budget=new FileCallBudget({limit}),fetchImpl=fetch}={}) {
  const provider=createTmapBatchProvider({appKey,budget,fetchImpl});
  return async ({signal,destinationId='maebong',now=Date.now}={})=>{
    const input=new TripInput({now});
    input.replace(exampleTripInput(now(),destinationId));
    try {return await input.calculate({provider,signal});}
    finally {input.clear();}
  };
}

export function routeFailure(code) {
  if(['ROUTE_BUDGET_EXCEEDED','ROUTE_QUOTA_EXCEEDED'].includes(code))return 'limit';
  if(code==='ROUTE_AUTH_FAILED'||code?.startsWith('ROUTE_BUDGET_'))return 'configuration';
  if(['ROUTE_NETWORK_ERROR','ROUTE_TIMEOUT','ROUTE_BATCH_TIMEOUT'].includes(code))return 'connection';
  return 'unavailable';
}
export function routeCandidates(report) {
  const trip = exampleTrip();
  const ids=new Set();
  if(!Array.isArray(report.candidates)||report.candidates.length>3)throw new Error('Invalid candidates');
  return report.candidates.map(metric => {
    const candidate = trip.candidates.find(c=>c.id === metric.id);
    if (!candidate||ids.has(metric.id)||metric.curbStatus!=='unknown'||
      ![metric.walkMeters,metric.walkSeconds,metric.detourSeconds].every(n=>Number.isSafeInteger(n)&&n>=0&&n<=2147483647))throw new Error('Invalid candidate');
    ids.add(metric.id);
    return {id:metric.id,name:`만남 지점 ${metric.id.toUpperCase()}`,point:candidate.point,
      walkMeters:metric.walkMeters,walkSeconds:metric.walkSeconds,detourSeconds:metric.detourSeconds,
      curbStatus:'unknown',note:report.source==='tmap'?'TMAP 경로 비교 · 예제 위치 · 정차 조건 미확인':'예제 경로 비교 · 실제 정차 조건은 확인되지 않았어요'};
  });
}
