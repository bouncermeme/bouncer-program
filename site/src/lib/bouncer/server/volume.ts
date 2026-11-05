/*
  The 24-hour SOL volume of every settled coin's pool, summed on the server
  (the founder, 2026-10-07: "3 should have the real volume"; the manager: do it
  server-side, incrementally, one JSON the board reads in one request).

  Each run lists the launches whose record names a pool, asks the keyed
  endpoint (RPC_SERVER_URL, or since 2026-10-15 the RPC route's
  RPC_UPSTREAM; server-only variables the browser never sees)
  for each pool's transactions newer than the last one it saw, reads the
  new ones, keeps every swap of the last 24 hours and a little more, and
  writes two JSON files to the project's Blob store (bouncer-volume): the
  state it resumes from (volume/<cluster>/state.json) and the summary the
  site serves (volume/<cluster>/volume.json, GET /api/volume). Vercel's cron
  calls /api/volume/refresh every minute (vercel.json), so a swap reaches
  the board within about a minute plus the board's own poll (market.ts).

  Every figure is a landed swap's SOL side, read from the pool's own
  transactions by the parser the trading page's chart uses
  (chain/poolSwaps.ts): nothing sampled, nothing estimated. A pool a run has
  not reached yet is absent from the summary, and the page shows "…" for
  it, never a figure. Node only: imported by the two route handlers and by
  nothing in the browser.

  The fallback (2026-10-09: the keyed endpoint's credits ran out at about
  12:25 UTC and every run failed). A refusal from RPC_SERVER_URL for rate or
  for its quota sends the same read to RPC_SERVER_FALLBACK_URL, by default
  the public devnet endpoint on devnet and none on mainnet ("off" turns it
  off). A refusal that names the quota keeps the function on the fallback
  for ten minutes, so a spent key is not asked again on every read. The
  public endpoint allows about 100 calls per 10 s per address and 40 of any
  one method, and Vercel's outbound addresses are shared, so reads through
  it are spaced 250 ms apart, its heavy methods 1.1 s apart, and
  transactions are read one at a time. Transactions are read oldest first:
  a run that runs out of time keeps what it read, the cursor moves up to it,
  and the next run goes on from there.
*/
import { Connection, PublicKey, type FetchFn } from "@solana/web3.js";
import { get, put } from "@vercel/blob";
import bs58 from "bs58";
import { ACCOUNTS } from "@contract/constants";
import { decodeLaunch, decodeRecord } from "../chain/decode";
import { fetchTransactions, type FetchedTransactions } from "../chain/history";
import { PROGRAM, settlementPda } from "../chain/pda";
import { swapsOfTransaction } from "../chain/poolSwaps";
import { categoryOf, UpstreamError, type UpstreamKind } from "../chain/upstreamError";
import { budgetStatus, isBudgetExhausted, meteredFetchFor, type BudgetState } from "./budget";
import { log } from "./output";
import { CLUSTER } from "@contract/active";

export const WINDOW_SECS = 86_400;
/* Swaps are kept a quarter hour past the window, so a read that lands late never drops one still inside it. */
const KEEP_SECS = WINDOW_SECS + 900;
const STATE_PATH = `volume/${CLUSTER}/state.json`;
const SUMMARY_PATH = `volume/${CLUSTER}/volume.json`;
/* The node's page of signatures; a pool with more new transactions than MAX_PAGES pages in one run is read on from the next. */
const PAGE = 1000;
const MAX_PAGES = 5;
/* Transactions per getTransaction batch, and the pause between batches: well under the keyed endpoint's rate. */
const BATCH = 10;
const BATCH_PAUSE_MS = 120;
/* A run starts no new pool after this long (the route's maxDuration is 60 s); the pools it did not reach go first next time. */
const RUN_BUDGET_MS = 40_000;
/* No read starts after this long; what is in hand is kept and the cursor moves up to it. */
const READ_DEADLINE_MS = 45_000;

interface StoredSwap {
  /* signature, block time (seconds), the SOL side in lamports as a decimal string */
  s: string;
  t: number;
  l: string;
}
interface PoolState {
  launch: string;
  mint: string;
  /* The newest signature seen on the pool: the next run reads only what is newer. */
  newest: string | null;
  swaps: StoredSwap[];
  /* False when a run hit MAX_PAGES before reaching what it already had: older swaps of that gap were not read. */
  complete: boolean;
  /* Unix seconds of the last run that read this pool; 0 until one has. */
  readAt: number;
}
interface State {
  version: 1;
  cluster: string;
  generatedAt: number;
  pools: Record<string, PoolState>;
}
export interface PoolVolume {
  launch: string;
  /* Lamports, as a decimal string: the SOL side of every swap in the window, buys and sells alike. */
  sol24: string;
  swaps24: number;
  lastSwapAt: number | null;
  readAt: number;
  complete: boolean;
}
export interface VolumeSummary {
  version: 1;
  cluster: string;
  generatedAt: number;
  windowSecs: number;
  source: "pool swaps";
  pools: Record<string, PoolVolume>;
}
export interface RefreshReport {
  cluster: string;
  generatedAt: number;
  ms: number;
  pools: number;
  refreshed: number;
  skipped: number;
  signatures: number;
  transactions: number;
  swaps: number;
  /* Listed by the node and not returned when asked for; left out, counted here. */
  absent: number;
  /* A pool that failed, by the category of its failure (chain/upstreamError.ts): never the provider's words (2026-10-16, GPT-6's F2). */
  errors: Record<string, ErrorCategory>;
  rpc?: RpcStatus;
  /* The day's read budget after the run (server/budget.ts). */
  budget: BudgetState;
}
export type ErrorCategory = UpstreamKind | "budget" | "other";

const pause = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const PUBLIC_DEVNET = "https://api.devnet.solana.com";
const QUOTA = /max usage|credit|quota|limit reached|usage limit|exceeded your/i;
const QUOTA_BACKOFF_MS = 600_000;
const FALLBACK_GAP_MS = 250;
const HEAVY_GAP_MS: Record<string, number> = { getProgramAccounts: 1_100, getTransaction: 1_100, getSignaturesForAddress: 1_100 };
/* Kept while the function stays warm, so the next run skips a spent key too. */
const shared = { quotaUntil: 0 };
/* An endpoint by kind, never by host: the keyed one is a secret, the public one is the public one. */
const kindOf = (u: string | null): "keyed" | "public" | null => (u === null ? null : u === PUBLIC_DEVNET ? "public" : "keyed");
const methodsOf = (init?: RequestInit): string[] => {
  try {
    const b: unknown = JSON.parse(String(init?.body));
    return (Array.isArray(b) ? b : [b]).map((x) => (x as { method?: unknown } | null)?.method).filter((m): m is string => typeof m === "string");
  } catch {
    return [];
  }
};

export interface Endpoints {
  primary: string;
  fallback: string | null;
}

/*
  The keyed endpoint and the one it falls back to (the note at the top). On
  devnet with neither variable (the founder, 2026-10-14: no key for the devnet
  site, so its traffic never drains a key the keeper or crypto-intel uses;
  since 2026-10-15 the site has its own key in RPC_UPSTREAM),
  every read goes to the public endpoint through the paced path from the
  start: primary and fallback are the same address and onFallback() is
  always true. Mainnet still refuses to run without a key.
*/
export function endpoints(env: Record<string, string | undefined> = process.env): Endpoints {
  /* 2026-10-15: RPC_SERVER_URL left the project with the launch data path; the site's one server key is RPC_UPSTREAM (the RPC route's), which this job reads through too. RPC_SERVER_URL, when set, still wins, so a separate key for this job stays possible. */
  const primary = env.RPC_SERVER_URL || env.RPC_UPSTREAM;
  if (!primary && (CLUSTER as string) === "devnet") return { primary: PUBLIC_DEVNET, fallback: PUBLIC_DEVNET };
  if (!primary) throw new UpstreamError("unconfigured");
  let fallback = env.RPC_SERVER_FALLBACK_URL ?? ((CLUSTER as string) === "devnet" ? PUBLIC_DEVNET : "");
  if (fallback === "off" || fallback === "none" || fallback === primary) fallback = "";
  return { primary, fallback: fallback || null };
}

export type RefusalReason = "unreachable" | "quota" | "rate" | "transactions";
export interface RpcStatus {
  primary: "keyed" | "public" | null;
  fallback: "keyed" | "public" | null;
  primaryRefusals: number;
  primaryQuota: number;
  primaryUnreachable: number;
  fallbackServed: number;
  fallbackRefusals: number;
  /* Why the last read went to the fallback, as a category and, for a refusal, its status number. */
  lastReason: RefusalReason | null;
  lastStatus: number | null;
  onFallbackUntil: string | null;
}

/* The rules of the note at the top: `fetch` for web3.js's Connection, `transactions` for the batched transaction reads. */
export class ServerRpc {
  readonly ep: Endpoints;
  readonly stats = { primaryRefusals: 0, primaryQuota: 0, primaryUnreachable: 0, fallbackServed: 0, fallbackRefusals: 0, lastReason: null as RefusalReason | null, lastStatus: null as number | null };
  private readonly fetchImpl: typeof fetch;
  private readonly state: { quotaUntil: number };
  private nextAt = 0;
  private readonly nextByMethod: Record<string, number> = {};

  /* The server's metered fetch by default (server/budget.ts): every read of the job is charged to the day, to the hard line, since the job's cadence bounds it and a browser flood at the soft line must not stop the day-end summary. The fallback's traffic is charged too (conservative: the public endpoint's reads count against the keyed budget). */
  constructor(ep: Endpoints, fetchImpl: typeof fetch = meteredFetchFor(true), state: { quotaUntil: number } = shared) {
    this.ep = ep;
    this.fetchImpl = fetchImpl;
    this.state = state;
  }

  /* The public endpoint alone (devnet without a key): paced from the first read. */
  publicOnly(): boolean {
    return this.ep.fallback !== null && this.ep.fallback === this.ep.primary;
  }

  onFallback(): boolean {
    return this.ep.fallback !== null && (this.publicOnly() || Date.now() < this.state.quotaUntil);
  }

  private async gate(methods: string[]): Promise<void> {
    let at = Math.max(Date.now(), this.nextAt);
    for (const m of methods) at = Math.max(at, this.nextByMethod[m] ?? 0);
    if (at > Date.now()) await pause(at - Date.now());
    this.nextAt = Date.now() + FALLBACK_GAP_MS;
    for (const m of methods) if (HEAVY_GAP_MS[m]) this.nextByMethod[m] = Date.now() + HEAVY_GAP_MS[m];
  }

  /* One request through the fallback; a refusal for rate is asked again after 2 and 4 s. */
  private async toFallback(init?: RequestInit): Promise<Response> {
    const methods = methodsOf(init);
    for (let attempt = 0; ; attempt++) {
      await this.gate(methods);
      this.stats.fallbackServed++;
      const res = await this.fetchImpl(this.ep.fallback as string, init);
      if (res.status !== 429) return res;
      this.stats.fallbackRefusals++;
      if (attempt >= 2) return res;
      await pause(2_000 * 2 ** attempt);
    }
  }

  readonly fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    if (this.onFallback()) return this.toFallback(init);
    let res: Response;
    try {
      res = await this.fetchImpl(input, init);
    } catch (e) {
      /* The budget's refusal is not the endpoint's: it stops the run, no fallback. */
      if (isBudgetExhausted(e) || !this.ep.fallback) throw e;
      this.stats.primaryUnreachable++;
      this.stats.lastReason = "unreachable";
      this.stats.lastStatus = null;
      return this.toFallback(init);
    }
    if (res.status !== 429 && res.status !== 402 && res.status !== 403) return res;
    const body = await res.clone().text().catch(() => "");
    const quota = QUOTA.test(body);
    if ((res.status !== 429 && !quota) || !this.ep.fallback) return res;
    this.stats.primaryRefusals++;
    if (quota) {
      this.stats.primaryQuota++;
      this.state.quotaUntil = Date.now() + QUOTA_BACKOFF_MS;
      this.stats.lastReason = "quota";
    } else this.stats.lastReason = "rate";
    this.stats.lastStatus = res.status;
    return this.toFallback(init);
  };

  /* A batch of transactions (history.ts's fetchTransactions): through the keyed endpoint while it answers, else one at a time through the fallback. */
  async transactions(signatures: string[]): Promise<FetchedTransactions> {
    if (this.onFallback()) return this.transactionsFromFallback(signatures);
    let got: FetchedTransactions;
    try {
      got = await fetchTransactions(this.ep.primary, signatures, this.fetchImpl);
    } catch (e) {
      if (isBudgetExhausted(e) || !this.ep.fallback) throw e;
      this.stats.primaryUnreachable++;
      this.stats.lastReason = "transactions";
      this.stats.lastStatus = e instanceof UpstreamError ? e.status : null;
      return this.transactionsFromFallback(signatures);
    }
    if (!got.refused.length || !this.ep.fallback) return got;
    this.stats.primaryRefusals++;
    this.stats.lastReason = "rate";
    const rest = await this.transactionsFromFallback(got.refused);
    for (const [k, v] of rest.found) got.found.set(k, v);
    got.absent.push(...rest.absent);
    got.unreadable.push(...rest.unreadable);
    got.refused = rest.refused;
    return got;
  }

  private async transactionsFromFallback(signatures: string[]): Promise<FetchedTransactions> {
    const out: FetchedTransactions = { found: new Map(), absent: [], refused: [], unreadable: [] };
    for (let k = 0; k < signatures.length; k++) {
      await this.gate(["getTransaction"]);
      this.stats.fallbackServed++;
      const got = await fetchTransactions(this.ep.fallback as string, [signatures[k]], this.fetchImpl);
      if (got.refused.length) {
        this.stats.fallbackRefusals++;
        out.refused.push(...signatures.slice(k));
        break;
      }
      for (const [s, tx] of got.found) out.found.set(s, tx);
      out.absent.push(...got.absent);
      out.unreadable.push(...got.unreadable);
    }
    return out;
  }

  status(): RpcStatus {
    return { primary: kindOf(this.ep.primary), fallback: kindOf(this.ep.fallback), ...this.stats, onFallbackUntil: this.publicOnly() ? "always (no keyed endpoint)" : this.onFallback() ? new Date(this.state.quotaUntil).toISOString() : null };
  }
}

/* The latest bytes from the store's origin, never its edge cache; null when the file does not exist yet. */
async function readJson<T>(path: string): Promise<T | null> {
  const r = await get(path, { access: "public", useCache: false });
  if (!r || r.statusCode !== 200) return null;
  return JSON.parse(await new Response(r.stream).text()) as T;
}

async function writeJson(path: string, value: unknown): Promise<string> {
  const r = await put(path, JSON.stringify(value), { access: "public", addRandomSuffix: false, allowOverwrite: true, contentType: "application/json", cacheControlMaxAge: 60 });
  return r.url;
}

interface PoolRef {
  pool: string;
  launch: string;
  mint: string;
}

/* Every launch whose record names a pool: the Launch accounts by size and discriminator, their records in reads of a hundred (as chainClient.listLaunches reads the board). */
async function listPools(conn: Connection): Promise<PoolRef[]> {
  const accounts = await conn.getProgramAccounts(PROGRAM, {
    commitment: "confirmed",
    filters: [{ dataSize: ACCOUNTS.Launch.len }, { memcmp: { offset: 0, bytes: bs58.encode(Uint8Array.from(ACCOUNTS.Launch.discriminator)) } }],
  });
  const launches = accounts.map((a) => ({ key: a.pubkey, account: decodeLaunch(a.pubkey.toBase58(), Uint8Array.from(a.account.data)) }));
  const out: PoolRef[] = [];
  for (let i = 0; i < launches.length; i += 100) {
    const chunk = launches.slice(i, i + 100);
    const infos = await conn.getMultipleAccountsInfo(
      chunk.map((l) => settlementPda(l.key)),
      "confirmed",
    );
    chunk.forEach((l, k) => {
      const info = infos[k];
      if (!l.account || !info) return;
      const record = decodeRecord(settlementPda(l.key).toBase58(), Uint8Array.from(info.data));
      if (record?.pool) out.push({ pool: record.pool, launch: l.key.toBase58(), mint: l.account.tokenMint });
    });
  }
  return out;
}

interface PoolRun {
  signatures: number;
  transactions: number;
  swaps: number;
  absent: number;
}

type Sig = { signature: string; err: unknown; blockTime?: number | null };

/*
  One pool brought up to date. The signature list is paged newest first
  from the node, stopping at the cursor (`until`), at the pool's first
  transaction, or past the kept window; the new landed transactions are
  read in batches and their swaps kept. The pool's state moves only once
  every read is in hand: a failure midway leaves it as it was, to be read
  again next minute.
*/
async function refreshPool(conn: Connection, rpc: ServerRpc, ref: PoolRef, st: PoolState, nowSec: number, deadline: number): Promise<PoolRun> {
  const key = new PublicKey(ref.pool);
  const run: PoolRun = { signatures: 0, transactions: 0, swaps: 0, absent: 0 };
  const cutoff = nowSec - KEEP_SECS;
  const sigs: Sig[] = [];
  let before: string | undefined;
  let complete = true;
  for (let pages = 0; ; ) {
    if (Date.now() > deadline) throw new Error("the run's time ran out while this pool's signatures were listed");
    const page: Sig[] = await conn.getSignaturesForAddress(key, { limit: PAGE, before, until: st.newest ?? undefined }, "confirmed");
    pages++;
    if (page.length === 0) break;
    sigs.push(...page);
    const last = page[page.length - 1];
    /* A short page is the end of what is newer than the cursor, or the pool's first transaction: the keyed endpoint answers whole pages. */
    if (page.length < PAGE) break;
    if (last.blockTime != null && last.blockTime < cutoff) break;
    if (pages >= MAX_PAGES) {
      complete = false;
      break;
    }
    before = last.signature;
  }
  run.signatures = sigs.length;

  const have = new Set(st.swaps.map((x) => x.s));
  /* Oldest first: a run that runs out of time keeps what it read, and the cursor moves up to it. */
  const todo = sigs.filter((s) => !s.err && (s.blockTime ?? nowSec) >= cutoff && !have.has(s.signature)).reverse();
  const timeOf = new Map(todo.map((s) => [s.signature, s.blockTime ?? null] as const));
  const fresh: StoredSwap[] = [];
  let read = 0;
  while (read < todo.length && Date.now() <= deadline) {
    /* One at a time on the fallback: the public endpoint counts each transaction of a batch. */
    const batch = todo.slice(read, read + (rpc.onFallback() ? 1 : BATCH)).map((s) => s.signature);
    const got = await rpc.transactions(batch);
    for (let attempt = 0; got.refused.length && attempt < 3; attempt++) {
      await pause(1_000 * (attempt + 1));
      const again = await rpc.transactions(got.refused);
      for (const [k, v] of again.found) got.found.set(k, v);
      got.absent.push(...again.absent);
      got.unreadable.push(...again.unreadable);
      got.refused = again.refused;
    }
    if (got.refused.length) throw new UpstreamError("rate");
    run.absent += got.absent.length;
    for (const [signature, tx] of got.found) {
      run.transactions++;
      for (const swap of swapsOfTransaction(tx, ref.pool, ref.mint)) {
        fresh.push({ s: signature, t: swap.blockTime ?? timeOf.get(signature) ?? nowSec, l: swap.solLamports.toString() });
        run.swaps++;
      }
    }
    read += batch.length;
    if (read < todo.length && !rpc.onFallback()) await pause(BATCH_PAUSE_MS);
  }
  const outOfTime = read < todo.length;
  if (outOfTime && read === 0) throw new Error("the run's time ran out before this pool's transactions were read");

  st.swaps = [...st.swaps, ...fresh].filter((x) => x.t >= cutoff).sort((a, b) => a.t - b.t);
  if (outOfTime) st.newest = todo[read - 1].signature;
  else if (sigs.length) st.newest = sigs[0].signature;
  st.complete = complete && !outOfTime;
  st.readAt = nowSec;
  return run;
}

function summarize(state: State, nowSec: number): VolumeSummary {
  const pools: Record<string, PoolVolume> = {};
  for (const [pool, st] of Object.entries(state.pools)) {
    /* Never read: absent, so the page shows "…" rather than a zero nobody measured. */
    if (st.readAt === 0) continue;
    let sum = 0n;
    let n = 0;
    let last: number | null = null;
    for (const x of st.swaps) {
      if (x.t < nowSec - WINDOW_SECS) continue;
      sum += BigInt(x.l);
      n++;
      last = last === null || x.t > last ? x.t : last;
    }
    pools[pool] = { launch: st.launch, sol24: sum.toString(), swaps24: n, lastSwapAt: last, readAt: st.readAt, complete: st.complete };
  }
  return { version: 1, cluster: CLUSTER, generatedAt: nowSec, windowSecs: WINDOW_SECS, source: "pool swaps", pools };
}

/* One run: every pool's new swaps read, the two files rewritten. The stalest pools go first, within the run's time budget. */
export async function refreshVolumes(): Promise<{ summary: VolumeSummary; report: RefreshReport }> {
  const started = Date.now();
  const rpc = new ServerRpc(endpoints());
  const conn = new Connection(rpc.ep.primary, { commitment: "confirmed", disableRetryOnRateLimit: true, fetch: rpc.fetch as FetchFn });
  const nowSec = Math.floor(started / 1000);
  const state: State = (await readJson<State>(STATE_PATH)) ?? { version: 1, cluster: CLUSTER, generatedAt: 0, pools: {} };
  if (state.cluster !== CLUSTER) throw new Error("the stored state is for another cluster than this deployment");
  const report: RefreshReport = { cluster: CLUSTER, generatedAt: nowSec, ms: 0, pools: 0, refreshed: 0, skipped: 0, signatures: 0, transactions: 0, swaps: 0, absent: 0, errors: {}, budget: budgetStatus().state };
  let refs: PoolRef[];
  try {
    refs = await listPools(conn);
  } catch (e) {
    /* The day's budget is spent before the run began: nothing read, nothing written, the summary as it stands. */
    if (!isBudgetExhausted(e)) throw e;
    report.ms = Date.now() - started;
    report.budget = budgetStatus().state;
    log("info", { volumeRefresh: { ...report, errors: 0, byCategory: { budget: 1 } } });
    return { summary: summarize(state, nowSec), report };
  }
  report.pools = refs.length;
  for (const ref of refs) state.pools[ref.pool] ??= { launch: ref.launch, mint: ref.mint, newest: null, swaps: [], complete: false, readAt: 0 };
  const live = new Set(refs.map((r) => r.pool));
  for (const p of Object.keys(state.pools)) if (!live.has(p)) delete state.pools[p];

  const order = refs.slice().sort((a, b) => state.pools[a.pool].readAt - state.pools[b.pool].readAt);
  for (const ref of order) {
    if (Date.now() - started > RUN_BUDGET_MS) {
      report.skipped++;
      continue;
    }
    try {
      const run = await refreshPool(conn, rpc, ref, state.pools[ref.pool], nowSec, started + READ_DEADLINE_MS);
      report.refreshed++;
      report.signatures += run.signatures;
      report.transactions += run.transactions;
      report.swaps += run.swaps;
      report.absent += run.absent;
    } catch (e) {
      report.errors[ref.pool] = categoryOf(e);
      /* The budget's refusal ends the run: the pools left are skipped, not asked. */
      if (isBudgetExhausted(e)) {
        report.skipped += order.length - order.indexOf(ref) - 1;
        break;
      }
    }
  }
  state.generatedAt = nowSec;
  const summary = summarize(state, nowSec);
  await writeJson(STATE_PATH, state);
  await writeJson(SUMMARY_PATH, summary);
  report.generatedAt = nowSec;
  report.ms = Date.now() - started;
  report.rpc = rpc.status();
  report.budget = budgetStatus().state;
  const byCategory: Record<string, number> = {};
  for (const c of Object.values(report.errors)) byCategory[c] = (byCategory[c] ?? 0) + 1;
  log("info", { volumeRefresh: { ...report, errors: Object.keys(report.errors).length, byCategory } });
  return { summary, report };
}

/* The summary as last written, or null before the first run. */
export async function readVolumeSummary(): Promise<VolumeSummary | null> {
  return readJson<VolumeSummary>(SUMMARY_PATH);
}
