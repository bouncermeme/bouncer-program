/*
  Search indexing, one decision (launch candidate, 2026-10-22; the founder: built now,
  off while the site is hidden, ONE switch at launch). A build or a request is
  indexed only when all of these hold:
  - SITE_INDEXING is exactly "on" (the switch; nothing else, not "ON", not "1");
  - the coming-soon gate is off (COMING_SOON_KEY unset or blank);
  - the deployment is not a Vercel preview, and not the local test board;
  - the pin is mainnet (NEXT_PUBLIC_BOUNCER_CLUSTER, contract/active.ts's reading:
    devnet unless it says mainnet), so the devnet site is never indexed.
  Off, every page's robots metadata says noindex, robots.txt disallows everything
  and every response the proxy passes carries the X-Robots-Tag header
  (lib/bouncer/siteCluster.ts holds the words; src/proxy.ts, next.config.ts and
  app/robots.ts call this). The pages are rendered at build, so flipping the
  switch takes a redeploy (docs/MAINNET-LAUNCH-PLAN.md, launch day).
  No imports: next.config.ts and the proxy load this file as it is.
*/
export type IndexingEnv = {
  SITE_INDEXING?: string;
  COMING_SOON_KEY?: string;
  VERCEL_ENV?: string;
  BOARD_PASSWORD?: string;
  NEXT_PUBLIC_BOUNCER_CLUSTER?: string;
  [name: string]: string | undefined;
};

/* The pin's cluster as the environment states it (contract/active.ts: devnet unless "mainnet" or "mainnet-beta"). */
export function clusterFromEnv(env: IndexingEnv): string {
  const v = (env.NEXT_PUBLIC_BOUNCER_CLUSTER ?? "").trim();
  return v === "mainnet" || v === "mainnet-beta" ? "mainnet-beta" : "devnet";
}

export function indexingOn(cluster: string, env: IndexingEnv): boolean {
  return (
    env.SITE_INDEXING === "on" &&
    !(env.COMING_SOON_KEY ?? "").trim() &&
    env.VERCEL_ENV !== "preview" &&
    !env.BOARD_PASSWORD &&
    (cluster === "mainnet" || cluster === "mainnet-beta")
  );
}
