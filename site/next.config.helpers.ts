import { createHash } from "node:crypto";
import { parseWalletList, WALLET_HASH_TAG } from "./src/lib/bouncer/creationPolicy";

/*
  The creation lists the browser may know (launch candidate, 2026-10-22):
  GENESIS_CREATORS and RESERVED_TICKER_OWNERS are server variables read by the
  attestation service (src/lib/bouncer/server/attest.ts). The create form gets
  only whether genesis mode is on and the wallets' hashes, inlined at build
  time through next.config.ts `env`, so it can say "invite-only" or "reserved"
  before a visitor signs, without the page carrying a wallet list. The hash is
  src/lib/bouncer/creationPolicy.ts walletHash's.

  Review L2 (2026-10-22): the lists are read with creationPolicy.ts
  parseWalletList, the server's own parser, so the two cannot disagree. Every
  entry is checked, then valid duplicates fold into one (W,W publishes W once,
  and the server admits W). A list with any entry that is not a wallet is
  malformed: genesis then publishes "on" with no hashes (the form says
  invite-only to everyone, as the server refuses everyone) and the owner list
  publishes no hashes (nobody owns a reserved name, on both sides). The build
  says which variable is malformed, never its value.
*/
function hashes(name: string, raw: string | undefined): { set: boolean; list: string } {
  const parsed = parseWalletList(raw);
  if (!parsed.set) return { set: false, list: "" };
  if (parsed.malformed) {
    console.warn(`next.config: ${name} has an entry that is not a wallet; the list is unreadable and fails closed (the create form and the attestation service both treat it so)`);
    return { set: true, list: "" };
  }
  return { set: true, list: [...parsed.wallets].map((w) => createHash("sha256").update(WALLET_HASH_TAG + w).digest("hex").slice(0, 32)).join(",") };
}

export function publicLists(env: NodeJS.ProcessEnv = process.env): { NEXT_PUBLIC_GENESIS_MODE: string; NEXT_PUBLIC_GENESIS_CREATOR_HASHES: string; NEXT_PUBLIC_RESERVED_OWNER_HASHES: string } {
  const g = hashes("GENESIS_CREATORS", env.GENESIS_CREATORS);
  const o = hashes("RESERVED_TICKER_OWNERS", env.RESERVED_TICKER_OWNERS);
  return { NEXT_PUBLIC_GENESIS_MODE: g.set ? "1" : "0", NEXT_PUBLIC_GENESIS_CREATOR_HASHES: g.list, NEXT_PUBLIC_RESERVED_OWNER_HASHES: o.list };
}

/*
  The bot check's build guards (the founder, 2026-10-23, rows 37 and the bot check fix).
  - Every Vercel build (VERCEL=1: mainnet or devnet, production or preview) stops without the Turnstile site key, so
    "no bot check is set up" can never reach a user. Local builds and the board have no key and are not stopped.
  - A production build (VERCEL_ENV=production) also stops on any of Cloudflare's published TEST keys, site or secret:
    they render "For testing only. If seen, report to site owner" and pass every visitor. Previews keep the TEST keys
    by design (docs/PREVIEW-ACCESS-2026-10-21.md).
  Cloudflare's test keys are a digit, "x", a run of zeros and two capitals: site keys 1x00000000000000000000AA,
  2x00000000000000000000AB, 1x00000000000000000000BB, 2x00000000000000000000BB, 3x00000000000000000000FF; secret keys
  1x0000000000000000000000000000000AA, 2x0000000000000000000000000000000AA, 3x0000000000000000000000000000000AA.
  - 23c (fresh L8): a production build with a real site key also stops on a blank or missing TURNSTILE_SECRET_KEY:
    the widget would draw and every permit refuse (signer-down), with nothing at build time to say why.
  The guard names the variable, never its value.
*/
export const TURNSTILE_TEST_KEY = /^[0-9]x0{19,}[A-Z]{2}$/;

export function turnstileBuildProblem(phase: string, env: NodeJS.ProcessEnv = process.env): string | null {
  if (phase !== "phase-production-build" /* next/constants PHASE_PRODUCTION_BUILD */ || env.VERCEL !== "1") return null;
  const site = (env.NEXT_PUBLIC_TURNSTILE_SITE_KEY ?? "").trim();
  if (!site) return "NEXT_PUBLIC_TURNSTILE_SITE_KEY is missing: a deployed build without the bot check would show \"no bot check is set up\". Set it on this Vercel project, then build again.";
  if (env.VERCEL_ENV !== "production") return null;
  if (TURNSTILE_TEST_KEY.test(site)) return "NEXT_PUBLIC_TURNSTILE_SITE_KEY is one of Cloudflare's TEST keys on a production build: it shows \"For testing only\" and passes every visitor. Set the real widget's site key, then build again.";
  if (!(env.TURNSTILE_SECRET_KEY ?? "").trim()) return "TURNSTILE_SECRET_KEY is missing on a production build with a real site key: every bot check would fail at the server. Set the widget's secret on this Vercel project, then build again.";
  if (TURNSTILE_TEST_KEY.test((env.TURNSTILE_SECRET_KEY ?? "").trim())) return "TURNSTILE_SECRET_KEY is one of Cloudflare's TEST keys on a production build: every token would verify. Set the real widget's secret, then build again.";
  return null;
}

/*
  23c, the creator sign-in (src/lib/bouncer/server/session.ts, decision D5): a Vercel production build stops without
  SESSION_SECRET (at least 32 characters). Without it no creator can sign in and every creation permit refuses.
  Names the variable, never its value.
*/
export function sessionBuildProblem(phase: string, env: NodeJS.ProcessEnv = process.env): string | null {
  if (phase !== "phase-production-build" || env.VERCEL !== "1" || env.VERCEL_ENV !== "production") return null;
  return (env.SESSION_SECRET ?? "").trim().length >= 32 ? null : "SESSION_SECRET is missing or shorter than 32 characters on a production build: creators could not sign in, so no launch could be created. Set it on this Vercel project (a random 48-character value), then build again.";
}

/*
  The load test's switch (src/lib/bouncer/server/loadTest.ts; the founder, 2026-10-25): LOADTEST_LIMIT_MULTIPLIER is read
  only on a Vercel preview of a devnet pin. A Vercel production build, or any Vercel build of a mainnet pin, stops
  while the variable is set at all, whatever its value, so it can never reach a production deployment by mistake.
  Names the variable, never its value.
*/
export function loadTestBuildProblem(phase: string, env: NodeJS.ProcessEnv = process.env, cluster: string = ""): string | null {
  if (phase !== "phase-production-build" || env.VERCEL !== "1") return null;
  if ((env.LOADTEST_LIMIT_MULTIPLIER ?? "").trim() === "") return null;
  if (env.VERCEL_ENV === "production") return "LOADTEST_LIMIT_MULTIPLIER is set on a production build: it multiplies the per-address limits and is for a devnet preview only. Remove it from this project's production environment, then build again.";
  if (cluster === "mainnet" || cluster === "mainnet-beta") return "LOADTEST_LIMIT_MULTIPLIER is set on a mainnet build: the load test's switch is for a devnet preview only. Remove it, then build again.";
  return null;
}
