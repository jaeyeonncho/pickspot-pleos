import {TmapRoutes} from './tmap.mjs';
import {FileCallBudget} from './call-budget.mjs';
import {RouteError,MAX_ROUTE_WAYPOINTS,checkAbort} from './contract.mjs';

import {DRIVE_PREFERENCES} from './drive-preference.mjs';

// Each comparison owns a separate reservation. Never reuse a lease across trips.
export function createTmapBatchProvider({appKey,limit=0,budget=new FileCallBudget({limit}),fetchImpl=fetch}={}) {
  new TmapRoutes({appKey,budget,fetchImpl});
  if(typeof budget.reserve!=='function')throw new RouteError('ROUTE_BUDGET_REQUIRED');
  return {
    source:'tmap',synthetic:false,drivePreferences:DRIVE_PREFERENCES,maxWaypoints:MAX_ROUTE_WAYPOINTS,
    route:()=>{throw new RouteError('ROUTE_BATCH_REQUIRED');},
    async prepareBatch(count,{signal}={}) {
      checkAbort(signal);
      if(!Number.isSafeInteger(count)||count<1||count>7)throw new RouteError('INVALID_ROUTE_BATCH');
      await budget.reserve(count,{signal});
      checkAbort(signal);
      let remaining=count;
      return new TmapRoutes({appKey,fetchImpl,budget:{consume:({signal:requestSignal}={})=>{
        checkAbort(signal);checkAbort(requestSignal);
        if(remaining<1)throw new RouteError('ROUTE_BUDGET_EXCEEDED');
        remaining--;
      }}});
    }
  };
}
