/*
  The site's daily budgets of upstream reads, with a breaker (2026-10-16,
  after GPT-6's final review: per-instance caches and a 200-winner cap
  bounded single requests, nothing bounded the day). Two meters:

  "rpc": every call the server makes to the keyed endpoint passes through
  `charge`: the RPC route for the browser's calls, and `meteredFetchFor`
  for the server's own readers (snapshot, history, funding, the volume
  job). A call is weighted by CREDITS (a scan or a history page costs more
  than an account read) and counted against RPC_DAILY_BUDGET for the UTC
  day.

  "price": every read of an external price source that a visitor can cause
  (a settled minute's candle on /api/sol-price/at, the fresh pair of quotes
  on /api/sol-price/check) passes through `chargePrice` and is counted
  against PRICE_DAILY_BUDGET (GPT-6's final report, section 2: the
  distinct-minute traffic had no cost limit). The spot quote on
  /api/sol-price is not metered: its 30 s cache and its pause after a
  failure bound it by themselves.

  Two lines on each meter (RPC_BUDGET_SOFT_PCT of the budget, 90 by
  default, then the budget itself). Reads that are not urgent stop at the
  soft line; past it the endpoints serve what they last read (`staleOr`),
  marked `source: "stale"`, with a short cache, every answer carries
  `x-bouncer-budget: degraded`, and the banner
  (components/shell/BudgetBanner) says so. Urgent calls go on to the hard
  line and nothing passes it: a send and the reads the signer makes around
  it (the RPC route's urgent set), the volume job (its cadence of one run a
  minute bounds it, and a browser flood must not stop the day-end summary),
  and the pre-seal price check (a flood of old minutes on /sol-price/at
  must not stop bidding). No day's spend is ever exceeded; the slack is
  only what a sync has not yet seen (below).

  Each ledger is shared across the function's instances through the Blob
  store the volume job already writes to: each instance keeps its own shard
  budget/<cluster>/<day>/<meter>/<instance>-<spent>.json (the spend in the
  name, cumulative, so one `list` sums everyone without a read-modify-write:
  the highest number per instance counts, an orphan from a failed delete is
  not added twice) and every SYNC_MS, or every SYNC_CREDITS, writes its
  shard and lists the others'. The admitted spend is therefore at most the
  cap plus what the other instances charged since their last shard write
  (under SYNC_CREDITS each, plus whatever lands while a sync is in flight),
  plus, for an instance that has just started, everything it admits before
  its first list lands (`others` is 0 until then; the first charge starts
  that sync at once). A store call is given STORE_MS; an instance that
  cannot reach the store counts alone for STORE_RETRY_MS and says so once,
  which still caps what that instance can spend. The rpc budget is a config
  value (a devnet pin's; a mainnet pin counts, below).
  Logged: one line per sync, one at every change of state, one a minute at
  most for refusals.

  The hard shared cap (2026-10-17, GPT-6's B1; docs/SHARED-SPEND-CAP-
  2026-10-17.md, the program lane's design; server/sharedCap.ts): with the
  counter's URL and token and SHARED_SPEND_CAP_RPC set, the rpc meter does
  not count for itself at all. This instance holds a lease: a block of
  credits reserved on the shared counter with one atomic script
  (SHARED_SPEND_BLOCK at a time, 100 by default, so a block's worth of calls
  costs one round trip), every paid call drawn from the block in hand, the
  next block reserved before the call that empties it. The counter's integer
  is the one count for every site instance and every keeper job, so no two
  instances can both fit through the last credit. A counter that cannot be
  reached, answers late, answers an HTTP error or answers wrong is a
  refusal: the paid call does not happen, nothing is counted locally in its
  place (the Blob ledger above is not consulted while the cap is on), and
  the counter is not asked again for STORE_RETRY_MS (the spec, section 4);
  the cap itself is asked again on every call. A block that no longer fits
  is asked for once more at the call's own cost, so the day's last credits
  are not stranded by the block size. The lease is dropped at the UTC day
  change and whatever it held stays on the old day's key. The upload meter
  reserves one picture at a time on its own key (spend/<genesis>/upload/
  <day>, UPLOAD_DAILY_BUDGET as its cap). The price meter stays local: its
  sources are public and its reads are not the provider's bill. The soft
  line is judged on the counter's last total; the limit shown is the cap.
  Not configured: a devnet pin runs the Blob ledger as before.

  A mainnet pin counts (the spend meter's revision 2, site half; round 6:
  no spend meter stops the money path on mainnet; the S1 choice (b),
  2026-10-31: browsing keeps a soft line). Every call is admitted at
  once and counted (countOnly): its credits go on this instance's tally,
  which the reservation script adds to the shared counter's key in the
  background under no cap (FLUSH_CREDITS or FLUSH_MS), and the day's total
  that comes back is the count. Nothing waits on the counter and nothing is
  refused by it: a counter that fails, or is not configured, refuses
  nothing; the tally waits for the next flush and one line a minute says
  so. The one line left is the soft one, for browsing only: a read that is
  not urgent and asks for a list or a history (BROWSING) is refused once
  the count passes RPC_BUDGET_SOFT_PCT of SHARED_SPEND_CAP_RPC, so the
  provider's own cap keeps room for the money path. Sends, simulations,
  blockhashes, statuses and the launch and bid pages' account reads never
  are. The count raises one SPEND_ALERT error line at each of ALERT_PCTS
  of that figure, once an instance a day, and the answers never say
  exhausted. The upload meter counts the same way (the per-address upload
  limits, lib/rateLimit.ts, stay); the pre-seal price check is counted and
  never refused. The provider caps (the Helius plan, Alchemy's) protect the
  bill; the per-address limits (lib/rateLimit.ts) and the permit limits
  (attest.ts) still stop abuse.
*/
import { isMainnet } from "../siteCluster";
import { log, noteOf } from "./output";
import { capKey, reserve, sharedCapConfig, type Configured } from "./sharedCap";
import { CLUSTER } from "@contract/active";

export class BudgetExhausted extends Error {
  constructor() {
    super("Today's chain read budget is spent.");
    this.name = "BudgetExhausted";
  }
}
/* The refusal by name as well as by class: a check may load this module twice, and a client may rewrap. */
export const isBudgetExhausted = (e: unknown): boolean => e instanceof BudgetExhausted || (e instanceof Error && e.name === "BudgetExhausted");

/* 24e: the endpoint still refused for rate after the metered fetch's own retries (meteredFetchFor). A kind, never the endpoint's text. */
export class RateLimited extends Error {
  constructor() {
    super("The endpoint refused for rate.");
    this.name = "RateLimited";
  }
}
export const isRateLimited = (e: unknown): boolean => e instanceof RateLimited || (e instanceof Error && e.name === "RateLimited");

export type Meter = "rpc" | "price" | "upload";
export type BudgetState = "ok" | "degraded" | "exhausted";
export interface BudgetStatus {
  meter: Meter;
  day: string;
  spent: number;
  limit: number;
  soft: number;
  state: BudgetState;
  /* Unix milliseconds of the next UTC midnight, when the day's count starts over. */
  resetsAt: number;
  /* "count": a mainnet pin's count (countOnly); "cap": the hard shared cap (sharedCap.ts); "shared": this instance's Blob shard beside the others'; "instance": this instance alone. */
  ledger: "count" | "cap" | "shared" | "instance";
}

/*
  Credits per JSON-RPC call; 1 for anything unlisted. The keyed provider's
  heavier calls. getTransactionsForAddress is priced at its worst page (Astra
  2026-10-17c, A3: Helius bills 10 credits per 100 full results, 10 at
  least, so a page of 1,000 is 100, not 10); the history reader reserves
  that and gives back what the page did not use (historyPageCredits).
*/
export const HISTORY_PAGE_CREDITS = 100;
export const CREDITS: Readonly<Record<string, number>> = { getProgramAccounts: 10, getTransactionsForAddress: HISTORY_PAGE_CREDITS };
/* What a history page of n full transactions costs the provider: 10 per 100, rounded up, 10 at least. */
export const historyPageCredits = (n: number): number => Math.max(10, Math.ceil(Math.max(0, n) / 100) * 10);
export const creditsOf = (methods: readonly string[]): number => methods.reduce((s, m) => s + (CREDITS[m] ?? 1), 0);

/* The devnet pin's default. The volume job alone reads about 100,000 credits a day; a mainnet pin has no default and the guard requires the variable. */
export const DEFAULT_DEVNET_BUDGET = 400_000;
/* External price reads a day, both pins: the sources are public and unkeyed, so the ceiling caps what a visitor can cause, not a bill. */
export const DEFAULT_PRICE_BUDGET = 50_000;
/* Pictures a day (the founder's item 7, S8): each is at most 2 MB in the token store, so the cap bounds the store's growth under a flood; a real day sees a handful. */
export const DEFAULT_UPLOAD_BUDGET = 500;
const DEFAULT_SOFT_PCT = 90;
const SYNC_MS = 15_000;
const SYNC_CREDITS = 100;
const STORE_MS = 5_000;
const STORE_RETRY_MS = 5 * 60_000;
/* A refusal keeps the state at degraded for this long, so the header and the banner agree with what the meter is doing. */
const REFUSAL_SHOWS_MS = 60_000;
const REFUSAL_LOG_MS = 60_000;
const MAX_KEPT = 5_000;
/* A mainnet pin's count: a batch's size and age, the pause after the counter failed a flush, the alert lines (percent of the day's figure), and the reservation's "no cap". */
const FLUSH_CREDITS = 100;
const FLUSH_MS = 15_000;
const COUNT_RETRY_MS = 60_000;
export const ALERT_PCTS = [50, 80, 100, 200, 400] as const;
const NO_CAP = Number.MAX_SAFE_INTEGER;
/* Browsing-only reads (S1 (b)): the lists and the history. The only reads a mainnet pin may refuse, past the soft line, and only when not urgent. */
export const BROWSING: ReadonlySet<string> = new Set(["getProgramAccounts", "getSignaturesForAddress", "getTransaction", "getTransactionsForAddress"]);
export const isBrowsing = (methods: readonly string[]): boolean => methods.some((m) => BROWSING.has(m));

const integerOr = (v: string | undefined, fallback: number): number => {
  if (v === undefined || v === "") return fallback;
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 ? n : 0;
};
/* The default follows the meter's pin (onMainnet: the build's, or a check's resetBudget), or the cluster named. */
export function limitFromEnv(env: NodeJS.ProcessEnv = process.env, cluster?: string): number {
  return integerOr(env.RPC_DAILY_BUDGET, (cluster === undefined ? onMainnet : isMainnet(cluster)) ? 0 : DEFAULT_DEVNET_BUDGET);
}
export function priceLimitFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  return integerOr(env.PRICE_DAILY_BUDGET, DEFAULT_PRICE_BUDGET);
}
export function uploadLimitFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  return integerOr(env.UPLOAD_DAILY_BUDGET, DEFAULT_UPLOAD_BUDGET);
}
/* The soft line's percent, for both meters; an empty variable is unset, not zero (2026-10-16, the adversarial review). */
export function softPctFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.RPC_BUDGET_SOFT_PCT;
  if (raw === undefined || raw === "") return DEFAULT_SOFT_PCT;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 && n <= 100 ? n : DEFAULT_SOFT_PCT;
}
/* The configured counter for a meter, or null: the price meter is never under it; the others are when the three variables are set. */
const underCap = (meter: Meter): Configured | null => {
  if (meter === "price") return null;
  const cfg = sharedCapConfig();
  return cfg.configured ? cfg : null;
};
/* Under the shared cap the rpc meter's limit is the cap itself. */
const limitOf = (meter: Meter): number => (meter === "rpc" ? (underCap("rpc")?.cap ?? limitFromEnv()) : meter === "price" ? priceLimitFromEnv() : uploadLimitFromEnv());
/* What the meter has spent: a mainnet pin's count (countedOf); under the cap, the counter's last total less this instance's undrawn block (every instance's reservations count); otherwise this instance plus the shards. */
const spentOf = (meter: Meter, l: Ledger): number => (counting(meter) ? countedOf(l) : underCap(meter) ? Math.max(0, l.capTotal - l.block) : l.local + l.others);
/* A mainnet pin counts the rpc and upload meters; the price meter stays local on every pin. */
const counting = (meter: Meter): boolean => onMainnet && meter !== "price";
/* A mainnet pin's count: the counter's total at the last flush and this instance's tally not yet sent. */
const countedOf = (l: Ledger): number => l.capTotal + l.pending;
const softOf = (limit: number): number => Math.floor((limit * softPctFromEnv()) / 100);

const dayOf = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
const midnightAfter = (ms: number): number => Date.UTC(new Date(ms).getUTCFullYear(), new Date(ms).getUTCMonth(), new Date(ms).getUTCDate() + 1);
const instance = Math.random().toString(36).slice(2, 10) + Date.now().toString(36);

interface Ledger {
  day: string;
  /* This instance's spend today; `others` the sum of the other shards at the last sync. */
  local: number;
  others: number;
  syncedAt: number;
  syncedLocal: number;
  /* The pathname of this instance's shard in the store, to replace at the next sync. */
  shard: string | null;
  lastState: BudgetState;
  lastRefusedAt: number;
  lastRefusalLogAt: number;
  syncing: boolean;
  /* Until when this instance counts alone after the store failed it. */
  storeFailedUntil: number;
  /* Under the shared cap: the lease's credits not yet drawn, the counter's total at the last reservation, until when the counter is not asked after it failed, and the queue that serializes this instance's reservations. */
  block: number;
  capTotal: number;
  counterFailedUntil: number;
  chain: Promise<unknown>;
  /* A mainnet pin's count: credits not yet sent to the counter, when they last were, whether a flush is in flight, when the count last logged a counter it could not reach, the alert lines said today. */
  pending: number;
  flushedAt: number;
  flushing: boolean;
  countLogAt: number;
  alerted: number[];
}
const fresh = (day: string): Ledger => ({ day, local: 0, others: 0, syncedAt: 0, syncedLocal: 0, shard: null, lastState: "ok", lastRefusedAt: 0, lastRefusalLogAt: 0, syncing: false, storeFailedUntil: 0, block: 0, capTotal: 0, counterFailedUntil: 0, chain: Promise.resolve(), pending: 0, flushedAt: 0, flushing: false, countLogAt: 0, alerted: [] });
/* The pin's kind, for the mainnet count; a check may override it (resetBudget). */
let onMainnet: boolean = isMainnet(CLUSTER);
let clock: () => number = Date.now;
const ledgers: Record<Meter, Ledger> = { rpc: fresh(dayOf(Date.now())), price: fresh(dayOf(Date.now())), upload: fresh(dayOf(Date.now())) };

/* The meter's ledger for the day. It rolls forward only: a sync that finishes after midnight with yesterday's clock must not bring yesterday back (2026-10-16, the adversarial review). */
function ledgerOf(meter: Meter, now: number): Ledger {
  const day = dayOf(now);
  if (day > ledgers[meter].day) {
    const old = ledgers[meter].shard;
    ledgers[meter] = fresh(day);
    if (old) void removeShard(old);
  }
  return ledgers[meter];
}

const stateOf = (spent: number, limit: number, soft: number): BudgetState => (spent >= limit ? "exhausted" : spent >= soft ? "degraded" : "ok");
/* The state the answers carry: a refusal under the soft line (a heavy call that did not fit) shows as degraded for a minute, so the readers' stale answers and the banner agree with the meter. */
const shownState = (l: Ledger, spent: number, limit: number, soft: number, now: number, meter: Meter = "rpc"): BudgetState => {
  /* A mainnet pin's count refuses no call for the day's spend, so it never says the reads are used up: past the soft line it says degraded (browsing is refused there); with no figure, only after a refusal. */
  if (counting(meter) && !(limit > 0)) return now - l.lastRefusedAt < REFUSAL_SHOWS_MS ? "degraded" : "ok";
  const s = stateOf(spent, limit, soft);
  const shown = s === "ok" && now - l.lastRefusedAt < REFUSAL_SHOWS_MS ? "degraded" : s;
  return counting(meter) && shown === "exhausted" ? "degraded" : shown;
};

export function budgetStatus(now: number = clock(), meter: Meter = "rpc"): BudgetStatus {
  const l = ledgerOf(meter, now);
  const limit = limitOf(meter);
  const soft = softOf(limit);
  const spent = spentOf(meter, l);
  return { meter, day: l.day, spent, limit, soft, state: shownState(l, spent, limit, soft, now, meter), resetsAt: midnightAfter(now), ledger: counting(meter) ? "count" : underCap(meter) ? "cap" : hasStore(l, now) ? "shared" : "instance" };
}

/*
  Charge `cost` to the meter's day. Urgent calls may spend up to the budget;
  others stop at the soft line. "refused" charges nothing, keeps the shown
  state at degraded for a minute and logs at most once a minute. The state
  after the charge comes back for the answer's header. `noRefusal` (a mainnet
  pin's pre-seal price check): counted and alerted, never refused.
*/
function chargeMeter(meter: Meter, cost: number, urgent: boolean, noRefusal = false): BudgetState | "refused" {
  const now = clock();
  const l = ledgerOf(meter, now);
  const limit = limitOf(meter);
  const soft = softOf(limit);
  const spent = l.local + l.others;
  const cap = urgent ? limit : soft;
  if (!noRefusal && spent + cost > cap) {
    l.lastRefusedAt = now;
    if (now - l.lastRefusalLogAt >= REFUSAL_LOG_MS) {
      l.lastRefusalLogAt = now;
      log("error", { budget: { meter, day: l.day, refused: cost, urgent, spent, soft, limit } });
    }
    noteState(meter, l, stateOf(spent, limit, soft), spent, limit);
    return "refused";
  }
  l.local += cost;
  const after = stateOf(spent + cost, limit, soft);
  noteState(meter, l, after, spent + cost, limit);
  if (noRefusal) alertOn(meter, l, spent + cost, limit);
  if (hasStore(l, now) && !l.syncing && (now - l.syncedAt >= SYNC_MS || l.local - l.syncedLocal >= SYNC_CREDITS)) void sync(meter, l, now);
  return shownState(l, spent + cost, limit, soft, now);
}

/*
  Charge `cost` against the hard shared cap (sharedCap.ts). This instance's
  reservations are serialized on the ledger's chain, so two requests in the
  same instant cannot both draw the last credit of a block. A refusal of any
  kind (the cap, the store unreachable, late, wrong, misconfigured) charges
  nothing, counts nothing locally, keeps the shown state at degraded for a
  minute and logs once a minute with the kind. A block that no longer fits
  under the cap is asked for once more at the call's own cost, so the last
  credits of the day are not stranded by the block size.
*/
async function chargeShared(meter: Meter, cost: number, urgent: boolean, cfg: Configured, block: number): Promise<BudgetState | "refused"> {
  const first = ledgerOf(meter, clock());
  const run = async (): Promise<BudgetState | "refused"> => {
    const now = clock();
    const l = ledgerOf(meter, now);
    const cap = meter === "rpc" ? cfg.cap : limitOf(meter);
    const soft = softOf(cap);
    const refuse = (why: string, known: number): "refused" => {
      l.lastRefusedAt = now;
      if (now - l.lastRefusalLogAt >= REFUSAL_LOG_MS) {
        l.lastRefusalLogAt = now;
        log("error", { budget: { meter, day: l.day, refused: cost, urgent, why, spent: known, soft, limit: cap, ledger: "cap" } });
      }
      noteState(meter, l, stateOf(known, cap, soft), known, cap);
      return "refused";
    };
    if (!urgent && spentOf(meter, l) + cost > soft) return refuse("soft", spentOf(meter, l));
    if (l.block < cost) {
      /* The counter failed a moment ago: refused without asking, for STORE_RETRY_MS (the spec, section 4), never counted locally. */
      if (now < l.counterFailedUntil) return refuse("counterDown", spentOf(meter, l));
      const key = capKey(meter, l.day);
      let want = Math.max(block, cost);
      let r = await reserve(cfg, key, want, cap);
      if (!r.ok && r.why === "cap" && want > cost) {
        want = cost;
        r = await reserve(cfg, key, want, cap);
      }
      if (!r.ok) {
        if (r.why === "cap") {
          if (r.used !== undefined) l.capTotal = Math.max(l.capTotal, r.used + l.block);
        } else l.counterFailedUntil = now + STORE_RETRY_MS;
        return refuse(r.why, spentOf(meter, l));
      }
      l.block += want;
      l.capTotal = r.used;
    }
    l.block -= cost;
    l.local += cost;
    const spent = spentOf(meter, l);
    noteState(meter, l, stateOf(spent, cap, soft), spent, cap);
    return shownState(l, spent, cap, soft, now);
  };
  const p = first.chain.then(run, run);
  first.chain = p.then(
    () => undefined,
    () => undefined,
  );
  return p;
}

/* One SPEND_ALERT error line for each of ALERT_PCTS the day's count has reached against the day's figure, once an instance a day (the site's alert channel is its error log). No figure, no line. */
function alertOn(meter: Meter, l: Ledger, spent: number, limit: number): void {
  if (!(limit > 0)) return;
  for (const pct of ALERT_PCTS) {
    if (spent * 100 < limit * pct || l.alerted.includes(pct)) continue;
    l.alerted.push(pct);
    log("error", { event: "SPEND_ALERT", meter, pct, day: l.day, spent, limit });
  }
}

/*
  A mainnet pin: the call is admitted and its cost counted, except a
  browsing read (S1 (b)) past the soft line of the day's figure. The tally
  goes to the counter in a batch, in the background, so no call waits on
  the store and none is refused by it. A counter that is not configured or
  does not answer is logged once a minute; the tally is kept for the next
  flush.
*/
function countOnly(meter: Meter, cost: number, browsing: boolean): BudgetState | "refused" {
  const now = clock();
  const l = ledgerOf(meter, now);
  const limit = limitOf(meter);
  const soft = softOf(limit);
  if (browsing && limit > 0 && countedOf(l) + cost > soft) {
    l.lastRefusedAt = now;
    if (now - l.lastRefusalLogAt >= REFUSAL_LOG_MS) {
      l.lastRefusalLogAt = now;
      log("error", { budget: { meter, day: l.day, refused: cost, why: "soft", spent: countedOf(l), soft, limit, ledger: "count" } });
    }
    noteState(meter, l, stateOf(countedOf(l), limit, soft), countedOf(l), limit);
    return "refused";
  }
  l.local += cost;
  l.pending += cost;
  const cfg = sharedCapConfig();
  if (!cfg.configured) {
    if (now - l.countLogAt >= REFUSAL_LOG_MS) {
      l.countLogAt = now;
      log("error", { budget: { meter, day: l.day, counted: cost, why: "unconfigured", missing: cfg.missing, ledger: "count" } });
    }
  } else if (!l.flushing && now >= l.counterFailedUntil && (l.pending >= flushAt(meter) || now - l.flushedAt >= FLUSH_MS)) void flush(meter, l, cfg);
  const spent = countedOf(l);
  if (limit > 0) noteState(meter, l, stateOf(spent, limit, soft), spent, limit);
  alertOn(meter, l, spent, limit);
  return shownState(l, spent, limit, soft, now, meter);
}

/* Send this instance's tally under no cap and keep the day's total that comes back. A failure refuses nothing, keeps the tally and pauses the flushes for COUNT_RETRY_MS. */
async function flush(meter: Meter, l: Ledger, cfg: Configured): Promise<void> {
  l.flushing = true;
  const n = l.pending;
  try {
    const r = await reserve(cfg, capKey(meter, l.day), n, NO_CAP);
    if (r.ok) {
      l.pending = Math.max(0, l.pending - n);
      l.capTotal = Math.max(l.capTotal, r.used);
      l.flushedAt = clock();
    } else {
      l.counterFailedUntil = clock() + COUNT_RETRY_MS;
      if (clock() - l.countLogAt >= REFUSAL_LOG_MS) {
        l.countLogAt = clock();
        log("error", { budget: { meter, day: l.day, why: r.why, uncounted: l.pending, ledger: "count" } });
      }
    }
  } finally {
    l.flushing = false;
  }
  if (ledgers[meter] !== l) return;
  alertOn(meter, l, countedOf(l), limitOf(meter));
  /* What came in while this batch was out goes next, once it makes a batch of its own. */
  if (clock() >= l.counterFailedUntil && l.pending >= flushAt(meter)) void flush(meter, l, cfg);
}
const flushAt = (meter: Meter): number => (meter === "upload" ? 1 : FLUSH_CREDITS);

/* The rpc meter: JSON-RPC method names, weighted by CREDITS. A mainnet pin counts (countOnly); otherwise, under the shared cap, a reservation before the call, and without it the Blob ledger. */
export async function charge(methods: readonly string[], urgent = false): Promise<BudgetState | "refused"> {
  if (onMainnet) return countOnly("rpc", creditsOf(methods), !urgent && isBrowsing(methods));
  const cfg = underCap("rpc");
  if (cfg) return chargeShared("rpc", creditsOf(methods), urgent, cfg, cfg.block);
  return chargeMeter("rpc", creditsOf(methods), urgent);
}

/* The rpc meter by cost rather than by method names, for a reader that prices its own call (the history page). `browsing`: a list or a history read, the only kind a mainnet pin refuses (past the soft line). */
export async function chargeRpcCredits(cost: number, urgent = false, browsing = false): Promise<BudgetState | "refused"> {
  if (onMainnet) return countOnly("rpc", cost, !urgent && browsing);
  const cfg = underCap("rpc");
  if (cfg) return chargeShared("rpc", cost, urgent, cfg, cfg.block);
  return chargeMeter("rpc", cost, urgent);
}

/*
  Give back credits reserved for a call that turned out cheaper (a history
  page under 1,000 transactions). Under the shared cap they return to this
  instance's undrawn block, so the next calls draw them before the counter is
  asked again; on the Blob ledger they come off this instance's count; on a
  mainnet pin they come off the tally not yet sent (a tally already sent
  stays counted). Never below zero, never across a day: a refund after
  midnight is dropped.
*/
export function refundRpcCredits(credits: number, day?: string): void {
  if (!(credits > 0)) return;
  const now = clock();
  const l = ledgerOf("rpc", now);
  if (day !== undefined && day !== l.day) return;
  const n = Math.min(Math.floor(credits), l.local);
  if (n <= 0) return;
  l.local -= n;
  if (onMainnet) l.pending = Math.max(0, l.pending - n);
  else if (underCap("rpc")) l.block += n;
}

/* The price meter: external price reads, one credit each. A settled minute's candle is not urgent; the pre-seal check is, and on a mainnet pin it is counted and never refused. */
export function chargePrice(reads = 1, urgent = false): BudgetState | "refused" {
  return chargeMeter("price", reads, urgent, onMainnet && urgent);
}

/* The upload meter: one credit per picture stored (api/token), one line, the budget itself. A mainnet pin counts (the per-address upload limits in lib/rateLimit.ts stay); otherwise, under the shared cap, one picture reserved at a time on the meter's own key. */
export async function chargeUpload(pictures = 1): Promise<BudgetState | "refused"> {
  if (onMainnet) return countOnly("upload", pictures, false);
  const cfg = underCap("upload");
  if (cfg) return chargeShared("upload", pictures, true, cfg, pictures);
  return chargeMeter("upload", pictures, true);
}

function noteState(meter: Meter, l: Ledger, state: BudgetState, spent: number, limit: number): void {
  if (state === l.lastState) return;
  l.lastState = state;
  log(state === "ok" ? "info" : "error", { budget: { meter, day: l.day, state, spent, limit } });
}

/* The JSON-RPC method names in a request body, for the charge; an unreadable body is one call. */
export function methodsOf(body: BodyInit | null | undefined): string[] {
  try {
    const parsed: unknown = JSON.parse(typeof body === "string" ? body : String(body ?? ""));
    const list = Array.isArray(parsed) ? parsed : [parsed];
    const names = list.map((x) => (x as { method?: unknown } | null)?.method).filter((m): m is string => typeof m === "string");
    return names.length ? names : ["unknown"];
  } catch {
    return ["unknown"];
  }
}

/*
  The server's fetch to the keyed endpoint: charged first, refused with
  BudgetExhausted past its line. Urgent for a job whose own cadence bounds
  it (the volume cron); not urgent for a visitor's read. The global fetch is
  read at call time, so a check's stub is the one used.
  24e (the founder, 2026-10-25): a refusal for rate (HTTP 429) is waited out and
  asked again, up to RATE_RETRIES times after a random, growing wait (a
  quarter to half a second, then twice that, then twice again, or the
  Retry-After asked, at most 2 s), so a crowd refused together does not
  return together. Every attempt is charged. After the last, RateLimited is
  thrown, for the route to name as busy.
*/
const RATE_RETRIES = 3;
const RATE_WAIT_MS = 250;
const RATE_WAIT_MAX_MS = 2_000;
export function rateWaitMs(attempt: number, retryAfter: string | null, random: () => number = Math.random): number {
  const asked = Number(retryAfter);
  const base = asked > 0 ? Math.min(asked * 1000, RATE_WAIT_MAX_MS) : Math.min(RATE_WAIT_MS * 2 ** attempt, RATE_WAIT_MAX_MS);
  return base * (1 + random());
}
export function meteredFetchFor(urgent: boolean, wait: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms))): typeof fetch {
  return async (input, init) => {
    for (let attempt = 0; ; attempt++) {
      if ((await charge(methodsOf(init?.body), urgent)) === "refused") throw new BudgetExhausted();
      const res = await globalThis.fetch(input, init);
      if (res.status !== 429) return res;
      await res.body?.cancel().catch(() => undefined);
      if (attempt >= RATE_RETRIES) throw new RateLimited();
      await wait(rateWaitMs(attempt, res.headers.get("retry-after")));
    }
  };
}

export const meteredFetch: typeof fetch = meteredFetchFor(false);

/* ---- what the readers last served, for the degraded state ---- */

const kept = new Map<string, unknown>();
function keep(key: string, value: unknown): void {
  if (kept.size >= MAX_KEPT) {
    const oldest = kept.keys().next().value;
    if (oldest !== undefined) kept.delete(oldest);
  }
  kept.delete(key);
  kept.set(key, value);
}

/*
  A read that may be refused for the budget: the fresh value when the read
  runs, else what this instance last read for the key, marked stale, else
  the refusal itself. Anything that is not the budget's refusal is thrown as
  it came. `worth` says whether a value is worth keeping (a snapshot of an
  address that is no launch is not: a scan of addresses must not push the
  launches people watch out of the kept set).
*/
export async function staleOr<T extends { source: string }>(key: string, read: () => Promise<T>, worth: (v: T) => boolean = () => true): Promise<T> {
  try {
    const v = await read();
    if (worth(v)) keep(key, v);
    return v;
  } catch (e) {
    if (isBudgetExhausted(e) && kept.has(key)) return { ...(kept.get(key) as T), source: "stale" };
    throw e;
  }
}

/* ---- the shared ledgers in the Blob store ---- */

const hasStore = (l: Ledger, now: number): boolean => Boolean(process.env.BLOB_READ_WRITE_TOKEN) && now >= l.storeFailedUntil;
const prefix = (day: string, meter: Meter): string => `budget/${CLUSTER}/${day}/${meter}/`;
const SHARD = /\/([a-z0-9]+)-(\d+)\.json$/;

/* A store call with a deadline: one that never answers must not freeze this instance's sharing. */
function within<T>(p: Promise<T>, ms = STORE_MS): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      const e = new Error("the store did not answer in time");
      e.name = "TimeoutError";
      reject(e);
    }, ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

async function sync(meter: Meter, l: Ledger, now: number): Promise<void> {
  l.syncing = true;
  try {
    const blob = await import("@vercel/blob");
    const old = l.shard;
    const local = l.local;
    const path = `${prefix(l.day, meter)}${instance}-${local}.json`;
    await within(blob.put(path, JSON.stringify({ instance, meter, spent: local, at: now }), { access: "public", addRandomSuffix: false, allowOverwrite: true, contentType: "application/json", cacheControlMaxAge: 0 }));
    /* The day rolled while the store answered: this ledger is history, its shard outside today's prefix. */
    if (ledgers[meter] !== l) return;
    l.shard = path;
    if (old && old !== path) await within(blob.del(old)).catch(() => undefined);
    /* The highest spend per instance, never a sum: a shard's number is cumulative, and an orphan of this instance (a delete that failed) is removed on sight. */
    const best = new Map<string, number>();
    const orphans: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await within(blob.list({ prefix: prefix(l.day, meter), cursor, limit: 1000 }));
      for (const b of page.blobs) {
        const m = SHARD.exec(b.pathname);
        if (!m) continue;
        if (m[1] === instance) {
          if (b.pathname !== path) orphans.push(b.pathname);
          continue;
        }
        best.set(m[1], Math.max(best.get(m[1]) ?? 0, Number(m[2])));
      }
      cursor = page.hasMore ? page.cursor : undefined;
    } while (cursor);
    if (ledgers[meter] !== l) return;
    let others = 0;
    for (const v of best.values()) others += v;
    l.others = others;
    l.syncedAt = now;
    l.syncedLocal = local;
    for (const o of orphans) await within(blob.del(o)).catch(() => undefined);
    const limit = limitOf(meter);
    log("info", { budget: { meter, day: l.day, spent: l.local + l.others, limit, state: stateOf(l.local + l.others, limit, softOf(limit)), instance: local, instances: best.size + 1 } });
  } catch (e) {
    /* The store is the volume job's; without it the instance counts alone for a while and says so once. */
    l.storeFailedUntil = clock() + STORE_RETRY_MS;
    log("error", { budget: "the shared ledger could not be reached; this instance counts alone for a while", meter, why: noteOf(e) });
  } finally {
    l.syncing = false;
  }
}

async function removeShard(path: string): Promise<void> {
  try {
    const blob = await import("@vercel/blob");
    await within(blob.del(path));
  } catch {
    /* yesterday's shard stays; it is outside today's prefix */
  }
}

/* For a check: start the day over on every meter, with an optional clock and an optional pin kind, and forget what was kept. */
export function resetBudget(opts: { now?: () => number; mainnet?: boolean } = {}): void {
  clock = opts.now ?? Date.now;
  onMainnet = opts.mainnet ?? isMainnet(CLUSTER);
  const day = dayOf(clock());
  ledgers.rpc = fresh(day);
  ledgers.price = fresh(day);
  ledgers.upload = fresh(day);
  kept.clear();
}
