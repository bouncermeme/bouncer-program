/*
  Clearing price and fills: the crate's settle and fill
  (crates/auction-core/src/clearing.rs) at INTERFACE v0.29, in BigInt. The
  crate is the reference; when this file and the crate disagree, this file
  has the bug. scripts/check-clearing.ts pins the fixtures of the migration
  checklist (N-11), which the crate's tests hold, and runs the invariants
  (N-12) on random books over the whole grid.

  The input is the reveal histogram H[k] (deposits summed per tick), not the
  bid list. With F the float and V the float's value at the clearing tick:

  - The clearing tick k* is the highest tick in 0..=MAX_TICK (2406 since 0.29) with
    cum(k) >= value_at_tick(k), where cum(k) is the sum of H[j] for j >= k.
    If no tick qualifies, not even the floor, the launch fails: nothing is
    sold, no record is written, every deposit is refunded in full, the whole
    supply burns. There is no cap tick and no ceiling (N-06; INTERFACE v0.15
    removed the cap, the founder: no limit of any kind).
  - The marginal tick m is the lowest tick at or above k* whose strictly
    higher deposits A = cum(m + 1) are under V. Usually m == k*; higher only
    when the bids above k* alone cover V. T = H[m], and A + T >= V (N-07).
  - A bid at t > m fills in full: tokens = floor(d * F / V), cost = d,
    refund 0 (N-08).
  - A bid at t == m shares the remainder pro rata, with R = F - ceil(A * F / V):
    tokens = floor(d * R / T), cost = ceil(d * (V - A) / T), refund = d - cost
    (N-09).
  - A bid at t < m, including one at or above k* but below m (it bid the
    clearing price and the maximums above it took the whole float first), and
    every invalid bid: tokens 0, the whole deposit back (N-10).

  Rounding, exactly as the crate: token amounts round down, costs round up.
  So sum(tokens) is within one atom per filled bidder of F (the remainder
  burns at finalize, SettlementRecord.burned_tokens) and sum(cost) is between
  V and V plus one lamport per marginal bidder (the excess is dust swept at
  finalize). V funds the pool (all of it until 0.27; since 0.28 V less the raise fee paid, pool_sol_in).

  This is a prediction of what the chain will do, byte for byte in BigInt.
  It is not the source of truth. The chain is, and the settlement record is
  compared to this prediction on every settled launch (N-12, X-04).
*/

import { MAX_TICK, TICK_COUNT, validateFloorValue, valueAtTick } from "./grid";

export interface Clearing {
  /* Clearing tick k*. Sets the one price everyone pays. */
  tick: number;
  /* Marginal tick m, at least k*. Bids above it fill in full, bids at it are rationed, bids below it get nothing. */
  marginalTick: number;
  /* Lamports the whole float is worth at k*. The clearing price is floatValue / float. What the winners paid in all: the pool's funding (less the raise fee paid, since 0.28). */
  floatValue: bigint;
  /* Sum of deposits at or above k*. At least floatValue. Informational. */
  winningDeposits: bigint;
  /* Sum of deposits strictly above m. Under floatValue. These fill in full. */
  aboveDeposits: bigint;
  /* Sum of deposits at m. With aboveDeposits, at least floatValue. */
  atDeposits: bigint;
  /* Float in token atoms, carried so fill cannot be called with a different one. */
  float: bigint;
}

export interface Fill {
  tokens: bigint;
  cost: bigint;
  refund: bigint;
}

/* The clearing, or null when the launch failed: no tick, not even the floor, is covered. The crate's settle. */
export function findClearing(depositsAtTick: readonly bigint[], floorValue: bigint, float: bigint): Clearing | null {
  validateFloorValue(floorValue);
  if (float <= 0n) throw new RangeError("zero float");
  if (depositsAtTick.length !== TICK_COUNT) throw new RangeError(`histogram must have ${TICK_COUNT} ticks`);
  let cum = 0n;
  for (let k = MAX_TICK; k >= 0; k--) {
    cum += depositsAtTick[k];
    const v = valueAtTick(floorValue, k);
    if (cum < v) continue;
    /* k is k*. Walk up from it until the deposits strictly above the candidate no longer cover V on their own. Ends by MAX_TICK, where nothing is above. */
    let m = k;
    let above = cum - depositsAtTick[k];
    while (above >= v) {
      m += 1;
      above -= depositsAtTick[m];
    }
    return { tick: k, marginalTick: m, floatValue: v, winningDeposits: cum, aboveDeposits: above, atDeposits: depositsAtTick[m], float };
  }
  return null;
}

/* One bid's fill from the clearing, the way deliver and claim compute it. */
export function fill(deposit: bigint, tick: number, c: Clearing): Fill {
  if (!Number.isInteger(tick) || tick < 0 || tick > MAX_TICK) throw new RangeError("tick out of range");
  const v = c.floatValue;
  const a = c.aboveDeposits;
  const t = c.atDeposits;
  if (v === 0n || a >= v || c.marginalTick < c.tick || a + t < v || c.winningDeposits < v) {
    throw new RangeError("not a clearing settle produced");
  }
  if (tick < c.marginalTick) return { tokens: 0n, cost: 0n, refund: deposit };
  if (tick > c.marginalTick) return { tokens: (deposit * c.float) / v, cost: deposit, refund: 0n };
  const taken = ceilDiv(a * c.float, v);
  const remaining = c.float - taken;
  const tokens = (deposit * remaining) / t;
  const cost = ceilDiv(deposit * (v - a), t);
  return { tokens, cost, refund: deposit - cost };
}

export function ceilDiv(n: bigint, d: bigint): bigint {
  if (d === 0n) throw new RangeError("division by zero");
  const q = n / d;
  return n % d === 0n ? q : q + 1n;
}

/* Build the histogram the program keeps, from a list of revealed (tick, deposit) pairs. */
export function histogram(revealed: Iterable<{ tick: number; deposit: bigint }>): bigint[] {
  const h: bigint[] = new Array(TICK_COUNT).fill(0n);
  for (const b of revealed) {
    if (!Number.isInteger(b.tick) || b.tick < 0 || b.tick > MAX_TICK) throw new RangeError("tick out of range");
    h[b.tick] += b.deposit;
  }
  return h;
}
