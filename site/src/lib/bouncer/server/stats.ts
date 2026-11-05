/*
  /stats: Bouncer in numbers (22e3, the founder 2026-10-23: its own page, linked from the footer, not the home page; 23c:
  classified by pool status, refunds split; review/2026-10-24-23c-morning/DESIGN.md section 10). Every figure is a
  sum over the chain index (server/chainIndex.ts), current-layout accounts only:
  - Launches: every launch. Cleared ones are funded: create_pool wrote SettlementRecord.pool (PoolLive, or Finalized
    with a pool; server/ticker.ts isFunded). A record alone is not cleared (settle, then abort).
  - Raised: the winners' SOL of cleared launches (SettlementRecord.float_value).
  - Locked forever: the SOL the pool opened with (pool_sol_at_open), held by the permanent lock.
  - Refunded, in three parts, refundable amounts (not a count of claims: the chain keeps no per-bid payout tally
    without reading every bid):
      losing bids      deposits of the bids that did not win, on cleared launches: total_deposits less the deposits
                       above and at the marginal tick (24c, fresh L7: bids from the clearing tick up to the marginal
                       one are refunded in full, so they are losing bids, though winning_deposits counts them)
      winners' change  what the winners deposited over what they paid: above_deposits + at_deposits - float_value
      failed launches  every deposit of a launch that ended without a pool (Failed, Aborted, Finalized without one)
  - To creators: the creators' part of the raise fee (raise_fee_creator), 0.6% of the raise on the mainnet terms.
  A live launch counts as a launch only. Lamports throughout; the page shows SOL.
  24c (fresh I8): every launch is in one bucket. Initializing past its window's end on the snapshot's clock can only
  abort, so it counts as ended (it took no bids), as the ticker rules hold it (ticker.ts launchHold). PoolLive whose
  record this read did not carry (read at another slot) is cleared, its figures added when the record is read.
*/
import type { ChainIndex } from "./chainIndex";
import { isFunded, windowEnd } from "./ticker";

export interface StatsTotals {
  launches: number;
  cleared: number;
  /* Ended with no pool: Failed, Aborted, or Finalized without a pool. */
  ended: number;
  live: number;
  bids: number;
  raised: bigint;
  locked: bigint;
  refunded: bigint;
  refundLosing: bigint;
  refundChange: bigint;
  refundFailed: bigint;
  toCreators: bigint;
}

const LIVE = new Set(["initializing", "open", "closed", "settled"]);
const pos = (a: bigint, b: bigint): bigint => (a > b ? a - b : 0n);

export function statsOf(index: Pick<ChainIndex, "launches" | "records"> & { blockTime?: number | null }): StatsTotals {
  const t: StatsTotals = { launches: 0, cleared: 0, ended: 0, live: 0, bids: 0, raised: 0n, locked: 0n, refunded: 0n, refundLosing: 0n, refundChange: 0n, refundFailed: 0n, toCreators: 0n };
  for (const l of index.launches) {
    if (l.layout === "legacy") continue;
    t.launches += 1;
    t.bids += l.bidCount;
    const r = index.records.get(l.address);
    const pastWindow = l.state === "initializing" && typeof index.blockTime === "number" && index.blockTime >= windowEnd(l);
    if (isFunded(l, r)) {
      t.cleared += 1;
      if (!r) continue;
      const filled = r.aboveDeposits + r.atDeposits;
      t.raised += r.floatValue;
      t.locked += r.poolSolAtOpen;
      t.toCreators += r.raiseFeeCreator;
      t.refundLosing += pos(l.totalDeposits, filled);
      t.refundChange += pos(filled, r.floatValue);
    } else if (l.state === "failed" || l.state === "aborted" || l.state === "finalized" || pastWindow) {
      t.ended += 1;
      t.refundFailed += l.totalDeposits;
    } else if (LIVE.has(l.state)) t.live += 1;
  }
  t.refunded = t.refundLosing + t.refundChange + t.refundFailed;
  return t;
}
