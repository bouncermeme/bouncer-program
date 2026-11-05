import BN from "bn.js";
import { PublicKey, type Connection, type Transaction } from "@solana/web3.js";
import type { PoolState } from "@meteora-ag/cp-amm-sdk";
import { fmtSol } from "../format";
import { networkNowSec } from "../netClock";
import { ataFor, WSOL_MINT } from "./pda";
import { sendAndConfirm, TxFailure, type SendOptions, type TxSigner } from "./signer";

/*
  Swaps against a launch's Meteora DAMM v2 pool, for the clusters Jupiter
  does not route (devnet, a local validator; the founder, 2026-10-07: "I can't see
  anything with trading at all on the site"). On mainnet the page keeps
  Jupiter (TokenMarket.tsx).

  The quote and the instruction are Meteora's own: @meteora-ag/cp-amm-sdk
  1.5.1, loaded on demand so a mainnet page never carries it. CpAmm.getQuote
  runs the program's swap math on the pool's state as read a moment before;
  CpAmm.swap builds the swap instruction with the token accounts it needs,
  creating the trader's token account when it is missing, wrapping SOL into
  a temporary account before the swap and closing it after (read in the
  SDK's bundle, 2026-10-07, not remembered). Nothing here types an offset or
  a discriminator; the wallet signs, the site broadcasts and confirms
  (signer.ts), so every failure says whether money moved.

  Tolerance: the swap lands only if the trader receives at least the quoted
  amount less TOLERANCE_BPS; below that the program refuses it and only the
  network fee is paid. There is no slippage control on the page (the founder).
*/
export const TOLERANCE_BPS = 100n;
/* The network's fee for one signature, the only cost outside the quote (the wrapped-SOL account's rent comes back when it closes in the same transaction). */
export const NETWORK_FEE_LAMPORTS = 5_000n;
const SIGNATURE_FEE = NETWORK_FEE_LAMPORTS;
/* A token account's size; its rent is read from the RPC. */
export const TOKEN_ACCOUNT_BYTES = 165;

type Sdk = typeof import("@meteora-ag/cp-amm-sdk");
let sdkPromise: Promise<Sdk> | null = null;
function sdk(): Promise<Sdk> {
  if (!sdkPromise) sdkPromise = import("@meteora-ag/cp-amm-sdk");
  return sdkPromise;
}

export interface PoolSide {
  mint: PublicKey;
  vault: PublicKey;
  program: PublicKey;
  decimals: number;
}

export interface PoolInfo {
  pool: PublicKey;
  a: PoolSide;
  b: PoolSide;
  /* Q64.64, as pool.ts reads it. */
  sqrtPrice: bigint;
  readAt: number;
  state: PoolState;
}

/* The pool as the SDK decodes it, with each side's token program (SPL Token or Token-2022, from the pool's own flags). */
export async function readPool(connection: Connection, pool: PublicKey, tokenDecimals: number): Promise<PoolInfo> {
  const { CpAmm, getTokenProgram } = await sdk();
  const state = await new CpAmm(connection).fetchPoolState(pool);
  const side = (mint: PublicKey, vault: PublicKey, flag: number): PoolSide => ({ mint, vault, program: getTokenProgram(flag), decimals: mint.equals(WSOL_MINT) ? 9 : tokenDecimals });
  return {
    pool,
    a: side(state.tokenAMint, state.tokenAVault, state.tokenAFlag),
    b: side(state.tokenBMint, state.tokenBVault, state.tokenBFlag),
    sqrtPrice: BigInt(state.sqrtPrice.toString()),
    readAt: Date.now(),
    state,
  };
}

export interface SwapQuote {
  amountIn: bigint;
  /* What the pool would pay out now, after its fee. */
  amountOut: bigint;
  /* The least the swap accepts: amountOut less the tolerance. The program refuses below it. */
  minOut: bigint;
  /* The pool's fee on this swap, already inside amountOut, in feeMint's units. */
  fee: bigint;
  /* The token the pool takes its fee in. The program's fee mode decides (read in the SDK's getFeeMode, 2026-10-07): collect mode 0 ("both tokens") takes the fee from the output token; mode 1 ("only B") takes it in token B whichever way the swap goes. */
  feeMint: PublicKey;
  feeIsSol: boolean;
  /* Percent. */
  priceImpactPct: number;
}

export async function quoteSwap(connection: Connection, info: PoolInfo, inputMint: PublicKey, amountIn: bigint): Promise<SwapQuote> {
  if (amountIn <= 0n) throw new Error("Nothing to swap.");
  const { CpAmm } = await sdk();
  const currentSlot = await connection.getSlot("confirmed");
  const q = new CpAmm(connection).getQuote({
    inAmount: new BN(amountIn.toString()),
    inputTokenMint: inputMint,
    /* The SDK's own minimum is not used; the page applies TOLERANCE_BPS itself. */
    slippage: 1,
    poolState: info.state,
    currentTime: networkNowSec(),
    currentSlot,
    tokenADecimal: info.a.decimals,
    tokenBDecimal: info.b.decimals,
  });
  const amountOut = BigInt(q.swapOutAmount.toString());
  const inputIsA = inputMint.equals(info.a.mint);
  const feeMint = Number(info.state.collectFeeMode) === 0 ? (inputIsA ? info.b.mint : info.a.mint) : info.b.mint;
  return {
    amountIn,
    amountOut,
    minOut: amountOut - (amountOut * TOLERANCE_BPS) / 10_000n,
    fee: BigInt(q.totalFee.toString()),
    feeMint,
    feeIsSol: feeMint.equals(WSOL_MINT),
    priceImpactPct: Number(q.priceImpact.toString()),
  };
}

/* The trader's token account for a mint, by the pool's token program for that side. */
export function tokenAccountFor(owner: PublicKey, side: PoolSide): PublicKey {
  return ataFor(owner, side.mint, side.program);
}

export interface Balances {
  lamports: bigint;
  /* Token atoms in the trader's token account; 0 when the account does not exist. */
  atoms: bigint;
  /* Whether the token account exists at all: a first buy creates it and its rent stays with it. */
  hasTokenAccount: boolean;
  readAt: number;
}

export async function readBalances(connection: Connection, owner: PublicKey, token: PoolSide): Promise<Balances> {
  const [lamports, acct] = await Promise.all([connection.getBalance(owner, "confirmed"), connection.getTokenAccountBalance(tokenAccountFor(owner, token), "confirmed").catch(() => null)]);
  return { lamports: BigInt(lamports), atoms: BigInt(acct?.value.amount ?? "0"), hasTokenAccount: acct !== null, readAt: Date.now() };
}

export interface SwapInput {
  info: PoolInfo;
  inputMint: PublicKey;
  outputMint: PublicKey;
  amountIn: bigint;
  minOut: bigint;
  /* Rent of one token account on this cluster, read from the RPC (client.getRent(TOKEN_ACCOUNT_BYTES)). */
  tokenAccountRent: bigint;
  /* What the trader holds now, for the refusal before any prompt. */
  balances: Balances;
}

/*
  One swap: built by the SDK, simulated, signed by the wallet, broadcast and
  confirmed by the site. Refuses before the prompt when the wallet plainly
  cannot pay: a buy needs the SOL plus up to two token accounts' rent (the
  temporary wrapped-SOL account, returned when it closes, and the token
  account if it does not exist yet) and the fee; a sell needs the tokens, one
  account's rent and the fee.
*/
export async function swapInPool(connection: Connection, input: SwapInput, signer: TxSigner, opts: SendOptions = {}): Promise<{ signature: string }> {
  opts.onStage?.({ step: "building" });
  const { CpAmm } = await sdk();
  const { info, inputMint, outputMint, amountIn, minOut, tokenAccountRent, balances } = input;
  const payer = new PublicKey(signer.address);
  const buying = inputMint.equals(WSOL_MINT);
  const token = info.a.mint.equals(WSOL_MINT) ? info.b : info.a;
  if (buying) {
    const need = amountIn + tokenAccountRent * (balances.hasTokenAccount ? 1n : 2n) + SIGNATURE_FEE;
    if (balances.lamports < need) {
      throw new TxFailure("nothingSent", "insufficientFunds", `This wallet holds ${fmtSol(balances.lamports)} and this needs about ${fmtSol(need)}: the SOL, the token accounts' rent (${fmtSol(tokenAccountRent)} each, the wrapped SOL one returned when it closes) and the fee.`, { expected: signer.address });
    }
  } else {
    if (balances.atoms < amountIn) throw new TxFailure("nothingSent", "insufficientFunds", `This wallet holds fewer tokens than that.`, { expected: signer.address });
    const need = tokenAccountRent + SIGNATURE_FEE;
    if (balances.lamports < need) {
      throw new TxFailure("nothingSent", "insufficientFunds", `This wallet holds ${fmtSol(balances.lamports)} and this needs about ${fmtSol(need)}: the wrapped SOL account's rent (returned when it closes) and the fee.`, { expected: signer.address });
    }
  }
  const tx: Transaction = await new CpAmm(connection).swap({
    payer,
    pool: info.pool,
    inputTokenMint: inputMint,
    outputTokenMint: outputMint,
    amountIn: new BN(amountIn.toString()),
    minimumAmountOut: new BN(minOut.toString()),
    tokenAMint: info.a.mint,
    tokenBMint: info.b.mint,
    tokenAVault: info.a.vault,
    tokenBVault: info.b.vault,
    tokenAProgram: info.a.program,
    tokenBProgram: info.b.program,
    referralTokenAccount: null,
    poolState: info.state,
  });
  tx.feePayer = payer;
  const before = balances.atoms;
  const sent = await sendAndConfirm(connection, tx, signer, [], {
    ...opts,
    /* After an ambiguous send: the trader's token balance moved, or it did not. */
    effect: async () => {
      const now = await readBalances(connection, payer, token);
      return { landed: now.atoms !== before, signature: null };
    },
  });
  return { signature: sent.signature };
}
