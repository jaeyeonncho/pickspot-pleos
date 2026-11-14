// Provider-independent route contract. Never derive walking time from straight-line distance.
export class RouteError extends Error {
  constructor(code) { super(code); this.name = 'RouteError'; this.code = code; }
}
export function point(value) {
  if (!value || !Number.isFinite(value.latitude) || !Number.isFinite(value.longitude) ||
      Math.abs(value.latitude) > 90 || Math.abs(value.longitude) > 180) throw new RouteError('INVALID_POINT');
  return {latitude:value.latitude, longitude:value.longitude};
}
// Match the current Pleos pickup planner: two stops total, including the pickup.
// This is a product limit, not the upstream API's maximum.
export const MAX_ROUTE_WAYPOINTS = 2;
export function routePoint(value) {
  const result = point(value);
  if (result.latitude === 0 && result.longitude === 0) throw new RouteError('ROUTE_COORDINATE_UNAVAILABLE');
  return result;
}
export function routeWaypoints(values = [], maximum = MAX_ROUTE_WAYPOINTS) {
  if (!Array.isArray(values)) throw new RouteError('INVALID_ROUTE_WAYPOINTS');
  if (values.length > maximum) throw new RouteError('ROUTE_WAYPOINT_LIMIT');
  return Array.from(values, routePoint);
}
// `point` is the vehicle pickup approach. A separately reviewed pedestrian
// entrance can be supplied as walkingPoint; older example inputs share one point.
// Copy and validate the whole batch before any provider request.
export function pickupCandidates(values) {
  if (!Array.isArray(values) || values.length < 1 || values.length > 3) throw new RouteError('INVALID_CANDIDATES');
  const ids = new Set();
  return values.map(candidate => {
    if (!candidate || typeof candidate.id !== 'string' || !/^[a-zA-Z0-9_-]{1,40}$/.test(candidate.id) ||
        ids.has(candidate.id) || !['unknown','restricted','designated'].includes(candidate.curbStatus)) {
      throw new RouteError('INVALID_CANDIDATES');
    }
    ids.add(candidate.id);
    const vehiclePoint = routePoint(candidate.point);
    return {id:candidate.id,curbStatus:candidate.curbStatus,point:vehiclePoint,
      walkingPoint:routePoint(candidate.walkingPoint === undefined ? vehiclePoint : candidate.walkingPoint)};
  });
}
export function summary(value) {
  if (!value || !Number.isSafeInteger(value.distanceMeters) || value.distanceMeters < 0 ||
      !Number.isSafeInteger(value.durationSeconds) || value.durationSeconds < 0) throw new RouteError('INVALID_ROUTE_RESPONSE');
  return {distanceMeters:value.distanceMeters, durationSeconds:value.durationSeconds};
}
export function checkAbort(signal) {
  if (signal?.aborted) throw new RouteError('ROUTE_CANCELLED');
}

// Settle promptly even if an adapter ignores cancellation; late rejection is still handled.
export function abortable(task, signal) {
  return new Promise((resolve,reject)=>{
    const abort=()=>finish(reject,new RouteError('ROUTE_CANCELLED'));
    const finish=(settle,value)=>{signal?.removeEventListener('abort',abort);settle(value);};
    if(signal?.aborted){abort();return;}
    signal?.addEventListener('abort',abort,{once:true});
    Promise.resolve().then(()=>{checkAbort(signal);return task();})
      .then(value=>finish(resolve,value),error=>finish(reject,error));
  });
}
