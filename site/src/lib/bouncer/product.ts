/*
  Fixed on every launch. None of these is a creator input: the form asks for
  a name, a ticker, a picture and a window, and nothing else.

  Every number here comes from the pinned contract (contract/constants.ts):
  the decided config for the cluster the site is built for (CONFIG_FOR_CLUSTER;
  on devnet the Config as set, CONFIG_FALLBACK: floor 5 SOL on mainnet (MAINNET_FLOOR), 10 SOL on devnet, minimum bid
  0.01768384 SOL, valve 12 h, bond 0.06 SOL) and the supply constants. They are the reference the pages fall
  back on; a running launch is read from its own account (Launch.floor_value
  and the genesis copies), and the creator form reads the Config account.

  No limits (the founder, 2026-09-24 evening: "I don't want to limit anything"; the
  contract since v0.15): no raise cap, no per wallet limit, no launch count.
  Exposure is bounded by what the program can do with the money, not by a
  number: deposits can only reach the pool, the raise fee's two destinations
  (0.28: the creator and lp_owner, when the pool opens) or return to bidders, the creator's
  bond can only reach whoever opens the pool or return to the creator, no
  instruction of this program can block a refund or a claim, and the abort
  valve means nothing is ever trapped.
*/

import { ACCOUNTS, BOUNDS, FLOAT, HISTOGRAM_INIT_LEN, POOL_RESERVE, TOKEN_DECIMALS, TOTAL_SUPPLY } from "@contract/constants";
import { CLUSTER, CONFIG_FOR_CLUSTER, ON_MAINNET_PIN } from "@contract/active";
import { DEVNET_CONFIG_LIVE } from "./devnetConfig";
import type { Launch } from "./types";
import { V030 } from "./v030";

/*
  Mainnet's min_bid (23c; the founder 2026-10-24, the fresh 23b review's L5): the mainnet Config takes 17,683,840 before genesis
  (docs/MAINNET-LAUNCH-PLAN.md D-C2, checked at D-V), so a bidder sends exactly 0.02 SOL with the costs. The crate's decided
  production set (contract/constants.json config.production) keeps 20,000,000 and is not read for it.
*/
export const MAINNET_MIN_BID = 17_683_840n;

/*
  Mainnet's floor (FL5; the founder, 2026-11-04; review/2026-11-04-mainnet/FLOOR-5-SPEC.md): the mainnet Config takes
  5,000,000,000 (5 SOL) through Squad B (pause on, update, pause off). The crate's decided set keeps 10,000,000,000 and
  is not read for it. raise-fee-gate.cjs pins the same number (MAINNET_FLOOR.decided); its test reads this line.
*/
export const MAINNET_FLOOR = 5_000_000_000n;

/* The fallback config: on mainnet the program's decided set with the Config's min_bid and floor; on devnet the Config as set (devnetConfig.ts, D in 22e3). */
export const CONFIG_FALLBACK = ON_MAINNET_PIN ? { ...CONFIG_FOR_CLUSTER, minBid: MAINNET_MIN_BID, floorValue: MAINNET_FLOOR } : { ...CONFIG_FOR_CLUSTER, ...DEVNET_CONFIG_LIVE };

export const PRODUCT = {
  /* The cluster the pinned contract was generated for. The page says which one it is on. */
  cluster: CLUSTER,
  /* Lamports the float is worth at tick 0 and the least a launch can raise. The market cap floor is twice this. Under it a launch fails and refunds everyone; there is no partial clear. */
  floorValue: CONFIG_FALLBACK.floorValue,
  minBid: CONFIG_FALLBACK.minBid,
  /* 0 since 0.26 (the founder, 2026-10-05): a pushed delivery takes no tokens; the pusher is repaid from the bid account's rent (pushCostText). 50 bps from 2026-09-24 to 0.25; launches created then still carry it. */
  deliveryFeeBps: CONFIG_FALLBACK.deliveryFeeBps,
  /* The creator's share of the locked LP, as a position NFT that collects that half's trading fees. the founder's decision of 2026-09-24, final. */
  creatorLpBps: CONFIG_FALLBACK.creatorLpBps,
  /* The abort valve: seconds after the window end (since 0.22 never from settlement: lib.rs recovery_deadline) before anyone may end a stalled launch. 12 hours in production, 10 minutes on devnet. */
  abortAfterSecs: CONFIG_FALLBACK.abortAfterSecs,
  /* The crank bond the creator posts at genesis: paid to whoever opens the pool (who spends about 0.043 SOL of it on rents, docs/lap-steps.md), returned to the creator only if the launch fails or is aborted. */
  crankBond: CONFIG_FALLBACK.crankBond,
  /* 0.28 (the founder, 2026-10-08): the raise fee, basis points of the cleared raise taken in SOL when the pool opens, and the creator's share of it in basis points of the fee; the platform's part is the rest. The pin's figures, checked by check-contract; no page prints them (2026-10-09): pages read the live Config (184, 186) or the launch's own account (8832, 8834). */
  raiseFeeBps: CONFIG_FALLBACK.raiseFeeBps,
  raiseFeeCreatorShareBps: CONFIG_FALLBACK.raiseFeeCreatorShareBps,
  tokenDecimals: TOKEN_DECIMALS,
  float: FLOAT,
  poolReserve: POOL_RESERVE,
  totalSupply: TOTAL_SUPPLY,
  /* Metadata limits, in UTF-8 bytes, not characters (MetadataTooLong 6032). */
  maxNameBytes: BOUNDS.maxName,
  maxSymbolBytes: BOUNDS.maxSymbol,
  maxUriBytes: BOUNDS.maxUri,
} as const;

/* Cleared-at market cap at the floor: the whole supply is twice the float. A 0.28 pool opens 1 percent under it (the raise fee). */
export function floorMcap(floorValue: bigint = PRODUCT.floorValue): bigint {
  return floorValue * 2n;
}

/* The delivery fee as a percentage. A launch carries its own copy (Launch.delivery_fee_bps); the default is the cluster's config value. */
export function fmtFee(bps: number = PRODUCT.deliveryFeeBps): string {
  return `${(bps / 100).toFixed(1)}%`;
}

/*
  0.26: what a pushed delivery costs the winner, by the launch's own terms (Launch.delivery_terms, read from the launch, never from the
  config). Terms 1 (a launch created by 0.26): no tokens; the bid account's rent repays the pusher the token account rent it fronted plus
  the launch's reward, and the winner gets the rest of it. Terms 0 (every launch created before): the pusher takes delivery_fee_bps of the
  tokens and the winner gets the whole bid account. A claim pays nobody under either.
*/
export function pushCostText(terms: { deliveryTerms: number; deliveryReward: bigint; deliveryFeeBps: number }): string {
  /* the founder's item 20 (2026-10-16): the rent clause is gone from the bid page; the fees page keeps the mechanism. */
  if (terms.deliveryTerms === 1) return `no tokens, only ${(Number(terms.deliveryReward) / 1e9).toFixed(6)} SOL`;
  return `${fmtFee(terms.deliveryFeeBps)} of the tokens`;
}
/* 24j (the founder, 2026-10-25): the bid page's Delivered card, one line: "Costs only 0.000025 SOL." ("Nothing to sign." went). */
export function deliveredCostLine(terms: { deliveryTerms: number; deliveryReward: bigint; deliveryFeeBps: number }): string {
  return terms.deliveryTerms === 1 ? `Costs only ${(Number(terms.deliveryReward) / 1e9).toFixed(6)} SOL.` : `Costs ${pushCostText(terms)}.`;
}
/*
  What comes back to a creator from the operating prepay: the prepay less what the steps after the window spend. The spend is read from
  devnet's finalized launches, Launch.ops_paid: 46,259,321 on X, Y and Z and 46,259,395 on B (2026-10-06), 46,259,389 on E (2026-10-02);
  the same figure under 0.25's 0.181 SOL prepay and 0.26's 0.06 SOL, because it is what the steps cost, not a share of the prepay.
*/
export const DEVNET_STEPS_SPENT_LAMPORTS = 46_259_395n;
export function prepayBack(crankBond: bigint): bigint {
  return crankBond > DEVNET_STEPS_SPENT_LAMPORTS ? crankBond - DEVNET_STEPS_SPENT_LAMPORTS : 0n;
}
/* The same for a launch not yet created: the config's terms, which 0.26 writes as terms 1 with the pin's reward. */
export const NEW_LAUNCH_PUSH = { deliveryTerms: 1, deliveryReward: BigInt(BOUNDS.deliveryRewardLamports), deliveryFeeBps: 0 } as const;

/*
  0.29 (docs/V029-DESIGN-2026-10-20.md section 11; the founder: creators pay for
  the receipt, and it deters spam): the rent genesis leaves on chain for
  good. The histogram, every bid's max and deposit counted at its tick and
  kept for anyone to recompute the clearing (19,272 bytes, made at 10,240 by
  create_launch and grown in the same transaction); the Launch account; the
  vault. Nothing closes them: a one-time launch cost, never a deposit and
  never refunded. About 0.1077 SOL at 2026-10-20's rent, read from the
  cluster wherever it is shown (hooks.useRent).
*/
export const SETUP_ACCOUNT_BYTES = { histogram: ACCOUNTS.Histogram.len, launch: ACCOUNTS.Launch.len, vault: ACCOUNTS.Vault.len } as const;
export interface SetupCost {
  histogram: bigint;
  launch: bigint;
  vault: bigint;
  total: bigint;
}
export function setupCost(rent: { histogram: bigint; launch: bigint; vault: bigint }): SetupCost {
  return { ...rent, total: rent.histogram + rent.launch + rent.vault };
}
/* The histogram's second step alone (grow_histogram): the rent of the bytes past the first 10,240, what a half-made launch's creator pays to finish. */
export const HISTOGRAM_INIT_BYTES = HISTOGRAM_INIT_LEN;
/*
  An allowance beside the prepay and the setup rent, for the balance check
  before the wallet prompt: genesis itself pays only the fees beyond them
  (two signatures since the seventh candidate, terms.ts CREATE_FEE; the mint
  and its metadata wait for create_pool). The create page states the exact
  total (chainClient.estimateCreateCost), and the wallet shows it.
*/
export const GENESIS_OTHER_LAMPORTS = 20_000_000n;

/* UTF-8 byte length, the way the program measures name, symbol and uri. */
export function utf8Length(s: string): number {
  return new TextEncoder().encode(s).length;
}

/*
  The least a bidder sends: the launch's minimum bid plus the bid's costs (rent, the processing charge, the network
  fee), the whole amount sent with the costs inside it (BidFlow.tsx).
  the founder, 2026-10-23 (22e3): a flat 0.02 SOL. The Config's min_bid is the deposit, so it is set to 0.02 SOL less the
  costs, 17,683,840 lamports (devnet at the 22e3 deploy; mainnet in its Config before genesis,
  docs/MAINNET-LAUNCH-PLAN.md), and minBid + costs is exactly 0.02 SOL. This floor (0.025 SOL from the founder's
  2026-10-08 rule until 22e3) now only guarantees that a mainnet field never takes less than 0.02 SOL. Should rent ever
  rise until the minimum bid plus the costs passes it, that sum wins: the field never takes less than the chain needs.
*/
export const MIN_SENT_MAINNET: bigint = 20_000_000n;
const ON_MAINNET = (CLUSTER as string) === "mainnet-beta" || (CLUSTER as string) === "mainnet";
export function leastSent(minBid: bigint, costs: bigint, onMainnet: boolean = ON_MAINNET): bigint {
  const least = minBid + costs;
  return onMainnet && MIN_SENT_MAINNET > least ? MIN_SENT_MAINNET : least;
}

/*
  More than the wallet holds (B2, the e2e test of 2026-10-22): what a bid sends
  (the deposit and its costs, all of which leave the wallet in one transaction)
  against the balance last read. The chain client refuses the same thing at send
  (requireBalance); this says it while the visitor types. Unknown balance: false.
*/
export function sentExceedsBalance(sent: bigint, balance: bigint | null): boolean {
  return balance !== null && sent > 0n && sent > balance;
}

/* 0.28: basis points as the pages write them: 100 is "1%", 6,000 "60%", 60 "0.6%". */
export const bpsPct = (bps: number): string => `${parseFloat((bps / 100).toFixed(4))}%`;

/* 0.28 (the founder, 2026-10-08): a launch's raise fee terms in words, from its own account or the config: "1% of the raise when the pool opens: 60% to the creator, 40% to Bouncer". */
export function raiseFeeTermsText(bps: number, creatorShareBps: number): string {
  return `${bpsPct(bps)} of the raise when the pool is created: ${bpsPct((bps * creatorShareBps) / 10_000)} to the creator, ${bpsPct((bps * (10_000 - creatorShareBps)) / 10_000)} to Bouncer`;
}

/*
  Where the pool opens, before it does. The approved sentence (design
  section 6) when every fee part is sure to be paid; "up to" when a part
  could stay in the pool, which only happens when a part is under the rent
  of an empty account and its wallet is empty at the open (view.ts,
  raiseFeeMayStay). `against` names the price: "the clearing price" on the
  launch pages, "the auction's market cap" on the how page.
*/
/*
  The trading fees a creator earns (the founder's item 10, 2026-10-16), never merged
  with the launch fee: the pool's swap fee is fixed by the one Meteora config
  create_pool accepts (WrongMeteoraConfig 6051: 1 percent flat, no dynamic
  fee), Meteora's protocol share of that fee is 20% on that config
  (docs/mainnet-cost-model.md, the 0.32% figure), and the rest is split by
  the two locked positions, Config.creator_lp_bps to the creator. In percent
  of trading volume: 0.48 to the creator, 0.32 to Bouncer, 0.20 to Meteora.
*/
/* v0.30 (the content sweep's code notes, 2026-10-27): every pool created under 0.30 charges 2% (the config the program pins); a pool created before keeps 1%. With creator_lp_bps 2,188: 0.35 to the creator, 1.25 to Bouncer, 0.40 to Meteora. */
export const POOL_SWAP_FEE_BPS = V030 ? 200 : 100;
/* One launch's pool: under 0.30 a pool from before it (trading_state 0 with a pool) keeps 1%; every other launch gets the pinned fee. */
export function poolSwapFeeBps(launch: Pick<Launch, "account" | "record"> | null | undefined): number {
  if (V030 && launch && launch.record?.pool && (launch.account.tradingState ?? 0) === 0) return 100;
  return POOL_SWAP_FEE_BPS;
}
/* The 0.30 pool terms on one launch (2%, the per-trade shares and the burn): v0.30, and not a pool from before it. */
export function onV030Pool(launch: Pick<Launch, "account" | "record"> | null | undefined): boolean {
  return V030 && poolSwapFeeBps(launch) === 200;
}
export const METEORA_PROTOCOL_SHARE_BPS = 2000;
export function tradingFeeSplit(creatorLpBps: number, feeBps: number = POOL_SWAP_FEE_BPS): { creatorPct: number; bouncerPct: number; meteoraPct: number } {
  const toPositions = (feeBps * (10_000 - METEORA_PROTOCOL_SHARE_BPS)) / 10_000;
  return {
    creatorPct: (toPositions * creatorLpBps) / 10_000 / 100,
    bouncerPct: (toPositions * (10_000 - creatorLpBps)) / 10_000 / 100,
    meteoraPct: (feeBps * METEORA_PROTOCOL_SHARE_BPS) / 10_000 / 100,
  };
}
/*
  v0.30, the core fold-in (the founder, 2026-10-27): of the platform's share, 60% to the treasury and 40% buys BOUNCER and
  burns it (0.75% and 0.50% of volume at 1.25%). The figure belongs to the 0.30 IDL; it had no such constant on
  2026-10-27, so it lives here until the re-pin brings one, and only v0.30 pages say it (V030).
*/
export const PLATFORM_TREASURY_SHARE_BPS = 6000;
export function platformSplit(bouncerPct: number): { treasuryPct: number; burnPct: number } {
  const treasuryPct = (bouncerPct * PLATFORM_TREASURY_SHARE_BPS) / 10_000;
  return { treasuryPct, burnPct: bouncerPct - treasuryPct };
}
/* The burn lines' figures, two decimals as the founder's approved text has them: 0.75%, 0.50%. */
export const fmtSharePct = (pct: number): string => `${pct.toFixed(2)}%`;
/* "0.75% to the treasury, 0.50% to buy and burn BOUNCER" (the approved words, F-5, P-2, C-3, B-5). */
export function burnSplitText(bouncerPct: number): string {
  const p = platformSplit(bouncerPct);
  return `${fmtSharePct(p.treasuryPct)} to the treasury, ${fmtSharePct(p.burnPct)} to buy and burn BOUNCER`;
}
/* A share of volume as a percentage with the digits it needs: 0.48%, 0.2%, 1%. */
export function fmtVolumePct(pct: number): string {
  return `${pct.toFixed(2).replace(/\.?0+$/, "")}%`;
}

export function raiseFeeOpensText(bps: number, mayStay: boolean, against = "the clearing price"): string {
  return mayStay ? `The pool opens up to ${bpsPct(bps)} under ${against}: a fee part whose wallet is empty then can stay in the pool.` : `The pool opens ${bpsPct(bps)} under ${against}.`;
}

/* The terms row on the launch and bid pages (design section 6): the terms, then where the pool opens. Once the pool is open (the record's pool_sol_at_open), the row keeps the terms only: the rows beside it state the real opening. */
export function raiseFeeTermsRow(bps: number, creatorShareBps: number, poolOpened: boolean, mayStay: boolean): string {
  return poolOpened ? `${raiseFeeTermsText(bps, creatorShareBps)}.` : `${raiseFeeTermsText(bps, creatorShareBps)}. ${raiseFeeOpensText(bps, mayStay)}`;
}
