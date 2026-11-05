/*
  The attestation service's server side (0.29; docs/V029-DESIGN-2026-10-20.md
  section 6, docs/ADVERSARIAL-GRIEFING-2026-10-20.md section 14.3). The route
  (app/api/attest/route.ts) does, in order:

  1. The per-address limits, before anything is verified, so a flood of
     tokens never reaches Cloudflare: 5 a minute and 30 an hour per launch,
     100 a day across launches ("limit-ip").
  2. Turnstile: the token at siteverify with the visitor's address and an
     idempotency key. A token is valid 300 s and once ("turnstile").
  3. The launch, read through the server's snapshot: open by the clock, its
     histogram grown (commit refuses 6071 before), and the attestor key this
     service holds listed in the config; otherwise "launch-closed", or
     "signer-down" for a key the program would refuse.
  4. An attestation already issued to this wallet for this launch and not
     expired is handed back as it was (a declined wallet prompt is retried
     without a second signature). Otherwise the issuance limits: 5 per
     wallet per launch in 2 hours and 20 a day per wallet ("limit-wallet"),
     7,200 a minute per launch ("limit-launch"); LIMITS below.
  5. The 125-byte message with expiry now plus 600 s, signed, stored until
     it expires, returned.

  The counts live in the Upstash counter the site and the keeper share
  (sharedCap.ts), one atomic script per step: every limit of the step is
  checked before any is counted, so a refusal costs nothing. An address is
  kept as a hash, never as itself. Fail closed: no counter, no Turnstile
  secret or no signer is "signer-down", and nothing is signed.

  The seventh candidate (the founder, 2026-10-20; docs/DIRECT-CALL-SAFETY-0.29.md
  items 7 and 8) splits recognition from validity:

  - A bid attestation is issued only for a launch in the platform's
    registry (the Redis set launches/<genesis8> on the same Upstash, which
    the keeper reads too), finished (state Open: its grow landed) and open by
    the clock; an unregistered launch is "unlisted" ("launch-closed" before).
  - A creation permit (issueCreate) passes the same address limits (the
    action "create" in the launch's place) and the same bot check, then:
    the create_launch data must be the instruction's own (its discriminator,
    at most the longest name, ticker and URI), and the launch must derive
    from this creator and the data's mint_salt; this service's key must be
    in the config; the wallet limits (walletCreate, 10 per launch address in a permit's life, and 20 a day);
    the launch is registered (SADD) before anything is signed, and a write
    that fails refuses the permit; then the 40 bytes expiry || sha256 of
    the 160-byte preimage are signed. No waiver: down means new launches
    wait.

  The launch candidate (the founder, 2026-10-22; lib/bouncer/creationPolicy.ts, the
  same check the create form runs): after the door, a creation permit is
  refused "not-allowed" while GENESIS_CREATORS is set and the creator is not
  in it (a list with any entry that is not a wallet refuses everyone), and
  "reserved" when the ticker or the name, read from the create_launch data,
  normalises to a reserved term and the creator is not in
  RESERVED_TICKER_OWNERS. Every permit issued or refused is one log line
  (app/api/attest/route.ts): the action, the result, the reason, the wallet
  and the launch in a short form; nothing else.

  The signer (signersFromEnv; the founder, 2026-10-22: AWS KMS replaces Turnkey):

  - Mainnet: the AWS KMS keys only (server/kmsSigner.ts; docs/AWS-KMS-SETUP.md),
    main then backup, from BOUNCER_KMS_ATTESTOR_*, reached with the
    Vercel OIDC role (BOUNCER_AWS_ROLE_ARN) or the fallback key pair. Never a key in an environment
    variable, whatever ATTEST_SIGNER_KEY holds. No complete KMS config: no
    signer, every permit "signer-down".
  - Devnet: the env test key ATTEST_SIGNER_KEY only (base58, a 64-byte Solana
    secret key or a 32-byte seed). KMS variables are ignored, a complete
    mainnet set included (Astra L3: a signer config must never silently
    replace the devnet signer). The one exception is a rehearsal, set on
    purpose: ATTEST_KMS_DEVNET_REHEARSAL=1 with the separate devnet key set
    BOUNCER_KMS_DEVNET_ATTESTOR_* (a separate TEST key) and its own role
    BOUNCER_AWS_DEVNET_ROLE_ARN; then those KMS keys only (no env key fallback),
    and a production key id (built in), a key id or public key equal to a
    production one, or the mainnet role refuses the rehearsal (no signer).

  Failover (signFirst): the keys the Config lists, in order; the main key
  first, then the backup once, in the same request, when the main throws, times
  out or answers a signature that does not verify. The permit names the key
  that signed it (Issued.attestor; the Ed25519 instruction carries that key,
  and the program accepts any of the Config's three attestors), so a backup
  permit is valid exactly when the backup is in the Config too: both keys must
  be. A key the Config does not list is never asked. Every signature is
  verified here against its key before it leaves.

  The cost of a signature (the adversarial review's M2, permit farming): before
  any key is asked, a global and a per-launch daily signature budget
  (ATTEST_SIG_BUDGET_DAY, ATTEST_SIG_BUDGET_LAUNCH_DAY; BUDGET below), counted
  in the same atomic step as the wallet limits, "limit-budget" when spent and
  one error line PERMIT_BUDGET_HIT (the site's only alert channel: its error
  log). On a mainnet pin (the spend meter's revision 2, round 6) the
  two budgets are counted and alert (PERMIT_BUDGET_ALERT at 50, 80 and 100
  percent, budgetWatch) and never refuse a permit; the address, wallet and
  launch limits still do. A bid permit also needs the bidder's wallet to hold the launch's
  minimum bid plus the bid's costs (the processing charge, the bid account's
  rent, the commit's fees), read with one getBalance (cached 15 s): "balance"
  otherwise. This module names nothing it hears.

  Socials A, ask 1 (review/2026-10-30-mainnet-steps/SOCIALS-A-ANSWER.md section 3): a creation permit whose URI
  names this site's token store is refused ("body", detail token-uri or token-file) unless it is the store's own form
  and that stored file's name and ticker are the create data's. "Names the store" is any host that serves it (the
  origin's, every host the site's own reader takes as its own, this deployment's Vercel names); on any other host a
  path that names a store file is refused (token-file-other-host) when our file at that name is another launch's. A
  store that cannot say is "signer-down". A URI outside the store is left as before.
*/
import { createHash, createPrivateKey, createPublicKey, randomBytes, randomUUID, sign as edSign, type KeyObject } from "node:crypto";
import bs58 from "bs58";
import { PublicKey } from "@solana/web3.js";
import { BOUNDS, INSTRUCTIONS } from "@contract/constants";
import { ATTEST_LIFE_SECS, attestMessage, createAttestMessage } from "../attest";
import { CREATE_TAKES_CLOSE_TS } from "../beacon";
import { WINDOW_AT_LANDING_MIN_SECS, WINDOW_MAX_SECS, WINDOW_MIN_SECS } from "../view";
import { launchPda, mintPda } from "../chain/pda";
import { isMainnet, siteOrigin } from "../siteCluster";
import { genesisOf, sharedCapConfig, storeSpace, type Configured } from "./sharedCap";
import { loadTestMultiplier, scaled } from "./loadTest";
import { coalesce } from "./coalesce";
import { creationRefusal, parseWalletList, type WalletList } from "../creationPolicy";
import { tickerKey } from "../tickerKey";
import type { ChainIndex } from "./chainIndex";
import { isIndexUnavailable, type IndexUnavailable } from "./chainIndex";
import type { Kv } from "./kv";
import { commit, markHanded, paramHash, prepare, tickerGate } from "./reservations";
import { ZERO_BID_REPEAT, zeroBidEnded } from "./ticker";
import type { TickerRelease } from "@/content/tickerReleases";
import { bidCosts } from "../terms";
import { ed25519Verifies, KMS_DEVNET_REHEARSAL, kmsSignersFromEnv, type KmsLike } from "./kmsSigner";
import { log } from "./output";
/* Socials A, ask 1 */
import { readTokenFacts } from "./tokenStore";
import { isOwnHost } from "../ownStore";
import { hasHiddenText } from "../socialLinks";
import { BRAND } from "../../brand";
import { CLUSTER } from "@contract/active";

/*
  23c, the copycat rules (server/ticker.ts, server/reservations.ts): the ticker is held by a live launch, a funded
  (trading) token or a pending reservation; the wallet is cooling down after repeated no-shows, or already has a launch
  being set up; or the hold could not be checked (fail closed). "session": the creator has not signed in (session.ts).
*/
export type AttestFailure = "body" | "turnstile" | "launch-closed" | "unlisted" | "limit-wallet" | "limit-ip" | "limit-launch" | "limit-budget" | "balance" | "signer-down" | "not-allowed" | "reserved" | "reserved-charset" | "ticker-live" | "ticker-trading" | "ticker-paying" | "ticker-pending" | "ticker-cooldown" | "wallet-pending" | "ticker-unchecked" | "session";
export interface Issued {
  attestor: string;
  expiry: number;
  message: string;
  signature: string;
}
/* An answer: the permit, or the refusal with a short fixed detail for the log line (never sent to the visitor). */
export type IssueResult = { ok: true; issued: Issued; signedBy?: string; failover?: boolean } | { ok: false; why: AttestFailure; detail?: string };

const SECOND = 1;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/*
  Section 14.3's limits. Each is { cap, window seconds }; the window starts at the first count.
  launchMinute (the founder, 2026-10-24e, the capacity decisions): 7,200 new permits a minute on one launch, 120 a second, so a
  final minute of 6,000 new bidders (100 a second) fits with a fifth to spare. It was 300 (5 a second), which refused the
  target before anything else did. The abuse limits stay as they were: per address, per wallet and the day's signature
  budgets (budgetLimits, per launch 10,000 a day), so one farmer gains nothing from the higher launch cap.
  ipLaunchMinute (the founder, 2026-10-25): 30 a minute per address per launch, was 5, for many bidders behind one shared
  address (a venue, a carrier's NAT). The hour (30) and the day (100) per address are unchanged. Creations keep 5 a
  minute per address (ipCreateMinute): the decision was for bids.
*/
export const LIMITS = {
  ipLaunchMinute: { cap: 30, secs: MINUTE },
  ipCreateMinute: { cap: 5, secs: MINUTE },
  ipLaunchHour: { cap: 30, secs: HOUR },
  ipDay: { cap: 100, secs: DAY },
  /* Bid permits per wallet per launch in 2 hours (the founder, 2026-10-31: 5, was 3). A permit still valid is handed back
     uncounted (step 4), so 5 is five fresh signatures. walletDay (20) stays above it, so nothing else moves. */
  walletLaunch: { cap: 5, secs: 2 * HOUR },
  /*
    Creation permits per wallet and launch address, signed in a permit's life (10 minutes from the first): the flood
    bound. The creator's limit is reservations.ts MAX_ATTEMPTS, five permits that can still land (rehearsal item 2);
    since v0.31 a permit whose close can no longer land stops counting there, so this is ten, room for those.
  */
  walletCreate: { cap: 10, secs: ATTEST_LIFE_SECS },
  walletDay: { cap: 20, secs: DAY },
  launchMinute: { cap: 7_200, secs: MINUTE },
} as const;

export const TURNSTILE_VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
export const TOKEN_MAX = 2048;
const TIMEOUT_MS = 3_000;

/*
  Check every key against its cap, then count every key, or none. KEYS are
  the counters; ARGV holds a cap and a window in seconds per key. Returns
  {1, 0} when counted, {0, i} when key i is full.
*/
export const LIMIT_SCRIPT =
  "for i = 1, #KEYS do local v = tonumber(redis.call('GET', KEYS[i]) or '0'); if v + 1 > tonumber(ARGV[2 * i - 1]) then return {0, i} end end; for i = 1, #KEYS do local v = redis.call('INCR', KEYS[i]); if v == 1 then redis.call('EXPIRE', KEYS[i], tonumber(ARGV[2 * i])) end end; return {1, 0}";

/* ---------------- the signer ---------------- */

export interface AttestSigner {
  publicKey: string;
  sign(message: Uint8Array): Promise<Uint8Array>;
  /* For the log line: "env", "kms-main", "kms-backup". */
  label?: string;
}

/* PKCS#8 for an Ed25519 seed: the fixed 16-byte prefix, then the 32 bytes. */
const PKCS8_ED25519 = Buffer.from("302e020100300506032b657004220420", "hex");

export function envSigner(secret: string): AttestSigner | null {
  let raw: Uint8Array;
  try {
    raw = bs58.decode(secret.trim());
  } catch {
    return null;
  }
  if (raw.length !== 64 && raw.length !== 32) return null;
  const seed = raw.subarray(0, 32);
  let key: KeyObject;
  try {
    key = createPrivateKey({ key: Buffer.concat([PKCS8_ED25519, Buffer.from(seed)]), format: "der", type: "pkcs8" });
  } catch {
    return null;
  }
  const spki = createPublicKey(key).export({ format: "der", type: "spki" });
  const pub = new Uint8Array(spki.subarray(spki.length - 32));
  /* A 64-byte Solana secret carries its public key: the two must agree. */
  if (raw.length === 64 && !Buffer.from(raw.subarray(32)).equals(Buffer.from(pub))) return null;
  return { publicKey: new PublicKey(pub).toBase58(), label: "env", sign: async (m) => new Uint8Array(edSign(null, Buffer.from(m), key)) };
}

/*
  The signers this deployment holds, in the order they are asked (empty: every
  permit is "signer-down"). The header says the rule; in short:
  mainnet: the KMS main and backup keys (BOUNCER_KMS_ATTESTOR_*), nothing else;
  devnet: ATTEST_SIGNER_KEY only, unless ATTEST_KMS_DEVNET_REHEARSAL is exactly
  "1", then the devnet KMS keys (BOUNCER_KMS_DEVNET_ATTESTOR_*) only.
  kms stands in for AWS in the check scripts.
*/
export function signersFromEnv(env: NodeJS.ProcessEnv = process.env, cluster: string = CLUSTER, kms?: KmsLike): AttestSigner[] {
  if (isMainnet(cluster)) return kmsSignersFromEnv(env, "mainnet", kms);
  if ((env[KMS_DEVNET_REHEARSAL] ?? "").trim() === "1") return kmsSignersFromEnv(env, "devnet", kms);
  const s = env.ATTEST_SIGNER_KEY;
  const one = typeof s === "string" && s.trim() !== "" ? envSigner(s) : null;
  return one ? [one] : [];
}
/* The first signer only (the review reproductions' shape). */
export function signerFromEnv(env: NodeJS.ProcessEnv = process.env, cluster: string = CLUSTER, kms?: KmsLike): AttestSigner | null {
  return signersFromEnv(env, cluster, kms)[0] ?? null;
}

/*
  Sign with the first signer that answers a signature verifying for its own key:
  each of the given signers once, in order (main, then backup). What each one did
  goes to the log as a fixed word ("main:ok", "main:timeout", "backup:ok").
*/
export async function signFirst(signers: readonly AttestSigner[], message: Uint8Array): Promise<{ ok: true; attestor: string; signature: Uint8Array; signedBy: string; failover: boolean; tried: string[] } | { ok: false; tried: string[] }> {
  const tried: string[] = [];
  for (const [i, s] of signers.entries()) {
    const name = s.label ?? `signer${i}`;
    try {
      const signature = await s.sign(message);
      if (!(signature instanceof Uint8Array) || signature.length !== 64 || !ed25519Verifies(s.publicKey, message, signature)) {
        tried.push(`${name}:bad-signature`);
        continue;
      }
      tried.push(`${name}:ok`);
      return { ok: true, attestor: s.publicKey, signature, signedBy: name, failover: i > 0, tried };
    } catch (e) {
      const code = e && typeof e === "object" && "code" in e && typeof (e as { code: unknown }).code === "string" && /^[a-z-]{1,20}$/.test((e as { code: string }).code) ? (e as { code: string }).code : "error";
      tried.push(`${name}:${code}`);
    }
  }
  return { ok: false, tried };
}

/* ---------------- the signature budgets (M2) ---------------- */

/* Signatures a UTC day, across launches and per launch. Unset: these; anything but a whole number from 0 refuses every permit (0 does too, on purpose). */
export const BUDGET = { day: 100_000, launchDay: 10_000 } as const;
export const BUDGET_ENV = { day: "ATTEST_SIG_BUDGET_DAY", launchDay: "ATTEST_SIG_BUDGET_LAUNCH_DAY" } as const;
export interface Budgets {
  day: number;
  launchDay: number;
  malformed: string[];
  /* A mainnet pin: the budgets alert (budgetWatch) and never refuse. Set by depsFromEnv. */
  alertOnly?: boolean;
}
export function budgetsFromEnv(env: NodeJS.ProcessEnv = process.env): Budgets {
  const malformed: string[] = [];
  const one = (name: string, dflt: number): number => {
    const v = (env[name] ?? "").trim();
    if (v === "") return dflt;
    if (!/^\d{1,9}$/.test(v)) {
      malformed.push(name);
      return 0;
    }
    return Number(v);
  };
  return { day: one(BUDGET_ENV.day, BUDGET.day), launchDay: one(BUDGET_ENV.launchDay, BUDGET.launchDay), malformed };
}
const utcDay = (sec: number): string => new Date(sec * 1000).toISOString().slice(0, 10);
/* The two budget counters for a signature now, for countAll; each key is the day's, kept two days. */
function budgetLimits(b: Budgets, launch: string, nowSec: number): { key: string; cap: number; secs: number }[] {
  const day = utcDay(nowSec);
  /* Alert-only budgets are counted in the same atomic step under no cap, so they are never the full key. */
  const cap = (n: number): number => (b.alertOnly ? Number.MAX_SAFE_INTEGER : n);
  return [
    { key: keyOf("sig-d", day), cap: cap(b.day), secs: 2 * DAY },
    { key: keyOf("sig-launch-d", launch, day), cap: cap(b.launchDay), secs: 2 * DAY },
  ];
}
/* The budget-failed counters beside the two budgets: signatures counted against a budget that never came (signer-down). */
function failedKeys(launch: string, nowSec: number): [string, string] {
  const day = utcDay(nowSec);
  return [keyOf("sig-failed-d", day), keyOf("sig-failed-launch-d", launch, day)];
}
/* The alert: one error line the log drain and the Vercel log search can match. Short forms only. failed: how much of that budget signer-down spent (null when unreadable). */
async function budgetHit(counter: Configured, action: "bid" | "create", scope: "day" | "launch-day", b: Budgets, launch: string, nowSec: number): Promise<void> {
  const [day, launchDay] = failedKeys(launch, nowSec);
  const failed = await counterCall(counter, ["GET", scope === "day" ? day : launchDay]).then(
    (v) => (v === null ? 0 : Number.isInteger(Number(v)) ? Number(v) : null),
    () => null,
  );
  log("error", { event: "PERMIT_BUDGET_HIT", action, scope, cap: scope === "day" ? b.day : b.launchDay, failed, malformed: b.malformed, launch: `${launch.slice(0, 6)}…${launch.slice(-6)}` });
}

/*
  A mainnet pin's alert-only budgets: once a permit's counts are taken, one read of the two counts; each crossing of
  50, 80 and 100 percent of its figure is one PERMIT_BUDGET_ALERT error line, once an instance, key and line, and a
  malformed figure is named once. It runs beside the permit's other store calls (S8) and never throws: a counter that
  does not answer changes nothing.
*/
const BUDGET_ALERT_PCTS = [50, 80, 100] as const;
const budgetAlerted = new Set<string>();
async function budgetWatch(counter: Configured, action: "bid" | "create", b: Budgets, launch: string, nowSec: number): Promise<void> {
  if (!b.alertOnly) return;
  try {
    if (budgetAlerted.size > 10_000) budgetAlerted.clear();
    if (b.malformed.length && !budgetAlerted.has("malformed")) {
      budgetAlerted.add("malformed");
      log("error", { event: "PERMIT_BUDGET_ALERT", action, malformed: b.malformed });
    }
    const limits = budgetLimits({ ...b, alertOnly: false }, launch, nowSec);
    const counts = await counterCall(counter, ["MGET", ...limits.map((l) => l.key)]);
    if (!Array.isArray(counts)) return;
    limits.forEach((l, i) => {
      const n = Number(counts[i] ?? 0);
      if (!(l.cap > 0) || !Number.isFinite(n)) return;
      for (const pct of BUDGET_ALERT_PCTS) {
        const mark = `${l.key}|${pct}`;
        if (n * 100 < l.cap * pct || budgetAlerted.has(mark)) continue;
        budgetAlerted.add(mark);
        log("error", { event: "PERMIT_BUDGET_ALERT", action, scope: i === 0 ? "day" : "launch-day", pct, count: n, cap: l.cap, launch: `${launch.slice(0, 6)}…${launch.slice(-6)}` });
      }
    });
  } catch {
    /* the counter did not answer: no alert this time */
  }
}

/* ---------------- the wallet's balance (M2) ---------------- */

/*
  A balance reader that keeps each answer for ttlMs (a few hundred wallets at most per instance), so a retried prompt
  costs no second read. 24g (Astra 24f R7-L2): an answer is dated from when it was asked for, so ttlMs bounds the
  sample's age: an answer that took longer than that is used once and never kept, and an answer older than the one kept
  never replaces it. Asks for one wallet while a read of it, asked for within ttlMs, is still out share that read.
*/
export function cachedBalanceReader(read: (wallet: string) => Promise<bigint>, ttlMs = 15_000, now: () => number = Date.now, max = 500): (wallet: string) => Promise<bigint | null> {
  const kept = new Map<string, { at: number; lamports: bigint }>();
  const out = new Map<string, { at: number; p: Promise<bigint | null> }>();
  return async (wallet) => {
    const t = now();
    const hit = kept.get(wallet);
    if (hit && t - hit.at < ttlMs) return hit.lamports;
    const pending = out.get(wallet);
    if (pending && t - pending.at < ttlMs) return pending.p;
    const entry: { at: number; p: Promise<bigint | null> } = { at: t, p: Promise.resolve(null) };
    entry.p = (async () => {
      try {
        const lamports = await read(wallet);
        const prior = kept.get(wallet);
        if (now() - t < ttlMs && (!prior || prior.at < t)) {
          if (!prior && kept.size >= max) kept.delete(kept.keys().next().value as string);
          kept.set(wallet, { at: t, lamports });
        }
        return lamports;
      } catch {
        return null;
      } finally {
        if (out.get(wallet) === entry) out.delete(wallet);
      }
    })();
    out.set(wallet, entry);
    return entry.p;
  };
}
/* 24e (the founder's capacity decisions, item 2): wallets asked for within 25 ms share one read (server/coalesce.ts); a wallet the chain has no account for holds nothing. */
export function batchedBalanceReader(readMany: (wallets: string[]) => Promise<bigint[]>, windowMs = 25, max = 100): (wallet: string) => Promise<bigint> {
  return coalesce(readMany, windowMs, max);
}
/* What a bid on this launch takes from the wallet at the least: the minimum bid and the bid's costs (terms.ts bidCosts: the processing charge, the bid account's rent, the commit's fees). */
export function leastHeld(facts: Pick<LaunchFacts, "minBid" | "processingCharge" | "attestRequired">, bidRent: bigint): bigint {
  return facts.minBid + bidCosts(bidRent, { processingCharge: facts.processingCharge, attestRequired: facts.attestRequired });
}

/* ---------------- the counter ---------------- */

const hashOf = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 24);
const keyOf = (kind: string, ...parts: string[]) => `attest/${storeSpace()}/${kind}/${parts.join("/")}`;
/* The launch registry, the keeper's key exactly (keeper/src/registry.mjs, registryKey): the set of launches this site created. Never in the load test's space: the keeper must see a test launch to close and refund it. */
export const registryKey = (): string => `launches/${genesisOf().slice(0, 8)}`;

async function counterCall(cfg: Configured, command: (string | number)[]): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
  try {
    const res = await globalThis.fetch(cfg.url, { method: "POST", headers: { authorization: `Bearer ${cfg.token}`, "content-type": "application/json" }, body: JSON.stringify(command.map(String)), cache: "no-store", signal: controller.signal });
    if (!res.ok) throw new CounterDown();
    const j = (await res.json()) as { result?: unknown; error?: unknown };
    if (!j || typeof j !== "object" || !("result" in j)) throw new CounterDown();
    return j.result;
  } catch (e) {
    if (e instanceof CounterDown) throw e;
    throw new CounterDown();
  } finally {
    clearTimeout(timer);
  }
}
export class CounterDown extends Error {
  constructor() {
    super("counter");
    this.name = "CounterDown";
  }
}

/* Count one against every limit, or none: the index of the first full one, or 0. */
export async function countAll(cfg: Configured, limits: { key: string; cap: number; secs: number }[]): Promise<number> {
  const r = await counterCall(cfg, ["EVAL", LIMIT_SCRIPT, limits.length, ...limits.map((l) => l.key), ...limits.flatMap((l) => [l.cap, l.secs])]);
  if (!Array.isArray(r) || r.length !== 2) throw new CounterDown();
  const [ok, which] = r.map(Number);
  if (ok === 1) return 0;
  if (ok === 0 && Number.isInteger(which) && which >= 1 && which <= limits.length) return which;
  throw new CounterDown();
}

/*
  A permit counted but never signed (signFirst failed: signer-down) gives the
  wallet's two counts back, wallet-launch and wallet-day, so an outage does not
  lock a bidder or creator out of a launch once the signer is back (adversarial
  review 22e2 L3). The budgets stay counted, since they cap what the signer is
  asked; the failure is counted in the budget-failed counters too, which
  PERMIT_BUDGET_HIT reports. One atomic step: KEYS are the ARGV[1] wallet
  counters (decremented, never below 0), then the failed counters (counted, kept
  ARGV[2] seconds). Best effort: a counter down here does not change the answer.
*/
export const GIVE_BACK_SCRIPT =
  "local n = tonumber(ARGV[1]); for i = 1, n do if tonumber(redis.call('GET', KEYS[i]) or '0') > 0 then redis.call('DECR', KEYS[i]) end end; for i = n + 1, #KEYS do if redis.call('INCR', KEYS[i]) == 1 then redis.call('EXPIRE', KEYS[i], tonumber(ARGV[2])) end end; return 1";
async function giveBack(cfg: Configured, walletKeys: string[], launch: string, nowSec: number): Promise<void> {
  const failed = failedKeys(launch, nowSec);
  await counterCall(cfg, ["EVAL", GIVE_BACK_SCRIPT, walletKeys.length + failed.length, ...walletKeys, ...failed, walletKeys.length, 2 * DAY]).catch(() => undefined);
}

/* ---------------- Turnstile ---------------- */

export type TurnstileVerdict = "pass" | "fail" | "down";

export async function verifyTurnstile(secret: string, token: string, ip: string): Promise<TurnstileVerdict> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const body: Record<string, string> = { secret, response: token, idempotency_key: randomUUID() };
    if (ip && ip !== "unknown" && !ip.includes("/")) body.remoteip = ip;
    const res = await globalThis.fetch(TURNSTILE_VERIFY_URL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), cache: "no-store", signal: controller.signal });
    if (!res.ok) return "down";
    const j = (await res.json()) as { success?: unknown };
    return j && j.success === true ? "pass" : "fail";
  } catch {
    return "down";
  } finally {
    clearTimeout(timer);
  }
}

/* ---------------- the whole step ---------------- */

export interface LaunchFacts {
  open: boolean;
  grown: boolean;
  attestors: readonly string[];
  /* The launch account's own terms, for the balance check: lamports. */
  minBid: bigint;
  processingCharge: bigint;
  attestRequired: boolean;
}
export interface AttestDeps {
  counter: Configured | null;
  turnstileSecret: string;
  /* In the order they are asked: main, then backup (signersFromEnv). Empty: "signer-down". */
  signers: readonly AttestSigner[];
  readLaunch: (launch: string) => Promise<LaunchFacts | null>;
  /* The config's attestor keys now, for a creation (no launch to read yet); null when unreadable. */
  readAttestors: () => Promise<readonly string[] | null>;
  /* The wallet's lamports (confirmed, cached briefly), and the bid account's rent; null when unreadable (then "signer-down": fail closed). */
  readBalance: (wallet: string) => Promise<bigint | null>;
  readBidRent: () => Promise<bigint | null>;
  budgets: Budgets;
  nowSec: () => number;
  /* GENESIS_CREATORS and RESERVED_TICKER_OWNERS as parsed lists (creationPolicy.ts). */
  genesis: WalletList;
  owners: WalletList;
  /*
    23c, the copycat rules: the store holding the reservations and the finalized chain index for the ticker rules
    (chainIndex.ts readTickerIndex: throws when it cannot be trusted, then "ticker-unchecked"). The attestation route
    always passes it (scripts/check-copycat-v2.ts holds that); a check that leaves it out tests the rest.
  */
  ticker?: { kv: Kv; readIndex: () => Promise<ChainIndex>; releases?: readonly TickerRelease[]; log?: (r: Record<string, unknown>) => void };
  /* 23c, the creator sign-in (session.ts): whether SESSION_SECRET is set, and the cookie's verified wallet. The route always passes it; issueCreate refuses without it (24c, fresh L3). */
  session?: { configured: boolean; wallet: string | null };
  /* Socials A, ask 1: a stored token file's name and ticker by its hash (server/tokenStore.ts readTokenFacts), null when there is none, throwing when the store cannot say. depsFromEnv passes the store's; without it a URI in this site's store refuses the permit. */
  readTokenFile?: (hash: string) => Promise<{ name: unknown; symbol: unknown } | null>;
  /* The load test's multiplier on the per-address limits (server/loadTest.ts): set by depsFromEnv, 1 when absent. */
  ipMultiplier?: number;
}

export function depsFromEnv(reads: Pick<AttestDeps, "readLaunch" | "readAttestors" | "readBalance" | "readBidRent">, env: NodeJS.ProcessEnv = process.env): AttestDeps {
  const c = sharedCapConfig(env);
  return { counter: c.configured ? c : null, turnstileSecret: (env.TURNSTILE_SECRET_KEY ?? "").trim(), signers: signersFromEnv(env), ...reads, budgets: { ...budgetsFromEnv(env), alertOnly: isMainnet(CLUSTER) }, nowSec: () => Math.floor(Date.now() / 1000), genesis: parseWalletList(env.GENESIS_CREATORS), owners: parseWalletList(env.RESERVED_TICKER_OWNERS), ipMultiplier: loadTestMultiplier(env, CLUSTER), readTokenFile: readTokenFacts };
}

const isKey = (s: unknown): s is string => {
  if (typeof s !== "string" || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s)) return false;
  try {
    return bs58.decode(s).length === 32;
  } catch {
    return false;
  }
};

/* Steps 1 and 2, shared by both permits: the address limits (scope: the launch, or "create"), then the token at siteverify. Null when both pass. */
async function door(counter: Configured, secret: string, scope: string, token: string | null, ip: string, m: number = 1): Promise<AttestFailure | null> {
  const ipKey = hashOf(ip || "unknown");
  /* m: the load test's multiplier on a devnet preview (server/loadTest.ts); 1 everywhere else. */
  const per = (l: { cap: number; secs: number }) => ({ cap: scaled(l.cap, m), secs: l.secs });
  if (await countAll(counter, [
    { key: keyOf("ip-launch-m", scope, ipKey), ...per(scope === "create" ? LIMITS.ipCreateMinute : LIMITS.ipLaunchMinute) },
    { key: keyOf("ip-launch-h", scope, ipKey), ...per(LIMITS.ipLaunchHour) },
    { key: keyOf("ip-d", ipKey), ...per(LIMITS.ipDay) },
  ])) return "limit-ip";
  if (!token || token.length > TOKEN_MAX) return "turnstile";
  const t = await verifyTurnstile(secret, token, ip);
  if (t === "down") return "signer-down";
  if (t === "fail") return "turnstile";
  return null;
}

/* The body and the token as the route read them; everything else is decided here. */
export async function issue(input: { launch: unknown; bidder: unknown; token: string | null; ip: string }, d: AttestDeps): Promise<IssueResult> {
  const { launch, bidder, token, ip } = input;
  if (!isKey(launch) || !isKey(bidder)) return { ok: false, why: "body" };
  if (!d.counter || !d.turnstileSecret || d.signers.length === 0) return { ok: false, why: "signer-down", detail: !d.counter ? "no-counter" : !d.turnstileSecret ? "no-turnstile-secret" : "no-signer" };
  const counter = d.counter;
  try {
    /* 1 and 2. The address, before anything is verified; then the bot check. */
    const refused = await door(counter, d.turnstileSecret, launch, token, ip, d.ipMultiplier ?? 1);
    if (refused) return { ok: false, why: refused, detail: refused === "signer-down" ? "turnstile-down" : undefined };

    /* 3. The launch: finished and open by the clock, one of this service's keys in its config, and created through this site (the registry; an unreadable registry refuses). */
    const facts = await d.readLaunch(launch);
    if (!facts || !facts.open || !facts.grown) return { ok: false, why: "launch-closed" };
    const usable = d.signers.filter((s) => facts.attestors.includes(s.publicKey));
    if (usable.length === 0) return { ok: false, why: "signer-down", detail: "attestor-not-in-config" };
    if ((await counterCall(counter, ["SISMEMBER", registryKey(), launch])) !== 1) return { ok: false, why: "unlisted" };

    /* 4. One live attestation per wallet per launch: handed back while it lasts (no new signature, so no budget and no balance read). */
    const now = d.nowSec();
    const permitKey = keyOf("permit", launch, bidder);
    const stored = await counterCall(counter, ["GET", permitKey]);
    if (typeof stored === "string") {
      const p = parseIssued(stored);
      if (p && usable.some((s) => s.publicKey === p.attestor) && p.expiry - now >= 60) return { ok: true, issued: p, signedBy: "stored" };
    }

    /* 4b. The wallet holds the least a bid takes (M2): a permit costs the farmer SOL in a wallet, not only a CAPTCHA. */
    const [held, rent] = await Promise.all([d.readBalance(bidder), d.readBidRent()]);
    if (held === null || rent === null) return { ok: false, why: "signer-down", detail: "balance-unreadable" };
    if (held < leastHeld(facts, rent)) return { ok: false, why: "balance" };

    /* 4c. The wallet and launch limits and the day's signature budgets, one atomic step: all checked, then all counted, before any key is asked. */
    const walletKeys = [keyOf("wallet-launch", launch, bidder), keyOf("wallet-d", bidder)];
    const full = await countAll(counter, [
      { key: walletKeys[0], ...LIMITS.walletLaunch },
      { key: walletKeys[1], ...LIMITS.walletDay },
      { key: keyOf("launch-m", launch), ...LIMITS.launchMinute },
      ...budgetLimits(d.budgets, launch, now),
    ]);
    if (full === 1 || full === 2) return { ok: false, why: "limit-wallet" };
    if (full === 3) return { ok: false, why: "limit-launch" };
    if (full === 4 || full === 5) {
      await budgetHit(counter, "bid", full === 4 ? "day" : "launch-day", d.budgets, launch, now);
      return { ok: false, why: "limit-budget", detail: full === 4 ? "budget-day" : "budget-launch-day" };
    }
    const watch = budgetWatch(counter, "bid", d.budgets, launch, now);

    /* 5. Sign: the main key, then the backup once. */
    const expiry = now + ATTEST_LIFE_SECS;
    const message = attestMessage(new PublicKey(launch), new PublicKey(bidder), expiry);
    const s = await signFirst(usable, message);
    if (!s.ok) {
      await Promise.all([giveBack(counter, walletKeys, launch, now), watch]);
      return { ok: false, why: "signer-down", detail: s.tried.join(",") };
    }
    const stored64: StoredPermit = [s.attestor, expiry, Buffer.from(message).toString("base64"), Buffer.from(s.signature).toString("base64")];
    await Promise.all([counterCall(counter, ["SET", permitKey, JSON.stringify(stored64), "EX", ATTEST_LIFE_SECS]).catch(() => undefined), watch]);
    return { ok: true, issued: fromStored(stored64), signedBy: s.signedBy, failover: s.failover };
  } catch (e) {
    return { ok: false, why: "signer-down", detail: e instanceof CounterDown ? "counter-down" : "error" };
  }
}

/* The create_launch data's longest: the discriminator, mint_salt, window_secs, reveal_round, the round point and hints, three strings at their bounds, the terms (40). */
const CREATE_DATA_MAX = 8 + 8 + 8 + 8 + 48 + 192 + 4 + BOUNDS.maxName + 4 + BOUNDS.maxSymbol + 4 + BOUNDS.maxUri + 40;
const CREATE_DISC = Uint8Array.from(INSTRUCTIONS.create_launch.discriminator);
/* Where the strings start: the discriminator, mint_salt, window_secs (v0.31: close_ts), reveal_round (8 each), the round point (48) and its hints (192). */
const CREATE_STRINGS_AT = 8 + 8 + 8 + 8 + 48 + 192;

/* v0.31: the cluster clock's room past the landing floor before a permit's instruction is taken as unable to land. */
export const CLOSE_LANDING_SLACK_SECS = 30;

/* v0.31: the close_ts this create_launch data carries; null before v0.31 or on short data. */
export function createCloseTs(data: Uint8Array): number | null {
  if (!CREATE_TAKES_CLOSE_TS || data.length < 24) return null;
  return Number(new DataView(data.buffer, data.byteOffset, data.byteLength).getBigInt64(16, true));
}

/* v0.31: until when this create_launch data can still land (its close_ts less the 240 s floor, plus the slack); null before v0.31 or on short data. */
export function landsUntil(data: Uint8Array): number | null {
  const closeTs = createCloseTs(data);
  return closeTs === null ? null : closeTs - WINDOW_AT_LANDING_MIN_SECS + CLOSE_LANDING_SLACK_SECS;
}

/* Round 28c (Opus M1): the room a close_ts gets against this server's clock, for the build's clock and the time from the build to the permit. */
export const CLOSE_TS_TOLERANCE_SECS = 30;

/*
  Round 28c (Opus M1, Fable F4, Terra T12; the founder's GO, 2026-10-28): whether a create's close_ts is one the site builds,
  a 5 to 60 minute window on the network clock (view.ts closeTsFor: at most 3,580 s ahead), read against this server's
  clock: from WINDOW_MIN_SECS less the tolerance to WINDOW_MAX_SECS, past which no landing can take it. True before
  v0.31 (no close_ts in the data).
*/
export function closeTsPlausible(data: Uint8Array, nowSec: number): boolean {
  const closeTs = createCloseTs(data);
  if (closeTs === null) return true;
  const lead = closeTs - nowSec;
  return lead >= WINDOW_MIN_SECS - CLOSE_TS_TOLERANCE_SECS && lead <= WINDOW_MAX_SECS;
}

/* The name and the ticker from the create_launch data (Borsh: a u32 length, then the UTF-8 bytes), or null when they do not parse within the program's bounds. */
export function createStrings(data: Uint8Array): { name: string; symbol: string } | null {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let at = CREATE_STRINGS_AT;
  const next = (max: number): string | null => {
    if (at + 4 > data.length) return null;
    const len = view.getUint32(at, true);
    at += 4;
    if (len > max || at + len > data.length) return null;
    const bytes = data.subarray(at, at + len);
    at += len;
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      return null;
    }
  };
  const name = next(BOUNDS.maxName);
  const symbol = name === null ? null : next(BOUNDS.maxSymbol);
  return name === null || symbol === null ? null : { name, symbol };
}

/* Socials A, ask 1 (review/2026-10-30-mainnet-steps/SOCIALS-A-ANSWER.md section 3): the URI after the ticker in the create_launch data (CREATE_DATA_MAX counts it), or null when the three strings do not parse within the program's bounds. */
export function createUri(data: Uint8Array): string | null {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let at = CREATE_STRINGS_AT;
  let last: string | null = null;
  for (const max of [BOUNDS.maxName, BOUNDS.maxSymbol, BOUNDS.maxUri]) {
    if (at + 4 > data.length) return null;
    const len = view.getUint32(at, true);
    at += 4;
    if (len > max || at + len > data.length) return null;
    try {
      last = new TextDecoder("utf-8", { fatal: true }).decode(data.subarray(at, at + len));
    } catch {
      return null;
    }
    at += len;
  }
  return last;
}

/*
  Socials A, ask 1: the hosts that serve this site's token store, so a URI on any of them reaches our files: the
  origin's host and every name under it, bouncer.meme and every name under it on either cluster; every host the
  site's own reader takes as its own (ownStore.ts isOwnHost, reused so the two never drift: bouncer.meme and www, the
  devnet project's vercel.app names, localhost, 127.0.0.1); and this deployment's own Vercel names (VERCEL_URL,
  VERCEL_BRANCH_URL, VERCEL_PROJECT_PRODUCTION_URL). A trailing dot and any port are the same host.
*/
export function servesOurStore(u: URL, origin: string = siteOrigin(), env: NodeJS.ProcessEnv = process.env): boolean {
  const host = u.hostname.toLowerCase().replace(/\.$/, "");
  let ownHost = "";
  try {
    ownHost = new URL(origin).hostname.toLowerCase();
  } catch {
    /* no origin: the other names still count */
  }
  const under = (d: string) => d !== "" && (host === d || host.endsWith(`.${d}`));
  if (under(ownHost) || under(BRAND.domain)) return true;
  if (isOwnHost(host, null) || (u.port !== "" && isOwnHost(`${host}:${u.port}`, null))) return true;
  return [env.VERCEL_URL, env.VERCEL_BRANCH_URL, env.VERCEL_PROJECT_PRODUCTION_URL].some((v) => {
    if (typeof v !== "string" || v.trim() === "") return false;
    try {
      return new URL(`https://${v.trim().replace(/^https?:\/\//i, "")}`).hostname.toLowerCase().replace(/\.$/, "") === host;
    } catch {
      return false;
    }
  });
}

/* Socials A, ask 1: the store file a path names (/api/token/<hash> or <hash>.json), read as a host passing it through to this site could: percent-decoded, repeated slashes as one, a trailing slash dropped; null for any other path. */
const STORE_PATH = /^\/api\/token\/([0-9a-f]{32})(?:\.json)?$/;
function storePathHash(pathname: string): string | null {
  let p = pathname;
  try {
    p = decodeURIComponent(p);
  } catch {
    /* as written */
  }
  return STORE_PATH.exec(p.replace(/\/{2,}/g, "/").replace(/(.)\/$/, "$1"))?.[1] ?? null;
}

/*
  Socials A, ask 1: what a URI names in this site's token store (the upload route's URL form on this deployment,
  siteCluster.ts siteOrigin: <origin>/api/token/<hash>.json).
  - On a host that serves the store (servesOurStore): exactly that form, { hash, ours: true }, else "malformed". The
    site never writes another, and a query, a case, a port, another of our hosts or a path spelled another way can
    still reach the same file (the proxy sends a token file with a query to the bare file; the reader takes every
    own host from this deployment's store).
  - On any other host whose path names a store file: { hash, ours: false }; a host we do not know of can still pass
    the path through to this site (another alias of the same project, an older deployment's name).
  - Anything else: null, left as before this change.
*/
export function ownTokenFile(uri: string | null, origin: string = siteOrigin(), env: NodeJS.ProcessEnv = process.env): { hash: string; ours: boolean } | "malformed" | null {
  if (uri === null) return null;
  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    return null;
  }
  if (servesOurStore(u, origin, env)) {
    const m = /^\/api\/token\/([0-9a-f]{32})\.json$/.exec(uri.slice(origin.length));
    return uri.startsWith(`${origin}/`) && m ? { hash: m[1], ours: true } : "malformed";
  }
  const hash = storePathHash(u.pathname);
  return hash ? { hash, ours: false } : null;
}

/* The creation permit (the seventh candidate). The body as the route read it: the creator, the launch and the create_launch data in base64. */
export async function issueCreate(input: { creator: unknown; launch: unknown; data: unknown; token: string | null; ip: string }, d: AttestDeps): Promise<IssueResult> {
  const { creator, launch, token, ip } = input;
  if (!isKey(creator) || !isKey(launch) || typeof input.data !== "string" || input.data.length > 4 * Math.ceil(CREATE_DATA_MAX / 3) || !/^[A-Za-z0-9+/]+={0,2}$/.test(input.data)) return { ok: false, why: "body" };
  const data = new Uint8Array(Buffer.from(input.data, "base64"));
  /* The instruction's own data, and the launch this creator and its mint_salt derive: anything else would be a permit the program refuses, or one for someone else's launch. */
  if (data.length < 16 || data.length > CREATE_DATA_MAX || !CREATE_DISC.every((b, i) => data[i] === b)) return { ok: false, why: "body" };
  const salt = new DataView(data.buffer, data.byteOffset).getBigUint64(8, true);
  if (launchPda(mintPda(new PublicKey(creator), salt)).toBase58() !== launch) return { ok: false, why: "body" };
  const strings = createStrings(data);
  if (!strings) return { ok: false, why: "body" };
  /* 2026-10-31 (T3 and F2, review/2026-10-31c-precheck/REPORT.md): the upload route's name rule (socialLinks.ts hasHiddenText, no line breaks) here too, so a launch whose URI is off the store, or empty, or names a file stored before the rule, gets no permit for a name with a control, direction override or invisible character. */
  if (hasHiddenText(strings.name, false)) return { ok: false, why: "body", detail: "name-hidden" };
  /* Round 28c (Opus M1): a close built on a clock far from this server's is refused before anything is counted; the page rebuilds on the network clock. */
  if (!closeTsPlausible(data, d.nowSec())) return { ok: false, why: "body", detail: "close-ts" };
  if (!d.counter || !d.turnstileSecret || d.signers.length === 0) return { ok: false, why: "signer-down", detail: !d.counter ? "no-counter" : !d.turnstileSecret ? "no-turnstile-secret" : "no-signer" };
  const counter = d.counter;
  /* 2c. 23c: the creator proved the wallet is theirs today (session.ts). 24c: before the bot check and the address counters (fresh L2), and never optional (fresh L3). */
  if (!d.session || !d.session.configured) return { ok: false, why: "signer-down", detail: "session-config" };
  if (d.session.wallet !== creator) return { ok: false, why: "session" };
  try {
    const refused = await door(counter, d.turnstileSecret, "create", token, ip, d.ipMultiplier ?? 1);
    if (refused) return { ok: false, why: refused, detail: refused === "signer-down" ? "turnstile-down" : undefined };

    /* 2b. Who may create now (genesis mode) and the reserved names (creationPolicy.ts): decided before anything is counted against the wallet or registered. */
    const policy = creationRefusal({ creator, name: strings.name, symbol: strings.symbol, genesis: d.genesis, owners: d.owners });
    /* A ticker outside A-Z and 0-9 (1 to 10 characters, an empty one included) is its own reason, so the form can say which rule. */
    if (policy) return { ok: false, why: policy.rule === "reserved-charset" ? "reserved-charset" : policy.why, detail: policy.rule ?? undefined };

    /*
      2d. Socials A, ask 1: a URI in this site's token store must name a stored file whose name and ticker are this
      launch's, so no launch can carry another's file (its description and links) to the wallets that read it. Only
      after the door, so the store is read for a signed-in creator who passed the bot check; before anything is counted
      against the wallet or registered. On a host that serves the store the file must exist and be this launch's; on
      any other host whose path names a store file, a file of ours at that name must be this launch's (no file there:
      as before). A URI outside the store is left as it was.
    */
    const own = ownTokenFile(createUri(data));
    if (own === "malformed") return { ok: false, why: "body", detail: "token-uri" };
    if (own) {
      if (!d.readTokenFile) return { ok: false, why: "signer-down", detail: "token-file-unchecked" };
      let file: { name: unknown; symbol: unknown } | null;
      try {
        file = await d.readTokenFile(own.hash);
      } catch {
        return { ok: false, why: "signer-down", detail: "token-file-unreadable" };
      }
      const another = !file || file.name !== strings.name || file.symbol !== strings.symbol;
      if (own.ours && another) return { ok: false, why: "body", detail: "token-file" };
      if (!own.ours && file && another) return { ok: false, why: "body", detail: "token-file-other-host" };
    }

    /* 3. One of this service's keys in the config: a permit by any other is refused by the program. */
    const attestors = await d.readAttestors();
    const usable = attestors ? d.signers.filter((s) => attestors.includes(s.publicKey)) : [];
    if (usable.length === 0) return { ok: false, why: "signer-down", detail: attestors ? "attestor-not-in-config" : "config-unreadable" };

    /*
      3b. 23c, the copycat rules (server/ticker.ts, server/reservations.ts): the chain's hold and the key's reservation
      against a finalized snapshot, then the identical retry, the cooldown, the wallet's one pending launch and the
      renewal bounds. Nothing has been counted yet.
    */
    const now = d.nowSec();
    const tk = d.ticker;
    const key = tickerKey(strings.symbol);
    const ph = paramHash(creator, launch, data);
    let index: ChainIndex | null = null;
    let moveFrom: string | null = null;
    if (tk) {
      if (!key) return { ok: false, why: "reserved-charset" };
      try {
        index = await tk.readIndex();
      } catch (e) {
        return { ok: false, why: "ticker-unchecked", detail: isIndexUnavailable(e) ? `index-${(e as IndexUnavailable).why}` : "index-unreadable" };
      }
      try {
        const gate = await tickerGate(tk.kv, key, launch, index, tk.releases, tk.log);
        if (gate.taken) return { ok: false, why: gate.why === "live" ? "ticker-live" : gate.why === "funded" ? (gate.paying ? "ticker-paying" : "ticker-trading") : "ticker-pending" };
        const prep = await prepare(tk.kv, { wallet: creator, launch, key, paramHash: ph, nowSec: now }, index, tk.log);
        if (!prep.ok) return prep.why === "renew-limit" ? { ok: false, why: "limit-wallet", detail: "renew-limit" } : { ok: false, why: prep.why };
        if (prep.retry && usable.some((s) => s.publicKey === prep.retry![0])) {
          await markHanded(tk.kv, launch);
          return { ok: true, issued: fromStored(prep.retry), signedBy: "stored" };
        }
        moveFrom = prep.moveFrom;
      } catch {
        return { ok: false, why: "ticker-unchecked", detail: "store-unreadable" };
      }
      const zero = zeroBidEnded(creator, index!);
      if (zero >= ZERO_BID_REPEAT) log("error", { event: "CREATOR_ZERO_BID_REPEAT", creator: short(creator), ended: zero });
    }

    /* 4. The wallet: 10 per launch address in a permit's life (the flood bound; the five a creator may hold are reservations.ts's), 20 a day (shared with bids), and the day's signature budgets, one atomic step. */
    const walletKeys = [keyOf("wallet-launch", launch, creator), keyOf("wallet-d", creator)];
    const full = await countAll(counter, [
      { key: walletKeys[0], ...LIMITS.walletCreate },
      { key: walletKeys[1], ...LIMITS.walletDay },
      ...budgetLimits(d.budgets, launch, now),
    ]);
    if (full === 1 || full === 2) return { ok: false, why: "limit-wallet" };
    if (full === 3 || full === 4) {
      await budgetHit(counter, "create", full === 3 ? "day" : "launch-day", d.budgets, launch, now);
      return { ok: false, why: "limit-budget", detail: full === 3 ? "budget-day" : "budget-launch-day" };
    }

    /* 5. Recognition before the signature: a write that fails refuses the permit. The budgets' alert read (S8) goes beside it. */
    const [added] = await Promise.all([counterCall(counter, ["SADD", registryKey(), launch]), budgetWatch(counter, "create", d.budgets, launch, now)]);
    if (added !== 0 && added !== 1) return { ok: false, why: "signer-down", detail: "registry" };

    /* 6. Sign the 40 bytes: the main key, then the backup once. */
    const expiry = now + ATTEST_LIFE_SECS;
    const message = await createAttestMessage(new PublicKey(creator), new PublicKey(launch), data, expiry);
    const s = await signFirst(usable, message);
    if (!s.ok) {
      await giveBack(counter, walletKeys, launch, now);
      return { ok: false, why: "signer-down", detail: s.tried.join(",") };
    }
    const permit: StoredPermit = [s.attestor, expiry, Buffer.from(message).toString("base64"), Buffer.from(s.signature).toString("base64")];

    /* 7. 23c: the reservation is committed before the signature leaves (reservations.ts commit). A loser's signature is never seen. */
    if (tk && key && index) {
      const attempt = { key, wallet: creator, launch, paramHash: ph, attemptId: randomBytes(8).toString("hex"), nowSec: now, permit, blockTime: index.blockTime ?? 0, moveFrom, landsUntil: landsUntil(data) };
      let c = await commit(tk.kv, attempt);
      /* 24c (fresh H1): a key held at the commit is looked at once more: a holder that is dead by now (released, an orphan, freed by the chain) is cleared by the gate, and the commit tried again. */
      if (c === "lost") {
        try {
          const again = await tickerGate(tk.kv, key, launch, index, tk.releases, tk.log);
          if (!again.taken) c = await commit(tk.kv, attempt);
        } catch {
          c = "uncertain";
        }
      }
      if (c === "lost" || c === "wallet-pending" || c === "stale") {
        await giveBack(counter, walletKeys, launch, now);
        return { ok: false, why: c === "wallet-pending" ? "wallet-pending" : "ticker-pending", detail: "commit" };
      }
      if (c === "uncertain") return { ok: false, why: "signer-down", detail: "reservation-uncertain" };
      /* 24d (fresh I3): only a permit that leaves here makes a later no-show count. */
      await markHanded(tk.kv, launch);
    }
    return { ok: true, issued: fromStored(permit), signedBy: s.signedBy, failover: s.failover };
  } catch (e) {
    return { ok: false, why: "signer-down", detail: e instanceof CounterDown ? "counter-down" : "error" };
  }
}

/* The stored attestation: [attestor, expiry, message base64, signature base64]. */
type StoredPermit = [string, number, string, string];
const fromStored = ([attestor, expiry, message, signature]: StoredPermit): Issued => ({ attestor, expiry, message, signature });

function parseIssued(s: string): Issued | null {
  try {
    const j: unknown = JSON.parse(s);
    if (Array.isArray(j) && j.length === 4 && typeof j[0] === "string" && typeof j[1] === "number" && typeof j[2] === "string" && typeof j[3] === "string") return fromStored(j as StoredPermit);
  } catch {
    /* unreadable: issue a new one */
  }
  return null;
}

/* ---------------- the log line ---------------- */

/* A wallet, a launch or an attestor in a log line: its first and last six characters (the log's scrub replaces a whole address as a token). */
export const short = (v: unknown): string | null => (typeof v === "string" && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(v) ? `${v.slice(0, 6)}…${v.slice(-6)}` : null);

/*
  Every permit issued or refused, bid and create, as one line (Grok, the launch
  candidate; 74a1dc6 for the first form): the action, the result, the reason
  (every refusal: the body, the bot check, the limits, the budget, the balance,
  the policy, signer-down with its fixed detail), which key signed and whether
  it was the backup, and the wallet, the launch and the attestor in the short
  form. Never a token, the visitor's address, a signature, a message or a full
  key. A backup signature and a signer-down are error lines, so the log search
  that watches errors sees a failing main key before both fail.
*/
export function permitLine(action: "bid" | "create", wallet: unknown, launch: unknown, r: IssueResult): { level: "info" | "error"; record: Record<string, string | boolean | null> } {
  const record = {
    event: "permit",
    action,
    result: r.ok ? "issued" : "refused",
    reason: r.ok ? null : r.why,
    /* For a policy refusal, the rule ("reserved-charset", "reserved-term"); for signer-down, what was down. */
    detail: r.ok ? null : (r.detail ?? null),
    signedBy: r.ok ? (r.signedBy ?? null) : null,
    failover: r.ok && r.failover === true,
    attestor: r.ok ? short(r.issued.attestor) : null,
    wallet: short(wallet),
    launch: short(launch),
  };
  const level = (r.ok && r.failover) || (!r.ok && r.why === "signer-down") ? "error" : "info";
  return { level, record };
}
