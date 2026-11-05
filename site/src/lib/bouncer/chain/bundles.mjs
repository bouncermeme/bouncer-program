/*
  How the steps of a launch are composed into as few transactions as the
  chain accepts (the founder, 2026-10-07: "have the close button or beacon button
  sign as many transactions at once as possible"). Plain ESM on
  @solana/web3.js alone, so the keeper can import it by path as it is and the
  browser can bundle it: no node modules, no contract file read at load.

  The rules are the keeper's (keeper/src/bundle.mjs, program lane, read
  2026-10-07 while still uncommitted): the same four groups, the same greedy
  packing in order, the same limits and the same unit estimates, so the site's
  one button and the keeper send the same instructions in the same order and
  split them at the same points. That file cannot be imported here because it
  loads keeper.mjs, which reads the contract files from disk at module load
  (node:fs); this one can be imported there. One module is the aim: the
  keeper's plan() can keep its launch-state logic and take pack, assemble,
  sizeOf and the limits from here, which is the program session's change to
  make, not this lane's.

    The beacon group (legacy): post_beacon, reveal (every sealed bid, at most
                     REVEAL_MAX a reveal instruction), settle when that opens
                     the last bid. post_beacon closes the book itself when the
                     launch is still Open (0.27, lib.rs post_beacon), so no
                     close instruction goes in front of it.
    The pool group   create_pool, finish_mint, lock_liquidity, each alone
                     (legacy): together they pass the runtime's instruction
                     trace limit (64 instructions a transaction, CPIs
                     included), measured on devnet 2026-10-07, whatever their
                     byte size. The pool trades at create_pool; finish_mint
                     (0.29, the ninth candidate: the token's metadata and the
                     mint authority's revocation, moved out of create_pool
                     for trace headroom) and the lock land after it, signed
                     in the same prompt. The lock does not wait for the
                     finish (the keeper's order, keeper/src/bundle.mjs).

  An instruction joins the current transaction while the serialized size stays
  within TX_BYTES, the unique accounts within ACCOUNTS_MAX and the estimated
  units within UNITS_MAX; otherwise a new transaction starts. Nothing here
  reads the chain.
*/
import { AddressLookupTableAccount, ComputeBudgetProgram, Transaction, TransactionMessage, VersionedTransaction } from "@solana/web3.js";

/** The runtime's packet limit for one serialized transaction, signatures included. */
export const TX_BYTES = 1232;
/** Unique account keys one transaction may carry (the runtime's limit). */
export const ACCOUNTS_MAX = 64;
/** Compute units one transaction may ask for. */
export const UNITS_MAX = 1_400_000;
/** Bids one reveal instruction carries; about 42,000 units each. */
export const REVEAL_MAX = 20;

/**
  Units each step takes, measured on devnet 2026-10-07 by the keeper (K, F,
  TESTY) and rounded up: the packer's estimate. The keeper sizes the limit it
  sends from a simulation of the packed transaction; a signer that signs every
  transaction before the first is sent cannot simulate the later ones (each
  needs the one before it landed), so unitLimit() sizes them from these.
*/
/* 0.29 (the keeper's figures, keeper/src/bundle.mjs): settle scans the 2,407-tick histogram, 560,605 units on the constructed worst case, so its estimate is 600,000 and it shares a transaction with at most 18 revealed bids. */
/* The ninth candidate (the keeper's figures): finish_mint 90,000; lock_liquidity 200,000 (it also closes the pass through). */
export const UNIT_EST = { close: 8_000, post_beacon: 70_000, reveal_base: 10_000, reveal_bid: 42_000, settle: 600_000, create_pool: 320_000, finish_mint: 90_000, lock_liquidity: 200_000, deliver: 50_000, refund: 15_000, burn_unsold: 35_000, abort: 15_000 };

/**
  Lamports a step's signer fronts on top of the fee, repaid by the launch
  where INTERFACE says so (the record's rent at settle; the pool accounts'
  rents at create_pool, about 0.043 SOL measured, asked as 0.05; the creator
  position's rent the pool step did not set aside at lock_liquidity).
*/
/* finish_mint fronts the Metaplex metadata's rent and fee (13,733,800 measured; the keeper asks 0.014 SOL, METADATA_RESERVE_LAMPORTS), repaid at cost plus the allowance in the same instruction. */
export const FRONT = { close: 0, post_beacon: 0, reveal: 0, settle: 6_400_000, create_pool: 50_000_000, finish_mint: 14_000_000, lock_liquidity: 5_000_000, deliver: 2_100_000, refund: 0, burn_unsold: 0, abort: 0 };

/**
 * @typedef {import("@solana/web3.js").TransactionInstruction} TransactionInstruction
 * @typedef {import("@solana/web3.js").PublicKey} PublicKey
 * @typedef {{ name: string, ix: TransactionInstruction, units: number, front: number, count?: number, alone?: boolean }} Item
 * @typedef {{ label: string, items: Item[], v0: boolean }} Spec
 * @typedef {{ payer: PublicKey, alt: AddressLookupTableAccount | null, price: number, blockhash?: string }} Ctx
 * @typedef {{ items: Item[], v0: boolean, label: string }} Packed
 */

/**
 * One instruction with its estimate and what its signer fronts.
 * @param {keyof typeof UNIT_EST | "reveal"} name
 * @param {TransactionInstruction} ix
 * @param {{ units?: number, count?: number, alone?: boolean }} [extra]
 * @returns {Item}
 */
export const item = (name, ix, extra = {}) => ({ name, ix, front: FRONT[name] ?? 0, units: extra.units ?? UNIT_EST[name] ?? 0, ...extra });

/**
 * A reveal instruction carrying `count` bids.
 * @param {TransactionInstruction} ix
 * @param {number} count
 * @returns {Item}
 */
export const revealItem = (ix, count) => item("reveal", ix, { count, units: UNIT_EST.reveal_base + UNIT_EST.reveal_bid * count });

/**
 * @template T
 * @param {T[]} list
 * @param {number} n
 * @returns {T[][]}
 */
export function chunk(list, n) {
  const out = [];
  for (let i = 0; i < list.length; i += n) out.push(list.slice(i, i + n));
  return out;
}

/**
 * The beacon group: post_beacon (when not posted yet), the reveals, settle when every bid is then open.
 * @param {{ postBeacon: TransactionInstruction | null, reveals: Item[], settle: TransactionInstruction | null }} g
 * @returns {Spec}
 */
export function beaconGroup(g) {
  const items = [];
  if (g.postBeacon) items.push(item("post_beacon", g.postBeacon));
  items.push(...g.reveals);
  if (g.settle) items.push(item("settle", g.settle));
  return { label: items.map((i) => i.name).join("+"), items, v0: false };
}

/**
 * The pool group: create_pool, finish_mint and lock_liquidity, each present when due, in that order.
 * @param {{ createPool: TransactionInstruction | null, finishMint: TransactionInstruction | null, lockLiquidity: TransactionInstruction | null }} g
 * @returns {Spec}
 */
export function poolGroup(g) {
  /*
    Measured on devnet 2026-10-07 13:08 UTC (launch BdMMvBdeRSdrGwfSK9uiBpqeBbbC69Vbu8nvGtmwAMHe): create_pool and
    lock_liquidity in one version 0 transaction (1,002 bytes, within every size limit) are refused by the runtime at
    the preflight, "Max instruction trace length exceeded" at the lock: the two steps' CPIs together pass the 64
    instructions a transaction may execute. So each goes alone, legacy; the lookup table is not needed for either.
  */
  const items = [];
  if (g.createPool) items.push(item("create_pool", g.createPool, { alone: true }));
  if (g.finishMint) items.push(item("finish_mint", g.finishMint, { alone: true }));
  if (g.lockLiquidity) items.push(item("lock_liquidity", g.lockLiquidity, { alone: true }));
  return { label: items.map((i) => i.name).join("+"), items, v0: false };
}

const DUMMY_BLOCKHASH = "11111111111111111111111111111111";

/**
 * The compute budget instructions every transaction starts with: the unit limit, and the unit price when there is one.
 * @param {number} limit
 * @param {number} price microlamports a unit
 */
export function budgetIxs(limit, price) {
  const ixs = [ComputeBudgetProgram.setComputeUnitLimit({ units: limit })];
  if (price > 0) ixs.push(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: price }));
  return ixs;
}

/**
 * The transaction for a packed set of items. A v0 set without a table is built as a legacy transaction.
 * @param {Item[]} items
 * @param {boolean} v0
 * @param {number} limit
 * @param {Ctx} ctx
 * @returns {Transaction | VersionedTransaction}
 */
export function assemble(items, v0, limit, ctx) {
  const ixs = [...budgetIxs(limit, ctx.price), ...items.map((i) => i.ix)];
  if (v0 && ctx.alt) {
    const msg = new TransactionMessage({ payerKey: ctx.payer, recentBlockhash: ctx.blockhash || DUMMY_BLOCKHASH, instructions: ixs }).compileToV0Message([ctx.alt]);
    return new VersionedTransaction(msg);
  }
  const tx = new Transaction();
  tx.add(...ixs);
  tx.feePayer = ctx.payer;
  tx.recentBlockhash = ctx.blockhash || DUMMY_BLOCKHASH;
  return tx;
}

/**
 * Serialized size with its signatures, as the runtime counts it.
 * @param {Item[]} items
 * @param {boolean} v0
 * @param {Ctx} ctx
 */
export function sizeOf(items, v0, ctx) {
  const tx = assemble(items, v0, UNITS_MAX, { ...ctx, blockhash: DUMMY_BLOCKHASH });
  if (tx instanceof VersionedTransaction) return tx.message.serialize().length + 1 + 64 * tx.message.header.numRequiredSignatures;
  const msg = tx.compileMessage();
  return msg.serialize().length + 1 + 64 * msg.header.numRequiredSignatures;
}

/** Unique accounts the items touch, plus the payer and the compute budget program. @param {Item[]} items */
export function accountsOf(items) {
  const set = new Set();
  for (const i of items) {
    set.add(i.ix.programId.toBase58());
    for (const k of i.ix.keys) set.add(k.pubkey.toBase58());
  }
  return set.size + 2;
}

/** @param {Item[]} items */
export const unitsOf = (items) => items.reduce((s, i) => s + i.units, 0);

/** @param {Item[]} items */
export const txFront = (items) => items.reduce((s, i) => s + i.front, 0);

/**
 * The unit limit for a transaction whose units cannot be simulated before it is signed: the estimate plus a quarter, within the cap.
 * @param {Item[]} items
 */
export const unitLimit = (items) => Math.min(UNITS_MAX, Math.ceil(unitsOf(items) * 1.25) + 5_000);

/**
 * Split a spec's items into transactions, greedily, in order.
 * @param {Spec} spec
 * @param {Ctx} ctx
 * @returns {Packed[]}
 */
export function pack(spec, ctx) {
  const txs = [];
  let cur = [];
  const fits = (items) => unitsOf(items) <= UNITS_MAX && accountsOf(items) <= ACCOUNTS_MAX && sizeOf(items, spec.v0, ctx) <= TX_BYTES;
  for (const it of spec.items) {
    /* An item marked alone takes a transaction of its own (the runtime's instruction trace limit, not a size). */
    if (!it.alone && !cur.some((c) => c.alone) && fits([...cur, it])) {
      cur.push(it);
      continue;
    }
    if (cur.length) {
      txs.push(cur);
      cur = [];
    }
    if (!fits([it])) throw new Error(`${it.name} does not fit a transaction on its own`);
    cur.push(it);
  }
  if (cur.length) txs.push(cur);
  return txs.map((items) => ({ items, v0: spec.v0 && !!ctx.alt, label: items.map((i) => i.name + (i.count ? `(${i.count})` : "")).join("+") }));
}

/**
 * A lookup table account built from what is known of it, for sizing without the chain. The table sent with a
 * transaction is always the one read from the chain, so a stale list here can only mis-size, never mis-address.
 * @param {PublicKey} key
 * @param {PublicKey[]} addresses
 */
export function localTable(key, addresses) {
  return new AddressLookupTableAccount({ key, state: { deactivationSlot: BigInt("18446744073709551615"), lastExtendedSlot: 0, lastExtendedSlotStartIndex: 0, authority: undefined, addresses } });
}
