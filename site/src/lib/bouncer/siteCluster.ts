/*
  What follows the pin without a hand on it (2026-10-15, the switch list's quiet
  site items): the contract pin says which cluster this build is for
  (contract/constants.ts CLUSTER, written by idl/gen), and these functions turn
  that one fact into the search-engine signals and the custody sentence. Every
  function takes the cluster so a check can ask about mainnet from a devnet
  checkout; the constants below are the pinned answers the pages use. The
  X-Robots-Tag header is the fourth signal: next.config.ts cannot import this
  module, so it reads the same pin from contract/deployment.json and restates
  the one-line mainnet rule (scripts/check-cluster-switch.ts holds them equal).
*/
import type { Metadata, MetadataRoute } from "next";
import { CLUSTER } from "@contract/active";
import { indexingOn, type IndexingEnv } from "@/lib/indexing";

/* Solana's own name is mainnet-beta; the contract pin may say either. */
export function isMainnet(cluster: string): boolean {
  return cluster === "mainnet" || cluster === "mainnet-beta";
}
export const ON_MAINNET = isMainnet(CLUSTER);

/*
  Search engines. Not for them while the deploy is a devnet test (the founder, 2026-09-28). Since the launch candidate
  (2026-10-22) a mainnet pin is indexed only when the switch is on and the gate is off (lib/indexing.ts indexingOn:
  SITE_INDEXING=on, no COMING_SOON_KEY, not a preview); until then every signal says noindex. The reviewer packet is
  never indexed.
*/
export const X_ROBOTS_TAG_NOINDEX = "noindex, nofollow, noarchive";
export const ROBOTS_NOINDEX: NonNullable<Metadata["robots"]> = { index: false, follow: false, nocache: true, googleBot: { index: false, follow: false } };
export function xRobotsTag(cluster: string, env: IndexingEnv = process.env): string | null {
  return indexingOn(cluster, env) ? null : X_ROBOTS_TAG_NOINDEX;
}
export function robotsMetadata(cluster: string, env: IndexingEnv = process.env): NonNullable<Metadata["robots"]> {
  return indexingOn(cluster, env) ? { index: true, follow: true } : ROBOTS_NOINDEX;
}
/* robots.txt when the app answers it (the gate is off; while it is on, the proxy answers lib/comingSoon.ts ROBOTS_WHILE_GATED). Indexed: everything but the API, and the sitemap. The reviewer packet is not named: indexing needs a mainnet pin, where /review is a 404 always (lib/reviewLock.ts, B20), and naming it would only advertise it. */
export function robotsRules(cluster: string, env: IndexingEnv = process.env, origin = "https://bouncer.meme"): MetadataRoute.Robots {
  return indexingOn(cluster, env)
    ? { rules: { userAgent: "*", allow: "/", disallow: ["/api/"] }, sitemap: `${origin}/sitemap.xml` }
    : { rules: { userAgent: "*", disallow: "/" } };
}

/*
  The custody wording (S6). Devnet: the upgrade authority is the deploy key, one key.
  Mainnet: Squad A holds it after runbook step 8, 3 of 3 with a one-day lock
  (docs/BOUNCER-PRE-MAINNET-GATES.md D2); the page beside it shows the pin's
  upgrade_authority, which is Squad A's vault on the mainnet pin. The mainnet
  words are a PLACEHOLDER until the founder approves them (S6): change them here only.
*/
export function upgradeAuthorityPhrase(cluster: string): string {
  return isMainnet(cluster) ? "a Squads multisig (3 of 3) with a 24 h time lock" : "one key today";
}
export function upgradeAuthoritySentence(cluster: string): string {
  return `The program's upgrade authority is ${upgradeAuthorityPhrase(cluster)}.`;
}
export const UPGRADE_AUTHORITY_PHRASE = upgradeAuthorityPhrase(CLUSTER);
export const UPGRADE_AUTHORITY_SENTENCE = upgradeAuthoritySentence(CLUSTER);

/*
  The site's own origin (2026-10-16, the founder's item 7 / S8): the token metadata
  URI written on chain points here (/api/token/<hash>.json), so the picture's
  store can move without touching any token. SITE_ORIGIN overrides it (the
  local board sets http://localhost:3000); otherwise the cluster's own site.
*/
export function siteOrigin(cluster: string = CLUSTER, env: NodeJS.ProcessEnv = process.env): string {
  const set = env.SITE_ORIGIN?.trim();
  if (set && /^https?:\/\/[A-Za-z0-9.-]+(:\d+)?$/.test(set)) return set;
  return isMainnet(cluster) ? "https://bouncer.meme" : "https://bouncer-devnet.vercel.app";
}
