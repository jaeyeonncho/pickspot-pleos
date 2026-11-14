// UI-neutral retry policy; successful reads reset the delay. No repeated mutations except an explicit end intent.
export class ConnectionRecovery {
  failures=0;
  connected=false;
  success() { this.failures=0;this.connected=true; }
  failure() { this.failures=Math.min(this.failures+1,5);this.connected=false; }
  get delay() { return this.failures ? Math.min(1000*2**(this.failures-1),15000) : 3000; }
}
export function restoreCredentials(raw,now=Date.now()) {
  try {
    const value=JSON.parse(raw);
    if (!value || !/^[a-f0-9-]{36}$/i.test(value.id) || !/^[A-Za-z0-9_-]{43}$/.test(value.token))return null;
    if (value.expiresAt!=null && (!Number.isSafeInteger(value.expiresAt) || value.expiresAt<=now))return null;
    return {id:value.id,token:value.token,...(value.expiresAt!=null?{expiresAt:value.expiresAt}:{}),ending:value.ending===true};
  } catch { return null; }
}
