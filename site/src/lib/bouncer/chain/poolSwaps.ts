import bs58 from "bs58";
import { PublicKey, type Connection } from "@solana/web3.js";
import { readU64 } from "./borsh";
import { fetchTransactions, takeTurn, type RawTransaction } from "./history";
import { DAMM_V2_PROGRAM, WSOL_MINT } from "./pool";

/*
  A pool's swaps, read from its own transactions, for the chart and the
  volume on the clusters Dexscreener does not index (devnet, a local
  validator). Every point is a landed swap on this pool; nothing is sampled,
  seeded or estimated.

  The price after each swap is the pool's own sqrt_price as the program
  wrote it in its swap event, which Anchor emits through an instruction to
  the program itself (the event's bytes are that inner instruction's data
  after an 8-byte tag). A node that returns no inner instructions, or a
  program build that emits an event this reader does not know, leaves the
  event out; then the swap's price is the two vaults' balances after it
  (post token balances), exact for a full-range pool up to the fees it holds,
  and the point says it came from the balances.

  Layouts from the IDL embedded in @meteora-ag/cp-amm-sdk 1.5.1 (cp_amm
  0.2.5), dumped by measure/cp-amm/idl-swap.cjs on 2026-10-07, not remembered:
    instruction swap  discriminator [248,198,158,145,225,117,135,200]
    instruction swap2 discriminator [65,75,63,76,235,91,91,136]
      accounts: 0 pool_authority, 1 pool, 2 input_token_account,
      3 output_token_account, 4 token_a_vault, 5 token_b_vault,
      6 token_a_mint, 7 token_b_mint, 8 payer, 9 token_a_program,
      10 token_b_program, 11 referral_token_account (optional),
      12 event_authority, 13 program
    event EvtSwap2 discriminator [189,66,51,168,38,80,117,153], then
      pool (32), trade_direction u8 (0 A to B, 1 B to A), collect_fee_mode u8,
      has_referral u8, params { amount_0 u64, amount_1 u64, swap_mode u8 },
      swap_result { included_fee_input_amount u64, excluded_fee_input_amount
      u64, amount_left u64, output_amount u64, next_sqrt_price u128,
      claiming_fee u64, protocol_fee u64, compounding_fee u64, referral_fee
      u64 }, included_transfer_fee_amount_in u64,
      included_transfer_fee_amount_out u64, excluded_transfer_fee_amount_out
      u64, current_timestamp u64, reserve_a_amount u64, reserve_b_amount u64.
*/
const SWAP_DISCRIMINATORS = [
  [248, 198, 158, 145, 225, 117, 135, 200],
  [65, 75, 63, 76, 235, 91, 91, 136],
];
const EVT_SWAP2 = [189, 66, 51, 168, 38, 80, 117, 153];
/* In an event instruction's data: the 8-byte event tag, the 8-byte event discriminator, then the 180-byte body. A log line's bytes start at the discriminator and are padded to this shape. */
const EVT_SWAP2_LEN = 8 + 8 + 180;
const BODY = 16;
const O = { pool: BODY, direction: BODY + 32, includedIn: BODY + 52, outputAmount: BODY + 76, nextSqrtPrice: BODY + 84, reserveA: BODY + 164, reserveB: BODY + 172 } as const;
const SLOT = { pool: 1, payer: 8 } as const;

function startsWith(data: Uint8Array, prefix: number[], at = 0): boolean {
  if (data.length < at + prefix.length) return false;
  for (let i = 0; i < prefix.length; i++) if (data[at + i] !== prefix[i]) return false;
  return true;
}

function u128(data: Uint8Array, off: number): bigint {
  let v = 0n;
  for (let i = 15; i >= 0; i--) v = (v << 8n) | BigInt(data[off + i]);
  return v;
}

export interface PoolSwap {
  signature: string;
  slot: number;
  blockTime: number | null;
  /* The wallet that signed the swap. */
  trader: string;
  /* buy: SOL in, the launch's token out. */
  side: "buy" | "sell";
  /* The SOL side of the trade: what the trader paid (a buy, fee included) or received (a sell). */
  solLamports: bigint;
  /* The token side: what the trader received (a buy) or paid (a sell, fee included). */
  tokenAtoms: bigint;
  /* True when the launch's token is the pool's token A (SOL is B). */
  tokenIsA: boolean;
  /* The pool's sqrt price after the swap, Q64.64, from the program's event; null when the event was not in the node's answer. */
  sqrtPriceAfter: bigint | null;
  /* The vaults' balances after the swap: from the event, or from the post token balances when the event was missing. */
  reserveA: bigint | null;
  reserveB: bigint | null;
  source: "event" | "balances";
}

const Q128 = 1n << 128n;

/* The market cap of the launch's token after a swap, in lamports: supply times the price, from the sqrt price when the event gave it, else from the reserves. Null when neither is known. */
export function swapMcapLamports(s: PoolSwap, supply: bigint): bigint | null {
  if (s.sqrtPriceAfter !== null && s.sqrtPriceAfter > 0n) {
    const sq = s.sqrtPriceAfter * s.sqrtPriceAfter;
    return s.tokenIsA ? (supply * sq) / Q128 : (supply * Q128) / sq;
  }
  if (s.reserveA !== null && s.reserveB !== null && s.reserveA > 0n && s.reserveB > 0n) {
    return s.tokenIsA ? (supply * s.reserveB) / s.reserveA : (supply * s.reserveA) / s.reserveB;
  }
  return null;
}

interface Ix {
  program: string;
  accounts: string[];
  data: Uint8Array;
}

function allInstructions(tx: RawTransaction): { top: Ix[]; inner: Ix[] } {
  const loaded = tx.meta?.loadedAddresses;
  const keys = [...tx.transaction.message.accountKeys, ...(loaded?.writable ?? []), ...(loaded?.readonly ?? [])];
  const of = (ix: { programIdIndex: number; accounts: number[]; data: string }): Ix => ({ program: keys[ix.programIdIndex], accounts: ix.accounts.map((a) => keys[a]), data: bs58.decode(ix.data) });
  return { top: tx.transaction.message.instructions.map(of), inner: (tx.meta?.innerInstructions ?? []).flatMap((g) => g.instructions.map(of)) };
}

/* The post balance of a token account in a transaction, or null when the node did not report it. */
function postTokenBalance(tx: RawTransaction, account: string): bigint | null {
  const loaded = tx.meta?.loadedAddresses;
  const keys = [...tx.transaction.message.accountKeys, ...(loaded?.writable ?? []), ...(loaded?.readonly ?? [])];
  const i = keys.indexOf(account);
  if (i < 0) return null;
  const b = tx.meta?.postTokenBalances?.find((x) => x.accountIndex === i);
  return b ? BigInt(b.uiTokenAmount.amount) : null;
}

function preTokenBalance(tx: RawTransaction, account: string): bigint | null {
  const loaded = tx.meta?.loadedAddresses;
  const keys = [...tx.transaction.message.accountKeys, ...(loaded?.writable ?? []), ...(loaded?.readonly ?? [])];
  const i = keys.indexOf(account);
  if (i < 0) return null;
  const b = tx.meta?.preTokenBalances?.find((x) => x.accountIndex === i);
  return b ? BigInt(b.uiTokenAmount.amount) : null;
}

/*
  The swaps on `pool` in one landed transaction, in order. A transaction may
  hold several (a router); each is matched to the swap event that follows it
  among the inner instructions, by order.
*/
export function swapsOfTransaction(tx: RawTransaction, pool: string, mint: string): PoolSwap[] {
  if (!tx.meta || tx.meta.err) return [];
  const { top, inner } = allInstructions(tx);
  const cp = DAMM_V2_PROGRAM;
  const isSwap = (ix: Ix) => ix.program === cp && SWAP_DISCRIMINATORS.some((d) => startsWith(ix.data, d)) && ix.accounts[SLOT.pool] === pool;
  const swaps = [...top, ...inner].filter(isSwap);
  if (swaps.length === 0) return [];
  const events = inner.filter((ix) => ix.program === cp && ix.data.length >= EVT_SWAP2_LEN && startsWith(ix.data, EVT_SWAP2, 8) && new PublicKey(ix.data.subarray(O.pool, O.pool + 32)).toBase58() === pool);
  /* Events in "Program data:" lines, for a build that emits them to the log instead. */
  for (const line of tx.meta.logMessages ?? []) {
    if (!line.startsWith("Program data: ")) continue;
    try {
      const data = Uint8Array.from(atob(line.slice("Program data: ".length)), (c) => c.charCodeAt(0));
      if (data.length >= EVT_SWAP2_LEN - 8 && startsWith(data, EVT_SWAP2) && new PublicKey(data.subarray(8, 40)).toBase58() === pool) {
        /* Only when the same event was not already found as an instruction (a build may do both). */
        if (events.length >= swaps.length) break;
        const padded = new Uint8Array(8 + data.length);
        padded.set(data, 8);
        events.push({ program: cp, accounts: [], data: padded });
      }
    } catch {}
  }
  /* The pool pairs the launch's token with SOL: the side that is not wrapped SOL is the token. The mint decides only when neither side is SOL. */
  const mintA = swaps[0].accounts[6];
  const mintB = swaps[0].accounts[7];
  const tokenIsA = mintB === WSOL_MINT ? true : mintA === WSOL_MINT ? false : mintA === mint;
  const vaultA = swaps[0].accounts[4];
  const vaultB = swaps[0].accounts[5];
  const out: PoolSwap[] = [];
  swaps.forEach((ix, i) => {
    const ev = events[i] ?? null;
    const base = { signature: tx.transaction.signatures[0], slot: tx.slot, blockTime: tx.blockTime ?? null, trader: ix.accounts[SLOT.payer], tokenIsA };
    if (ev) {
      const d = ev.data;
      const aToB = d[O.direction] === 0;
      const includedIn = readU64(d, O.includedIn);
      const output = readU64(d, O.outputAmount);
      /* A to B: A in, B out. The SOL side is B when the token is A. */
      const solIn = tokenIsA ? !aToB : aToB;
      out.push({ ...base, side: solIn ? "buy" : "sell", solLamports: solIn ? includedIn : output, tokenAtoms: solIn ? output : includedIn, sqrtPriceAfter: u128(d, O.nextSqrtPrice), reserveA: readU64(d, O.reserveA), reserveB: readU64(d, O.reserveB), source: "event" });
      return;
    }
    const preA = preTokenBalance(tx, vaultA);
    const postA = postTokenBalance(tx, vaultA);
    const preB = preTokenBalance(tx, vaultB);
    const postB = postTokenBalance(tx, vaultB);
    if (preA === null || postA === null || preB === null || postB === null) return;
    const dA = postA - preA;
    const dB = postB - preB;
    const solDelta = tokenIsA ? dB : dA;
    const tokenDelta = tokenIsA ? dA : dB;
    /* Several swaps without events in one transaction cannot be told apart by balances: one point for the transaction. */
    if (i > 0) return;
    out.push({ ...base, side: solDelta > 0n ? "buy" : "sell", solLamports: solDelta < 0n ? -solDelta : solDelta, tokenAtoms: tokenDelta < 0n ? -tokenDelta : tokenDelta, sqrtPriceAfter: null, reserveA: postA, reserveB: postB, source: "balances" });
  });
  return out;
}

export interface PoolSwapsRead {
  /* Newest first. */
  swaps: PoolSwap[];
  newest: string | null;
  oldest: string | null;
  /* The block time of the pool's first transaction (its creation), when the listing reached it and that transaction holds no swap; null otherwise. */
  openedAt: number | null;
  stats: { signatures: number; transactions: number; requests: number; refused: number; missing: string[]; fromBalances: number };
}

export interface PoolSwapsOptions {
  /* Only transactions newer than this signature. */
  until?: string;
  /* Transactions already read, by signature; a read that fails midway resumes from here. */
  have?: Map<string, PoolSwap[]>;
  onProgress?: (read: number, total: number) => void;
}

const PAGE = 1000;
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

/*
  Every swap on a pool, read through the same paced line as a launch's
  history (history.ts: eight transactions a request on a keyed endpoint, one
  every 1.1 s on Solana's public ones, which refuse more). A refusal is not
  the end: the refused signatures go back to the head of the queue and the
  line waits the window the endpoint asks for.
*/
export async function readPoolSwaps(connection: Connection, pool: PublicKey, mint: string, opts: PoolSwapsOptions = {}): Promise<PoolSwapsRead> {
  const endpoint = connection.rpcEndpoint;
  const poolKey = pool.toBase58();
  const have = opts.have ?? new Map<string, PoolSwap[]>();
  const stats: PoolSwapsRead["stats"] = { signatures: 0, transactions: 0, requests: 0, refused: 0, missing: [], fromBalances: 0 };

  const sigs: { signature: string; err: unknown; slot: number; blockTime?: number | null }[] = [];
  let before: string | undefined;
  for (;;) {
    const page = await takeTurn(endpoint, async () => ({ value: await connection.getSignaturesForAddress(pool, { limit: PAGE, before, until: opts.until }, "confirmed"), asked: 1 }));
    stats.requests++;
    if (page.length === 0) break;
    sigs.push(...page);
    before = page[page.length - 1].signature;
    if (page.length < PAGE && opts.until) break;
  }
  stats.signatures = sigs.length;
  const landed = sigs.filter((s) => !s.err);
  const todo = landed.filter((s) => !have.has(s.signature)).map((s) => s.signature);
  const total = landed.length;
  const report = () => opts.onProgress?.(total - todo.length + stats.transactions, total);
  report();

  const queue = todo.slice();
  const absent: string[] = [];
  let refusals = 0;
  while (queue.length) {
    let list: string[] = [];
    let got: Awaited<ReturnType<typeof fetchTransactions>>;
    try {
      got = await takeTurn(endpoint, async (limited) => {
        list = queue.slice(0, limited ? 1 : 8);
        const value = await fetchTransactions(endpoint, list);
        /* Thrown as a rate limit so the line slows down for every reader on this endpoint; the request is put back below. */
        if (value.refused.length && value.found.size === 0) throw new Error("429 Too many requests: the RPC refused a swap read.");
        return { value, asked: list.length };
      });
    } catch (e) {
      stats.refused++;
      if (++refusals >= 6) throw e;
      await pause(500);
      continue;
    }
    refusals = 0;
    stats.requests++;
    queue.splice(0, list.length, ...got.refused);
    for (const [signature, tx] of got.found) {
      const swaps = swapsOfTransaction(tx, poolKey, mint);
      stats.fromBalances += swaps.filter((s) => s.source === "balances").length;
      stats.transactions++;
      have.set(signature, swaps);
    }
    for (const s of got.unreadable) {
      stats.transactions++;
      have.set(s, []);
    }
    absent.push(...got.absent);
    report();
  }
  stats.missing = absent;

  const swaps: PoolSwap[] = [];
  for (const s of landed) swaps.push(...(have.get(s.signature) ?? []));

  /* The pool's first transaction is its creation, which holds no swap; its time is when the pool opened. Only judged on a full listing that reached the end. */
  let openedAt: number | null = null;
  if (!opts.until && landed.length) {
    const first = landed[landed.length - 1];
    const firstSwaps = have.get(first.signature);
    if (firstSwaps && firstSwaps.length === 0) openedAt = first.blockTime ?? null;
  }
  return { swaps, newest: sigs[0]?.signature ?? null, oldest: sigs.length ? sigs[sigs.length - 1].signature : null, openedAt, stats };
}
