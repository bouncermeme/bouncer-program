/*
  Derived numbers the pages show. Pure functions over the account shapes.
  Anything that turns atoms and ticks into something a person reads lives here.
*/

import { POOL_RESERVE, TOKEN_DECIMALS, WINDOW } from "@contract/constants";
import { ceilDiv, fill, type Clearing, type Fill } from "./clearing";
import { atomsToNumber, SOL_DECIMALS } from "./format";
import { valueAtTick } from "./grid";
import type { BidAccount, Launch, LaunchAccount, LaunchState, SettlementRecord } from "./types";

/*
  Window rules: the creator picks 5 to 60 minutes and the window is fixed once
  set. No early close, no extension. The bounds come from the contract.
*/
export const WINDOW_MIN_SECS: number = WINDOW.minWindowSecs;
export const WINDOW_MAX_SECS: number = WINDOW.maxWindowSecs;
export const WINDOW_DEFAULT_SECS: number = WINDOW.defaultWindowSecs;

/*
  v0.31 (idl/INTERFACE-v0.31-NOTE.md): create_launch takes the absolute close, and the window it lands with is that
  close less the landing clock. The program accepts 240 s to 3,600 s at landing (crates/auction-core close.rs
  MIN_WINDOW_AT_LANDING_SECS: the 5 minute minimum less the 60 s approval grace); under 240 it refuses CloseTooSoon.
*/
export const WINDOW_AT_LANDING_MIN_SECS = 240;

/*
  The 60 minute ceiling has no grace: a close a full 3,600 s past this device's clock is refused InvalidWindow when
  the cluster clock runs behind it (devnet's beacons read 2 to 3 s behind on 2026-10-28), so a close is never set
  closer than this to the ceiling. A 60 minute window closes 20 s early; every shorter one is exact.
*/
export const CLOSE_CEILING_HEADROOM_SECS = 20;

/* v0.31: the close create_launch carries for a window picked now (unix seconds, this device's clock). */
export function closeTsFor(windowSecs: number, nowSec: number): number {
  return nowSec + Math.min(windowSecs, WINDOW_MAX_SECS - CLOSE_CEILING_HEADROOM_SECS);
}

/* When the book closes: open_ts + window_secs on the cluster clock. */
export function closeAtTs(a: LaunchAccount): number {
  return a.openTs + a.windowSecs;
}

/*
  Whether a bid can still land, by the clock, not by the state byte. The book
  closes at close_at whatever the state reads: the close instruction is
  cosmetic for a launch above the floor, and a commit after close_at closes
  the book instead of placing a bid (checklist S-02, S-03).
*/
export function bookOpen(a: LaunchAccount, nowSec: number): boolean {
  return a.state === "open" && nowSec < closeAtTs(a);
}

export function isOver(state: LaunchState): boolean {
  return state === "finalized" || state === "aborted" || state === "failed";
}

/* Refunds in progress: failed or aborted, not yet burned. */
export function isRefunding(state: LaunchState): boolean {
  return state === "failed" || state === "aborted";
}

/* Did the launch end without a sale, at any point after: refunding, or finalized with no record (every refund out, supply burned). No token in anyone's hands either way. */
export function endedWithoutSale(launch: Launch): boolean {
  const s = launch.account.state;
  return isRefunding(s) || (s === "finalized" && !launch.recordExists);
}

/*
  When abort may first be called: abort_after_secs after the window end while
  Open or Closed; after the settlement's timestamp while Settled (checklist
  T-06). Pass the record's settledTs once the launch has one.
*/
/*
  The recovery deadline (0.22): the scheduled close plus the valve, all
  copied onto the launch at genesis, so it is fixed from creation and the same
  in every state. From it on nothing moves the launch forward, and any
  bidder's refund or claim cancels it and pays that bidder in one step.
*/
export function recoveryDeadline(a: LaunchAccount): number {
  return closeAtTs(a) + a.abortAfterSecs;
}

/* Whether a launch that never reached its pool is past its deadline, so its deposits can be recovered. */
export function recoverable(a: LaunchAccount, nowSec: number): boolean {
  /* 0.29: abort accepts an Initializing launch at the deadline too, and burn_unsold then returns its prepay. */
  return (a.state === "initializing" || a.state === "open" || a.state === "closed" || a.state === "settled") && nowSec >= recoveryDeadline(a);
}

/* 0.29, the seventh candidate: created without its grow (state Initializing) and still inside its window, so its creator can finish it. */
export function setupFinishable(a: LaunchAccount, nowSec: number | null): boolean {
  return a.state === "initializing" && (nowSec == null || nowSec < closeAtTs(a));
}

/*
  The mint exists and the pool is open for it: the state says so (pool live),
  or the launch is finalized with a record. Before this there is no token to
  trade or to show. Used by the pages (through ShareSlot) and by the server's
  share facts, which decide whether /launch/<id> lands on trading.
*/
/* v0.30: where create_pool pays the raise fee's platform part: the treasury the launch recorded, or lp_owner on a launch created before 0.30 (lib.rs create_pool; WrongTreasury 6090). */
export function poolTreasury(a: LaunchAccount): string {
  return a.treasury ?? a.lpOwner;
}

export function mintIsLive(launch: Launch): boolean {
  const s = launch.account.state;
  return s === "poolLive" || (s === "finalized" && launch.recordExists);
}

/* A settlement record exists from settle onward, and survives an abort after settling. */
export function hasRecord(state: LaunchState): boolean {
  return state === "settled" || state === "poolLive" || state === "finalized";
}

/* The whole supply: the float plus the pool's reserve half. Both fixed. */
export function totalSupply(a: LaunchAccount): bigint {
  return a.float + POOL_RESERVE;
}

/* Market cap in lamports at a tick: the float's value scaled to the whole supply. */
export function mcapAtTick(a: LaunchAccount, tick: number): bigint {
  return (valueAtTick(a.floorValue, tick) * totalSupply(a)) / a.float;
}

/* Market cap implied by a float value, in lamports. */
export function mcapForValue(a: LaunchAccount, value: bigint): bigint {
  return (value * totalSupply(a)) / a.float;
}

/* SOL per whole token at a tick, as a display number. */
export function priceAtTick(launch: Launch, tick: number): number {
  return priceForValue(launch, valueAtTick(launch.account.floorValue, tick));
}

export function priceForValue(launch: Launch, value: bigint): number {
  const sol = atomsToNumber(value, SOL_DECIMALS);
  const tokens = atomsToNumber(launch.account.float, launch.token.decimals);
  return tokens > 0 ? sol / tokens : 0;
}

/*
  The pool that opened (checklist N-14, C-24): create_pool wraps the proceeds
  (float_value until 0.27; since 0.28 pool_sol_in, float_value less the raise
  fee paid) against the whole reserve half on Meteora, and the pool opens
  holding pool_sol_at_open on the SOL side: that less dust_lamports.
  Meteora does not count SOL strangers send to its vault (INTERFACE 485,
  642); on Raydium (0.18 and earlier) the excess over the proceeds was such
  SOL. Opening price per token is pool_sol_at_open / POOL_RESERVE; opening
  market cap is twice pool_sol_at_open, so a 0.28 pool opens 1 percent under
  "Cleared at" (twice float_value).
*/
export function openingMcap(record: SettlementRecord): bigint {
  return 2n * record.poolSolAtOpen;
}

export function openingPricePerToken(record: SettlementRecord): number {
  return atomsToNumber(record.poolSolAtOpen, SOL_DECIMALS) / atomsToNumber(POOL_RESERVE, TOKEN_DECIMALS);
}

/* Lamports strangers added to the pool's SOL side before it opened, over what the program wrapped (pool_sol_in once a pool opens under 0.28, float_value before; a pool opened before the upgrade reads pool_sol_in 0). Only a Raydium pool (0.18 and earlier) could count them: Meteora does not count SOL strangers send to its vault (INTERFACE 485, 642), so on every Meteora launch (0.19 on) the pool opens exactly on what was wrapped less the dust, and this is 0. */
export function poolPremium(record: SettlementRecord): bigint {
  const wrapped = record.poolSolIn > 0n ? record.poolSolIn : record.floatValue;
  return record.poolSolAtOpen > wrapped ? record.poolSolAtOpen - wrapped : 0n;
}

/*
  0.28 (the founder, 2026-10-08): the raise fee of a settled launch, from its record.
  settle agrees two parts from the launch's own terms (raise_fee_creator,
  raise_fee_platform); create_pool pays them (the paid figures; 0 for a part
  its destination could not hold rent exempt, which then stays in the pool)
  and wraps the rest of the proceeds (pool_sol_in). Before the pool opens the
  figures are the agreed ones. Null when no fee is or was taken: no fee
  agreed (every launch created before 0.28, any launch whose terms carry a
  zero fee), or the pool opened with both parts left in it. Its pool then
  gets all of float_value and opens at the clearing price, as before, and
  every old sentence holds.
*/
export interface RaiseFee {
  /* create_pool has run: creator, platform and total are what was paid; before, what was agreed. */
  open: boolean;
  creator: bigint;
  platform: bigint;
  total: bigint;
  /* What settle agreed (record 360, 368): the fee as the launch's terms set it, for the sentence. */
  agreedCreator: bigint;
  agreedPlatform: bigint;
  agreedTotal: bigint;
  /* A part agreed at settle and not paid at create_pool: it stayed in the pool. */
  creatorStayed: bigint;
  platformStayed: bigint;
  /* What the pool gets on its SOL side before dust and strays: pool_sol_in once open, float_value less the agreed parts before. */
  toPool: bigint;
  /* The launch's own terms, for the words ("1%", "60%"). */
  bps: number;
  creatorShareBps: number;
}

export function raiseFeeOf(a: LaunchAccount, record: SettlementRecord): RaiseFee | null {
  const agreed = record.raiseFeeCreator + record.raiseFeePlatform;
  if (agreed === 0n) return null;
  const open = record.poolSolAtOpen > 0n;
  const creator = open ? record.raiseFeeCreatorPaid : record.raiseFeeCreator;
  const platform = open ? record.raiseFeePlatformPaid : record.raiseFeePlatform;
  if (creator + platform === 0n) return null;
  return {
    open,
    creator,
    platform,
    total: creator + platform,
    agreedCreator: record.raiseFeeCreator,
    agreedPlatform: record.raiseFeePlatform,
    agreedTotal: agreed,
    creatorStayed: open && record.raiseFeeCreatorPaid === 0n ? record.raiseFeeCreator : 0n,
    platformStayed: open && record.raiseFeePlatformPaid === 0n ? record.raiseFeePlatform : 0n,
    toPool: open && record.poolSolIn > 0n ? record.poolSolIn : record.floatValue - agreed,
    bps: a.raiseFeeBps,
    creatorShareBps: a.raiseFeeCreatorShareBps,
  };
}

/* How far under the clearing price the pool opens, or will: the launch's own fee ("1%" at 100 bps) when both parts are taken; when a part stayed in the pool, what was taken over the raise, to two decimals at most ("0.4%", "0.6%"). */
export function underClearingText(fee: RaiseFee, floatValue: bigint): string {
  if (fee.creatorStayed === 0n && fee.platformStayed === 0n) return `${parseFloat((fee.bps / 100).toFixed(4))}%`;
  if (floatValue === 0n) return "0%";
  return `${parseFloat(((Number(fee.total) / Number(floatValue)) * 100).toFixed(2))}%`;
}

/* 0.28: the program's raise_fee_parts (lib.rs:299-305): the fee is floor(value x bps / 10,000), the creator's part floor(fee x share / 10,000), the platform's the rest. */
export function raiseFeeParts(value: bigint, bps: number, creatorShareBps: number): { creator: bigint; platform: bigint } {
  const fee = (value * BigInt(bps)) / 10_000n;
  const creator = (fee * BigInt(creatorShareBps)) / 10_000n;
  return { creator, platform: fee - creator };
}

export interface FeeMayStay {
  creator: boolean;
  platform: boolean;
}

/*
  Before the pool opens, which raise fee parts could stay in the pool (the
  pre-open wording edge case, 2026-10-09). The program pays a part only if
  its wallet then holds the rent exemption with it in (fee_payable,
  lib.rs:312), judged at create_pool on that moment's balance, so no read
  now can promise it. A part at least the rent of an empty account is always
  paid; a smaller one stays when its wallet is empty then. Parts only grow
  with the raise, so before settle they are judged at the floor (the least a
  launch can clear at), after settle on the record's agreed parts. While the
  rent is unread both count, so the words never promise what may not happen.
  Once the pool is open the record says what was paid and nothing is at
  risk. On mainnet's floor the smaller part is about 60 times the rent;
  devnet launches that clear under about 0.16 SOL can leave one.
*/
/* After settle, on the record's agreed parts: exact, so a part of 0 is nothing to stay. */
export function raiseFeeMayStay(parts: { creator: bigint; platform: bigint }, rentEmpty: bigint | null): FeeMayStay {
  const risk = (p: bigint) => p > 0n && (rentEmpty === null || p < rentEmpty);
  return { creator: risk(parts.creator), platform: risk(parts.platform) };
}

/*
  Before settle, at the floor: a part at least the rent there is at least the
  rent at any clearing value. A part under it, 0 included, may be under it
  when the launch clears (a part that rounds to 0 at the floor can be a few
  lamports above it), so it counts unless it is 0 by the terms: no fee, or a
  share of none (the 0.28 review of the site fixes, 2026-10-10).
*/
export function raiseFeeMayStayAtFloor(floorValue: bigint, bps: number, creatorShareBps: number, rentEmpty: bigint | null): FeeMayStay {
  if (bps === 0) return { creator: false, platform: false };
  const parts = raiseFeeParts(floorValue, bps, creatorShareBps);
  const risk = (p: bigint, possible: boolean) => possible && (rentEmpty === null || p < rentEmpty);
  return { creator: risk(parts.creator, creatorShareBps > 0), platform: risk(parts.platform, creatorShareBps < 10_000) };
}

export function launchFeeMayStay(a: LaunchAccount, record: SettlementRecord | null, rentEmpty: bigint | null): FeeMayStay {
  if (a.raiseFeeBps === 0 || (record && record.poolSolAtOpen > 0n)) return { creator: false, platform: false };
  if (!record) return raiseFeeMayStayAtFloor(a.floorValue, a.raiseFeeBps, a.raiseFeeCreatorShareBps, rentEmpty);
  return raiseFeeMayStay({ creator: record.raiseFeeCreator, platform: record.raiseFeePlatform }, rentEmpty);
}

export const anyMayStay = (m: FeeMayStay): boolean => m.creator || m.platform;

export function clearingFromRecord(a: LaunchAccount, r: SettlementRecord): Clearing {
  return {
    tick: r.clearingTick,
    marginalTick: r.marginalTick,
    floatValue: r.floatValue,
    winningDeposits: r.winningDeposits,
    aboveDeposits: r.aboveDeposits,
    atDeposits: r.atDeposits,
    float: a.float,
  };
}

/* filled: above the margin, in full. marginal: at the margin, rationed pro rata. outbid: bid the clearing price or more and still got nothing, the maximums above took the float. refunded: below the price. unrevealed: never opened (invalid), refunded in full. */
export type RowStatus = "filled" | "marginal" | "outbid" | "refunded" | "unrevealed";

export interface SettledRow {
  bid: BidAccount;
  tick: number | null;
  fill: Fill;
  status: RowStatus;
}

export interface SettlementView {
  clearing: Clearing;
  rows: SettledRow[];
  /* The marginal tick: the lowest maximum still needed. Its bids share what the full fills left, pro rata. */
  margin: { tick: number; bidders: number; deposits: bigint; spent: bigint; tokens: bigint };
  winners: number;
  tokensSold: bigint;
  /* Sum of every cost: at least the float value (which funds the pool and, since 0.28, the raise fee), over by at most one lamport per marginal bidder. */
  proceeds: bigint;
  refunded: bigint;
  unrevealedDeposits: bigint;
  /* Largest bidder share = tokens / total supply, a fixed denominator (never a running total of what has been delivered). */
  largest: { bidder: string; tokens: bigint; cost: bigint; shareOfSupply: number } | null;
  /* The settlement self check (N-12): every invariant the record and the predicted fills must satisfy. Empty when the port and the chain agree. */
  selfCheckFailures: string[];
}

/*
  The step a bid opened at, for the book: a revealed bid's own, and a parked bid's (v0.32) where its held payout
  says it opened there. park_bid leaves the tick where reveal wrote it and holds exactly the fill deliver would have
  sent (lib.rs park_bid, payout_for), so a parked bid whose tick predicts the tokens it holds opened at that tick; one
  that never opened holds a full refund at tick 0 and is unopened wherever tick 0 would have won. The final E2E's S1
  (2026-10-30): a parked winner read as "Unopened, refunded", its deposit counted as refunded and not as a winner.
  A parked loser that never opened, on a launch that cleared above tick 0, reads as refunded below the price: the same
  full refund, as the account cannot tell the two apart.
*/
export function openedTick(bid: BidAccount, clearing: Clearing): number | null {
  if (bid.tick != null) return bid.tick;
  const held = bid.state === "parked" ? bid.parked : undefined;
  if (!held || held.tick == null) return null;
  return fill(bid.deposit, held.tick, clearing).tokens === held.tokens ? held.tick : null;
}

/* Predict every bid's outcome from the record, the way deliver and claim will. counts: the launch's histogram (0.29, its own account), when read; the self check's histogram rows wait for it. */
export function buildSettlementView(launch: Launch, record: SettlementRecord, bids: BidAccount[], counts: readonly bigint[] | null = null): SettlementView {
  const a = launch.account;
  const clearing = clearingFromRecord(a, record);
  const rows: SettledRow[] = bids.map((bid) => {
    const tick = openedTick(bid, clearing);
    if (tick == null) {
      return { bid, tick: null, fill: { tokens: 0n, cost: 0n, refund: bid.deposit }, status: "unrevealed" };
    }
    const f = fill(bid.deposit, tick, clearing);
    const status: RowStatus =
      tick > clearing.marginalTick ? "filled" : tick === clearing.marginalTick ? "marginal" : tick >= clearing.tick ? "outbid" : "refunded";
    return { bid, tick, fill: f, status };
  });
  rows.sort((x, y) => (y.tick ?? -1) - (x.tick ?? -1) || (y.bid.deposit > x.bid.deposit ? 1 : y.bid.deposit < x.bid.deposit ? -1 : 0));

  let tokensSold = 0n;
  let proceeds = 0n;
  let refunded = 0n;
  let unrevealedDeposits = 0n;
  let winners = 0;
  let largest: SettlementView["largest"] = null;
  for (const r of rows) {
    tokensSold += r.fill.tokens;
    proceeds += r.fill.cost;
    refunded += r.fill.refund;
    if (r.status === "unrevealed") unrevealedDeposits += r.bid.deposit;
    if (r.fill.tokens > 0n) winners++;
    if (r.fill.tokens > 0n && (!largest || r.fill.tokens > largest.tokens)) {
      largest = { bidder: r.bid.bidder, tokens: r.fill.tokens, cost: r.fill.cost, shareOfSupply: 0 };
    }
  }
  if (largest) largest.shareOfSupply = shareOfSupply(a, largest.tokens);
  const marginRows = rows.filter((r) => r.status === "marginal");
  const margin = {
    tick: clearing.marginalTick,
    bidders: marginRows.length,
    deposits: clearing.atDeposits,
    spent: clearing.floatValue - clearing.aboveDeposits,
    tokens: marginRows.reduce((s, r) => s + r.fill.tokens, 0n),
  };

  return { clearing, rows, margin, winners, tokensSold, proceeds, refunded, unrevealedDeposits, largest, selfCheckFailures: settlementSelfCheck(a, record, rows, counts) };
}

/*
  The settlement self check, checklist N-12: run on every settled launch the
  site renders. A port that drifted from the crate fails one of these on real
  data. Each failure is a sentence the page can show; an empty list is a pass.
*/
export function settlementSelfCheck(a: LaunchAccount, record: SettlementRecord, rows: SettledRow[], counts: readonly bigint[] | null = null): string[] {
  const out: string[] = [];
  const k = record.clearingTick;
  const m = record.marginalTick;
  const v = record.floatValue;
  const F = a.float;
  const cum = (lo: number) => (counts ?? []).slice(lo).reduce((s, x) => s + x, 0n);
  const filled = rows.filter((r) => r.fill.tokens > 0n);
  const atMargin = rows.filter((r) => r.status === "marginal").length;
  const sumTokens = rows.reduce((s, r) => s + r.fill.tokens, 0n);
  const sumCost = rows.reduce((s, r) => s + r.fill.cost, 0n);
  /* deliver, refund and claim close Bid accounts, so the sums over the rows are invariants only while every bid that was settled is still on chain. */
  const complete = rows.length >= record.revealedBids + record.invalidBids;
  if (m < k) out.push("the marginal tick is below the clearing tick");
  if (!(record.aboveDeposits < v && v <= record.aboveDeposits + record.atDeposits)) out.push("the deposits above and at the margin do not bracket the float value");
  if (v !== valueAtTick(a.floorValue, k)) out.push("the float value is not the grid's value at the clearing tick");
  if (sumTokens > F) out.push("the predicted fills exceed the float");
  if (complete && sumTokens + BigInt(filled.length) < F) out.push("the predicted fills leave more than one atom per filled bidder unsold");
  for (const r of rows) {
    if (r.fill.cost > r.bid.deposit) out.push("a cost exceeds its deposit");
    if (r.fill.cost + r.fill.refund !== r.bid.deposit) out.push("a cost and refund do not sum to the deposit");
    if (r.tick != null && r.tick > m && (r.fill.cost !== r.bid.deposit || r.fill.tokens !== (r.bid.deposit * F) / v)) out.push("a bid above the margin is not filled in full");
    if ((r.tick == null || r.tick < m) && (r.fill.tokens !== 0n || r.fill.refund !== r.bid.deposit)) out.push("a bid below the margin is not refunded in full");
  }
  if (complete && !(v <= sumCost && sumCost <= v + BigInt(atMargin))) out.push("the costs do not cover the float value within one lamport per marginal bidder");
  /* The histogram is filled by reveal (0.29: its own account, kept for good); once read, the clearing tick must be maximal on it. */
  if (counts && counts.some((x) => x > 0n)) {
    if (cum(k) < v) out.push("the deposits at or above the clearing tick do not cover the float value");
    if (k < counts.length - 1 && cum(k + 1) >= valueAtTick(a.floorValue, k + 1)) out.push("a higher tick is also covered: the clearing tick is not maximal");
  }
  if (record.aboveDeposits > 0n && ceilDiv(record.aboveDeposits * F, v) > F) out.push("the full fills alone exceed the float");
  return [...new Set(out)];
}

/* A holding as a share of the whole supply, the one denominator every percentage on the site uses. */
export function shareOfSupply(a: LaunchAccount, tokens: bigint): number {
  return ratio(tokens, totalSupply(a));
}

export function ratio(n: bigint, d: bigint): number {
  if (d === 0n) return 0;
  return Number((n * 1_000_000n) / d) / 1_000_000;
}
