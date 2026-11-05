/*
  The copycat rules on the chain's side (23c, policy t2; review/2026-10-24-23c-morning/DESIGN.md section 3). Pure: a
  launch in a finalized snapshot (server/chainIndex.ts) holds its ticker key, or does not. The reservations an issued
  permit commits before any launch lands are server/reservations.ts; the two together decide (tickerGate there).

  | The launch in the snapshot                                             | Its key                       |
  | Initializing, while the snapshot's time is before the window's end     | live (it can still activate)  |
  | Open, Closed or Settled                                                | live (settled is not funded)  |
  | PoolLive, or Finalized with record.pool set                            | funded: forever               |
  | Failed, Aborted, Finalized without a pool, Initializing past its window | free at once                  |

  - The window's end is open_ts + window_secs (the program's window_params().close_ts(); the close_ts field reads 0
    until the launch closes). The snapshot's time is its finalized block time, never the server's clock.
  - No creator is exempt: their own pending, live or funded launch holds against them too. After a failure the key is
    free for everyone, the creator included (a relaunch is a new launch address).
  - A funded hold is released only by an entry naming that one launch: in content/tickerReleases.ts, or an admin
    release in the store (server/tickerAdmin.ts, read by reservations.ts storeReleases). Never a live launch, never a
    ticker-wide release (another launch with the key holds again).
  - Devnet's 0.28 launches (layout "legacy") have no readable pool: their PoolLive holds, their Finalized does not
    (DESIGN.md D3). Mainnet refuses any snapshot with an unreadable launch (chainIndex.ts readTickerIndex).
*/
import { TICKER_RELEASES, type TickerRelease } from "@/content/tickerReleases";
import type { ChainIndex, IndexedLaunch, IndexedRecord } from "./chainIndex";

export type ChainHold = "live" | "funded";

/* The window's end, as the program reads it. */
export const windowEnd = (l: Pick<IndexedLaunch, "openTs" | "windowSecs">): number => l.openTs + l.windowSecs;

/* Whether create_pool wrote the pool (the funding evidence). A legacy launch's record is not read: only PoolLive counts. */
export function isFunded(l: IndexedLaunch, rec: IndexedRecord | undefined): boolean {
  if (l.state === "poolLive") return true;
  return l.state === "finalized" && l.layout === "current" && rec?.funded === true;
}

/* One launch's hold on its key at the snapshot's time, before any release. */
export function launchHold(l: IndexedLaunch, rec: IndexedRecord | undefined, snapshotTime: number): ChainHold | null {
  if (l.state === "initializing") return snapshotTime < windowEnd(l) ? "live" : null;
  if (l.state === "open" || l.state === "closed" || l.state === "settled") return "live";
  return isFunded(l, rec) ? "funded" : null;
}

/* A release entry applies to exactly its launch, and only to a funded hold. */
export const releasedBy = (l: IndexedLaunch, releases: readonly TickerRelease[]): TickerRelease | null => releases.find((r) => r.launch === l.address && r.key === l.key) ?? null;

export interface KeyStatus {
  hold: ChainHold | null;
  /* P-T2 (the founder, 2026-10-27): a funded hold whose launch is paying out (v0.30: PoolLive, trading_state 1), so the refusal says so. */
  paying: boolean;
  /* Every launch in the snapshot with this key (for the reservation's reconciliation). */
  launches: IndexedLaunch[];
  /* Release entries that named a launch with this key that is not funded (ignored; the caller logs them). */
  ignoredReleases: TickerRelease[];
}

/* The chain's hold on `key`: live beats funded; null when every launch with the key is free. */
export function chainHold(key: string, index: Pick<ChainIndex, "launches" | "records" | "blockTime">, releases: readonly TickerRelease[] = TICKER_RELEASES): KeyStatus {
  const t = index.blockTime ?? 0;
  const launches = index.launches.filter((l) => l.key === key);
  let hold: ChainHold | null = null;
  let paying = false;
  const ignoredReleases: TickerRelease[] = [];
  for (const l of launches) {
    const h = launchHold(l, index.records.get(l.address), t);
    const rel = releasedBy(l, releases);
    if (rel && h !== "funded") ignoredReleases.push(rel);
    if (h === "funded" && rel) continue;
    if (h === "live") hold = "live";
    else if (h === "funded" && hold === null) hold = "funded";
    if (h === "funded" && l.state === "poolLive" && l.tradingState === 1) paying = true;
  }
  return { hold, launches, ignoredReleases, paying };
}

/* Whether this one launch frees its key at the snapshot (failed, aborted, unfunded, past its window, or released). */
export function launchFrees(l: IndexedLaunch, index: Pick<ChainIndex, "records" | "blockTime">, releases: readonly TickerRelease[] = TICKER_RELEASES): boolean {
  const h = launchHold(l, index.records.get(l.address), index.blockTime ?? 0);
  return h === null || (h === "funded" && releasedBy(l, releases) !== null);
}

/* A creator's ended launches with no bid at all (the CREATOR_ZERO_BID_REPEAT line at 2 or more). */
export function zeroBidEnded(creator: string, index: Pick<ChainIndex, "launches" | "records" | "blockTime">): number {
  let n = 0;
  for (const l of index.launches) {
    if (l.creator !== creator || l.layout !== "current" || l.bidCount !== 0) continue;
    if (launchHold(l, index.records.get(l.address), index.blockTime ?? 0) === null) n += 1;
  }
  return n;
}
export const ZERO_BID_REPEAT = 2;
