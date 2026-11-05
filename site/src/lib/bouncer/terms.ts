/*
  The terms a signer states (INTERFACE 0.25): any amount the program or its
  config sets, and that the signer pays, travels in the instruction's own
  data.

  create_launch carries LaunchTerms, the eight values a launch copies from
  the config (six since 0.25, the raise fee and its creator share since 0.28). The create page shows them from one config read and sends back
  exactly those; the program refuses TermsChanged (6066) if the config is
  different when the instruction executes, before anything is created or
  debited. Nothing in this module reads the chain: the terms sent are the
  terms that were on the screen.

  commit carries a ceiling on the processing charge. The bid page shows the
  charge and sends the same figure; the program refuses
  ProcessingChargeAboveMaximum (6067) if its charge is higher. 0.29: the
  charge is a config term each launch copies at genesis
  (Launch.processing_charge, at most BOUNDS.maxProcessingCharge), so the
  figure shown and sent is the launch's own, which nothing can change after
  genesis.
*/
import { BOUNDS } from "@contract/constants";
import { fmtDuration, fmtSol } from "./format";
import type { ConfigAccount, LaunchTerms } from "./types";

/* The pin's default charge (the config's at the re-pin). 0.29: a launch's own is Launch.processing_charge, which the bid page shows and sends. */
export const PROCESSING_CHARGE: bigint = BigInt(BOUNDS.processingChargeLamports);

/*
  The network fee of a commit, lamports, known exactly: one signature's base
  fee, with the compute budget set explicitly by the transaction builder
  (chain/chainClient.ts): COMMIT_COMPUTE_UNITS at COMMIT_COMPUTE_UNIT_PRICE
  micro-lamports a unit, which is 0, so nothing is added to the base fee. A
  commit consumed 14,072 units on devnet (4GnCmoUE…BDgQWd, 2026-10-07); the
  limit leaves room. The network takes the fee; nothing sends it.
  24e: in the auction's last 90 seconds a capped priority fee may be added
  (priorityPrice below). The fee line on the bid page still shows the base
  fee only: showing the priority fee there is a visible change, held for
  the founder's mock (review/2026-10-24e-late-close-mock).
*/
export const SIGNATURE_FEE: bigint = 5_000n;
/*
  24e (the founder's capacity decisions, item 3): the commit's compute limit, measured. Twelve landed 0.29 commits on devnet used
  16,337 to 20,837 units in all (review/2026-10-24d-BIDRATE.md, review/2026-10-24d-commitcu.mjs); 30,000 leaves 44 percent
  over the most seen, for the branches not measured there (the late close, a bid that fills the cap). It was a flat 50,000.
  The limit is what each writable account's per-block budget is charged at admission, so a smaller one lets more bids into
  a block on the launch and its vault.
*/
export const COMMIT_COMPUTE_UNITS = 30_000;
/*
  2026-10-25, the funded load test (review/2026-10-25-loadtest/RESULTS.md): commit creates the bid account with Anchor's
  init, which searches for its address's bump from 255 down, about 1,500 units for each try that misses. A flat 30,000
  covered a bid account found within 9 missed tries, barely: at 10 or more (about 1 wallet in 1,000 on any one launch,
  and always the same wallets for that launch) the simulation ran out of units and the bid could never be placed. 6 of
  12,900 test bids were refused that way, every one at 10 or 13 missed tries; no placed bid needed more than 9; the
  three refused wallets sent again at 31,600 used 31,489 each. The limit is now BUMP_BASE_UNITS plus BUMP_TRY_UNITS a
  missed try, never under 30,000: 30,000 exactly up to 6 missed tries (more than 99 wallets in 100), 34,400 at 9,
  36,000 at 10, about 4,500 over the most each was seen to use.

  24n (F8, Astra's 24m E2E, review/2026-10-25-astra-e2e/REPORT.md): every landed commit used exactly 16,490 + 1,500
  units a missed try (new largest; a plain accept one less, a late close 13,726 + 1,500 a try), and F8 asks 1.5 times
  that on every branch. 1,600 a try fell short from 3 missed tries (34,000 needed at 4, 30,000 given). Now 25,500 plus
  2,250 a try (1.5 x 16,490 = 24,735, plus 765 spare; 1.5 x 1,500 = 2,250), never under 30,000: 0 to 2 missed tries
  (7 wallets in 8) keep 30,000 exactly; 32,250 at 3, 41,250 at 7, 48,000 at 10.
*/
export const BUMP_BASE_UNITS = 25_500;
export const BUMP_TRY_UNITS = 2_250;
export function commitComputeUnits(missedTries: number): number {
  return Math.max(COMMIT_COMPUTE_UNITS, BUMP_BASE_UNITS + BUMP_TRY_UNITS * Math.max(0, Math.floor(missedTries)));
}
/* The price outside the auction's last FINAL_WINDOW_SECS: nothing. */
export const COMMIT_COMPUTE_UNIT_PRICE = 0;
/*
  24e, item 3: a priority fee only near the end. Inside the last 90 seconds the price is what recent transactions that
  wrote the launch and its vault paid (the 75th percentile of the nonzero ones, plus a tenth), never more than
  PRIORITY_MAX_MICROLAMPORTS: at 30,000 units that is 30,000 lamports (0.00003 SOL) a bid at the most. Zero earlier, and
  zero when nothing recent paid one (devnet).
*/
export const FINAL_WINDOW_SECS = 90;
export const PRIORITY_MAX_MICROLAMPORTS = 1_000_000;
export function priorityPrice(recent: readonly number[], secondsLeft: number): number {
  if (!(secondsLeft <= FINAL_WINDOW_SECS)) return 0;
  const paid = recent.filter((f) => Number.isFinite(f) && f > 0).sort((a, b) => a - b);
  if (paid.length === 0) return 0;
  const p75 = paid[Math.min(paid.length - 1, Math.floor(paid.length * 0.75))];
  return Math.min(PRIORITY_MAX_MICROLAMPORTS, Math.ceil((p75 * 11) / 10));
}
/* A price as the site will send it: a whole number of micro-lamports within the cap, and zero outside the final window. */
export function boundedPrice(price: number, secondsLeft: number): number {
  if (!(secondsLeft <= FINAL_WINDOW_SECS) || !Number.isFinite(price) || price <= 0) return 0;
  return Math.min(PRIORITY_MAX_MICROLAMPORTS, Math.floor(price));
}
/* The priority fee a commit at this price pays, lamports (the runtime's rule: the limit times the price, rounded up). */
export function priorityLamports(price: number, units: number = COMMIT_COMPUTE_UNITS): bigint {
  return price > 0 ? BigInt(Math.ceil((units * price) / 1_000_000)) : 0n;
}
/*
  24g (the founder's cost line, 2026-10-25): the priority fee a bid page takes out of what is sent, and the price it sends with
  it. `base` is what is sent less the other costs. A fee that would take the deposit under the minimum is not added: that
  bid goes at price 0, so the least the field takes never moves.
*/
export function bidPriority(base: bigint, minBid: bigint, price: number, units: number): { priority: bigint; price: number } {
  const full = priorityLamports(price, units);
  return full > 0n && base - full >= minBid ? { priority: full, price } : { priority: 0n, price: 0 };
}

/* What a launch's commit is priced by: its own charge and whether it is gated (0.29). The config's pair stands in where no launch is named (the fees page). */
export interface BidTerms {
  processingCharge: bigint;
  attestRequired: boolean;
}

/*
  0.29: a gated launch's commit carries the bot check's Ed25519 instruction,
  and the network charges its signature like the transaction's own
  (docs/ADVERSARIAL-GRIEFING-2026-10-20.md 14.1, Agave's fee rule): two
  signatures' fees, 10,000 lamports, instead of one.
*/
export function commitFee(t: Pick<BidTerms, "attestRequired">): bigint {
  return SIGNATURE_FEE * (t.attestRequired ? 2n : 1n);
}

/*
  The create's own compute budget (2026-10-29, the founder's phone test: Phantom warned "Failed to simulate the results of
  this request" on RFOR's create, and had added its own priority fee to it, since the create carried no price). Every
  limit is the site's, so the wallet changes nothing. The units: the most of 8 creates on 0.31 and 0.32 was 774,283
  (RFOR), so 900,000. The price is small and real, 450 lamports at that limit. The loaded account data: about 1.135 MB
  at 0.32 (the program's data, 1,133,853 bytes, the Config and the builtins; the accounts it makes are empty when
  loaded), so 2 MiB, room for the program to grow; RFOR's own create simulated on devnet loads under it and refuses
  MaxLoadedAccountsDataSizeExceeded under 100 KB.
*/
export const CREATE_COMPUTE_UNITS = 900_000;
export const CREATE_COMPUTE_UNIT_PRICE = 500;
export const CREATE_LOADED_ACCOUNTS_DATA_BYTES = 2 * 1024 * 1024;

/* 0.29, the seventh candidate: every creation carries the creation permit's Ed25519 instruction, charged like a signature, so genesis pays two signatures' fees, 10,000 lamports; since 2026-10-29 the create's priority fee too, 450 lamports. */
export const CREATE_FEE = 2n * SIGNATURE_FEE + priorityLamports(CREATE_COMPUTE_UNIT_PRICE, CREATE_COMPUTE_UNITS);

/* the founder, 2026-10-08: "if someone bids 2 sol, they should have any fees taken out of that 2 sol." The costs that come out of what a bidder sends, so the deposit is what was typed less these: the launch's charge, the Bid account's rent on this cluster (hooks.useRent(ACCOUNTS.Bid.len)) and the fee. */
export function bidCosts(bidRent: bigint, t: BidTerms): bigint {
  return t.processingCharge + bidRent + commitFee(t);
}

export function termsOf(c: ConfigAccount): LaunchTerms {
  return { floorValue: c.floorValue, minBid: c.minBid, abortAfterSecs: c.abortAfterSecs, deliveryFeeBps: c.deliveryFeeBps, creatorLpBps: c.creatorLpBps, crankBond: c.crankBond, raiseFeeBps: c.raiseFeeBps, raiseFeeCreatorShareBps: c.raiseFeeCreatorShareBps };
}

export function sameTerms(a: LaunchTerms, b: LaunchTerms): boolean {
  return a.floorValue === b.floorValue && a.minBid === b.minBid && a.abortAfterSecs === b.abortAfterSecs && a.deliveryFeeBps === b.deliveryFeeBps && a.creatorLpBps === b.creatorLpBps && a.crankBond === b.crankBond && a.raiseFeeBps === b.raiseFeeBps && a.raiseFeeCreatorShareBps === b.raiseFeeCreatorShareBps;
}

/* The terms as one string, and back: a stable dependency for an effect, where the config object is new on every read. */
export function termsKey(t: LaunchTerms): string {
  return [t.floorValue, t.minBid, t.abortAfterSecs, t.deliveryFeeBps, t.creatorLpBps, t.crankBond, t.raiseFeeBps, t.raiseFeeCreatorShareBps].join(":");
}
export function termsFromKey(key: string): LaunchTerms {
  const p = key.split(":");
  return { floorValue: BigInt(p[0]), minBid: BigInt(p[1]), abortAfterSecs: Number(p[2]), deliveryFeeBps: Number(p[3]), creatorLpBps: Number(p[4]), crankBond: BigInt(p[5]), raiseFeeBps: Number(p[6]), raiseFeeCreatorShareBps: Number(p[7]) };
}

export interface TermChange {
  /* What the term is, in the words the create page uses for it. */
  label: string;
  was: string;
  now: string;
}

const pct = (bps: number) => `${bps / 100}%`;
const lamports = (v: bigint) => `${v.toLocaleString("en-US")} lamports`;
/* SOL as the page writes it, or to the lamport when two different amounts would print the same. */
function solPair(was: bigint, now: bigint): [string, string] {
  const a = fmtSol(was);
  const b = fmtSol(now);
  return a !== b ? [a, b] : [lamports(was), lamports(now)];
}
function timePair(was: number, now: number): [string, string] {
  const a = fmtDuration(was);
  const b = fmtDuration(now);
  return a !== b ? [a, b] : [`${was.toLocaleString("en-US")} seconds`, `${now.toLocaleString("en-US")} seconds`];
}

/* Every term that differs, in the order the page states them: what the creator pays and gets first. */
export function termChanges(was: LaunchTerms, now: LaunchTerms): TermChange[] {
  const out: TermChange[] = [];
  const add = (label: string, pair: [string, string]) => out.push({ label, was: pair[0], now: pair[1] });
  if (was.crankBond !== now.crankBond) add("The operating prepay you put up", solPair(was.crankBond, now.crankBond));
  if (was.creatorLpBps !== now.creatorLpBps) add("Your share of the locked liquidity", [pct(was.creatorLpBps), pct(now.creatorLpBps)]);
  if (was.raiseFeeBps !== now.raiseFeeBps) add("The fee on the raise, paid when the pool opens", [pct(was.raiseFeeBps), pct(now.raiseFeeBps)]);
  if (was.raiseFeeCreatorShareBps !== now.raiseFeeCreatorShareBps) add("Your share of that fee", [pct(was.raiseFeeCreatorShareBps), pct(now.raiseFeeCreatorShareBps)]);
  if (was.floorValue !== now.floorValue) add("What your launch needs in deposits to launch", solPair(was.floorValue, now.floorValue));
  if (was.minBid !== now.minBid) add("The minimum bid", solPair(was.minBid, now.minBid));
  if (was.deliveryFeeBps !== now.deliveryFeeBps) add("The fee a bidder pays on a pushed delivery", [pct(was.deliveryFeeBps), pct(now.deliveryFeeBps)]);
  if (was.abortAfterSecs !== now.abortAfterSecs) add("The time after the window before bidders can take their deposits back", timePair(was.abortAfterSecs, now.abortAfterSecs));
  return out;
}
