/*
  Per-client limits on the site's public API (2026-10-20, the adversarial
  pass's S1, docs/ADVERSARIAL-GRIEFING-2026-10-20.md section 6): every paid
  call the RPC route forwards is charged to the one daily cap the site
  shares with the keeper, so a client hammering /api/rpc could spend the
  day and stall the keeper until midnight UTC. src/proxy.ts runs this on
  every /api request before any route does.

  A client is its network address as Vercel's edge reports it (x-real-ip,
  else the first x-forwarded-for entry); an IPv6 address counts by its /64,
  which one subscriber usually holds whole. A shared address (an office, a
  mobile carrier's NAT) shares one allowance, so the limits sit well above
  what one person's tabs send: the board reads through /api/rpc a few calls
  every 30 s.

  Two layers:
  - Burst windows, in this instance's memory: fixed windows per class, every
    attempt counted (a refused one too, so a flood stays refused).
  - The RPC route's hourly and daily totals across instances, in the
    Upstash counter the shared cap already uses (sharedCap.ts), when it is
    configured: an instance adds its own count for a client in batches (every
    SYNC_EVERY credits or SYNC_MS), reads back the total, and refuses that
    client locally until the window turns once the total is past the limit.
    The count is in credits (the spend meter's revision 2, S1 (b),
    2026-10-31): the proxy counts one for the request, the RPC route the rest
    of what its calls cost (rpcCredits, budget.ts CREDITS), so one batch of
    scans counts what it costs. The batch is sent in the background (S6): no
    request waits on the counter, and a client is refused from the answer
    after the one that put it over. The key holds a hash of the address,
    never the address. A counter that cannot be reached leaves the burst
    windows in charge: the limits are an availability guard.
  The outer layer is Vercel's WAF rate limiting rule (the founder's call; it is
  project configuration, not code).

  Query strings (the same section's cache note): a GET under /api takes only
  the parameters its route reads, so a cache-busting string cannot turn the
  CDN's one answer into a chain read per request. Any other parameter is
  refused before a route runs, except on the token files wallets and
  explorers read (/api/token/<file>), which are sent to the bare address
  instead.

  Nothing here builds a Response or writes a line: the proxy does both.
*/
import { createHash } from "node:crypto";
import { capKey, sharedCapConfig, type Configured } from "@/lib/bouncer/server/sharedCap";
import { loadTestMultiplier } from "@/lib/bouncer/server/loadTest";
import { CLUSTER } from "@contract/active";

export type LimitClass = "rpc" | "upload" | "bids" | "attest" | "ticker" | "stats" | "session" | "admin" | "snapshot" | "api";
export interface Window {
  ms: number;
  max: number;
}

const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/* The burst windows per class, per instance. */
export const BURST: Record<LimitClass, Window[]> = {
  rpc: [{ ms: 10 * SECOND, max: 60 }, { ms: MINUTE, max: 240 }],
  upload: [{ ms: HOUR, max: 10 }, { ms: DAY, max: 30 }],
  bids: [{ ms: 10 * SECOND, max: 20 }, { ms: MINUTE, max: 60 }],
  /* 0.29: the attestation route. Its own limits are the counter's, across instances (server/attest.ts, 5 a minute per launch per address); this only stops a burst at one instance before it reaches the counter or Cloudflare. */
  /* 2026-10-25: raised with the counter's per-address minute (5 to 30), so this burst stop never refuses below it. */
  attest: [{ ms: 10 * SECOND, max: 15 }, { ms: MINUTE, max: 40 }],
  /* 23c: the copycat check, the stats totals and the creator sign-in each have their own class, so a flood of one never spends another's window (the fleet-wide side is the chain index's read budget and the shared stats snapshot). */
  ticker: [{ ms: 10 * SECOND, max: 10 }, { ms: MINUTE, max: 40 }],
  stats: [{ ms: 10 * SECOND, max: 10 }, { ms: MINUTE, max: 30 }],
  session: [{ ms: 10 * SECOND, max: 6 }, { ms: MINUTE, max: 20 }],
  /* The admin ticker release: one person signing by hand. */
  admin: [{ ms: 10 * SECOND, max: 4 }, { ms: MINUTE, max: 12 }],
  /*
    24n (plan fix 5): the shared snapshots a live page polls (GET /api/launches, /api/launch/<id>, and the deposit feed's
    /api/launch/<id>/bids?recent=). A launch page reads about 60 a minute and the board about 20, so the "api" burst
    (120 per 10 s) froze about 20 people behind one carrier address. The CDN answers nearly all of these; a miss costs
    one shared read, bounded by the server's keep period, not by this window.
  */
  snapshot: [{ ms: 10 * SECOND, max: 600 }],
  api: [{ ms: 10 * SECOND, max: 120 }],
};

/* The RPC route's totals across instances (the counter), in credits: an hour and a UTC day. At 20,000 a day one address can spend at most about 4 percent of a 500,000 credit day. RATE_LIMIT_RPC_HOUR and RATE_LIMIT_RPC_DAY override. */
export const RPC_HOUR_DEFAULT = 3_000;
export const RPC_DAY_DEFAULT = 20_000;
export const SYNC_EVERY = 20;
export const SYNC_MS = 5 * SECOND;

/* The parameters each GET route under /api reads; a route not listed reads none. */
const QUERY: { re: RegExp; keys: string[] }[] = [
  /* 24n: the deposit feed's newest n (recent) and the slot that keys its CDN copy (v). */
  { re: /^\/api\/launch\/[^/]+\/bids$/, keys: ["after", "recent", "v"] },
  { re: /^\/api\/launch\/[^/]+\/funding$/, keys: ["bidders"] },
  { re: /^\/api\/sol-price\/at$/, keys: ["ts"] },
  /* 23c (fresh M1): the copycat check reads the ticker and the wallet; without this entry every call was refused. */
  { re: /^\/api\/ticker$/, keys: ["s", "w"] },
  /* 24d: the board's two sets (app/api/launches). */
  { re: /^\/api\/launches$/, keys: ["set"] },
];
const TOKEN_FILE = /^\/api\/token\/[^/]+$/;
/* The Vercel cron's own route: its secret is its limit, and the cron calls from Vercel's addresses. */
const UNLIMITED = new Set(["/api/volume/refresh"]);

export function classify(method: string, path: string, params?: URLSearchParams): LimitClass | null {
  if (path !== "/api" && !path.startsWith("/api/")) return null;
  if (UNLIMITED.has(path)) return null;
  if (path === "/api/rpc") return "rpc";
  if (path === "/api/token" && method === "POST") return "upload";
  const read = method === "GET" || method === "HEAD";
  if (read && (path === "/api/launches" || /^\/api\/launch\/[^/]+$/.test(path))) return "snapshot";
  if (/^\/api\/launch\/[^/]+\/bids$/.test(path)) return read && params?.has("recent") && !params.has("after") ? "snapshot" : "bids";
  if (path === "/api/attest") return "attest";
  if (path === "/api/ticker") return "ticker";
  if (path === "/api/stats") return "stats";
  if (path === "/api/session") return "session";
  if (path.startsWith("/api/admin/")) return "admin";
  return "api";
}

/* "ok", "strip" (a token file with a query: send to the bare address) or "refuse" (a parameter the route does not read). */
export function queryVerdict(method: string, path: string, params: URLSearchParams): "ok" | "strip" | "refuse" {
  if (method !== "GET" && method !== "HEAD") return "ok";
  if (path !== "/api" && !path.startsWith("/api/")) return "ok";
  const keys = [...params.keys()];
  if (keys.length === 0) return "ok";
  if (TOKEN_FILE.test(path)) return "strip";
  const allowed = QUERY.find((q) => q.re.test(path))?.keys ?? [];
  return keys.every((k) => allowed.includes(k)) && new Set(keys).size === keys.length ? "ok" : "refuse";
}

/* The client's address as the edge reports it; an IPv6 address by its /64. */
export function clientOf(headers: Headers): string {
  const raw = (headers.get("x-real-ip") ?? headers.get("x-forwarded-for")?.split(",")[0] ?? "").trim();
  if (!raw) return "unknown";
  if (raw.includes(":")) {
    const groups = raw.replace(/^\[|\]$/g, "").split("%")[0].split(":");
    const full: string[] = [];
    const gap = groups.indexOf("");
    if (gap >= 0) {
      const head = groups.slice(0, gap).filter(Boolean);
      const tail = groups.slice(gap).filter(Boolean);
      full.push(...head, ...Array(Math.max(0, 8 - head.length - tail.length)).fill("0"), ...tail);
    } else full.push(...groups);
    return `${full.slice(0, 4).map((g) => g.toLowerCase().replace(/^0+(?=.)/, "")).join(":")}::/64`;
  }
  return raw;
}

export type Verdict = { ok: true } | { ok: false; retryAfter: number };

/* ---------------- The burst windows, in memory ---------------- */

const counts = new Map<string, { start: number; n: number }>();
const MAX_ENTRIES = 50_000;

function sweep(now: number): void {
  if (counts.size < MAX_ENTRIES) return;
  for (const [k, v] of counts) if (now - v.start > DAY) counts.delete(k);
  /* Still full (a flood of distinct addresses): start over rather than grow without bound. */
  if (counts.size >= MAX_ENTRIES) counts.clear();
}

/* m: the load test's multiplier on a devnet preview (server/loadTest.ts); 1 everywhere else. */
export function burst(cls: LimitClass, client: string, now: number = Date.now(), m: number = loadTestMultiplier(process.env, CLUSTER)): Verdict {
  sweep(now);
  let wait = 0;
  for (const w of BURST[cls]) {
    const key = `${cls}|${w.ms}|${client}`;
    const start = Math.floor(now / w.ms) * w.ms;
    const c = counts.get(key);
    const entry = c && c.start === start ? c : { start, n: 0 };
    entry.n++;
    counts.set(key, entry);
    if (entry.n > w.max * m) wait = Math.max(wait, start + w.ms - now);
  }
  return wait > 0 ? { ok: false, retryAfter: Math.max(1, Math.ceil(wait / SECOND)) } : { ok: true };
}

/* ---------------- The RPC route's totals, across instances ---------------- */

export interface TotalsConfig {
  counter: Configured;
  hour: number;
  day: number;
}

const positive = (v: string | undefined, fallback: number): number => (v && /^\d+$/.test(v.trim()) && Number(v) > 0 ? Number(v) : fallback);

export function totalsConfig(env: NodeJS.ProcessEnv = process.env): TotalsConfig | null {
  const counter = sharedCapConfig(env);
  if (!counter.configured) return null;
  const m = loadTestMultiplier(env, CLUSTER);
  return { counter, hour: positive(env.RATE_LIMIT_RPC_HOUR, RPC_HOUR_DEFAULT) * m, day: positive(env.RATE_LIMIT_RPC_DAY, RPC_DAY_DEFAULT) * m };
}

/* Adds n to the client's hour and day keys (each expiring after its window) and returns both totals. */
export const TOTALS_SCRIPT =
  "local n = tonumber(ARGV[1]); local h = redis.call('INCRBY', KEYS[1], n); if redis.call('TTL', KEYS[1]) < 0 then redis.call('EXPIRE', KEYS[1], 7200) end; local d = redis.call('INCRBY', KEYS[2], n); if redis.call('TTL', KEYS[2]) < 0 then redis.call('EXPIRE', KEYS[2], 172800) end; return {h, d}";

const hashed = (client: string): string => createHash("sha256").update(`bouncer-rate:${client}`).digest("hex").slice(0, 20);
const hourOf = (now: number) => new Date(Math.floor(now / HOUR) * HOUR).toISOString().slice(0, 13);
const dayOf = (now: number) => new Date(now).toISOString().slice(0, 10);

interface Tally {
  pending: number;
  lastSync: number;
  hourKey: string;
  dayKey: string;
  /* Refused until this time, once a total passed its limit. */
  blockedUntil: number;
  /* A batch is on its way to the counter (S6: never awaited by a request). */
  syncing: boolean;
}
const tallies = new Map<string, Tally>();

async function addTotals(cfg: TotalsConfig, hourKey: string, dayKey: string, n: number): Promise<[number, number] | null> {
  try {
    const res = await globalThis.fetch(cfg.counter.url, {
      method: "POST",
      headers: { authorization: `Bearer ${cfg.counter.token}`, "content-type": "application/json" },
      body: JSON.stringify(["EVAL", TOTALS_SCRIPT, "2", hourKey, dayKey, String(n)]),
      cache: "no-store",
      signal: AbortSignal.timeout(cfg.counter.timeoutMs),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { result?: unknown };
    const r = body.result;
    if (!Array.isArray(r) || r.length !== 2) return null;
    const [h, d] = r.map(Number);
    return Number.isFinite(h) && Number.isFinite(d) ? [h, d] : null;
  } catch {
    return null;
  }
}

/* The client's tally for this hour and day. */
function tallyOf(client: string, now: number): Tally {
  const id = hashed(client);
  const hourKey = capKey(`rate-rpc-hour/${id}`, hourOf(now));
  const dayKey = capKey(`rate-rpc-day/${id}`, dayOf(now));
  let t = tallies.get(client);
  if (!t || t.dayKey !== dayKey || t.hourKey !== hourKey) {
    if (tallies.size >= MAX_ENTRIES) tallies.clear();
    t = { pending: 0, lastSync: now, hourKey, dayKey, blockedUntil: t && t.dayKey === dayKey ? t.blockedUntil : 0, syncing: false };
    tallies.set(client, t);
  }
  return t;
}

/* Send the tally's batch and judge the totals that come back; in the background, so no request waits on the counter (S6). */
async function syncTally(cfg: TotalsConfig, t: Tally, now: number): Promise<void> {
  t.syncing = true;
  const n = t.pending;
  t.pending = 0;
  t.lastSync = now;
  try {
    const totals = await addTotals(cfg, t.hourKey, t.dayKey, n);
    if (!totals) {
      /* The counter did not answer: the count goes back to wait for the next batch. */
      t.pending += n;
      return;
    }
    const [h, d] = totals;
    if (d > cfg.day) t.blockedUntil = Math.floor(now / DAY) * DAY + DAY;
    else if (h > cfg.hour) t.blockedUntil = Math.floor(now / HOUR) * HOUR + HOUR;
  } finally {
    t.syncing = false;
  }
}

/* Add credits to the client's tally, and start a batch when one is due. */
function addTo(cfg: TotalsConfig, t: Tally, credits: number, now: number): void {
  t.pending += credits;
  if (!t.syncing && (t.pending >= SYNC_EVERY || now - t.lastSync >= SYNC_MS)) void syncTally(cfg, t, now);
}

/* One RPC request from this client (the proxy): refused while it is over a total; otherwise one credit counted, and sent to the counter in a batch. */
export function rpcTotals(client: string, cfg: TotalsConfig | null, now: number = Date.now()): Verdict {
  if (!cfg) return { ok: true };
  const t = tallyOf(client, now);
  if (now < t.blockedUntil) return { ok: false, retryAfter: Math.max(1, Math.ceil((t.blockedUntil - now) / SECOND)) };
  addTo(cfg, t, 1, now);
  return { ok: true };
}

/* The rest of what a request's calls cost (the RPC route, after its checks: their credits less the one the proxy counted). Counted, never a verdict: the next request is judged on it. */
export function rpcCredits(client: string, credits: number, cfg: TotalsConfig | null, now: number = Date.now()): void {
  if (!cfg || !(credits > 0)) return;
  addTo(cfg, tallyOf(client, now), Math.floor(credits), now);
}

/* For the checks: forget every count. */
export function resetLimits(): void {
  counts.clear();
  tallies.clear();
}
