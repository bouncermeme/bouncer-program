/*
  A transaction's bytes read for the site's Bouncer-only rule (server/scope.ts,
  Astra 2026-10-17c): the signatures, the fee payer, the message bytes the
  signatures sign, and each instruction's program and accounts, with a
  version 0 message's lookup tables resolved from the site's own frozen table
  (lookupTables.ts). Plain data out, nothing of the library's objects, so the
  server module holds no transaction and reads no field named like an
  exception's. Null for anything that is not a transaction, or a version 0
  message that names a table that is not ours.
*/
import { PublicKey, VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58";
import { LOOKUP_ADDRESSES, LOOKUP_TABLES } from "./lookupTables";

export interface DecodedTransaction {
  /* The signatures as placed, the first the fee payer's. */
  signatures: Uint8Array[];
  numRequiredSignatures: number;
  payer: PublicKey;
  /* The serialized message, what the signatures sign. */
  messageBytes: Uint8Array;
  /* Each instruction's program and the accounts it names, as base58. */
  instructions: { program: string; accounts: string[] }[];
}

const KNOWN_TABLES: ReadonlySet<string> = new Set(Object.values(LOOKUP_TABLES));
const B58 = /^[1-9A-HJ-NP-Za-km-z]+$/;
const B64 = /^[A-Za-z0-9+/]+={0,2}$/;
const MAX_CHARS = 1_800;

function bytesOf(text: string): Uint8Array[] {
  const out: Uint8Array[] = [];
  if (B64.test(text)) out.push(Buffer.from(text, "base64"));
  if (B58.test(text)) {
    try {
      out.push(bs58.decode(text));
    } catch {
      /* not base58 */
    }
  }
  return out;
}

/* The bytes of a transaction as web3.js sends them (base64, or base58), decoded; legacy and version 0 alike. */
export function decodeTransaction(text: unknown): DecodedTransaction | null {
  if (typeof text !== "string" || text.length === 0 || text.length > MAX_CHARS) return null;
  for (const bytes of bytesOf(text)) {
    let tx: VersionedTransaction;
    try {
      tx = VersionedTransaction.deserialize(bytes);
    } catch {
      continue;
    }
    const m = tx.message;
    const keys = m.staticAccountKeys.map((k) => k.toBase58());
    if (m.version !== "legacy") {
      const writable: string[] = [];
      const readonly: string[] = [];
      for (const l of m.addressTableLookups) {
        if (!KNOWN_TABLES.has(l.accountKey.toBase58())) return null;
        for (const i of l.writableIndexes) {
          const a = LOOKUP_ADDRESSES[i];
          if (!a) return null;
          writable.push(a.toBase58());
        }
        for (const i of l.readonlyIndexes) {
          const a = LOOKUP_ADDRESSES[i];
          if (!a) return null;
          readonly.push(a.toBase58());
        }
      }
      keys.push(...writable, ...readonly);
    }
    if (keys.length === 0) return null;
    const instructions: DecodedTransaction["instructions"] = [];
    for (const ix of m.compiledInstructions) {
      const program = keys[ix.programIdIndex];
      if (program === undefined) return null;
      instructions.push({ program, accounts: ix.accountKeyIndexes.map((i) => keys[i]).filter((k): k is string => k !== undefined) });
    }
    return { signatures: tx.signatures.map((s) => Uint8Array.from(s)), numRequiredSignatures: m.header.numRequiredSignatures, payer: m.staticAccountKeys[0], messageBytes: m.serialize(), instructions };
  }
  return null;
}
