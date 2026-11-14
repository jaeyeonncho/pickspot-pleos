import {RouteError, point, routePoint, routeWaypoints, MAX_ROUTE_WAYPOINTS, pickupCandidates, summary, checkAbort, abortable} from './contract.mjs';

import {requireDrivePreference} from './drive-preference.mjs';

const FATAL = new Set(['ROUTE_AUTH_FAILED','ROUTE_QUOTA_EXCEEDED','ROUTE_CANCELLED']);
// Reference calculation only: this is NOT the current Pleos route, nor approval to stop at a curb.
// At most 3 candidates / 7 calls. Sequential scheduling avoids a burst and stops promptly on quota errors.
export async function estimatePickupRoutes(input, {provider, signal, now = Date.now, timeoutMs = 15_000} = {}) {
  checkAbort(signal);
  if (!provider || typeof provider.route !== 'function' || typeof provider.source !== 'string' || typeof provider.synthetic !== 'boolean') {
    throw new RouteError('INVALID_ROUTE_PROVIDER');
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) throw new RouteError('INVALID_TIMEOUT');
  if (!input?.destination) throw new RouteError('DESTINATION_REQUIRED');
  const driver = point(input.driver), passenger = point(input.passenger), destination = routePoint(input.destination);
  const waypoints = routeWaypoints(input.waypoints, MAX_ROUTE_WAYPOINTS - 1);
  if (waypoints.length && !(Number.isSafeInteger(provider.maxWaypoints) && provider.maxWaypoints >= waypoints.length + 1)) {
    throw new RouteError('ROUTE_WAYPOINTS_UNSUPPORTED');
  }
  const preference = requireDrivePreference(provider,input.drivePreference);
  // Copy all inputs before the first await so an in-flight UI edit cannot mix two trips.
  const candidates = pickupCandidates(input.candidates);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort, {once:true});
  let calls = 0;
  const ask = async request => {
    checkAbort(controller.signal);
    calls++;
    const result = summary(await abortable(()=>provider.route({...request,signal:controller.signal}),controller.signal));
    checkAbort(controller.signal);
    return result;
  };
  const requestedAt = now();
  try {
    const eligible = candidates.filter(c => c.curbStatus !== 'restricted');
    const excluded = candidates.filter(c => c.curbStatus === 'restricted').map(c => ({id:c.id,reason:'CURB_RESTRICTED'}));
    const results = [];
    const stops = waypoints.length ? {waypoints} : {};
    const baseline = eligible.length ? await ask({mode:'drive',origin:driver,destination,drivePreference:preference,...stops}) : null;
    for (const candidate of eligible) {
      try {
        const walk = await ask({mode:'walk',origin:passenger,destination:candidate.walkingPoint});
        const drive = await ask({mode:'drive',origin:driver,destination,via:candidate.point,drivePreference:preference,...stops});
        const delta = drive.durationSeconds - baseline.durationSeconds;
        results.push({id:candidate.id,curbStatus:candidate.curbStatus,walkMeters:walk.distanceMeters,
          walkSeconds:walk.durationSeconds,viaDriveSeconds:drive.durationSeconds,
          detourSeconds:Math.max(0,delta),rawDeltaSeconds:delta,
          warnings:[...(candidate.curbStatus === 'unknown' ? ['CURB_UNVERIFIED'] : []),
            ...(delta < 0 ? ['ROUTE_COMPARISON_VARIATION'] : [])]});
      } catch (error) {
        if (!(error instanceof RouteError) || FATAL.has(error.code) || error.code.startsWith('ROUTE_BUDGET_')) throw error;
        excluded.push({id:candidate.id,reason:error.code});
      }
    }
    checkAbort(controller.signal);
    return {source:provider.source,synthetic:provider.synthetic,referenceOnly:true,
      method:'provider_route_via_pickup_minus_provider_baseline',drivePreference:preference,vehicleRouteOptionMatched:false,originalWaypointCount:waypoints.length,
      pickupOrder:'before_original_waypoints',requestedAt,completedAt:now(),
      providerCalls:calls,baselineDriveSeconds:baseline?.durationSeconds ?? null,candidates:results,excluded};
  } catch (error) {
    if (signal?.aborted) throw new RouteError('ROUTE_CANCELLED');
    if (controller.signal.aborted) throw new RouteError('ROUTE_BATCH_TIMEOUT');
    if (error instanceof RouteError) throw error;
    throw new RouteError('ROUTE_PROVIDER_ERROR');
  } finally {
    clearTimeout(timer); signal?.removeEventListener('abort', onAbort);
  }
}
