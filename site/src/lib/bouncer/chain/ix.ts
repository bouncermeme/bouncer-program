/*
  Instruction builders. The discriminator and the argument order come from
  INSTRUCTIONS in the pin; the account order is the IDL's. An optional
  account that does not exist is the program id in its slot, read only,
  Anchor's convention (the settlement record of a launch that has none).

  0.29: create_launch carries the histogram (["hist", launch], created at
  10,240 bytes) and grow_histogram, in the same transaction, takes it to
  its full size; commit carries the config and the Instructions sysvar
  (read only, for the attestation); reveal carries the histogram before
  the bids, settle after the vault (read only).
*/
import { PublicKey, TransactionInstruction, type AccountMeta } from "@solana/web3.js";
import { INSTRUCTIONS } from "@contract/constants";
import { CREATE_TAKES_CLOSE_TS } from "../beacon";
import { Writer } from "./borsh";
import { ASSOCIATED_TOKEN_PROGRAM, CP_AMM_PROGRAM, EVENT_AUTHORITY, INSTRUCTIONS_SYSVAR, METEORA_CONFIG, POOL_AUTHORITY, PROGRAM, RENT_SYSVAR, SYSTEM_PROGRAM, TOKEN_2022_PROGRAM, TOKEN_METADATA_PROGRAM, TOKEN_PROGRAM, WSOL_MINT } from "./pda";

type InstructionName = keyof typeof INSTRUCTIONS;

function data(name: InstructionName, args?: Writer): Uint8Array {
  const disc = Uint8Array.from(INSTRUCTIONS[name].discriminator);
  const body = args ? args.toBytes() : new Uint8Array(0);
  const out = new Uint8Array(disc.length + body.length);
  out.set(disc, 0);
  out.set(body, disc.length);
  return out;
}

const w = (pubkey: PublicKey, signer = false): AccountMeta => ({ pubkey, isWritable: true, isSigner: signer });
const r = (pubkey: PublicKey, signer = false): AccountMeta => ({ pubkey, isWritable: false, isSigner: signer });
/* An optional account: the record when it exists, else the program id, read only. */
const opt = (pubkey: PublicKey | null, writable: boolean): AccountMeta => (pubkey ? { pubkey, isWritable: writable, isSigner: false } : r(PROGRAM));

function ix(name: InstructionName, keys: AccountMeta[], args?: Writer): TransactionInstruction {
  const expected = INSTRUCTIONS[name].accounts.length;
  if (keys.length < expected) throw new Error(`${name}: ${keys.length} accounts, the pin lists ${expected}`);
  return new TransactionInstruction({ programId: PROGRAM, keys, data: Buffer.from(data(name, args)) });
}

export interface CreateLaunchArgs {
  mintSalt: bigint;
  windowSecs: number;
  /* v0.31: the absolute close (unix seconds) the program takes in window_secs' place; ignored before. */
  closeTs: number;
  revealRound: bigint;
  roundPoint: Uint8Array;
  roundHints: Uint8Array;
  name: string;
  symbol: string;
  uri: string;
  /* 0.25, last: LaunchTerms, the config values the creator was shown, in the config's own order (Config bytes 76 to 111, and since 0.28 184 to 187: eight terms, 40 bytes). */
  expected: { floorValue: bigint; minBid: bigint; abortAfterSecs: number; deliveryFeeBps: number; creatorLpBps: number; crankBond: bigint; raiseFeeBps: number; raiseFeeCreatorShareBps: number };
}

/* 0.19: the mint is a PDA nobody signs for and nothing exists at; the token vault and metadata wait for create_pool. */
export function createLaunchIx(k: { config: PublicKey; creator: PublicKey; tokenMint: PublicKey; launch: PublicKey; vault: PublicKey; histogram: PublicKey }, a: CreateLaunchArgs): TransactionInstruction {
  const args = new Writer().u64(a.mintSalt).i64(CREATE_TAKES_CLOSE_TS ? a.closeTs : a.windowSecs).u64(a.revealRound).bytes(a.roundPoint, 48).bytes(a.roundHints, 192).string(a.name).string(a.symbol).string(a.uri);
  const t = a.expected;
  args.u64(t.floorValue).u64(t.minBid).u64(BigInt(t.abortAfterSecs)).u16(t.deliveryFeeBps).u16(t.creatorLpBps).u64(t.crankBond).u16(t.raiseFeeBps).u16(t.raiseFeeCreatorShareBps);
  /* 0.29, the seventh candidate: the Instructions sysvar last, through which the program reads the creation permit before it and hashes its own data. */
  return ix("create_launch", [r(k.config), w(k.creator, true), r(k.tokenMint), w(k.launch), w(k.vault), w(k.histogram), r(SYSTEM_PROGRAM), r(INSTRUCTIONS_SYSVAR)], args);
}

/* 0.29: the creator pays the histogram's rent shortfall and it grows to its full size; sent in create's transaction, or alone to finish a launch whose second step never landed. */
export function growHistogramIx(k: { launch: PublicKey; histogram: PublicKey; creator: PublicKey }): TransactionInstruction {
  return ix("grow_histogram", [w(k.launch), w(k.histogram), w(k.creator, true), r(SYSTEM_PROGRAM)]);
}

export function commitIx(k: { launch: PublicKey; vault: PublicKey; bid: PublicKey; bidder: PublicKey; config: PublicKey }, a: { deposit: bigint; sealed: Uint8Array; commitment: Uint8Array; flags: number; maxProcessingCharge: bigint }): TransactionInstruction {
  /* 0.25, last: the ceiling on the processing charge the bidder agreed to. */
  const args = new Writer().u64(a.deposit).bytes(a.sealed, 128).bytes(a.commitment, 32).u8(a.flags).u64(a.maxProcessingCharge);
  return ix("commit", [w(k.launch), w(k.vault), w(k.bid), w(k.bidder, true), r(SYSTEM_PROGRAM), r(k.config), r(INSTRUCTIONS_SYSVAR)], args);
}

export function refundIx(k: { launch: PublicKey; vault: PublicKey; settlement: PublicKey | null; bid: PublicKey; bidder: PublicKey; caller: PublicKey }): TransactionInstruction {
  return ix("refund", [w(k.launch), w(k.vault), opt(k.settlement, true), w(k.bid), w(k.bidder), w(k.caller, true)]);
}

/* v0.30 (SPEC 3.4): permissionless, once every bid is paid out; thaws the pool's token vault and revokes the freeze authority. The vault PDA signs by seeds. */
export function openTradingIx(k: { launch: PublicKey; settlement: PublicKey; vault: PublicKey; tokenMint: PublicKey; pool: PublicKey; tokenAVault: PublicKey }): TransactionInstruction {
  return ix("open_trading", [w(k.launch), w(k.settlement), r(k.vault), w(k.tokenMint), r(k.pool), w(k.tokenAVault), r(TOKEN_PROGRAM)]);
}

export function abortIx(k: { launch: PublicKey; settlement: PublicKey | null }): TransactionInstruction {
  return ix("abort", [w(k.launch), opt(k.settlement, false)]);
}

/* The steps between the window end and a live pool. Anyone may send them; the launch page offers each as the next step (chainClient.push*). */
export function closeIx(k: { launch: PublicKey }): TransactionInstruction {
  return ix("close", [w(k.launch)]);
}
export function postBeaconIx(k: { launch: PublicKey }, signature: Uint8Array): TransactionInstruction {
  return ix("post_beacon", [w(k.launch)], new Writer().bytes(signature, 48));
}
/* One or more Bid accounts in remaining accounts (INTERFACE, reveal). 0.22: the vault and the processor, who is paid each opened bid's processing charge. 0.29: the histogram before the bids. */
export function revealIx(k: { launch: PublicKey; vault: PublicKey; processor: PublicKey; histogram: PublicKey }, bids: PublicKey[]): TransactionInstruction {
  return ix("reveal", [w(k.launch), w(k.vault), w(k.processor, true), w(k.histogram), ...bids.map((b) => w(b))]);
}
/* 0.22: the vault after the creator bid; the payer is repaid the record's rent and the step allowance from the operating prepay. */
export function settleIx(k: { launch: PublicKey; settlement: PublicKey; payer: PublicKey; creatorBid: PublicKey | null; vault: PublicKey; histogram: PublicKey }): TransactionInstruction {
  return ix("settle", [w(k.launch), w(k.settlement), w(k.payer, true), r(SYSTEM_PROGRAM), opt(k.creatorBid, false), w(k.vault), r(k.histogram)]);
}

/*
  The pool steps and finalize, INTERFACE v0.21. Account order is the IDL's
  and matches the Rust smoke client that landed them on devnet. 0.29, the
  ninth candidate (docs/ASTRA-REVIEW-FIXES-2026-10-21.md): the metadata, the
  Token Metadata program and the rent sysvar left create_pool for
  finish_mint, which runs after it; create_pool takes 25 accounts.
*/
export interface PoolKeys {
  launch: PublicKey;
  settlement: PublicKey;
  vault: PublicKey;
  tokenMint: PublicKey;
  tokenVault: PublicKey;
  poolCreator: PublicKey;
  poolWsol: PublicKey;
  poolTokens: PublicKey;
  payer: PublicKey;
  platformNftMint: PublicKey;
  platformNftAccount: PublicKey;
  platformPosition: PublicKey;
  pool: PublicKey;
  tokenAVault: PublicKey;
  tokenBVault: PublicKey;
  /* 0.28, the two trailing accounts, writable; the raise fee's two parts are credited to them: Launch.creator, and v0.30 the treasury the launch recorded (Launch.lp_owner on a launch created before 0.30; WrongTreasury otherwise). */
  creatorWallet: PublicKey;
  treasury: PublicKey;
}

export function createPoolIx(k: PoolKeys, a: { creator: PublicKey; mintSalt: bigint }): TransactionInstruction {
  const args = new Writer().bytes(a.creator.toBytes(), 32).u64(a.mintSalt);
  return ix(
    "create_pool",
    [
      w(k.launch), w(k.settlement), w(k.vault), w(k.tokenMint), w(k.tokenVault), r(WSOL_MINT),
      w(k.poolCreator), w(k.poolWsol), w(k.poolTokens), w(k.payer, true),
      w(k.platformNftMint), w(k.platformNftAccount), w(k.platformPosition),
      w(k.pool), w(k.tokenAVault), w(k.tokenBVault),
      r(METEORA_CONFIG), r(POOL_AUTHORITY), r(EVENT_AUTHORITY), r(CP_AMM_PROGRAM), r(TOKEN_2022_PROGRAM), r(TOKEN_PROGRAM), r(SYSTEM_PROGRAM),
      w(k.creatorWallet), w(k.treasury),
    ],
    args,
  );
}

/*
  0.29, the ninth candidate: the token's Metaplex metadata and the mint
  authority's revocation, after create_pool (cosmetic and not time bound:
  the lock does not wait for it). Any wallet, once (MintAlreadyFinished
  6080 after), on a PoolLive launch; the signer is repaid its rent plus the
  step allowance from the operating prepay. The eleventh candidate: also in
  Finalized, and a trailing writable `creator` (Launch.creator), paid what
  is left of the metadata reserve lock_liquidity held back.
*/
export function finishMintIx(k: { launch: PublicKey; vault: PublicKey; tokenMint: PublicKey; metadata: PublicKey; payer: PublicKey; creator: PublicKey }): TransactionInstruction {
  return ix("finish_mint", [w(k.launch), w(k.vault), w(k.tokenMint), w(k.metadata), r(TOKEN_METADATA_PROGRAM), w(k.payer, true), r(RENT_SYSVAR), r(TOKEN_PROGRAM), r(SYSTEM_PROGRAM), w(k.creator)]);
}

export function lockLiquidityIx(k: {
  launch: PublicKey;
  settlement: PublicKey;
  vault: PublicKey;
  poolCreator: PublicKey;
  payer: PublicKey;
  creator: PublicKey;
  creatorNftMint: PublicKey;
  creatorNftAccount: PublicKey;
  creatorPosition: PublicKey;
  creatorNftAta: PublicKey;
  platformNftMint: PublicKey;
  platformPosition: PublicKey;
  platformNftAccount: PublicKey;
  pool: PublicKey;
  poolPayer: PublicKey;
  /*
    The ninth candidate: create_pool's wrapped SOL pass through (["pool_wsol", launch]), closed here to the pool payer.
    The twelfth: null once release_pool_cash closed it (SettlementRecord.cash_released), and the slot takes the program
    id; the pass through while nothing released the cash is refused TokenAccountsRequired, and the reverse cannot load.
  */
  poolWsol: PublicKey | null;
}): TransactionInstruction {
  return ix("lock_liquidity", [
    /* 0.22: launch writable, the vault after the settlement (the signer and the pool payer are repaid from the operating prepay). 0.23: the creator is writable, it receives the unused prepay here. */
    w(k.launch), w(k.settlement), w(k.vault), w(k.poolCreator), w(k.payer, true), w(k.creator),
    w(k.creatorNftMint), w(k.creatorNftAccount), w(k.creatorPosition), w(k.creatorNftAta),
    r(k.platformNftMint), w(k.platformPosition), r(k.platformNftAccount), w(k.pool),
    r(POOL_AUTHORITY), r(EVENT_AUTHORITY), r(CP_AMM_PROGRAM), r(TOKEN_2022_PROGRAM), r(ASSOCIATED_TOKEN_PROGRAM), r(SYSTEM_PROGRAM),
    w(k.poolPayer),
    /* The ninth candidate, two trailing accounts: the pass through and the token program that closes it. */
    opt(k.poolWsol, true), r(TOKEN_PROGRAM),
  ]);
}

export function deliverIx(k: { launch: PublicKey; vault: PublicKey; settlement: PublicKey; tokenMint: PublicKey; tokenVault: PublicKey; bid: PublicKey; bidder: PublicKey; bidderToken: PublicKey; caller: PublicKey; callerToken: PublicKey }): TransactionInstruction {
  return ix("deliver", [
    w(k.launch), w(k.vault), w(k.settlement), r(k.tokenMint), w(k.tokenVault), w(k.bid), w(k.bidder), w(k.bidderToken), w(k.caller, true),
    r(TOKEN_PROGRAM), r(ASSOCIATED_TOKEN_PROGRAM), r(SYSTEM_PROGRAM), w(k.callerToken),
  ]);
}

/*
  v0.32: the bidder's own collect of a parked payout. The token vault and the token destination are the program id when
  no tokens are parked (a refund's park); the destination of the lamports is the bidder's wallet.
*/
export function collectParkedIx(k: { launch: PublicKey; vault: PublicKey; tokenVault: PublicKey | null; tokenDestination: PublicKey | null; bid: PublicKey; bidder: PublicKey; destination: PublicKey }): TransactionInstruction {
  return ix("collect_parked", [w(k.launch), w(k.vault), opt(k.tokenVault, true), opt(k.tokenDestination, true), w(k.bid), r(k.bidder, true), w(k.destination), r(TOKEN_PROGRAM)]);
}

/* Finalize. With no mint (failed or aborted, 0.19 on) the four token slots take the program id; with one, the pool pass-throughs go in too (as the smoke client sent them). */
export function burnUnsoldIx(k: { launch: PublicKey; vault: PublicKey; settlement: PublicKey | null; tokenMint: PublicKey | null; tokenVault: PublicKey | null; caller: PublicKey; creator: PublicKey; poolTokens: PublicKey | null; poolCreator: PublicKey | null }): TransactionInstruction {
  return ix("burn_unsold", [
    w(k.launch), w(k.vault), opt(k.settlement, true), opt(k.tokenMint, true), opt(k.tokenVault, true), w(k.caller, true),
    r(TOKEN_PROGRAM), w(k.creator), opt(k.poolTokens, true), opt(k.poolCreator, false),
  ]);
}
