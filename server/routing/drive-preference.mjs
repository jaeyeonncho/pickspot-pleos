import {RouteError} from './contract.mjs';

// Calculation preferences, NOT an inferred mapping from Pleos routeOption.
// https://tmap-skopenapi.readme.io/reference/자동차-경로안내 (checked 2026-11-14)
export const TMAP_DRIVE_OPTIONS = Object.freeze({
  recommended:0, 'free-first':1, fastest:2, beginner:3,
  'highway-first':4, shortest:10, 'avoid-school-zones':19
});
export const DRIVE_PREFERENCES = Object.freeze(Object.keys(TMAP_DRIVE_OPTIONS));
export function drivePreference(value, {required=false}={}) {
  if(value===undefined) {
    if(required)throw new RouteError('DRIVE_PREFERENCE_REQUIRED');
    return 'recommended';
  }
  if(typeof value!=='string'||!Object.hasOwn(TMAP_DRIVE_OPTIONS,value))throw new RouteError('INVALID_DRIVE_PREFERENCE');
  return value;
}
export function requireDrivePreference(provider,value) {
  const preference=drivePreference(value);
  // Legacy example providers already use their recommended/default route.
  if(preference!=='recommended' && (!Array.isArray(provider?.drivePreferences)||!provider.drivePreferences.includes(preference)))
    throw new RouteError('DRIVE_PREFERENCE_UNSUPPORTED');
  return preference;
}
