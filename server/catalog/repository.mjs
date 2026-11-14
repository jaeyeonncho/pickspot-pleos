import {validateCatalog,selectReviewedCandidates} from './catalog.mjs';
import {RouteError} from '../routing/contract.mjs';
const freeze=value=>{if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}return value;};

// The server owns updates. An invalid replacement revokes old records as well.
// This is explicit reload, not a file watcher or a public administration API.
export class CandidateCatalog {
  #value=null;#revision=0;#listeners=new Set();
  constructor(raw) {if(raw!==undefined)this.replace(raw);}
  replace(raw) {
    this.#value=null;this.#revision++;
    for(const listener of [...this.#listeners])listener();
    this.#value=freeze(validateCatalog(raw));
    return this.#revision;
  }
  select(ids,{now=Date.now()}={}) {
    if(!this.#value)throw new RouteError('CANDIDATE_CATALOG_REQUIRED');
    const selected=selectReviewedCandidates(this.#value,ids,{now});
    return freeze({...selected,revision:this.#revision});
  }
  assertCurrent(selection,{now=Date.now()}={}) {
    if(!this.#value||selection.revision!==this.#revision)throw new RouteError('CANDIDATE_CATALOG_CHANGED');
    if(!Number.isSafeInteger(now)||now<=0)throw new RouteError('INVALID_CLOCK');
    if(now>=selection.validUntil)throw new RouteError('CANDIDATE_REVIEW_EXPIRED');
  }
  onChange(listener) {this.#listeners.add(listener);return ()=>this.#listeners.delete(listener);}
}
