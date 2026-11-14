export class ShareApi {
  constructor({credentials=null,fetchImpl=globalThis.fetch.bind(globalThis),origin=globalThis.location?.origin,timeoutMs=8000}={}) {
    Object.assign(this,{credentials,fetchImpl,origin,timeoutMs});
  }
  async request(path,method='GET',body,{signal,keepalive=false}={}) {
    const controller=new AbortController(),abort=()=>controller.abort();
    const timer=setTimeout(abort,this.timeoutMs);signal?.addEventListener('abort',abort,{once:true});
    if(signal?.aborted)abort();
    try {
      const response=await this.fetchImpl(`${this.origin}${path}`,{method,signal:controller.signal,cache:'no-store',redirect:'error',keepalive,
        headers:{...(body?{'Content-Type':'application/json'}:{}),...(this.credentials?{Authorization:`Bearer ${this.credentials.token}`}:{})},
        ...(body?{body:JSON.stringify(body)}:{})});
      const data=await response.json();
      if(!response.ok)throw Object.assign(new Error('SHARING_REQUEST_FAILED'),{status:response.status,code:typeof data.error==='string'?data.error:'REQUEST_FAILED'});
      return data;
    } finally {clearTimeout(timer);signal?.removeEventListener('abort',abort);}
  }
  path(action=''){if(!this.credentials)throw new Error('SESSION_REQUIRED');return `/v1/sessions/${this.credentials.id}${action}`;}
  read(options){return this.request(this.path(),'GET',undefined,options);}
  routingDisclosure(options){return this.request(this.path('/routing-disclosure'),'GET',undefined,options);}
  grant(body,options){return this.request(this.path('/location-consent'),'POST',body,options);}
  update(body,options){return this.request(this.path('/passenger-location'),'PUT',body,options);}
  withdraw(body,options){return this.request(this.path('/location-consent'),'DELETE',body,options);}
  end(options){return this.request(this.path(),'DELETE',undefined,options);}
}
