import {RouteError} from './contract.mjs';

// Application policy aligned with the vehicle's local route snapshot lifetime.
// A client timestamp bounds validity; it does not authenticate a navigation route.
export const ROUTE_CONTEXT_POLICY = Object.freeze({maxAgeMs:30_000,futureToleranceMs:5_000});

export function routeContextExpiry(observedAt, at, {required=false}={}) {
  if(observedAt===undefined) {
    if(required)throw new RouteError('ROUTE_CONTEXT_REQUIRED');
    return null;
  }
  if(!Number.isSafeInteger(observedAt)||observedAt<=0||observedAt-at>ROUTE_CONTEXT_POLICY.futureToleranceMs) {
    throw new RouteError('INVALID_ROUTE_TIME');
  }
  const age=Math.max(0,at-observedAt);
  if(age>=ROUTE_CONTEXT_POLICY.maxAgeMs)throw new RouteError('ROUTE_CONTEXT_STALE');
  return at+ROUTE_CONTEXT_POLICY.maxAgeMs-age;
}
