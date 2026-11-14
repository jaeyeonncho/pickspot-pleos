import {fileURLToPath} from 'node:url';
import {TmapRoutes} from './routing/tmap.mjs';
import {FixtureRoutes} from './routing/fixture.mjs';
import {exampleTripInput} from './routing/example.mjs';
import {TripInput} from './routing/trip-input.mjs';
import {RouteError} from './routing/contract.mjs';
import {FileCallBudget, dailyCallLimit} from './routing/call-budget.mjs';

export async function preview({args = [], env = process.env, fetchImpl = fetch, budget} = {}) {
  const live = args.length === 2 && args.includes('--live') && args.includes('--example-only');
  if (args.length && !live) throw new RouteError('USE_NO_FLAGS_OR_LIVE_EXAMPLE_ONLY');
  const provider = live ? new TmapRoutes({appKey:env.TMAP_APP_KEY,fetchImpl,
    budget:budget ?? new FileCallBudget({limit:dailyCallLimit(env.TMAP_DAILY_CALL_LIMIT)})}) : new FixtureRoutes();
  const input=new TripInput();
  input.replace(exampleTripInput());
  try { return await input.calculate({provider}); }
  finally { input.clear(); }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const report = await preview({args:process.argv.slice(2)});
    console.log(JSON.stringify(report,null,2));
    if (!report.candidates.length) process.exitCode = 1;
  } catch (error) {
    console.error(JSON.stringify({error:error instanceof RouteError ? error.code : 'ROUTE_PREVIEW_FAILED'}));
    process.exitCode = 1;
  }
}
