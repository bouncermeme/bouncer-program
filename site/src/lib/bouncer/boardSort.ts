import type { PoolMcap, Volume } from "./market";
import type { Launch } from "./types";
import { bookOpen, hasRecord, isOver, recoverable } from "./view";
import { tickerKey } from "./tickerKey";

/*
  The Closed board's order (the founder, 2026-10-15). Three sorts, chosen on the
  board: New (the default), Highest market cap, Highest volume 24h. All
  three order what the board has already read: open_ts from the launch
  account, the pools' market caps (usePoolMcaps) and the 24-hour volumes
  (useVolumes) that the cards show anyway. Choosing a sort reads nothing.

  In every sort a launch still being processed comes first, newest first:
  a settlement in flight is the one thing on the Closed board that moves.
  Then the launches with the chosen figure, largest first; then the rest
  (no pool, a pool not yet read, or one that could not be read), newest
  first. Under New the figure is open_ts itself, so there is no tail.
*/
export type BoardSort = "new" | "mcap" | "volume" | "raise";

export const BOARD_SORTS: ReadonlyArray<{ id: BoardSort; label: string }> = [
  { id: "new", label: "New" },
  { id: "mcap", label: "Market Cap" },
  { id: "volume", label: "Volume" },
  { id: "raise", label: "Highest raise" },
];
/*
  24o (the founder's approved mock, 2026-10-26): Highest raise, by the figure the card shows as Raised, the record's
  float_value (what the winning bids paid, before the raise fee), largest first, compared as lamports. The definition
  and the board it covers (Recently cleared only) are as the founder confirmed (review/2026-10-27-24o-NEEDS-FOUNDER.md, Q1 and
  Q2 A, 2026-10-26). A launch whose record has not been read yet goes after the rest, newest first.
*/
/* 24n (the founder, 2026-10-26): the dropdown's words, "New", "Market Cap", "Volume" (were "Highest market cap", "Highest volume 24h"); the orders are unchanged. */

export const BOARD_SORT_DEFAULT: BoardSort = "new";

/* The browser's remembered choice (localStorage), read and written inside try/catch. */
export const BOARD_SORT_KEY = "bouncer:board-sort";

export function isBoardSort(x: unknown): x is BoardSort {
  return x === "new" || x === "mcap" || x === "volume" || x === "raise";
}

export interface BoardFigures {
  /* By launch id; null until the first read lands. */
  mcaps: Map<string, PoolMcap> | null;
  /* By pool address. */
  volumes: Map<string, Volume>;
}

/* A launch that has stopped taking bids but has no outcome yet (bids opening, the clearing cap, the pool), and is not past its recovery deadline. */
export function isProcessing(l: Launch, nowSec: number | null): boolean {
  return !isOver(l.account.state) && !hasRecord(l.account.state) && !(nowSec != null && recoverable(l.account, nowSec));
}

/* The pool's market cap in lamports, or null when there is no pool or it has not been read. */
export function mcapFigure(l: Launch, mcaps: Map<string, PoolMcap> | null): bigint | null {
  const pool = l.record?.pool;
  if (!pool || !mcaps) return null;
  return mcaps.get(l.id)?.mcapLamports ?? null;
}

/* The 24-hour volume as one number: dollars on mainnet, lamports off it (one kind per cluster, so the figures compare). Null while loading or unavailable. */
export function volumeFigure(l: Launch, volumes: Map<string, Volume>): number | null {
  const pool = l.record?.pool;
  if (!pool) return null;
  const v = volumes.get(pool);
  if (!v) return null;
  if (v.kind === "usd") return v.usd24;
  if (v.kind === "sol") return Number(v.lamports24);
  return null;
}

const newest = (x: Launch, y: Launch) => y.account.openTs - x.account.openTs;

/* The raise in lamports (the card's Raised), or null while the record has not been read. */
export function raiseFigure(l: Launch): bigint | null {
  return l.record ? l.record.floatValue : null;
}

export function sortClosed(launches: Launch[], mode: BoardSort, nowSec: number | null, figures: BoardFigures): Launch[] {
  const figure = (l: Launch): bigint | number | null => (mode === "mcap" ? mcapFigure(l, figures.mcaps) : mode === "volume" ? volumeFigure(l, figures.volumes) : mode === "raise" ? raiseFigure(l) : l.account.openTs);
  return launches.slice().sort((x, y) => {
    const px = isProcessing(x, nowSec);
    const py = isProcessing(y, nowSec);
    if (px !== py) return px ? -1 : 1;
    if (px) return newest(x, y);
    const fx = figure(x);
    const fy = figure(y);
    if (fx !== null && fy !== null) {
      if (fy > fx) return 1;
      if (fy < fx) return -1;
      return newest(x, y);
    }
    if (fx !== null) return -1;
    if (fy !== null) return 1;
    return newest(x, y);
  });
}

/*
  Your launches (the founder, 2026-10-18): every launch the connected wallet
  created (Launch.creator), from the board's own list, so it costs no read;
  newest first. No wallet, no launches. The How and create pages' "Claim
  fees" links land on it by this anchor.
*/
export const YOUR_LAUNCHES_ANCHOR = "your-launches";

export function createdBy(launches: Launch[], wallet: string | null): Launch[] {
  if (!wallet) return [];
  return launches.filter((l) => l.account.creator === wallet).sort((x, y) => y.account.openTs - x.account.openTs);
}

/*
  Board hygiene (2026-10-20, the adversarial pass's S2, docs/ADVERSARIAL-
  GRIEFING-2026-10-20.md sections 2 and 5e): a launch costs about 0.07 SOL,
  so a run of junk launches is cheap. Display only; nothing on chain changes
  and nobody is kept from launching.
  - Live now: the launches someone has bid on first, then the rest, each
    soonest to close first (a fresh honest launch has no bid either, so it
    is ordered after, never hidden); the board shows a page at a time, so
    a thousand open launches mount a dozen cards, not a thousand.
  - Did not clear: a launch that ended with no bid at all has nothing to
    refund and nothing to see; those stay out of the list behind their own
    button.
  - Every card names its creator and, past one, how many launches that
    creator has on the board; a ticker or name that other launches on the
    board also use is said on the card.
*/
export function liveOrder(open: Launch[], closeAt: (l: Launch) => number): Launch[] {
  const soonest = (x: Launch, y: Launch) => closeAt(x) - closeAt(y);
  return [...open.filter((l) => l.account.bidCount > 0).sort(soonest), ...open.filter((l) => l.account.bidCount === 0).sort(soonest)];
}

export function splitDead(dead: Launch[]): { withBids: Launch[]; noBids: Launch[] } {
  return { withBids: dead.filter((l) => l.account.bidCount > 0), noBids: dead.filter((l) => l.account.bidCount === 0) };
}

export interface BoardFacts {
  /* Launches on the board by creator address. */
  byCreator: Map<string, number>;
  /* Launches on the board by ticker, compared on the creation permit's key (tickerOf). */
  byTicker: Map<string, number>;
  /* v0.30 item 8: the launches themselves by ticker, for the notice's rule (sameNameOthers). */
  tickerLaunches: Map<string, Launch[]>;
  /* The page's clock and the admin's hidden directions (hiddenPairs.ts), when the page has them. */
  nowSec?: number | null;
  hidden?: ReadonlySet<string>;
}

const norm = (s: string) => s.trim().toLowerCase();
/*
  The ticker as the creation permit compares it (the founder's final rule, 2026-10-27: the reserved-ticker normalization,
  tickerKey.ts: case, look-alike characters, repeats), so P3P3 and PEPE are one ticker here too. A ticker outside the
  permit's alphabet (a launch from before the rule) keeps its plain comparison; an empty one matches nothing.
*/
export const tickerOf = (symbol: string): string => tickerKey(symbol.trim()) ?? (norm(symbol) ? `raw:${norm(symbol)}` : "");

/*
  Launch search (the founder, 2026-10-30, approved as mocked: review/2026-10-30-launch-search): where a launch stands for a
  query, or null when it does not match. Reads nothing: the board's own list. Lower is first; a board keeps its own
  order within a rank. No mark says original or copycat (the founder): the board's order puts the holder first.
    0  the ticker as typed (letter case and a leading $ ignored)
    1  the same ticker by the creation rule's key (tickerOf: 0WL finds OWL, BRL1 finds BRR1)
    2  part of the ticker or of the name (a name is matched, never flagged: the founder, 2026-10-27)
    3  the start of the launch's, the mint's or the creator's full address (4 characters or more, exact case), or a
       card's own short form "AbCd…WxYz"
*/
const B58 = "[1-9A-HJ-NP-Za-km-z]";
/* A card's short form of an address ("AbCd…WxYz", or three dots), and the start of one (4 characters or more). */
const SHORT_FORM = new RegExp(`^(${B58}{3,})(?:…|\\.\\.\\.)(${B58}{3,})$`);
const ADDRESS_START = new RegExp(`^${B58}{4,44}$`);
/* The query as matched: trimmed, with a leading $ dropped (a ticker is often typed $OWL). Empty means no search, so a
   lone $ (the first key of $OWL) leaves the boards as they are. */
export const searchText = (query: string): string => query.trim().replace(/^\$/, "").trim();
export function searchRank(l: Launch, query: string): number | null {
  const q = searchText(query);
  if (!q) return 0;
  const lower = q.toLowerCase();
  const sym = norm(l.token.symbol);
  if (sym && sym === lower) return 0;
  const key = tickerKey(q.replace(/[^A-Za-z0-9]/g, ""));
  if (key && key === tickerOf(l.token.symbol)) return 1;
  if ((sym && sym.includes(lower)) || norm(l.token.name).includes(lower)) return 2;
  const addresses = [l.id, l.account.tokenMint, l.account.creator];
  const short = q.match(SHORT_FORM);
  if (short && addresses.some((a) => a.startsWith(short[1]) && a.endsWith(short[2]))) return 3;
  if (ADDRESS_START.test(q) && addresses.some((a) => a.startsWith(q))) return 3;
  return null;
}

/* A board's launches that match, ticker matches first, the board's own order kept within each rank. */
export function searchBoard(launches: Launch[], query: string): Launch[] {
  return launches
    .map((l, i) => ({ l, i, r: searchRank(l, query) }))
    .filter((x) => x.r !== null)
    .sort((x, y) => x.r! - y.r! || x.i - y.i)
    .map((x) => x.l);
}

type SearchedBoards = Record<"live" | "cleared" | "dead" | "my" | "created", Launch[]>;
/*
  The home boards for a query: each board keeps only its matches (searchBoard), and `matched` counts the launches that
  match across the whole list, each once. Everything else in `groups` (the cards' facts) passes through untouched, so
  a card's creator count and ticker note stay the whole board's whatever the query.
*/
export function searchGroups<G extends SearchedBoards>(groups: G, all: readonly Launch[], query: string): G & { matched: number } {
  if (!searchText(query)) return { ...groups, matched: all.length };
  const find = (ls: Launch[]) => searchBoard(ls, query);
  return { ...groups, live: find(groups.live), cleared: find(groups.cleared), dead: find(groups.dead), my: find(groups.my), created: find(groups.created), matched: all.filter((l) => searchRank(l, query) !== null).length };
}

export function boardFacts(launches: Launch[]): BoardFacts {
  const byCreator = new Map<string, number>();
  const byTicker = new Map<string, number>();
  const tickerLaunches = new Map<string, Launch[]>();
  const add = (m: Map<string, number>, k: string) => {
    if (k) m.set(k, (m.get(k) ?? 0) + 1);
  };
  const push = (m: Map<string, Launch[]>, k: string, l: Launch) => {
    if (k) m.set(k, [...(m.get(k) ?? []), l]);
  };
  for (const l of launches) {
    add(byCreator, l.account.creator);
    add(byTicker, tickerOf(l.token.symbol));
    push(tickerLaunches, tickerOf(l.token.symbol), l);
  }
  return { byCreator, byTicker, tickerLaunches };
}

/*
  v0.30 item 8 and the final ticker rule (the founder, 2026-10-27, review/2026-10-27-v030/FOUNDER-UI-DECISIONS.md, "TICKER
  RULE, FINAL"): tickers are unique, enforced by the creation permit; a ticker is released only when its launch fails,
  so two launches can share a ticker only after a failure (or by the admin's approved reuse, server/tickerAdmin.ts).
  The notice shows only in that first case, and only on the new launch: it names the earlier launches with this
  ticker that failed. This is the creation gate's own rule
  (server/ticker.ts launchHold: null), read from the board's list: Failed, Aborted, Finalized without a pool, or
  Initializing past its window. A record not read yet counts as no pool, so the notice shows (the safe side).
*/
export function freedByFailure(l: Launch, nowSec: number | null): boolean {
  const a = l.account;
  if (a.state === "failed" || a.state === "aborted") return true;
  if (a.state === "finalized") return !l.record?.pool;
  if (a.state === "initializing") return nowSec != null && nowSec >= a.openTs + a.windowSecs;
  return false;
}

/*
  The other launches this one's notice names, by the rule above: earlier launches with this ticker (tickerOf) that
  failed, never one the admin hid for this launch (8C: hidden entirely; `hidden` holds "<launch>><other>",
  app/api/names). The failed launch itself names nobody. The coin's name is never compared (the founder, 2026-10-27).
*/
export function sameNameOthers(l: Launch, ticker: readonly Launch[], opts: { nowSec: number | null; hidden?: ReadonlySet<string> }): { by: "ticker" | null; launches: Launch[] } {
  const named = ticker.filter((x) => x.id !== l.id && !opts.hidden?.has(`${l.id}>${x.id}`) && x.account.openTs < l.account.openTs && freedByFailure(x, opts.nowSec));
  return named.length > 0 ? { by: "ticker", launches: named.sort((x, y) => y.account.openTs - x.account.openTs) } : { by: null, launches: [] };
}

/* What a card says about its launch's neighbours: the creator's count on the board, and how many other launches its notice names by ticker. */
export function cardFacts(facts: BoardFacts | null | undefined, l: Launch, opts: { nowSec: number | null; hidden?: ReadonlySet<string> } = { nowSec: null }): { creatorLaunches: number; sameTicker: number } {
  if (!facts) return { creatorLaunches: 1, sameTicker: 0 };
  /* v0.30 item 8: the card's note follows the launch page's notice (sameNameOthers). */
  const c = sameNameOthers(l, facts.tickerLaunches.get(tickerOf(l.token.symbol)) ?? [], opts);
  return { creatorLaunches: facts.byCreator.get(l.account.creator) ?? 1, sameTicker: c.launches.length };
}

/*
  The launch page's creator panel and copycat line (the founder, 2026-10-20), from
  the same list the board reads (useLaunchList) and by the board's own
  rules: the outcome by the sections the board files a launch under, the
  repeated ticker by cardFacts' comparison.
*/
export type LaunchOutcome = "live" | "processing" | "cleared" | "failed" | "aborted";

export function outcomeOf(l: Launch, nowSec: number | null): LaunchOutcome {
  const a = l.account;
  if (nowSec != null ? bookOpen(a, nowSec) : a.state === "open") return "live";
  if (isProcessing(l, nowSec)) return "processing";
  if (hasRecord(a.state) && l.recordExists && !(nowSec != null && recoverable(a, nowSec))) return "cleared";
  return a.state === "aborted" ? "aborted" : "failed";
}

/* The creator's other launches on the board, newest first. */
export function otherLaunchesBy(launches: Launch[], l: Launch): Launch[] {
  return createdBy(launches, l.account.creator).filter((x) => x.id !== l.id);
}

/* The other launches this one's notice names (the card's rule: matching tickers only; v0.30 item 8, sameNameOthers), newest first. */
export function copycatsOf(launches: Launch[], l: Launch, opts: { nowSec: number | null; hidden?: ReadonlySet<string> } = { nowSec: null }): { by: "ticker" | null; launches: Launch[] } {
  const k = tickerOf(l.token.symbol);
  const ticker = k === "" ? [] : launches.filter((x) => tickerOf(x.token.symbol) === k);
  return sameNameOthers(l, ticker, opts);
}
