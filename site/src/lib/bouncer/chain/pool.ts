import { PublicKey } from "@solana/web3.js";

/*
  The Meteora DAMM v2 pool a settled launch's proceeds (less the raise fee, 0.28) went into, read from
  its account (the founder, 2026-10-06: the closed cards and the trading view show
  the current market cap). The pool's spot price is its sqrt_price, a Q64.64
  fixed-point square root of (token B base units per token A base unit); the
  market cap is that price times the launch's total supply, in lamports when
  the other side is SOL. A chain read on every network, the same figure
  Dexscreener derives on mainnet; nothing here is an index or an estimate.

  Layout: cp_amm 0.2.5 (program cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG),
  computed from the IDL embedded in @meteora-ag/cp-amm-sdk 1.5.1
  (measure/cp-amm/pool-layout.cjs): 1,112 bytes, discriminator then
  pool_fees (160), token_a_mint at 168, token_b_mint at 200, the vaults at
  232 and 264, liquidity at 360, sqrt_price at 456. Checked against launch
  Z's pool on devnet (measure/cp-amm/verify-pool.ts) before use.
*/
export const DAMM_V2_PROGRAM = "cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG";
export const WSOL_MINT = "So11111111111111111111111111111111111111112";
const POOL_SIZE = 1112;
const DISCRIMINATOR = [241, 154, 109, 4, 17, 177, 109, 188];
/* 24o: activation_point (u64) at 472 and activation_type (u8) at 480, the offsets the program checks (programs/bouncer/src/meteora.rs, pool::ACTIVATION_POINT; POOL_STATUS at 481 follows). */
const OFF = { tokenAMint: 168, tokenBMint: 200, tokenAVault: 232, tokenBVault: 264, liquidity: 360, sqrtPrice: 456, activationPoint: 472, activationType: 480 } as const;
/* cp_amm's ActivationType::Timestamp: activation_point is a unix time in seconds. */
const ACTIVATION_TIMESTAMP = 1;

export interface DammPool {
  tokenAMint: string;
  tokenBMint: string;
  tokenAVault: string;
  tokenBVault: string;
  liquidity: bigint;
  /* Q64.64: sqrt(B base units per A base unit) times 2^64. */
  sqrtPrice: bigint;
  /* When the pool's swaps opened: a unix time when activationType is 1 (timestamp), a slot when it is 0. */
  activationPoint: bigint;
  activationType: number;
}

function u128(data: Uint8Array, off: number): bigint {
  let v = 0n;
  for (let i = 15; i >= 0; i--) v = (v << 8n) | BigInt(data[off + i]);
  return v;
}

/* The pool account decoded, or null when the bytes are not a cp_amm Pool of the pinned layout. */
export function decodeDammPool(data: Uint8Array): DammPool | null {
  if (data.length !== POOL_SIZE) return null;
  for (let i = 0; i < 8; i++) if (data[i] !== DISCRIMINATOR[i]) return null;
  const key = (off: number) => new PublicKey(data.subarray(off, off + 32)).toBase58();
  return {
    tokenAMint: key(OFF.tokenAMint),
    tokenBMint: key(OFF.tokenBMint),
    tokenAVault: key(OFF.tokenAVault),
    tokenBVault: key(OFF.tokenBVault),
    liquidity: u128(data, OFF.liquidity),
    sqrtPrice: u128(data, OFF.sqrtPrice),
    activationPoint: u64(data, OFF.activationPoint),
    activationType: data[OFF.activationType],
  };
}

function u64(data: Uint8Array, off: number): bigint {
  let v = 0n;
  for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(data[off + i]);
  return v;
}

/*
  24o (the founder, 2026-10-26: a card's age runs "from when the open trading started"): the unix second the pool's swaps
  opened. Since 0.20 the program's create_pool checks the pool it made activates by timestamp at that instruction's own
  clock (check_pool_bytes: activation_point equals Clock::unix_timestamp), so this is when trading opened, read from the
  pool account the board already has. Null, never a stand-in time, when the pool does not pair `mint` with SOL, does
  not activate by timestamp, or names a time before the launch's book closed (`notBefore`, its close_ts when set).
*/
export function tradingSince(pool: DammPool, mint: string, notBefore: number): number | null {
  const paired = (pool.tokenAMint === mint && pool.tokenBMint === WSOL_MINT) || (pool.tokenBMint === mint && pool.tokenAMint === WSOL_MINT);
  if (!paired || pool.activationType !== ACTIVATION_TIMESTAMP || pool.activationPoint <= 0n || pool.activationPoint > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  const at = Number(pool.activationPoint);
  return at >= notBefore ? at : null;
}

const Q64 = 1n << 64n;

/*
  The market cap of `mint` in lamports at the pool's spot price: supply (base
  units) times the price in SOL base units per token base unit. With the token
  as A and SOL as B, price = sqrtPrice^2 / 2^128, so
  mcap = supply * sqrtPrice^2 / 2^128. With the sides the other way round the
  price inverts: mcap = supply * 2^128 / sqrtPrice^2. Integer arithmetic
  throughout, rounded down. Null when the pool does not pair `mint` with SOL
  or has no price.
*/
export function poolMcapLamports(pool: DammPool, mint: string, supply: bigint): bigint | null {
  if (pool.sqrtPrice === 0n) return null;
  const sq = pool.sqrtPrice * pool.sqrtPrice;
  if (pool.tokenAMint === mint && pool.tokenBMint === WSOL_MINT) return (supply * sq) / (Q64 * Q64);
  if (pool.tokenBMint === mint && pool.tokenAMint === WSOL_MINT) return (supply * Q64 * Q64) / sq;
  return null;
}
