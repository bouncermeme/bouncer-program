/*
  The hard daily spending cap the site shares with the keeper
  (docs/SHARED-SPEND-CAP-2026-10-17.md, the program lane's design, sections
  2 to 5; the keeper's client is keeper/src/spend.mjs and this is its
  counterpart). GPT-6 2026-10-17, B1: the Blob ledger in budget.ts is
  eventual, so two instances with a budget of one admitted two, and an
  instance that lost the store counted alone.

  One counter the two Vercel projects share (Upstash Redis through the
  Marketplace, its REST endpoint), one key a UTC day per cluster and meter,
  spend/<first 8 characters of the cluster's genesis hash>/<meter>/<day>,
  moved only by the spec's reservation script run as one atomic step on
  the server: n credits onto the key, and taken back when the result passes
  the cap. Credits are reserved BEFORE the paid call, in blocks
  (SHARED_SPEND_BLOCK, 100 by default) drawn down locally. Fail closed: a
  counter that cannot be reached, answers after the deadline, answers an
  HTTP 4xx or 5xx, an error, or anything that is not the triple, is a
  refusal; nothing is counted locally in its place and the paid call does
  not happen. A reservation that timed out on the way back may still have
  landed; that only ends the day sooner.

  Configured by the counter's URL and token (SPEND_COUNTER_URL and
  SPEND_COUNTER_TOKEN, or the names the Marketplace injects:
  KV_REST_API_URL and KV_REST_API_TOKEN, or UPSTASH_REDIS_REST_URL and
  UPSTASH_REDIS_REST_TOKEN) and SHARED_SPEND_CAP_RPC, credits a day. Any of
  the three missing or malformed is "not configured": a devnet pin runs the
  Blob ledger as before, and the deploy guard refuses a mainnet build without
  the three. On a mainnet pin the cap refuses nothing (the spend meter's
  revision 2, round 6): it is the day's figure the count alerts against and
  browsing's soft line is drawn from (budget.ts countOnly); the counter
  carries the count.

  This module names nothing it hears: no body text, no exception text, no
  log line; a caller gets a typed refusal with one of the spec's categories.
*/
import { createHash } from "node:crypto";
import { GENESIS_HASH } from "../chain/cluster";
import { isMainnet } from "../siteCluster";
import { CLUSTER } from "@contract/active";
import { loadTestMultiplier } from "./loadTest";

export type CapShape = "off" | "ok" | "malformed";
export type Configured = { configured: true; url: string; token: string; cap: number; block: number; timeoutMs: number };
export type NotConfigured = { configured: false; missing: string[] };
export type SharedCapConfig = Configured | NotConfigured;
/* The spec's categories (section 5), plus "cap" for a reservation the counter refused. */
export type Category = "cap" | "timeout" | "network" | "http4xx" | "http5xx" | "malformed" | "error";
export type Reservation = { ok: true; used: number; cap: number } | { ok: false; why: Category; used?: number; cap?: number };

/* The reservation, the spec's text (section 3) character for character with the keeper's: n credits onto the key, a 2-day expiry on a fresh key, taken back over the cap. Returns {admitted, used, cap}. */
export const RESERVE_SCRIPT =
  "local n = tonumber(ARGV[1]); local cap = tonumber(ARGV[2]); local v = redis.call('INCRBY', KEYS[1], n); if redis.call('TTL', KEYS[1]) < 0 then redis.call('EXPIRE', KEYS[1], 172800) end; if cap > 0 and v > cap then redis.call('DECRBY', KEYS[1], n); return {0, v - n, cap} end; return {1, v, cap}";
export const DEFAULT_BLOCK = 100;
export const DEFAULT_TIMEOUT_MS = 2_000;
export const URL_NAMES = ["SPEND_COUNTER_URL", "KV_REST_API_URL", "UPSTASH_REDIS_REST_URL"] as const;
export const TOKEN_NAMES = ["SPEND_COUNTER_TOKEN", "KV_REST_API_TOKEN", "UPSTASH_REDIS_REST_TOKEN"] as const;
export const CAP_NAME = "SHARED_SPEND_CAP_RPC";

/* The cluster's genesis hash names the key, so the devnet and mainnet counters never mix (the keeper does the same from EXPECTED_GENESIS). */
export function genesisOf(cluster: string = CLUSTER): string {
  return isMainnet(cluster) ? GENESIS_HASH["mainnet-beta"] : cluster === "testnet" ? GENESIS_HASH.testnet : GENESIS_HASH.devnet;
}
/* The site's space on the store: the genesis hash's first 8 characters, and "-lt" after them while the load test's switch is on (server/loadTest.ts), so a test preview never counts against production's keys. */
export function storeSpace(cluster: string = CLUSTER, env: NodeJS.ProcessEnv = process.env): string {
  const g = genesisOf(cluster).slice(0, 8);
  return loadTestMultiplier(env, cluster) > 1 ? `${g}-lt` : g;
}
export const capKey = (meter: string, day: string, cluster: string = CLUSTER): string => `spend/${storeSpace(cluster)}/${meter}/${day}`;

const firstSet = (env: NodeJS.ProcessEnv, names: readonly string[]): string => {
  for (const n of names) {
    const v = env[n];
    if (typeof v === "string" && v.trim() !== "") return v.trim();
  }
  return "";
};
const boundedInt = (v: string | undefined, fallback: number, min: number, max: number): number => {
  if (typeof v !== "string" || !/^\d+$/.test(v.trim())) return fallback;
  const n = Number(v.trim());
  return n >= min && n <= max ? n : fallback;
};
/* https without credentials of its own (the token is the header); plain http only to this machine, for the two-process check's loopback counter. The deploy guard takes https only. */
export const counterUrlOk = (v: string): boolean => {
  if (!/^https?:\/\/[^\s/?#]+/.test(v)) return false;
  try {
    const u = new URL(v);
    if (u.username || u.password) return false;
    return u.protocol === "https:" || (u.protocol === "http:" && (u.hostname === "127.0.0.1" || u.hostname === "localhost"));
  } catch {
    return false;
  }
};

/* "off" when none of the three is set, "ok" when all three are well formed, "malformed" between (for the deploy guard's mirror and the checks; budget.ts asks sharedCapConfig). */
export function sharedCapShape(env: NodeJS.ProcessEnv = process.env): CapShape {
  const url = firstSet(env, URL_NAMES);
  const token = firstSet(env, TOKEN_NAMES);
  const cap = env[CAP_NAME]?.trim() ?? "";
  if (url === "" && token === "" && cap === "") return "off";
  const capN = /^\d+$/.test(cap) ? Number(cap) : 0;
  return counterUrlOk(url) && token.length >= 16 && capN > 0 && Number.isSafeInteger(capN) ? "ok" : "malformed";
}

/* The configuration as the keeper reads it (spendConfigFromEnv): the three values, or the names of what is missing or wrong. */
export function sharedCapConfig(env: NodeJS.ProcessEnv = process.env): SharedCapConfig {
  const url = firstSet(env, URL_NAMES);
  const token = firstSet(env, TOKEN_NAMES);
  const capText = env[CAP_NAME]?.trim() ?? "";
  const cap = /^\d+$/.test(capText) && Number.isSafeInteger(Number(capText)) ? Number(capText) : 0;
  const missing: string[] = [];
  if (url === "") missing.push(URL_NAMES[0]);
  else if (!counterUrlOk(url)) missing.push(`${URL_NAMES[0]} is not an https URL without credentials`);
  if (token === "") missing.push(TOKEN_NAMES[0]);
  else if (token.length < 16) missing.push(`${TOKEN_NAMES[0]} is too short`);
  if (!(cap > 0)) missing.push(CAP_NAME);
  if (missing.length) return { configured: false, missing };
  return { configured: true, url, token, cap, block: boundedInt(env.SHARED_SPEND_BLOCK, DEFAULT_BLOCK, 1, 10_000), timeoutMs: boundedInt(env.SPEND_COUNTER_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, 100, 10_000) };
}

/*
  A reviewer's proof that the site and the keeper count on one store (Astra
  2026-10-17c, item 4): the first 8 hex characters of sha256 of the counter
  URL's hostname, the keeper's scheme. Never the URL, never the token; the
  hostname itself stays out of every answer (the output policy withholds it).
*/
export function counterFingerprint(cfg: Configured): string | null {
  try {
    return createHash("sha256").update(new URL(cfg.url).hostname).digest("hex").slice(0, 8);
  } catch {
    return null;
  }
}

/* The counter's reply, typed: {"result":[1,used,cap]} admitted, {"result":[0,used,cap]} over the cap; an error field is "error"; anything else "malformed". */
export function parseReply(text: string): Reservation {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, why: "malformed" };
  }
  if (!parsed || typeof parsed !== "object") return { ok: false, why: "malformed" };
  if (!("result" in parsed)) return { ok: false, why: "error" in parsed ? "error" : "malformed" };
  const result = (parsed as { result: unknown }).result;
  if (!Array.isArray(result) || result.length !== 3) return { ok: false, why: "malformed" };
  const nums = result.map((x) => (typeof x === "number" ? x : typeof x === "string" && /^-?\d+$/.test(x) ? Number(x) : NaN));
  if (nums.some((n) => !Number.isFinite(n)) || nums[1] < 0) return { ok: false, why: "malformed" };
  return nums[0] === 1 ? { ok: true, used: nums[1], cap: nums[2] } : { ok: false, why: "cap", used: nums[1], cap: nums[2] };
}

/*
  Reserve `want` credits under `cap` on `key`, within the deadline. The
  global fetch is read at call time so a check's stub is the one used. Every
  path out of here is a typed Reservation; nothing the counter said travels.
*/
export async function reserve(cfg: Configured, key: string, want: number, cap: number = cfg.cap): Promise<Reservation> {
  if (!(want > 0) || !(cap > 0)) return { ok: false, why: "malformed" };
  const controller = new AbortController();
  let timedOut = false;
  const abortTimer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, cfg.timeoutMs);
  let raceTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    const call = (async () => {
      const res = await globalThis.fetch(cfg.url, {
        method: "POST",
        headers: { authorization: `Bearer ${cfg.token}`, "content-type": "application/json" },
        body: JSON.stringify(["EVAL", RESERVE_SCRIPT, "1", key, String(want), String(cap)]),
        cache: "no-store",
        signal: controller.signal,
      });
      const text = await res.text();
      return { status: res.status, text };
    })();
    /* A fetch that ignores its signal (a stub, a stuck socket) is cut by the race as well. */
    const late = new Promise<"timeout">((resolve) => {
      raceTimer = setTimeout(() => resolve("timeout"), cfg.timeoutMs + 50);
    });
    const answer = await Promise.race([call, late]);
    if (answer === "timeout") return { ok: false, why: "timeout" };
    if (answer.status >= 500) return { ok: false, why: "http5xx" };
    if (answer.status >= 400) return { ok: false, why: "http4xx" };
    return parseReply(answer.text);
  } catch {
    return { ok: false, why: timedOut ? "timeout" : "network" };
  } finally {
    clearTimeout(abortTimer);
    if (raceTimer !== undefined) clearTimeout(raceTimer);
  }
}
