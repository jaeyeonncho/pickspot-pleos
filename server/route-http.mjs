import {ApiError} from './api-error.mjs';
import {RouteError} from './routing/contract.mjs';

const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const only=(value,keys)=>object(value)&&Object.keys(value).every(key=>keys.includes(key));
const point=value=>only(value,['latitude','longitude']);

// Accept vehicle inputs only. Passenger fixes and candidate coordinates belong to
// the authenticated store/catalog, never to this request's payload.
export function vehicleRouteRequest(body) {
  if(!only(body,['expectedVersion','driver','destination','waypoints','routeObservedAt','drivePreference','candidateIds'])||
    (body.driver!==undefined&&(!only(body.driver,['point','observedAt','accuracyMeters','source','consent','routingProvider'])||!point(body.driver.point)))||
    (body.destination!==undefined&&(!only(body.destination,['point','name'])||!point(body.destination.point)))||
    (body.waypoints!==undefined&&(!Array.isArray(body.waypoints)||!body.waypoints.every(point)))) {
    throw new ApiError(400,'INVALID_ROUTE_INPUT');
  }
  if(!Number.isSafeInteger(body.expectedVersion)||body.expectedVersion<1)throw new ApiError(409,'VERSION_CONFLICT');
  const {expectedVersion,...trip}=body;
  return {expectedVersion,trip};
}

// Do not reflect provider messages, URLs, credentials or unknown error codes.
const statuses=new Map();
for(const [status,codes] of [
  [400,['INVALID_POINT','INVALID_DESTINATION','DESTINATION_REQUIRED','INVALID_LOCATION_TIME',
    'LOCATION_ACCURACY_REQUIRED','LOCATION_CONSENT_REQUIRED','LOCATION_SOURCE_MISMATCH',
    'ORIGINAL_WAYPOINTS_REQUIRED','INVALID_ROUTE_WAYPOINTS','ROUTE_WAYPOINT_LIMIT',
    'ROUTE_COORDINATE_UNAVAILABLE','ROUTE_CONTEXT_REQUIRED','INVALID_ROUTE_TIME',
    'DRIVE_PREFERENCE_REQUIRED','INVALID_DRIVE_PREFERENCE','INVALID_CANDIDATES','CATALOG_CANDIDATE_IDS_REQUIRED']],
  [403,['ROUTING_CONSENT_REQUIRED']],
  [409,['PASSENGER_LOCATION_REQUIRED','LOCATION_STALE','ROUTE_CONTEXT_STALE','TRIP_EXPIRED',
    'TRIP_INPUT_CHANGED','ROUTE_CANCELLED','CANDIDATE_NOT_REVIEWED','CANDIDATE_CATALOG_CHANGED','CANDIDATE_REVIEW_EXPIRED']],
  [429,['ROUTE_BUDGET_EXCEEDED','ROUTE_QUOTA_EXCEEDED']],
  [503,['CANDIDATE_CATALOG_REQUIRED','DRIVE_PREFERENCE_UNSUPPORTED','ROUTE_WAYPOINTS_UNSUPPORTED',
    'ROUTE_BUDGET_DISABLED','ROUTE_BUDGET_UNAVAILABLE','ROUTE_BUDGET_BUSY','ROUTE_AUTH_FAILED']],
  [504,['ROUTE_TIMEOUT','ROUTE_BATCH_TIMEOUT']],
  [502,['INVALID_ROUTE_RESPONSE','ROUTE_NETWORK_ERROR','ROUTE_PROVIDER_ERROR','ROUTE_RESPONSE_TOO_LARGE']]
])for(const code of codes)statuses.set(code,status);

export function routeHttpError(error) {
  if(error instanceof RouteError)return new ApiError(statuses.get(error.code)??502,
    statuses.has(error.code)?error.code:'ROUTE_SERVICE_ERROR');
  return error;
}

export function routeHttpReport(report) {
  return {...report,excluded:report.excluded.map(({id,reason})=>({id,
    reason:reason==='CURB_RESTRICTED'||statuses.has(reason)?reason:'ROUTE_SERVICE_ERROR'}))};
}
