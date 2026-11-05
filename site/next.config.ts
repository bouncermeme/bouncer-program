import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { NextConfig } from "next";
import { loadTestBuildProblem, publicLists, sessionBuildProblem, turnstileBuildProblem } from "./next.config.helpers";
import { indexingOn } from "./src/lib/indexing";

/*
  The contract pin, read from contract/deployment.json (written beside
  contract/constants.ts's CLUSTER by idl/gen). This file is loaded before the
  app and cannot import its modules, so the one-line mainnet rule of
  src/lib/bouncer/siteCluster.ts is restated here; scripts/check-cluster-switch.ts
  holds the two equal and the two pins agreeing.
*/
/* Since the launch candidate (2026-10-22) the cluster is NEXT_PUBLIC_BOUNCER_CLUSTER's record (contract/active.ts): deployment.json for devnet, the default, deployment.mainnet.json for mainnet. */
const CLUSTER_ENV = (process.env.NEXT_PUBLIC_BOUNCER_CLUSTER ?? "").trim();
const PINNED_CLUSTER: string = JSON.parse(readFileSync(join(process.cwd(), "contract", CLUSTER_ENV === "mainnet" || CLUSTER_ENV === "mainnet-beta" ? "deployment.mainnet.json" : "deployment.json"), "utf8")).cluster;
/* Indexed only with the switch on and the gate off on a mainnet pin (src/lib/indexing.ts, the one decision). */
const INDEXED = indexingOn(PINNED_CLUSTER, process.env);

const nextConfig: NextConfig = {
  /*
    Off on purpose, 2026-09-26. React's strict mode (dev only) mounts twice,
    and @solana/wallet-standard-wallet-adapter-react builds its wallet
    adapters in a state initializer and destroys them in an unmount effect,
    so under the double mount the adapter that stays connected has lost its
    change listener and the orphan keeps it. The wallet's account switch and
    disconnect events then never reach the page in `next dev`, which is
    where the founder walks the flow. Proven with the rehearsal wallet: two
    listeners added, one removed, the connected adapter deaf. Production
    builds never double mount, so this changes nothing there.
  */
  reactStrictMode: false,
  /* Genesis mode and the reserved-name owners as the create form may know them: a flag and wallet hashes, never a wallet (next.config.helpers.ts). */
  env: publicLists(),
  /* The local test board builds beside the dev server's output, never over it (scripts/local-board.sh). */
  distDir: process.env.NEXT_DIST_DIR || ".next",
  /*
    So the founder can open the dev server from his phone, 2026-09-28: `next dev`
    refuses dev assets to any hostname but localhost unless listed. Private
    home-network addresses (the phone on the same Wi-Fi) and Cloudflare
    quick tunnels (an https address, for wallets that insist on one). Dev
    only; a production build ignores this.
  */
  allowedDevOrigins: ["192.168.*.*", "10.*.*.*", "*.trycloudflare.com"],
  /*
    The coming-soon gate (src/proxy.ts) judges the address as asked, 2026-10-31 (tag 31c). Normalised, Next's adapter
    hands the proxy /_next/data/<any build id>/whitepaper.json as /whitepaper, and on Vercel with no x-nextjs-data
    mark, so the open-page rule let Next's not-found page through (review/2026-10-31-whitepaper-public/LIVE.md).
    Every rule there is an exact path or a prefix that a data route never matches, so a data route now gets the gate.
  */
  skipProxyUrlNormalize: true,
  /*
    The 404 for an address no route matches is app/global-not-found.tsx (tag 31d): the site and the public whitepaper
    have a root layout each (app/(site), app/(public)), so there is no single layout to draw it under.
  */
  experimental: { globalNotFound: true },
  /*
    Search engines follow the pin (2026-10-15) and, since the launch candidate
    (2026-10-22), the switch: a build that is not indexed (src/lib/indexing.ts:
    a devnet pin, or a mainnet pin without SITE_INDEXING=on and the gate off)
    sends the header on every response, beside app/robots.ts and the layout's
    metadata. An indexed build sends none, except on the reviewer packet.
  */
  async headers() {
    const noindex = [{ key: "X-Robots-Tag", value: "noindex, nofollow, noarchive" }];
    return INDEXED ? [{ source: "/review/:path*", headers: noindex }, { source: "/review", headers: noindex }] : [{ source: "/:path*", headers: noindex }];
  },
};

/* The bot check's build guards (next.config.helpers.ts turnstileBuildProblem; scripts/check-turnstile-guard.ts), and the load test's (loadTestBuildProblem; scripts/check-load-test-switch.ts). */
export default function config(phase: string): NextConfig {
  const problem = turnstileBuildProblem(phase) ?? sessionBuildProblem(phase) ?? loadTestBuildProblem(phase, process.env, PINNED_CLUSTER);
  if (problem) throw new Error(problem);
  return nextConfig;
}
