/*
  The interface the site needs from the Bouncer program, INTERFACE.md v0.18.

  Shapes follow the pinned contract (contract/constants.ts, ACCOUNTS) field
  for field, camelCased. Byte offsets live there, never here: a decoder reads
  ACCOUNTS.<name>.fields.<field>.offset and .size. The chain client in ./chain/ decodes
  real accounts by those same offsets.

  Units, same as the program:
  - lamports for SOL, the only quote asset. Always bigint.
  - token atoms: six decimals (TOKEN_DECIMALS). Always bigint.
  - value: lamports the whole float is worth at a tick. Prices are never
    stored. Price per token is value / float. A market cap is value times the
    whole supply over the float, and the supply is twice the float.
  - timestamps: unix seconds, as numbers.
*/

import { BidState as ChainBidState, LaunchState as ChainLaunchState } from "@contract/constants";
import type { DecodedEvent } from "./chain/events";
import type { TxSigner, SendOptions } from "./chain/signer";
import type { FundingReport } from "./funding";
import type { WalletAge } from "./walletAge";
import type { Permit } from "./attest";

/* Launch.state: 0 Open, 1 Closed, 2 Settled, 3 PoolLive, 4 Finalized, 5 Aborted, 6 Failed, 7 Initializing. Failed: deposits never covered the floor (at close, or after invalid bids at settle), refunds only, no record. Aborted: the kill switch, refunds only, terminal. Initializing (0.29): created without its grow_histogram; no bid, no step, until the creator's grow lands before the window ends (then Open), else inert until abort at the recovery deadline returns the prepay. */
export type LaunchState = "initializing" | "open" | "closed" | "settled" | "poolLive" | "finalized" | "aborted" | "failed";

/* The on chain byte for each state, from the generated enum, so a decoder never retypes the numbers. */
export const LAUNCH_STATE_BY_BYTE: Readonly<Record<number, LaunchState>> = {
  [ChainLaunchState.Open]: "open",
  [ChainLaunchState.Closed]: "closed",
  [ChainLaunchState.Settled]: "settled",
  [ChainLaunchState.PoolLive]: "poolLive",
  [ChainLaunchState.Finalized]: "finalized",
  [ChainLaunchState.Aborted]: "aborted",
  [ChainLaunchState.Failed]: "failed",
  [ChainLaunchState.Initializing]: "initializing",
};

/* Bid.state: 0 Sealed, 1 Revealed, 2 Invalid (did not open: wrong round, bad plaintext or a tick past the grid; refunded in full), 3 Done, 4 Parked (v0.32). A bid closed by deliver, refund or claim reads as absent on chain, not as Done. */
export type BidState = "sealed" | "revealed" | "invalid" | "done" | "parked";

/*
  v0.32 (idl/INTERFACE-v0.32-NOTE.md, "State, layout and errors"): park_bid leaves the bid open in state 4, PARKED, its
  payout held for the bidder (parked_tokens in the launch's token vault, parked_lamports in its vault) until
  collect_parked or push_parked closes it. The pin's enum names only 0 to 3 (constants.json BidState has no name for
  4), so the byte is named here, beside it; scripts/check-contract.ts holds the pin to having no other 4.
*/
export const BID_STATE_PARKED = 4;

export const BID_STATE_BY_BYTE: Readonly<Record<number, BidState>> = {
  [ChainBidState.Sealed]: "sealed",
  [ChainBidState.Revealed]: "revealed",
  [ChainBidState.Invalid]: "invalid",
  [ChainBidState.Done]: "done",
  [BID_STATE_PARKED]: "parked",
};

/* LaunchClosed.reason: always 0, WindowElapsed. Nothing about deposits closes the book. */
export type CloseReason = "windowElapsed";

export interface TokenMeta {
  mint: string;
  name: string;
  symbol: string;
  decimals: number;
  description: string;
  creator: string;
  links?: { website?: string; x?: string; telegram?: string };
  /* Mock only. Points the holder map at a real mint so the embed renders. Real launches use mint. */
  holderMapAddress?: string;
  /* Token image: the metadata URI's image, the site's own /api/token/<hash> for a launch created since 2026-10-16 (chain/metadata.ts fetches it best effort). */
  image?: string;
}

/* Config account. PDA ["config"], 632 bytes (ACCOUNTS.Config). One per deployment. Its values are copied into a launch at genesis (lp_owner, abort_after_secs, delivery_fee_bps, creator_lp_bps, crank_bond, and since 0.28 raise_fee_bps and raise_fee_creator_share_bps); the copies are what the launch runs on. */
export interface ConfigAccount {
  address: string;
  version: number;
  /* Byte 10. While 1, create_launch is refused (EmergencyUpdatePaused 6000) and nothing else changes; every running launch proceeds. Disclosed wherever a launch can be created. */
  emergencyUpdatePause: boolean;
  /* Offset 112: when the pause was last set, unix seconds. 0 never. */
  emergencyUpdatePauseTs: number;
  /* Can set the pause and update this account, nothing else. 0.24: set at init_config to the program's upgrade authority; changed only by propose_admin then accept_admin by the proposed key. */
  admin: string;
  /* Receives the protocol's lock position NFT at lock_liquidity side 1, and the swept creator fee. 0.24: copied into each launch at genesis, and collect_platform_fees pays the launch's copy; changed only by admin_update_config proposing then accept_lp_owner signed by the proposed key. */
  lpOwner: string;
  /* 0.24, offsets 120 and 152: a proposed admin or fee destination that has not yet accepted. The zero key when none is pending. */
  pendingAdmin: string;
  pendingLpOwner: string;
  /* v0.30, offset 324: the treasury (the Ledger, FOUNDER-DECISIONS): the raise fee's platform part and 60% of the platform's trading fees; changed only by admin_update_config proposing then accept_treasury signed by the proposed key (offset 356, the zero key when none is pending). */
  treasury: string;
  pendingTreasury: string;
  /* Lamports the float is worth at tick 0, and the least a launch can raise. 5 SOL in production, 0.05 SOL on devnet. */
  floorValue: bigint;
  /* Lamports. 0.02 SOL in production, 0.001 SOL on devnet. */
  minBid: bigint;
  /* Seconds after the window end (since 0.22 never from settlement: lib.rs recovery_deadline) before abort may be called. 43,200 in production, 600 on devnet. */
  abortAfterSecs: number;
  /* Basis points of a pushed delivery's tokens paid to whoever pushes. 50. Claims are free. */
  deliveryFeeBps: number;
  /* Basis points of the LP locked for the creator's position, the rest for the protocol's. 5,000. */
  creatorLpBps: number;
  /* Lamports the creator posts at genesis: what opening the pool on Meteora costs. Paid to whoever opens the pool; returned to the creator if the launch fails or is aborted. 0.181 SOL. */
  crankBond: bigint;
  /* 0.28, offsets 184 and 186: the raise fee, basis points of the cleared raise taken in SOL when the pool opens (100), and the creator's share of it in basis points of the fee (6,000); the platform's part is the rest. Copied into each launch at genesis. */
  raiseFeeBps: number;
  raiseFeeCreatorShareBps: number;
  /* 0.29, offset 188: the attestation services' public keys (three slots, the unused ones zero and left out here). commit accepts an attestation signed by any of them, read live. */
  attestors: string[];
  /* 0.29, offset 284: whether new launches require the bid attestation (copied into Launch.attest_required at genesis). */
  attestBids: boolean;
  /* 0.29, offset 292: the processing charge new launches copy at genesis. */
  processingCharge: bigint;
  /* v0.30, offset 300: the reveal margin create_launch checks the round against (60 to 300 s); a create aims with this, never the pin's. */
  revealMarginSecs: number;
}

/* 0.29: the per-tick revealed deposits, PDA ["hist", launch], 19,272 bytes, kept for good (the creator's rent, never returned). */
export interface HistogramAccount {
  address: string;
  /* TICK_COUNT entries, lamports; zero until reveal. */
  counts: readonly bigint[];
}

/* Launch account. PDA ["launch", token_mint], 1,376 bytes since 0.29 (ACCOUNTS.Launch; 9,568 before, with the per-tick deposits inside). */
export interface LaunchAccount {
  address: string;
  /* 0.19: the salt of the mint PDA; 0 on a launch created under 0.18. */
  mintSalt: bigint;
  /* 0.19: name, symbol and URI from the Launch account, or null on a launch created under 0.18 (its names are in Metaplex metadata). */
  meta: { name: string; symbol: string; uri: string } | null;
  state: LaunchState;
  /* Byte 11. 1 once settle wrote a record, never cleared, so it survives an abort. When 1, refund, claim and abort must carry the settlement record. */
  settled: boolean;
  /* The round signature has been verified and stored. */
  beaconPosted: boolean;
  /* Set by commit when the creator bids, never cleared. */
  creatorHasBid: boolean;
  /* No rights after genesis. Receives the crank bond back after a failure or an abort, and the creator's lock NFT. */
  creator: string;
  /* Mint authority revoked, freeze authority none. */
  tokenMint: string;
  tokenVault: string;
  /* Token atoms offered to bidders. Always half the supply (FLOAT). */
  float: bigint;
  /* Lamports the whole float is worth at tick 0: the floor, and the least the launch can raise. Copied from the config at genesis. */
  floorValue: bigint;
  /* Minimum deposit per bid, copied from the config at genesis. */
  minBid: bigint;
  /* The create transaction's block time. */
  openTs: number;
  /* The creator's window in seconds, 300 to 3600. Fixed once set: the book closes at open_ts + window_secs on the cluster clock. */
  windowSecs: number;
  /* Unix timestamp the book closed (the close instruction's block time). 0 while open. */
  closeTs: number;
  /* drand quicknet round every bid is sealed to. Fixed at genesis. */
  revealRound: bigint;
  /* The drand identity for revealRound: hash to curve on G1 of sha256(round as u64 big endian), compressed, 48 bytes. Derived and verified on chain since v0.14. */
  roundPoint: Uint8Array;
  /* The round's signature, 48 bytes, once post_beacon ran. Null before. */
  beaconSignature: Uint8Array | null;
  /* Lamports held for bidders. Excludes the vault's rent and the crank bond. */
  totalDeposits: bigint;
  bidCount: number;
  /* Bids decrypted. */
  revealedCount: number;
  /* Bids that did not open. Refunded in full, excluded from clearing. */
  invalidCount: number;
  /* Bids closed by deliver or refund (or a claim, before v0.30), in any state. */
  distributedCount: number;
  /* Public during the window. */
  largestDeposit: bigint;
  /* Genesis copies of the config. What the launch runs on: abort checks this valve, deliver takes this fee, lock_liquidity applies this split, this wallet receives the protocol's lock NFT. A config change never reaches a running launch. */
  lpOwner: string;
  abortAfterSecs: number;
  deliveryFeeBps: number;
  creatorLpBps: number;
  /* 0 while the operating prepay sits in the vault, 1 once create_pool paid it whole to the pool's payer (0.16 to 0.21), 2 once burn_unsold returned the remainder to the creator, 3 (0.23) once lock_liquidity returned it, with the finalize allowance held back. */
  bondState: number;
  /* Lamports the creator posted at genesis. */
  crankBond: bigint;
  /* 0.22: how much of crankBond (the operating prepay) has been paid to the signers of the steps after the window. The rest goes back to the creator at finalize. */
  opsPaid: bigint;
  /*
    0.26: how a pushed delivery is paid for. 1 on a launch created by 0.26: no tokens are taken; the bid account's rent repays the pusher
    the token account rent it fronted plus deliveryReward lamports, and the winner gets the rest. 0 on every launch created before
    (the pusher takes deliveryFeeBps of the tokens and the winner gets the whole bid account). Read from the launch, never from the config.
  */
  deliveryTerms: number;
  deliveryReward: bigint;
  /* 0.29, offset 648: 1 when every bid needs the attestation (an Ed25519 instruction just before commit), copied from Config.attest_bids at genesis; 0 when not required or once waived. */
  attestRequired: boolean;
  /* 0.29, offset 656: the processing charge every bid on this launch pays, copied from the config at genesis. commit sends it as the ceiling. */
  processingCharge: bigint;
  /* 0.29, offset 664: the lamports the creator paid for the histogram (its rent, never returned). 0 until grow_histogram landed. */
  histogramRent: bigint;
  /* 0.29, offset 672: when the operator's multisig waived the attestation on this launch, unix seconds; 0 if never. */
  attestWaivedTs: number;
  /* 0.29, offset 680: the histogram reached its full size (grow_histogram landed). commit refuses HistogramNotReady (6071) while false. */
  histogramGrown: boolean;
  /* 0.29, the eleventh candidate, offset 688: the part of the prepay's return lock_liquidity held back for finish_mint (METADATA_RESERVE_LAMPORTS while the mint is not finished), paid out by finish_mint. */
  metadataReserve: bigint;
  /* 0.29, the eleventh candidate, offset 696: finish_mint landed (the token's metadata written, the mint authority revoked). */
  mintFinished: boolean;
  /* v0.30, offset 704 (v030.ts): 0 a pool from before 0.30, 1 frozen since create_pool, 2 open (open_trading landed). */
  tradingState?: number;
  /* v0.30, offset 712: the treasury recorded at genesis, null on a launch created before 0.30 (its raise fee part goes to lpOwner). */
  treasury?: string | null;
  /* v0.32, offsets 784 and 792: the bids parked and not yet collected or pushed, and the lamports they hold in the vault (0 on a launch from before 0.32). */
  parkedCount?: number;
  parkedLamports?: bigint;
  /* 0.28, offsets 8832 and 8834: the raise fee terms the creator signed, copied from the config at genesis. 0 and 0 on every launch created before 0.28, which pays no fee and opens its pool at the clearing price. */
  raiseFeeBps: number;
  raiseFeeCreatorShareBps: number;
}

/* Bid account. PDA ["bid", launch, bidder], 324 bytes (ACCOUNTS.Bid). One bid per wallet per launch. Closed to the bidder when done. */
export interface BidAccount {
  address: string;
  state: BidState;
  /* Bit 0: reserved since v0.30 (it was the claim flag; commit refuses it, ClaimRemoved 6083, and every bid is pushed). Bit 1: the launch creator's bid, set by the program at commit whatever the client passed. */
  flags: number;
  bidder: string;
  launch: string;
  /* Lamports deposited. Public from the moment the bid lands. */
  deposit: bigint;
  placedTs: number;
  /* drand IBE ciphertext, 128 bytes: U (96) || V (16) || W (16). See ./seal.ts. */
  sealed: Uint8Array;
  /* Reserved, 32 zero bytes. */
  commitment: Uint8Array;
  /* Tick recovered at reveal, 0 to MAX_TICK (2406 since 0.29). Null while sealed or invalid. */
  tick: number | null;
  /*
    v0.32: a parked bid's payout, held for the bidder: the tokens (atoms, zero for a loser) and the lamports, net of the parker's reward. Only on state "parked".
    tick: the Bid's tick bytes as park_bid left them (it never writes them): where reveal wrote the step, or 0 for a bid that never opened. Not
    a maximum to show by itself; the book takes it only where it predicts the tokens held (view.ts openedTick, the final E2E's S1).
  */
  parked?: { tokens: bigint; lamports: bigint; tick?: number };
  /* 0.22: lamports paid at commit on top of the deposit for opening this bid; paid to whoever opens it, or returned with the deposit if nobody does. 0 on bids placed before 0.22. */
  processingCharge: bigint;
}

/* Bid.flags, from the generated BidFlags. Bit 1 is the program's: set at commit when the bidder is Launch.creator, so the label is never inferred by comparing keys. */
export { BidFlags } from "@contract/constants";

export function isCreatorBid(b: Pick<BidAccount, "flags">): boolean {
  return (b.flags & 2) !== 0;
}


/* Settlement record. PDA ["settlement", launch], 784 bytes (ACCOUNTS.SettlementRecord). Written by settle, updated by deliver, claim, create_pool, lock_liquidity and burn_unsold. Exists only for a launch that cleared; a failed launch has none. */
export interface SettlementRecord {
  address: string;
  launch: string;
  clearingTick: number;
  /* At least clearingTick: bids above it fill in full, bids at it are rationed pro rata, bids below it get nothing. */
  marginalTick: number;
  /* Lamports the whole float is worth at the clearing tick. The clearing price is this / float; every winner paid it. It funds the pool: all of it until 0.27; since 0.28 this less the raise fee paid (poolSolIn). */
  floatValue: bigint;
  /* Sum of revealed deposits at or above the clearing tick. */
  winningDeposits: bigint;
  /* Revealed deposits strictly above the marginal tick, under floatValue. These fill in full. */
  aboveDeposits: bigint;
  /* Revealed deposits at the marginal tick, the divisor for the marginal fills. */
  atDeposits: bigint;
  revealedBids: number;
  /* Refunded in full, excluded from clearing. */
  invalidBids: number;
  settledTs: number;
  /* Running total as deliver and claim run. */
  tokensDelivered: bigint;
  /* Bids closed since settlement, by deliver, claim or refund. Equals Launch.distributed_count once every bid is closed. */
  distributedBids: number;
  /* Largest bidder share = this / float. */
  largestFillTokens: bigint;
  /* The Meteora DAMM v2 pool. Null until create_pool. */
  pool: string | null;
  /* Atoms burned at finalize: the float's rounding remainder, at most one atom per filled bidder. Zero only when every fill divided exactly. */
  burnedTokens: bigint;
  /* The creator's own bid. Zero and state 0 when the creator did not bid; state 2 when its ciphertext did not open. */
  creatorDeposit: bigint;
  creatorTokens: bigint;
  creatorCost: bigint;
  creatorTick: number;
  creatorBidState: 0 | 1 | 2;
  /* Bit 0 the creator's LP position is locked, bit 1 the protocol's. 3 before burn_unsold will run. */
  lpLockState: number;
  /* LP tokens the pool minted at create_pool, split by the launch's creator_lp_bps at lock_liquidity. */
  lpTotal: bigint;
  /* Mints of the two lock position NFTs, null until each side is locked. The holder of each collects that position's trading fees from Raydium. */
  creatorLockNft: string | null;
  protocolLockNft: string | null;
  /* Offset 264: lamports on the pool's SOL side when it opened: what the program wrapped for the pool (floatValue until 0.27, poolSolIn since 0.28) less dust_lamports (Meteora does not count SOL strangers send to its vault (INTERFACE 485, 642), so on every Meteora launch (0.19 on) the pool opens exactly on what was wrapped less the dust). Opening price per token is this / POOL_RESERVE; opening market cap 2 times this. */
  poolSolAtOpen: bigint;
  /* 0.21: reserve atoms the opening left in pool_tokens; burn_unsold burns them. */
  dustTokensBurned: bigint;
  /* 0.20: who landed create_pool; lock_liquidity returns the unused rent loan to it. Null before create_pool. */
  poolPayer: string | null;
  /* v0.30, offset 408: when open_trading (or the admin's forced open, offset 416) thawed the pool, unix seconds; 0 until then and on every pool from before 0.30. */
  openedTs?: number;
  openedForced?: boolean;
  /* 0.23: lamports create_pool lent the pool creator PDA, recorded when lent; lock_liquidity repays the pool payer this less what it returns. 0 on records written before 0.23. */
  poolLoan: bigint;
  /*
    0.28, offsets 360 to 399. settle agrees the raise fee from the launch's terms:
    raiseFeeCreator = floor(floor(floatValue x raiseFeeBps / 10,000) x share / 10,000), raiseFeePlatform the rest of the fee.
    create_pool pays them (the paid figures; 0 when the destination could not hold the part rent exempt, and then it stayed in the pool)
    and records poolSolIn, the proceeds wrapped for the pool: floatValue less the two parts paid. Before the pool opens the paid
    figures and poolSolIn read 0. A launch created before 0.28 agrees no fee (both parts 0); if its pool opened under 0.28,
    poolSolIn reads floatValue, and 0 if it opened before the upgrade. So poolSolIn is not a marker of a fee launch: the agreed parts are.
  */
  raiseFeeCreator: bigint;
  raiseFeePlatform: bigint;
  raiseFeeCreatorPaid: bigint;
  raiseFeePlatformPaid: bigint;
  poolSolIn: bigint;
  /*
    0.29, the twelfth candidate (Astra's F2), offset 400: release_pool_cash ran (three days after settlement, the
    creator's split not landed). It closed the pass through and settled the pool payer and the creator's prepay, so a
    later lock_liquidity takes the program id in its payer_wsol slot and does the split and the NFT alone, its payer
    unpaid. False on every record written before.
  */
  cashReleased: boolean;
}

/* What the site shows for one launch. Account plus metadata the chain does not hold. */
export interface Launch {
  /* URL slug. */
  id: string;
  token: TokenMeta;
  account: LaunchAccount;
  /* Whether the SettlementRecord PDA exists. Finalized without one is a launch that failed or was aborted and has had every refund pushed and the supply burned. */
  recordExists: boolean;
  /* The record as decoded in the same read that found it (the board's one batched call, or the launch's own read). Null when it does not exist. Its clearing figures never change after settle; payout counters on it may be behind, so pages that show those read the record again. */
  record: SettlementRecord | null;
  /* False when the account on chain is shorter than the v0.18 layout: created under an older program version, refused by the program (Anchor 3003). The page decodes nothing and says so. */
  readable: boolean;
}

/* Input to the commit instruction, before sealing. The tick is sealed on the device; see ./seal.ts. */
export interface CommitInput {
  launchId: string;
  deposit: bigint;
  /* 0.25: the most the bidder agreed to pay as the processing charge, in lamports: the figure the bid page showed (the pin's). A ceiling; the program takes its own charge and refuses ProcessingChargeAboveMaximum (6067) if that is higher. */
  maxProcessingCharge: bigint;
  /* The bidder's maximum, as a tick on the launch grid, 0 to MAX_TICK (2406 since 0.29). */
  tick: number;
  /* 0.29: the bot check's signed message for this launch and wallet (lib/bouncer/attest.ts), required when the launch's attest_required is set; its Ed25519 instruction goes immediately before commit. */
  permit?: Permit | null;
  /* 24g: the priority price (micro-lamports a unit) the bid page showed and took out of what is sent (hooks.ts useFinalPrice); bounded again when the transaction is built. Absent: the client reads the shared send context itself, as before. */
  priceMicroLamports?: number;
}

/*
  commit can succeed without placing a bid: if the book was already closeable
  it closes it, takes nothing, and returns. The client reads the launch state
  after the transaction rather than assuming a bid was placed.
*/
export type CommitResult =
  | { kind: "placed"; bid: BidAccount; signature: string }
  /* networkFee (24e, bug B): what the transaction paid the network, lamports, exact: the signatures' fees and any priority fee the site set (terms.ts). */
  | { kind: "closedInstead"; reason: CloseReason; signature: string; networkFee: bigint };

/*
  The creator form. Four fields and nothing else: name, ticker, image, window.
  The floor is protocol wide, every launch is quoted in SOL, the float is half
  the supply. None of that is a choice, so none of it is here.
*/
/*
  0.25, LaunchTerms: the config values a launch copies (six since 0.25; the raise fee and its creator share since 0.28, eight), as the creator was
  shown them. create_launch carries them and the program refuses TermsChanged
  (6066) unless the config equals them when it executes; the launch and the
  prepay then take their values from these, never from the config.
*/
export interface LaunchTerms {
  floorValue: bigint;
  minBid: bigint;
  abortAfterSecs: number;
  deliveryFeeBps: number;
  creatorLpBps: number;
  /* The operating prepay debited from the creator at genesis. */
  crankBond: bigint;
  /* 0.28: the raise fee and the creator's share of it, the seventh and eighth terms (Config bytes 184 to 187). */
  raiseFeeBps: number;
  raiseFeeCreatorShareBps: number;
}

export interface CreateLaunchInput {
  /* 0.25: the terms that were on the creator's screen when they pressed create. Required: the client never reads the config for them at send time. */
  terms: LaunchTerms;
  /* At most 32 bytes (BOUNDS.maxName), counted in UTF-8 bytes, not characters. */
  name: string;
  /* At most 10 bytes (BOUNDS.maxSymbol). */
  symbol: string;
  /* The picture as the data URL the form read. Stored through /api/token before the transaction (lib/bouncer/tokenUpload.ts); never sent on chain. Null only for a simulation. */
  image: string | null;
  /* 300 to 3600. */
  windowSecs: number;
  /* The metadata URI the upload answered (/api/token/<hash>.json), at most 200 bytes (BOUNDS.maxUri). Empty for a simulation. */
  uri?: string;
  /* 0.29, the seventh candidate: the bot check's token, spent on the creation permit (lib/bouncer/attest.ts). Absent for a cost estimate. */
  botToken?: string | null;
}

/* Delivered, from the event the program emits on deliver and claim: what actually left the vault for this bid, and the fee a pushed delivery took (0 on a claim). */
export interface Delivery {
  bid: string;
  bidder: string;
  /* Tokens the fill was worth, before the fee. */
  tokens: bigint;
  /* The deposit less what came back. Null when the delivery was read from its transaction and the bid's commit is not in the history the RPC serves. */
  cost: bigint | null;
  refund: bigint;
  /* Tokens out of `tokens` that went to whoever pushed. 0 on a claim. What arrived is tokens minus this. */
  feeTokens: bigint;
  /* False when the node's answer did not settle the amounts (no inner instructions and no token balances): tokens, refund and feeTokens are then 0 and mean nothing; the payout itself is certain. */
  settled: boolean;
  /* The bidder claimed it themselves (no fee) rather than having it pushed. */
  claimed: boolean;
  signature: string;
  blockTime: number | null;
}

/*
  A bid whose account is gone. deliver, refund and claim close the Bid to the
  bidder (INTERFACE, Bid account), so after distribution the book is only in
  the events: BidRevealed carries the tick, Delivered or Refunded what left.
*/
export interface ClosedBid {
  bid: string;
  bidder: string;
  deposit: bigint;
  /* From BidRevealed; null when the bid never opened (BidInvalid) or the reveal was not found in the log. */
  tick: number | null;
  /* From BidInvalid. */
  invalid: boolean;
  delivered: Delivery | null;
  refunded: { amount: bigint; signature: string; settled: boolean } | null;
  creator: boolean;
}

/* A history read in progress: landed transactions read so far, of how many, and how many the node listed and then did not return. */
export interface HistoryProgress {
  read: number;
  total: number;
  missing: number;
  /* False when the node's list ended before the launch's creation (a ledger that starts later); null until judged. */
  complete: boolean | null;
}

/* PoolCreated, from the event: who opened the pool and what it opened with. */
export interface PoolOpening {
  pool: string;
  cranker: string;
  crankBond: bigint;
  poolSolAtOpen: bigint;
  floatValue: bigint;
  signature: string;
  blockTime: number | null;
}

/* The lifecycle steps any wallet may push by hand, in order (INTERFACE v0.21). refundFor and deliver name a bidder. */
export type PushStep = "close" | "beacon" | "reveal" | "settle" | "createPool" | "finishMint" | "lock" | "deliver" | "refundFor" | "openTrading" | "finalize";

/* The one button after the window (chain/drive.ts): what a press does, in how many transactions and wallet prompts, and what the signer fronts. */
export interface DrivePlan {
  /* finish: the beacon, the reveals, settle and the pool; pool: the pool alone (Settled); lock: the creator's liquidity (Pool live, not locked), with finish_mint first while it is due; mint: finish_mint alone (Pool live and locked, the mint authority still held; 0.29, the ninth candidate). */
  kind: "finish" | "pool" | "lock" | "mint";
  /* Unix seconds before which nothing can start (the reveal round's publication), 0 when nothing waits. */
  notBefore: number;
  beaconDue: boolean;
  sealed: number;
  settles: boolean;
  opensPool: boolean;
  /* finish_mint goes in: the token's metadata written and its mint authority revoked. */
  finishesMint: boolean;
  locks: boolean;
  transactions: number;
  prompts: number;
  /* Lamports the signer fronts on top of the fees; the creator's operating prepay repays them in the same transactions. */
  front: bigint;
  labels: string[];
}

export interface DriveResult {
  transactions: { label: string; signature: string; confirmedAt: number }[];
  prompts: number;
  /* When the reveal round was published, unix seconds, when the press posted it. */
  roundAt: number | null;
  /* Date.now() at the confirmation of the transaction that created the pool. v0.30: nothing trades until open_trading (SettlementRecord.opened_ts). */
  poolAt: number | null;
  /* create_pool and lock_liquidity landed in one transaction. */
  bundledPool: boolean;
}

export interface BouncerClient {
  getConfig(): Promise<ConfigAccount>;
  listLaunches(): Promise<Launch[]>;
  getLaunch(id: string): Promise<Launch | null>;
  /* The client's current copy of a launch, synchronously, for useSyncExternalStore. Null until it has been read. */
  peekLaunch(id: string): Launch | null;
  /* When the RPC has answered that it holds no launch at this address: the time of that answer. Null before the first answer, or when a launch is there. */
  peekMissing(id: string): number | null;
  subscribeLaunch(id: string, onChange: (launch: Launch | null) => void): () => void;
  /* Every bid account for a launch. Ticks are null while sealed. A closed bid is absent. */
  getBids(id: string): Promise<BidAccount[]>;
  /* 24n: the newest `count` bid accounts by placed_ts, for the deposit feed (a small shared read). */
  getRecentBids(id: string, count: number): Promise<BidAccount[]>;
  /* 24n: read the launch again now, then every second a few times, until a copy at or past minSlot (or one passing test) reaches every subscriber. */
  refreshLaunch(id: string, until?: { minSlot?: number; test?: (l: Launch) => boolean }): Promise<void>;
  getSettlement(id: string): Promise<SettlementRecord | null>;
  /* Rent the cluster charges to hold an account of this many bytes, lamports. Read from the RPC, never typed. */
  getRent(bytes: number): Promise<bigint>;
  /* Every event in a launch's whole history, oldest first: payouts and commits read from the transactions, the rest from the program's log lines. Read incrementally and cached. */
  getEvents(id: string): Promise<DecodedEvent[]>;
  /* The events of one wallet's bid on a launch, from the bid account's own few transactions. */
  getBidEvents(launchId: string, bidder: string): Promise<DecodedEvent[]>;
  /* How far the read of a launch's history has got. Null before it starts. */
  historyProgress(id: string): HistoryProgress | null;
  /* The events a read in progress has found so far, oldest first; the last complete read once it has ended. */
  peekEvents(id: string): DecodedEvent[];
  /* Delivered events for a launch, by bid address. */
  getDeliveries(id: string): Promise<Map<string, Delivery>>;
  getPoolCreated(id: string): Promise<PoolOpening | null>;
  /* Seals the tick on the device and sends one commit transaction through the signer. */
  commit(input: CommitInput, signer: TxSigner, opts?: SendOptions): Promise<CommitResult>;
  /* create_launch. Genesis is the auction: mint, vault, revoke, open, in one transaction the creator signs. Costs the creator the crank bond plus the rents. */
  /* earlier: an earlier attempt by this creator, whose outcome was unknown, had landed; nothing new was sent. */
  createLaunch(input: CreateLaunchInput, signer: TxSigner, opts?: SendOptions): Promise<{ id: string; signature: string; earlier?: boolean }>;
  /* What genesis will cost this creator, simulated on the cluster: bond, rents, Metaplex's fee, the transaction fee. Throws a fixed sentence, never the RPC's words (the founder's item 17). */
  estimateCreateCost(input: CreateLaunchInput, creator: string): Promise<bigint>;
  /* A wallet's SOL balance in lamports, confirmed: the create page reads it before simulating, so an empty wallet is told so instead of a refusal. */
  getBalanceLamports(address: string): Promise<bigint>;
  getMyBid(launchId: string, bidder: string): Promise<BidAccount | null>;
  /* Which of these launches still hold a bid account for this wallet: where its deposit sits. One read per hundred launches. */
  getMyBids(launchIds: string[], bidder: string): Promise<Set<string>>;
  /* Every winner traced back through SOL transfers for a funding source shared with the creator. Null until the launch has a record. */
  getFundingReport(id: string, bidders: readonly string[]): Promise<FundingReport | null>;
  /* The age of a launch's creator wallet: its first transaction, as far back as the RPC's history reaches (walletAge.ts). Through the site's route, which reads it once per creator; kept for the session. */
  getCreatorAge(launchId: string, creator: string): Promise<WalletAge>;
  /* 0.29: the launch's histogram (the per-tick revealed deposits), null when it is not there at its full size. A settled launch's never changes, so it is kept for the session. */
  getHistogram(launchId: string): Promise<HistogramAccount | null>;
  /* 0.29: grow_histogram alone, for a launch whose create landed without its second step; only its creator can send it. */
  finishSetup(launchId: string, signer: TxSigner, opts?: SendOptions): Promise<{ signature: string }>;
  /*
    refund: the signer's own bid back in full. Allowed for every bid of a failed or aborted launch, and from Settled onward for a losing or invalid bid; a winning bid is refused (IsAWinner) until the pool is live, when it is delivered or claimed instead. Nothing leaves in Open or Closed (NotRefundable). The record goes in the transaction whenever the launch has one.
  */
  refund(launchId: string, signer: TxSigner, opts?: SendOptions): Promise<{ signature: string; slot?: number }>;
  /* v0.32: the bidder collects a parked payout (chain/parked.ts). */
  collectParked(launchId: string, signer: TxSigner, opts?: SendOptions): Promise<{ signature: string; slot?: number; tokens: bigint; lamports: bigint }>;
  /* 9C (the founder, 2026-10-27): one wallet's balance change in a landed transaction, from the node's pre and post balances (chain/balance.ts); null when the node does not serve it after a few tries, the transaction failed or the wallet is not in it. */
  walletChange(signature: string, address: string): Promise<bigint | null>;
  /* abort: the kill switch, abort_after_secs after the window end while Open or Closed, or after settled_ts while Settled; never once a pool exists. The first call ends the launch for everyone. Carries the record once the launch has one. */
  abort(launchId: string, signer: TxSigner, opts?: SendOptions): Promise<{ signature: string }>;
  /* One lifecycle step by hand, sent by any wallet. */
  push(launchId: string, step: PushStep, signer: TxSigner, opts?: SendOptions, bidder?: string): Promise<{ signature: string }>;
  /* Everything due after the window in the fewest transactions, signed in one prompt where the wallet allows (chain/drive.ts). */
  drive(launchId: string, signer: TxSigner, opts?: SendOptions): Promise<DriveResult>;
  /* The plan for that press, from what the page already holds; no RPC. Null when nothing is due. */
  drivePlan(launch: Launch, bids: BidAccount[], record: SettlementRecord | null, payer: string, signer: TxSigner | null, genesis: string | null, mintHeld?: boolean): DrivePlan | null;
  /* 0.29, the ninth candidate: whether the launch's mint still has its authority (finish_mint due); null before a mint exists or when unreadable. */
  mintAuthorityHeld(launchId: string, view?: boolean): Promise<boolean | null>;
}
