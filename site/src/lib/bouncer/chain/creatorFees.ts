import { PublicKey, Transaction, TransactionInstruction, type AccountInfo, type Connection } from "@solana/web3.js";
import { fmtSol } from "../format";
import { ASSOCIATED_TOKEN_PROGRAM, ataFor, CP_AMM_PROGRAM, EVENT_AUTHORITY, meteoraVaultPda, POOL_AUTHORITY, positionPda, SYSTEM_PROGRAM, TOKEN_2022_PROGRAM, TOKEN_PROGRAM, WSOL_MINT } from "./pda";
import { sendAndConfirm, TxFailure, type SendOptions, type TxSigner } from "./signer";

/*
  The creator's LP trading fees (the founder, 2026-10-14: a "Claim fees" button for
  the creator, shown only to the launch's creator wallet holding the creator's
  position NFT; unclaimed fees in SOL; one click claims and unwraps).

  At lock_liquidity the program splits Config.creator_lp_bps of the pool's
  locked liquidity into a second Meteora DAMM v2 position and moves its NFT
  (Token-2022, mint ["position_nft", launch, 0]) to the creator's Token-2022
  associated account, closing Meteora's own NFT account for it
  (programs/bouncer/src/lib.rs, give_creator_nft). The position earns its
  share of every swap's fee, all in wrapped SOL (the pool's collect_fee_mode
  is OnlyB). Only the NFT's holder can claim it: Meteora's claim_position_fee
  refuses any other signer (InvalidAuthority, 6053, read in a devnet
  simulation 2026-10-14), so hiding the button is a convenience, never the
  guard. No Bouncer instruction is in this path.

  The figure: Meteora credits a position lazily. What a claim pays is the
  position's fee_b_pending plus the pool's fee_b_per_liquidity since the
  position's checkpoint times the position's liquidity, at the 2^128 scale,
  floored (keeper/src/fees.mjs claimableOf, which matched the chain's
  payments to the lamport; on 2026-10-14 it predicted 2,387,999 lamports for
  the 0.28 proof launch's creator and a simulated claim paid 2,387,999). The
  difference is taken modulo 2^256 as Meteora does. Offsets: Position 408
  bytes, Pool 1,112 (keeper/src/fees.mjs, checked against meteora.rs and on
  devnet).

  The transaction (hand-built, so a mainnet page needs no Meteora SDK, which
  dammSwap.ts keeps off mainnet): create the wallet's wrapped SOL account
  when it is missing, claim into it, close it to the wallet, so the fees
  arrive as SOL and the account's rent comes back. Meteora also wants a token
  account for the launch's mint; it receives nothing under OnlyB, so one the
  wallet lacks is created and closed again in the same transaction, costing
  nothing. Closing the wrapped SOL account unwraps everything in it,
  including any wrapped SOL the wallet already held; the page says so before
  the prompt. The amount claimed is read from the position afterwards
  (total_claimed_b_fee), never from the wallet's balance, which the unwrap
  and the rent move too.
*/

const POSITION = { LEN: 408, POOL: 8, NFT_MINT: 40, FEE_B_CHECKPOINT: 104, FEE_B_PENDING: 144, UNLOCKED: 152, VESTED: 168, PERMANENT: 184, TOTAL_CLAIMED_B: 208 } as const;
const POSITION_DISCRIMINATOR = [0xaa, 0xbc, 0x8f, 0xe4, 0x7a, 0x40, 0xf7, 0xd0];
const POOL = { LEN: 1112, TOKEN_A_MINT: 168, TOKEN_B_MINT: 200, TOKEN_A_VAULT: 232, TOKEN_B_VAULT: 264, COLLECT_FEE_MODE: 484, FEE_B_PER_LIQUIDITY: 520 } as const;
const POOL_DISCRIMINATOR = [241, 154, 109, 4, 17, 177, 109, 188];
/* collect_fee_mode 1: every fee in token B (wrapped SOL). create_pool requires it (lib.rs). */
const ONLY_B = 1;
/* sha256("global:claim_position_fee")[..8] (programs/bouncer/src/meteora.rs, pinned by its test). */
const CLAIM_POSITION_FEE = Uint8Array.of(0xb4, 0x26, 0x9a, 0x11, 0x85, 0x21, 0xa2, 0xd3);
const LIQUIDITY_SCALE = 128n;
const U256 = 1n << 256n;
const U64_MAX = (1n << 64n) - 1n;
/* The network's fee for the one signature. */
export const CLAIM_NETWORK_FEE = 5_000n;
/* An SPL token account's size; its rent is read from the RPC by the caller. */
export const TOKEN_ACCOUNT_BYTES = 165;

function u64(d: Uint8Array, o: number): bigint {
  let v = 0n;
  for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(d[o + i]);
  return v;
}
function u128(d: Uint8Array, o: number): bigint {
  return u64(d, o) + (u64(d, o + 8) << 64n);
}
function u256(d: Uint8Array, o: number): bigint {
  return u128(d, o) + (u128(d, o + 16) << 128n);
}
function key(d: Uint8Array, o: number): PublicKey {
  return new PublicKey(d.subarray(o, o + 32));
}
function startsWith(d: Uint8Array, disc: number[]): boolean {
  return disc.every((b, i) => d[i] === b);
}

export interface FeePosition {
  pool: PublicKey;
  nftMint: PublicKey;
  checkpointB: bigint;
  pendingB: bigint;
  liquidity: bigint;
  totalClaimedB: bigint;
}
export interface FeePool {
  tokenAMint: PublicKey;
  tokenBMint: PublicKey;
  tokenAVault: PublicKey;
  tokenBVault: PublicKey;
  collectFeeMode: number;
  feeBPerLiquidity: bigint;
}

/* A cp_amm Position, or null when the bytes are not one. */
export function decodePosition(d: Uint8Array): FeePosition | null {
  if (d.length !== POSITION.LEN || !startsWith(d, POSITION_DISCRIMINATOR)) return null;
  return {
    pool: key(d, POSITION.POOL),
    nftMint: key(d, POSITION.NFT_MINT),
    checkpointB: u256(d, POSITION.FEE_B_CHECKPOINT),
    pendingB: u64(d, POSITION.FEE_B_PENDING),
    liquidity: u128(d, POSITION.UNLOCKED) + u128(d, POSITION.VESTED) + u128(d, POSITION.PERMANENT),
    totalClaimedB: u64(d, POSITION.TOTAL_CLAIMED_B),
  };
}
/* A cp_amm Pool's fee fields, or null when the bytes are not one. */
export function decodeFeePool(d: Uint8Array): FeePool | null {
  if (d.length !== POOL.LEN || !startsWith(d, POOL_DISCRIMINATOR)) return null;
  return {
    tokenAMint: key(d, POOL.TOKEN_A_MINT),
    tokenBMint: key(d, POOL.TOKEN_B_MINT),
    tokenAVault: key(d, POOL.TOKEN_A_VAULT),
    tokenBVault: key(d, POOL.TOKEN_B_VAULT),
    collectFeeMode: d[POOL.COLLECT_FEE_MODE],
    feeBPerLiquidity: u256(d, POOL.FEE_B_PER_LIQUIDITY),
  };
}
/* What a claim pays the position now, in lamports of wrapped SOL. */
export function claimableOf(pos: FeePosition, pool: FeePool): bigint {
  const delta = (((pool.feeBPerLiquidity - pos.checkpointB) % U256) + U256) % U256;
  const accrued = (delta * pos.liquidity) >> LIQUIDITY_SCALE;
  const total = pos.pendingB + accrued;
  return total > U64_MAX ? U64_MAX : total;
}

/* An SPL (or Token-2022) token account's base fields; null when the account is missing or not one of `program`'s. */
function tokenAccount(info: AccountInfo<Buffer> | null, program: PublicKey): { mint: PublicKey; owner: PublicKey; amount: bigint } | null {
  if (!info || !info.owner.equals(program) || info.data.length < 165) return null;
  return { mint: key(info.data, 0), owner: key(info.data, 32), amount: u64(info.data, 64) };
}

export interface CreatorFeeAccounts {
  pool: PublicKey;
  position: PublicKey;
  nftMint: PublicKey;
  /* The wallet's Token-2022 associated account for the NFT. */
  nftAccount: PublicKey;
  tokenMint: PublicKey;
  vaultA: PublicKey;
  vaultB: PublicKey;
  /* The wallet's classic associated accounts for wrapped SOL and for the launch's token. */
  wsolAccount: PublicKey;
  tokenAccount: PublicKey;
}

export interface CreatorFees {
  owner: string;
  /* Whether `owner` holds the position's NFT in its associated Token-2022 account (amount 1). */
  holds: boolean;
  /* Lamports a claim pays now. Fees keep accruing, so a claim can pay a little more. */
  unclaimed: bigint;
  /* Everything this position has paid out so far, Meteora's own counter. */
  claimedTotal: bigint;
  /* Wrapped SOL already in the wallet's wrapped SOL account; the claim's unwrap returns it as SOL too. */
  wrapped: bigint;
  hasWsolAccount: boolean;
  hasTokenAccount: boolean;
  lamports: bigint;
  accounts: CreatorFeeAccounts;
  readAt: number;
}

/*
  One read (getMultipleAccountsInfo): the position, the pool, the wallet's NFT
  account, its wrapped SOL and launch-token accounts, the wallet itself and
  the pool's two vaults. Throws when anything is not what the pin and the
  program say it must be: the position must be cp_amm's, of this pool and
  this NFT; the pool OnlyB, the launch's token as A and wrapped SOL as B, with
  the vaults Meteora derives, both under the classic token program.
*/
export async function readCreatorFees(connection: Connection, args: { owner: PublicKey; pool: PublicKey; nftMint: PublicKey; tokenMint: PublicKey }): Promise<CreatorFees> {
  const { owner, pool, nftMint, tokenMint } = args;
  const accounts: CreatorFeeAccounts = {
    pool,
    position: positionPda(nftMint),
    nftMint,
    nftAccount: ataFor(owner, nftMint, TOKEN_2022_PROGRAM),
    tokenMint,
    vaultA: meteoraVaultPda(tokenMint, pool),
    vaultB: meteoraVaultPda(WSOL_MINT, pool),
    wsolAccount: ataFor(owner, WSOL_MINT, TOKEN_PROGRAM),
    tokenAccount: ataFor(owner, tokenMint, TOKEN_PROGRAM),
  };
  const keys = [accounts.position, pool, accounts.nftAccount, accounts.wsolAccount, accounts.tokenAccount, owner, accounts.vaultA, accounts.vaultB];
  const [posInfo, poolInfo, nftInfo, wsolInfo, tokInfo, ownerInfo, vaultAInfo, vaultBInfo] = await connection.getMultipleAccountsInfo(keys, "confirmed");
  if (!posInfo || !posInfo.owner.equals(CP_AMM_PROGRAM)) throw new Error("The creator's position is not on this cluster.");
  if (!poolInfo || !poolInfo.owner.equals(CP_AMM_PROGRAM)) throw new Error("The pool is not on this cluster.");
  const pos = decodePosition(posInfo.data);
  const p = decodeFeePool(poolInfo.data);
  if (!pos || !p) throw new Error("The position or the pool is not in the layout this page reads.");
  if (!pos.pool.equals(pool) || !pos.nftMint.equals(nftMint)) throw new Error("The position does not belong to this pool and NFT.");
  if (p.collectFeeMode !== ONLY_B || !p.tokenAMint.equals(tokenMint) || !p.tokenBMint.equals(WSOL_MINT)) throw new Error("This pool does not take its fees in SOL as this page expects.");
  if (!p.tokenAVault.equals(accounts.vaultA) || !p.tokenBVault.equals(accounts.vaultB)) throw new Error("The pool's vaults are not the ones Meteora derives.");
  if (!vaultAInfo?.owner.equals(TOKEN_PROGRAM) || !vaultBInfo?.owner.equals(TOKEN_PROGRAM)) throw new Error("The pool's vaults are not under the token program this page uses.");
  const nft = tokenAccount(nftInfo, TOKEN_2022_PROGRAM);
  const wsol = tokenAccount(wsolInfo, TOKEN_PROGRAM);
  return {
    owner: owner.toBase58(),
    holds: !!nft && nft.mint.equals(nftMint) && nft.owner.equals(owner) && nft.amount === 1n,
    unclaimed: claimableOf(pos, p),
    claimedTotal: pos.totalClaimedB,
    wrapped: wsol && wsol.mint.equals(WSOL_MINT) && wsol.owner.equals(owner) ? wsol.amount : 0n,
    hasWsolAccount: !!wsolInfo,
    hasTokenAccount: !!tokInfo,
    lamports: BigInt(ownerInfo?.lamports ?? 0),
    accounts,
    readAt: Date.now(),
  };
}

/* The position's paid-out counter alone, for the landed check and the amount afterwards. */
export async function readClaimedTotal(connection: Connection, position: PublicKey): Promise<bigint | null> {
  const info = await connection.getAccountInfo(position, "confirmed");
  const pos = info && info.owner.equals(CP_AMM_PROGRAM) ? decodePosition(info.data) : null;
  return pos ? pos.totalClaimedB : null;
}

/* Meteora's claim_position_fee, its 15 accounts in the program's order (meteora.rs claim_position_fee, with the event tail). `signer` must hold the NFT in `nftAccount`; Meteora refuses anyone else. */
export function claimPositionFeeIx(a: { pool: PublicKey; position: PublicKey; tokenAAccount: PublicKey; tokenBAccount: PublicKey; vaultA: PublicKey; vaultB: PublicKey; tokenAMint: PublicKey; nftAccount: PublicKey; signer: PublicKey }): TransactionInstruction {
  const ro = (pubkey: PublicKey) => ({ pubkey, isSigner: false, isWritable: false });
  const rw = (pubkey: PublicKey) => ({ pubkey, isSigner: false, isWritable: true });
  return new TransactionInstruction({
    programId: CP_AMM_PROGRAM,
    data: Buffer.from(CLAIM_POSITION_FEE),
    keys: [
      ro(POOL_AUTHORITY),
      ro(a.pool),
      rw(a.position),
      rw(a.tokenAAccount),
      rw(a.tokenBAccount),
      rw(a.vaultA),
      rw(a.vaultB),
      ro(a.tokenAMint),
      ro(WSOL_MINT),
      ro(a.nftAccount),
      { pubkey: a.signer, isSigner: true, isWritable: false },
      ro(TOKEN_PROGRAM),
      ro(TOKEN_PROGRAM),
      ro(EVENT_AUTHORITY),
      ro(CP_AMM_PROGRAM),
    ],
  });
}

/* The associated token program's CreateIdempotent (instruction 1): the payer funds the account's rent. */
export function createAtaIdempotentIx(payer: PublicKey, owner: PublicKey, mint: PublicKey, tokenProgram: PublicKey): TransactionInstruction {
  return new TransactionInstruction({
    programId: ASSOCIATED_TOKEN_PROGRAM,
    data: Buffer.from([1]),
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: ataFor(owner, mint, tokenProgram), isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: SYSTEM_PROGRAM, isSigner: false, isWritable: false },
      { pubkey: tokenProgram, isSigner: false, isWritable: false },
    ],
  });
}

/* The token program's CloseAccount (instruction 9): the account's lamports, wrapped SOL included, go to `to`. */
function closeAccountIx(account: PublicKey, to: PublicKey, owner: PublicKey): TransactionInstruction {
  return new TransactionInstruction({
    programId: TOKEN_PROGRAM,
    data: Buffer.from([9]),
    keys: [
      { pubkey: account, isSigner: false, isWritable: true },
      { pubkey: to, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: true, isWritable: false },
    ],
  });
}

/* The claim as one transaction for the holder: open what is missing, claim, close the launch-token account if this transaction opened it, close the wrapped SOL account. */
export function claimFeesTransaction(f: CreatorFees): Transaction {
  const me = new PublicKey(f.owner);
  const a = f.accounts;
  const tx = new Transaction();
  tx.add(createAtaIdempotentIx(me, me, WSOL_MINT, TOKEN_PROGRAM));
  if (!f.hasTokenAccount) tx.add(createAtaIdempotentIx(me, me, a.tokenMint, TOKEN_PROGRAM));
  tx.add(claimPositionFeeIx({ pool: a.pool, position: a.position, tokenAAccount: a.tokenAccount, tokenBAccount: a.wsolAccount, vaultA: a.vaultA, vaultB: a.vaultB, tokenAMint: a.tokenMint, nftAccount: a.nftAccount, signer: me }));
  if (!f.hasTokenAccount) tx.add(closeAccountIx(a.tokenAccount, me, me));
  tx.add(closeAccountIx(a.wsolAccount, me, me));
  tx.feePayer = me;
  return tx;
}

export interface Claimed {
  signature: string;
  /* What the position paid, from its own counter; null when the read after the claim did not show the change in time. */
  claimed: bigint | null;
  /* Wrapped SOL that was already in the wallet's account and came out with the unwrap. */
  unwrapped: bigint;
}

/*
  The claim, for the wallet that holds the NFT. Everything it builds from is
  read again here, at the click (the card's figure can be 20 s old: a claim
  just made, or a token account opened by a buy since, would otherwise be
  built from stale flags). Refuses before any prompt when the wallet does not
  hold the NFT, when there is less to claim than the fee, or when it cannot
  front the accounts' rent and the fee (the rent comes back in the same
  transaction). Then simulate, sign, send and confirm through signer.ts, so
  every failure says whether money moved. After an ambiguous send the
  position's paid-out counter decides.
*/
export async function claimCreatorFees(connection: Connection, card: CreatorFees, signer: TxSigner, opts: SendOptions = {}): Promise<Claimed> {
  opts.onStage?.({ step: "building" });
  if (signer.address !== card.owner) throw new TxFailure("nothingSent", "walletSwitched", "Your wallet switched to a different account before it signed.", { expected: card.owner, signedAs: signer.address });
  let f: CreatorFees;
  let tokenAccountRent: bigint;
  try {
    const a = card.accounts;
    [f, tokenAccountRent] = await Promise.all([
      readCreatorFees(connection, { owner: new PublicKey(card.owner), pool: a.pool, nftMint: a.nftMint, tokenMint: a.tokenMint }),
      connection.getMinimumBalanceForRentExemption(TOKEN_ACCOUNT_BYTES, "confirmed").then(BigInt),
    ]);
  } catch (e) {
    throw new TxFailure("nothingSent", "rpcUnreachable", `The position could not be read again before building the claim (${e instanceof Error ? e.message.slice(0, 120) : String(e)}). Nothing was built, signed or sent.`, { cause: e });
  }
  if (!f.holds) throw new TxFailure("nothingSent", "refused", "This wallet does not hold the creator's position NFT, so Meteora would refuse the claim.", { expected: f.owner });
  if (f.unclaimed <= CLAIM_NETWORK_FEE) throw new TxFailure("nothingSent", "refused", `Only ${fmtSol(f.unclaimed)} to claim now, no more than the network fee, so nothing was built.`, { expected: f.owner });
  const need = (f.hasWsolAccount ? 0n : tokenAccountRent) + (f.hasTokenAccount ? 0n : tokenAccountRent) + CLAIM_NETWORK_FEE;
  if (f.lamports < need) {
    throw new TxFailure("nothingSent", "insufficientFunds", `This wallet holds ${fmtSol(f.lamports)} and this needs about ${fmtSol(need)} up front: the fee and the rent of the accounts it opens, which is returned in the same transaction.`, { expected: f.owner });
  }
  const before = f.claimedTotal;
  const tx = claimFeesTransaction(f);
  const sent = await sendAndConfirm(connection, tx, signer, [], {
    ...opts,
    effect: async () => {
      const now = await readClaimedTotal(connection, f.accounts.position);
      return { landed: now !== null && now > before, signature: null };
    },
  });
  /* The node can answer a moment behind its own confirmation: ask up to three times. */
  let after: bigint | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 1500));
    after = await readClaimedTotal(connection, f.accounts.position).catch(() => null);
    if (after !== null && after > before) break;
  }
  return { signature: sent.signature, claimed: after !== null && after > before ? after - before : null, unwrapped: f.wrapped };
}
