/*
  The load test's switch (the founder, 2026-10-25: the funded load test on a test deployment, review/2026-10-25-loadtest).
  One machine stands in for thousands of bidders, so the per-address limits would stop it at 30 permits a minute.
  LOADTEST_LIMIT_MULTIPLIER (a whole number, 2 to 1,000) multiplies every per-address limit: the attestation
  counter's (server/attest.ts door: a minute, an hour, a day) and the proxy's burst windows and RPC totals
  (lib/rateLimit.ts). Nothing else moves: the per-wallet limits, the per-launch minute, the signature budgets and the
  shared cap keep their own numbers.

  It is read only on a Vercel preview of a devnet pin (VERCEL_ENV=preview, the cluster not mainnet). Anywhere else,
  production, a local build, any mainnet pin, the value is ignored and the multiplier is 1; a Vercel production build
  with the variable set at all stops (next.config.helpers.ts loadTestBuildProblem), and scripts/deploy-devnet.sh
  refuses a production deploy while the project's production environment lists it.

  While it is on, the site's own keys on the store move to their own space (storeSpace: "<genesis8>-lt"), so the
  test's limits, budgets and reservations never count against production's on the shared store. The launch registry
  stays shared (attest.ts registryKey): the keeper must see the test launches to close and refund them.
*/
import { isMainnet } from "../siteCluster";

export const LOADTEST_NAME = "LOADTEST_LIMIT_MULTIPLIER";
export const LOADTEST_MAX = 1_000;

export function loadTestMultiplier(env: NodeJS.ProcessEnv, cluster: string): number {
  if (env.VERCEL_ENV !== "preview" || isMainnet(cluster)) return 1;
  const v = (env[LOADTEST_NAME] ?? "").trim();
  if (!/^[0-9]{1,4}$/.test(v)) return 1;
  const n = Number(v);
  return n >= 2 && n <= LOADTEST_MAX ? n : 1;
}

/* A cap times the multiplier (1 leaves it as it is). */
export const scaled = (cap: number, m: number): number => cap * m;
