import {createHash} from 'node:crypto';
import {ApiError} from './api-error.mjs';
import {ROUTING_CONSENT_VERSION} from './shared/routing-consent-policy.mjs';

export function routingDisclosure(origin,configuration) {
  const region=configuration?.processingRegion;
  if(!configuration||typeof configuration!=='object'||Array.isArray(configuration)||
    Object.keys(configuration).some(key=>key!=='processingRegion')||
    typeof region!=='string'||!region.trim()||region.length>100||/[\u0000-\u001f\u007f]/.test(region))throw new ApiError(400,'INVALID_ROUTING_DISCLOSURE');
  const value={version:ROUTING_CONSENT_VERSION,origin,processingRegion:region,routingProvider:'tmap'};
  return Object.freeze({...value,id:createHash('sha256').update(JSON.stringify(value)).digest('hex')});
}
