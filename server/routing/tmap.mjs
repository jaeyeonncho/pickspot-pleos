import {RouteError, point, routePoint, routeWaypoints, MAX_ROUTE_WAYPOINTS, summary, checkAbort} from './contract.mjs';

import {drivePreference, DRIVE_PREFERENCES, TMAP_DRIVE_OPTIONS} from './drive-preference.mjs';

const BASE = 'https://apis.openapi.sk.com/tmap/routes';
const MAX_BYTES = 2_000_000;

// Only normalized totals leave this adapter. No response bodies, keys, or coordinates are logged.
export function parseTmapSummary(data) {
  if (data?.error || data?.type !== 'FeatureCollection' || !Array.isArray(data.features)) {
    throw new RouteError('INVALID_ROUTE_RESPONSE');
  }
  const totals = data.features.map(f => f?.properties).filter(p => p && ('totalTime' in p || 'totalDistance' in p));
  if (totals.length !== 1) throw new RouteError('INVALID_ROUTE_RESPONSE');
  return summary({distanceMeters:totals[0].totalDistance, durationSeconds:totals[0].totalTime});
}

export class TmapRoutes {
  constructor({appKey, budget, fetchImpl = fetch, timeoutMs = 8000} = {}) {
    if (typeof appKey !== 'string' || !appKey.trim() || /[\r\n]/.test(appKey)) throw new RouteError('TMAP_KEY_REQUIRED');
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) throw new RouteError('INVALID_TIMEOUT');
    if (!budget || typeof budget.consume !== 'function') throw new RouteError('ROUTE_BUDGET_REQUIRED');
    this.appKey = appKey.trim(); this.fetch = fetchImpl; this.timeoutMs = timeoutMs;
    this.budget = budget;
    this.source = 'tmap'; this.synthetic = false;
    this.drivePreferences = DRIVE_PREFERENCES;
    this.maxWaypoints = MAX_ROUTE_WAYPOINTS;
  }
  async route({mode, origin, destination, via, waypoints, drivePreference: preference, signal}) {
    checkAbort(signal);
    if (!['walk','drive'].includes(mode) || (mode === 'walk' && via != null)) throw new RouteError('INVALID_ROUTE_REQUEST');
    if (mode === 'walk' && preference !== undefined) throw new RouteError('INVALID_ROUTE_REQUEST');
    const selectedPreference = drivePreference(preference);
    const originalStops = routeWaypoints(waypoints);
    if (mode === 'walk' && originalStops.length) throw new RouteError('INVALID_ROUTE_REQUEST');
    const start = point(origin), end = routePoint(destination);
    const stops = routeWaypoints([...(via == null ? [] : [via]), ...originalStops]);
    const body = {startX:start.longitude,startY:start.latitude,endX:end.longitude,endY:end.latitude,
      reqCoordType:'WGS84GEO',resCoordType:'WGS84GEO',
      startName:encodeURIComponent('출발'),endName:encodeURIComponent('도착'),
      searchOption:mode === 'walk' ? '0' : TMAP_DRIVE_OPTIONS[selectedPreference]};
    if (mode === 'drive') {
      body.totalValue = 2;
      if (stops.length) body.passList = stops.map(stop => `${stop.longitude},${stop.latitude}`).join('_');
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    const onAbort = () => controller.abort();
    signal?.addEventListener('abort', onAbort, {once:true});
    let response;
    try {
      await this.budget.consume({signal:controller.signal});
      checkAbort(signal);
      if (controller.signal.aborted) throw new RouteError('ROUTE_TIMEOUT');
      response = await this.fetch(`${BASE}${mode === 'walk' ? '/pedestrian' : ''}?version=1`, {
        method:'POST', redirect:'error', signal:controller.signal,
        headers:{'Content-Type':'application/json',Accept:'application/json',appKey:this.appKey},
        body:JSON.stringify(body)
      });
      if (!response.ok) {
        const code = [401,403].includes(response.status) ? 'ROUTE_AUTH_FAILED' :
          response.status === 429 ? 'ROUTE_QUOTA_EXCEEDED' : 'ROUTE_PROVIDER_ERROR';
        throw new RouteError(code);
      }
      const length = Number(response.headers.get('content-length'));
      if (length > MAX_BYTES) throw new RouteError('ROUTE_RESPONSE_TOO_LARGE');
      if (!response.body) throw new RouteError('INVALID_ROUTE_RESPONSE');
      const chunks = []; let bytes = 0;
      for await (const chunk of response.body) {
        bytes += chunk.byteLength;
        if (bytes > MAX_BYTES) throw new RouteError('ROUTE_RESPONSE_TOO_LARGE');
        chunks.push(chunk);
      }
      checkAbort(signal);
      if (controller.signal.aborted) throw new RouteError('ROUTE_TIMEOUT');
      let data;
      try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { throw new RouteError('INVALID_ROUTE_RESPONSE'); }
      return parseTmapSummary(data);
    } catch (error) {
      if (signal?.aborted) throw new RouteError('ROUTE_CANCELLED');
      if (controller.signal.aborted) throw new RouteError('ROUTE_TIMEOUT');
      if (error instanceof RouteError) throw error;
      throw new RouteError('ROUTE_NETWORK_ERROR');
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', onAbort);
      if (response?.body && !response.body.locked) await response.body.cancel().catch(() => {});
    }
  }
}
