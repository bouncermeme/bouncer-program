/*
  Account decoders. Every offset and size is ACCOUNTS.<name>.fields.<field>
  from the pin; nothing is counted here. An account shorter than its layout
  or with another discriminator decodes to null: the page says the launch was
  created under an older program version (checklist A-08, C-31) instead of
  reading garbage.

  0.29: a Launch must be exactly its length. The 0.29 layout moved every
  field after offset 296 by 8,192 bytes and kept the discriminator, so a
  0.28 launch (9,568 bytes) is longer than the layout and would decode
  garbage; the program refuses it too (LaunchLayoutUnknown, 6078). The
  per-tick deposits are the Histogram account's (decodeHistogram).
*/
import { ACCOUNTS, TICK_COUNT } from "@contract/constants";
import { BID_STATE_BY_BYTE, LAUNCH_STATE_BY_BYTE, type BidAccount, type ConfigAccount, type HistogramAccount, type LaunchAccount, type SettlementRecord } from "../types";
import { isZero, readBytes, readI64, readPubkey, readU16, readU32, readU64, readU8 } from "./borsh";

type AccountName = keyof typeof ACCOUNTS;
interface Field {
  offset: number;
  size: number;
  type: string;
}

function layout(name: AccountName): { len: number; discriminator: readonly number[]; f: Record<string, Field> } {
  const a = ACCOUNTS[name];
  return { len: a.len, discriminator: a.discriminator, f: a.fields as unknown as Record<string, Field> };
}

/* Whether the bytes are an account of this layout: long enough, with the pin's discriminator. */
export function isAccount(name: AccountName, data: Uint8Array): boolean {
  const { len, discriminator } = layout(name);
  if (data.length < len) return false;
  if ((name === "Launch" || name === "Histogram") && data.length !== len) return false;
  for (let i = 0; i < discriminator.length; i++) if (data[i] !== discriminator[i]) return false;
  return true;
}

const ZERO_KEY = "11111111111111111111111111111111";

export function decodeConfig(address: string, data: Uint8Array): ConfigAccount | null {
  if (!isAccount("Config", data)) return null;
  const { f } = layout("Config");
  return {
    address,
    version: readU8(data, f.version.offset),
    emergencyUpdatePause: readU8(data, f.emergency_update_pause.offset) !== 0,
    emergencyUpdatePauseTs: readI64(data, f.emergency_update_pause_ts.offset),
    admin: readPubkey(data, f.admin.offset),
    lpOwner: readPubkey(data, f.lp_owner.offset),
    pendingAdmin: readPubkey(data, f.pending_admin.offset),
    pendingLpOwner: readPubkey(data, f.pending_lp_owner.offset),
    floorValue: readU64(data, f.floor_value.offset),
    minBid: readU64(data, f.min_bid.offset),
    abortAfterSecs: Number(readU64(data, f.abort_after_secs.offset)),
    deliveryFeeBps: readU16(data, f.delivery_fee_bps.offset),
    creatorLpBps: readU16(data, f.creator_lp_bps.offset),
    crankBond: readU64(data, f.crank_bond.offset),
    raiseFeeBps: readU16(data, f.raise_fee_bps.offset),
    raiseFeeCreatorShareBps: readU16(data, f.raise_fee_creator_share_bps.offset),
    attestors: [0, 1, 2].map((i) => readPubkey(data, f.attestors.offset + 32 * i)).filter((k) => k !== ZERO_KEY),
    attestBids: readU8(data, f.attest_bids.offset) !== 0,
    processingCharge: readU64(data, f.processing_charge.offset),
    revealMarginSecs: readU32(data, f.reveal_margin_secs.offset),
    /* v0.30, offsets 324 and 356: the platform's destination for the raise fee's part and the trading fees' 60%, and a proposed one (the zero key when none). */
    treasury: readPubkey(data, f.treasury.offset),
    pendingTreasury: readPubkey(data, f.pending_treasury.offset),
  };
}

export function decodeLaunch(address: string, data: Uint8Array): LaunchAccount | null {
  if (!isAccount("Launch", data)) return null;
  const { f } = layout("Launch");
  const state = LAUNCH_STATE_BY_BYTE[readU8(data, f.state.offset)];
  if (!state) return null;
  const sigOff = f.beacon_signature.offset;
  return {
    address,
    state,
    settled: readU8(data, f.settled.offset) !== 0,
    beaconPosted: readU8(data, f.beacon_posted.offset) !== 0,
    creatorHasBid: readU8(data, f.creator_has_bid.offset) !== 0,
    creator: readPubkey(data, f.creator.offset),
    tokenMint: readPubkey(data, f.token_mint.offset),
    tokenVault: readPubkey(data, f.token_vault.offset),
    float: readU64(data, f.float.offset),
    floorValue: readU64(data, f.floor_value.offset),
    minBid: readU64(data, f.min_bid.offset),
    openTs: readI64(data, f.open_ts.offset),
    windowSecs: readI64(data, f.window_secs.offset),
    closeTs: readI64(data, f.close_ts.offset),
    revealRound: readU64(data, f.reveal_round.offset),
    roundPoint: readBytes(data, f.round_point.offset, f.round_point.size),
    beaconSignature: isZero(data, sigOff, f.beacon_signature.size) ? null : readBytes(data, sigOff, f.beacon_signature.size),
    totalDeposits: readU64(data, f.total_deposits.offset),
    bidCount: readU32(data, f.bid_count.offset),
    revealedCount: readU32(data, f.revealed_count.offset),
    invalidCount: readU32(data, f.invalid_count.offset),
    distributedCount: readU32(data, f.distributed_count.offset),
    largestDeposit: readU64(data, f.largest_deposit.offset),
    lpOwner: readPubkey(data, f.lp_owner.offset),
    abortAfterSecs: Number(readU64(data, f.abort_after_secs.offset)),
    deliveryFeeBps: readU16(data, f.delivery_fee_bps.offset),
    creatorLpBps: readU16(data, f.creator_lp_bps.offset),
    bondState: readU8(data, f.bond_state.offset),
    crankBond: readU64(data, f.crank_bond.offset),
    opsPaid: readU64(data, f.ops_paid.offset),
    deliveryTerms: readU8(data, f.delivery_terms.offset),
    deliveryReward: readU64(data, f.delivery_reward.offset),
    raiseFeeBps: readU16(data, f.raise_fee_bps.offset),
    raiseFeeCreatorShareBps: readU16(data, f.raise_fee_creator_share_bps.offset),
    attestRequired: readU8(data, f.attest_required.offset) !== 0,
    processingCharge: readU64(data, f.processing_charge.offset),
    histogramRent: readU64(data, f.histogram_rent.offset),
    attestWaivedTs: readI64(data, f.attest_waived_ts.offset),
    histogramGrown: readU8(data, f.histogram_grown.offset) !== 0,
    metadataReserve: readU64(data, f.metadata_reserve.offset),
    mintFinished: readU8(data, f.mint_finished.offset) !== 0,
    tradingState: readU8(data, f.trading_state.offset),
    treasury: keyOrNull(readPubkey(data, f.treasury.offset)),
    parkedCount: readU32(data, f.parked_count.offset),
    parkedLamports: readU64(data, f.parked_lamports.offset),
    mintSalt: readU64(data, f.mint_salt.offset),
    meta: launchMeta(data, f),
  };
}

/* 0.19: name, symbol and URI in the Launch account, length-prefixed. A launch created under 0.18 reads zero lengths here and keeps its names in Metaplex metadata. */
function launchMeta(data: Uint8Array, f: Record<string, { offset: number; size: number }>): { name: string; symbol: string; uri: string } | null {
  const text = (field: string, lenField: string) => {
    const len = Math.min(readU8(data, f[lenField].offset), f[field].size);
    return new TextDecoder().decode(data.subarray(f[field].offset, f[field].offset + len));
  };
  const name = text("name", "name_len");
  if (!name) return null;
  return { name, symbol: text("symbol", "symbol_len"), uri: text("uri", "uri_len") };
}

export function decodeBid(address: string, data: Uint8Array): BidAccount | null {
  if (!isAccount("Bid", data)) return null;
  const { f } = layout("Bid");
  const state = BID_STATE_BY_BYTE[readU8(data, f.state.offset)];
  if (!state) return null;
  return {
    address,
    state,
    flags: readU8(data, f.flags.offset),
    bidder: readPubkey(data, f.bidder.offset),
    launch: readPubkey(data, f.launch.offset),
    deposit: readU64(data, f.deposit.offset),
    placedTs: readI64(data, f.placed_ts.offset),
    sealed: readBytes(data, f.sealed.offset, f.sealed.size),
    commitment: readBytes(data, f.commitment.offset, f.commitment.size),
    /* The tick means something only once the bid opened; while sealed or invalid the bytes are not a maximum. */
    tick: state === "revealed" ? readU16(data, f.tick.offset) : null,
    processingCharge: readU64(data, f.processing_charge.offset),
    /* v0.32: the payout park_bid held for the bidder (Bid.parked_tokens 268, parked_lamports 276), and the tick bytes it left as reveal wrote them. */
    ...(state === "parked" ? { parked: { tokens: readU64(data, f.parked_tokens.offset), lamports: readU64(data, f.parked_lamports.offset), tick: readU16(data, f.tick.offset) } } : {}),
  };
}

/* 0.29: the per-tick revealed deposits, in lamports, PDA ["hist", launch]. Filled by reveal, read by settle, never closed. Null unless the account is at its full size with the pin's discriminator. */
export function decodeHistogram(address: string, data: Uint8Array): HistogramAccount | null {
  if (!isAccount("Histogram", data)) return null;
  const { f } = layout("Histogram");
  const tickCount = readU16(data, f.tick_count.offset);
  if (tickCount !== TICK_COUNT) return null;
  const counts: bigint[] = new Array<bigint>(TICK_COUNT);
  for (let k = 0; k < TICK_COUNT; k++) counts[k] = readU64(data, f.counts.offset + 8 * k);
  return { address, counts };
}

const keyOrNull = (s: string) => (s === ZERO_KEY ? null : s);

export function decodeRecord(address: string, data: Uint8Array): SettlementRecord | null {
  if (!isAccount("SettlementRecord", data)) return null;
  const { f } = layout("SettlementRecord");
  const cbs = readU8(data, f.creator_bid_state.offset);
  return {
    address,
    launch: readPubkey(data, f.launch.offset),
    clearingTick: readU16(data, f.clearing_tick.offset),
    marginalTick: readU16(data, f.marginal_tick.offset),
    floatValue: readU64(data, f.float_value.offset),
    winningDeposits: readU64(data, f.winning_deposits.offset),
    aboveDeposits: readU64(data, f.above_deposits.offset),
    atDeposits: readU64(data, f.at_deposits.offset),
    revealedBids: readU32(data, f.revealed_bids.offset),
    invalidBids: readU32(data, f.invalid_bids.offset),
    settledTs: readI64(data, f.settled_ts.offset),
    tokensDelivered: readU64(data, f.tokens_delivered.offset),
    distributedBids: readU32(data, f.distributed_bids.offset),
    largestFillTokens: readU64(data, f.largest_fill_tokens.offset),
    pool: keyOrNull(readPubkey(data, f.pool.offset)),
    burnedTokens: readU64(data, f.burned_tokens.offset),
    creatorDeposit: readU64(data, f.creator_deposit.offset),
    creatorTokens: readU64(data, f.creator_tokens.offset),
    creatorCost: readU64(data, f.creator_cost.offset),
    creatorTick: readU16(data, f.creator_tick.offset),
    creatorBidState: cbs === 1 ? 1 : cbs === 2 ? 2 : 0,
    lpLockState: readU8(data, f.lp_lock_state.offset),
    lpTotal: readU64(data, f.lp_total.offset),
    creatorLockNft: keyOrNull(readPubkey(data, f.creator_lock_nft.offset)),
    protocolLockNft: keyOrNull(readPubkey(data, f.protocol_lock_nft.offset)),
    poolSolAtOpen: readU64(data, f.pool_sol_at_open.offset),
    dustTokensBurned: readU64(data, f.dust_tokens_burned.offset),
    poolPayer: keyOrNull(readPubkey(data, f.pool_payer.offset)),
    openedTs: readI64(data, f.opened_ts.offset),
    openedForced: readU8(data, f.opened_forced.offset) !== 0,
    poolLoan: readU64(data, f.pool_loan.offset),
    raiseFeeCreator: readU64(data, f.raise_fee_creator.offset),
    raiseFeePlatform: readU64(data, f.raise_fee_platform.offset),
    raiseFeeCreatorPaid: readU64(data, f.raise_fee_creator_paid.offset),
    raiseFeePlatformPaid: readU64(data, f.raise_fee_platform_paid.offset),
    poolSolIn: readU64(data, f.pool_sol_in.offset),
    cashReleased: readU8(data, f.cash_released.offset) === 1,
  };
}
