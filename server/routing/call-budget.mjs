import {mkdir, lstat, open, rename, unlink, rmdir} from 'node:fs/promises';
import {constants} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {fileURLToPath} from 'node:url';
import {RouteError, checkAbort} from './contract.mjs';

const DEFAULT_PATH = fileURLToPath(new URL('../.state/tmap-calls.json', import.meta.url));
const fail = code => { throw new RouteError(code); };

export function dailyCallLimit(value = '0') {
  if (typeof value !== 'string' || !/^(0|[1-9]\d{0,6})$/.test(value)) fail('ROUTE_BUDGET_CONFIG_INVALID');
  return Number(value);
}

function dayAt(time) {
  // A local policy, not the provider's billing reset time. Korea has UTC+09:00.
  if (!Number.isSafeInteger(time) || time < 0 || time > 253402268399999) fail('ROUTE_BUDGET_CLOCK_INVALID');
  return new Date(time + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function validate(record) {
  if (!record || Object.keys(record).sort().join() !== 'day,limit,used,version' || record.version !== 1 ||
      typeof record.day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(record.day) ||
      !Number.isFinite(Date.parse(record.day)) || new Date(record.day).toISOString().slice(0,10) !== record.day ||
      !Number.isSafeInteger(record.limit) || record.limit < 1 || record.limit > 9_999_999 ||
      !Number.isSafeInteger(record.used) || record.used < 1 || record.used > record.limit) fail('ROUTE_BUDGET_UNAVAILABLE');
  return record;
}

// One ledger shared by all processes using this project. Persist BEFORE dispatch;
// failed/cancelled requests are never refunded. A crashed lock is not auto-stolen.
export class FileCallBudget {
  constructor({filePath = DEFAULT_PATH, limit = 0, now = Date.now, lockTimeoutMs = 1000} = {}) {
    if (!Number.isSafeInteger(limit) || limit < 0 || limit > 9_999_999 ||
        !Number.isSafeInteger(lockTimeoutMs) || lockTimeoutMs < 1 || lockTimeoutMs > 5000 ||
        typeof now !== 'function') fail('ROUTE_BUDGET_CONFIG_INVALID');
    this.filePath = resolve(filePath); this.limit = limit; this.now = now; this.lockTimeoutMs = lockTimeoutMs;
  }

  async #record() {
    try {
      const directory=await lstat(dirname(this.filePath));
      if(!directory.isDirectory()||directory.isSymbolicLink())fail('ROUTE_BUDGET_UNAVAILABLE');
      const file=await open(this.filePath,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
      try {
        const info=await file.stat();
        if(!info.isFile()||info.size>1024)fail('ROUTE_BUDGET_UNAVAILABLE');
        return validate(JSON.parse(await file.readFile('utf8')));
      }finally{await file.close();}
    }catch(error){
      if(error?.code==='ENOENT')return null;
      fail('ROUTE_BUDGET_UNAVAILABLE');
    }
  }

  // A read-only snapshot, not a reservation and not the provider account's usage.
  async status() {
    const record=await this.#record(),day=dayAt(this.now());
    if(record&&day<record.day)fail('ROUTE_BUDGET_CLOCK_INVALID');
    const current=record?.day===day;
    const used=current?record.used:0,limit=current?Math.min(this.limit,record.limit):this.limit;
    return {day,used,limit,remaining:Math.max(0,limit-used),advisory:true};
  }

  async consume({signal} = {}) {
    return this.reserve(1, {signal});
  }

  // Admit an entire calculation atomically; never spend the final few calls on
  // a batch that cannot finish. Reservations, including cancelled work, are not refunded.
  async reserve(count, {signal} = {}) {
    checkAbort(signal);
    if (!Number.isSafeInteger(count) || count < 1 || count > 7) fail('ROUTE_BUDGET_CONFIG_INVALID');
    if (this.limit === 0) fail('ROUTE_BUDGET_DISABLED');
    const directory = dirname(this.filePath), lock = `${this.filePath}.lock`;
    let acquired = false, temporary;
    try {
      await mkdir(directory, {recursive:true, mode:0o700});
      const info = await lstat(directory);
      if (!info.isDirectory() || info.isSymbolicLink()) fail('ROUTE_BUDGET_UNAVAILABLE');
      const started = performance.now();
      while (!acquired) {
        checkAbort(signal);
        try { await mkdir(lock, {mode:0o700}); acquired = true; }
        catch (error) {
          if (error?.code !== 'EEXIST') throw error;
          if (performance.now() - started >= this.lockTimeoutMs) fail('ROUTE_BUDGET_BUSY');
          await delay(10, undefined, {signal});
        }
      }
      checkAbort(signal);
      let record=await this.#record();

      const day = dayAt(this.now());
      if (record && day < record.day) fail('ROUTE_BUDGET_CLOCK_INVALID');
      if (!record || day > record.day) record = {version:1, day, used:0, limit:this.limit};
      const limit = Math.min(this.limit, record.limit);
      if (record.used + count > limit) fail('ROUTE_BUDGET_EXCEEDED');
      checkAbort(signal);
      record = {...record, used:record.used + count, limit};
      temporary = `${this.filePath}.${randomUUID()}.tmp`;
      const file = await open(temporary, 'wx', 0o600);
      try { await file.writeFile(`${JSON.stringify(record)}\n`); await file.sync(); }
      finally { await file.close(); }
      // Cancellation after committing can consume a slot without sending a request.
      await rename(temporary, this.filePath); temporary = undefined;
      const parent = await open(directory, constants.O_RDONLY);
      try { await parent.sync(); } finally { await parent.close(); }
      return {day, used:record.used, limit, remaining:limit - record.used};
    } catch (error) {
      checkAbort(signal);
      if (error instanceof RouteError) throw error;
      fail('ROUTE_BUDGET_UNAVAILABLE');
    } finally {
      if (temporary) await unlink(temporary).catch(() => {});
      if (acquired) {
        try { await rmdir(lock); }
        catch { fail('ROUTE_BUDGET_UNAVAILABLE'); }
      }
    }
  }
}
