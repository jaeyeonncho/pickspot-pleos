import {RouteError, routeWaypoints, checkAbort} from './contract.mjs';
import {exampleTrip} from './example.mjs';
import {drivePreference} from './drive-preference.mjs';
// Authored synthetic totals. Not saved TMAP responses, and never an error fallback.
export class FixtureRoutes {
  source = 'synthetic-fixture'; synthetic = true;
  constructor(destinationId='maebong') { this.destinationId=destinationId; }
  async route({mode, origin, destination, via, waypoints, drivePreference: preference, signal}) {
    checkAbort(signal);
    if (routeWaypoints(waypoints).length) throw new RouteError('ROUTE_WAYPOINTS_UNSUPPORTED');
    if (drivePreference(preference)!=='recommended') throw new RouteError('DRIVE_PREFERENCE_UNSUPPORTED');
    const trip = exampleTrip(this.destinationId);
    const equal = (a,b) => a?.latitude === b?.latitude && a?.longitude === b?.longitude;
    if (mode === 'drive' && equal(origin,trip.driver) && equal(destination,trip.destination)) {
      if (via == null) return {distanceMeters:2400,durationSeconds:this.destinationId==='maebong'?600:480};
      const i = trip.candidates.findIndex(c => equal(c.point,via));
      if (i >= 0) return {distanceMeters:[2900,3200,2550][i],durationSeconds:(this.destinationId==='maebong'?[720,900,645]:[750,525,600])[i]};
    }
    if (mode === 'walk' && via == null && equal(origin,trip.passenger)) {
      const i = trip.candidates.findIndex(c => equal(c.point,destination));
      if (i >= 0) return {distanceMeters:[230,90,480][i],durationSeconds:[240,120,420][i]};
    }
    throw new RouteError('FIXTURE_INPUT_MISMATCH');
  }
}
