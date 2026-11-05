/*
  A funding provider on a plain Solana RPC, no indexer. This is what the walk
  can afford today, and scripts/probe-funding.ts measures what it costs.

  For one wallet: page getSignaturesForAddress from the newest signature
  backwards until the history ends or maxSignaturePages is hit. Funding
  transfers are the oldest transactions, so a wallet whose history does not
  end within the page budget is returned as null: unresolvable here. Then
  the oldest maxTransactions signatures are fetched parsed, in one batched
  call, and every native SOL transfer into the wallet becomes a hop.

  2026-11-04 (04e): mainnet carries version 1 transactions (16 of a BOUNCER
  winner's oldest 24), and web3.js's getParsedTransactions asked for version 0
  throws for the whole batch on one of them (-32015), so the wallet came back
  as an error and the trade page said "Not traced". The chunk is now one raw
  JSON-RPC batch of getTransaction, jsonParsed, maxSupportedTransactionVersion
  1, through the connection's own fetch (the server's metered one), each reply
  matched by its id and checked against its own signature, one reply's error
  not spoiling the others: the same as chain/history.ts fetchTransactions.

  Not a hop: SPL token transfers, wrapped SOL, rent paid into program owned
  accounts, and the wallet paying itself. A failed transaction is skipped.

  Public RPC endpoints rate limit per method, and a batched transaction fetch
  counts once per signature (the public devnet endpoint refused a batch of
  24 with a 429 on 2026-09-24). Transactions are therefore fetched in small
  chunks with a pause between them, and a 429 is retried with backoff a few
  times before the wallet is given up.

  The launch page also reads the launch's history, transaction by
  transaction, from the same endpoint under the same limit. Measured
  2026-10-02 on the public devnet endpoint: with each pacing itself, every
  one of this trace's 19 requests was refused and the history of a
  14-transaction launch took 55 s. So the chunks here wait their turn in the
  history reader's line (chain/history.ts, takeTurn), which also tells them
  when the endpoint takes one transaction at a time.
*/

import { Connection, PublicKey, type ParsedInstruction, type ParsedTransactionWithMeta, type PartiallyDecodedInstruction } from "@solana/web3.js";
import { takeTurn } from "./chain/history";
import type { FundingHop, FundingProvider } from "./funding";

export interface RpcFundingOptions {
  /* Signature pages of 1,000 read per wallet before giving up on it. */
  maxSignaturePages: number;
  /* Oldest transactions fetched per wallet to look for incoming transfers. */
  maxTransactions: number;
  /* Signatures per parsed transaction fetch. */
  batchSize: number;
  /* Pause between chunks, milliseconds. */
  pauseMs: number;
  /* Retries on a rate limit before the wallet is given up. */
  retries: number;
}

export const RPC_DEFAULTS: RpcFundingOptions = { maxSignaturePages: 2, maxTransactions: 24, batchSize: 3, pauseMs: 400, retries: 4 };

export interface RpcStats {
  rpcCalls: number;
  signaturePages: number;
  signaturesRead: number;
  transactionsRead: number;
  retries: number;
  ms: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function isRateLimit(e: unknown): boolean {
  const m = e instanceof Error ? e.message : String(e);
  return /429|too many requests/i.test(m);
}

async function withBackoff<T>(call: () => Promise<T>, o: RpcFundingOptions, stats: RpcStats): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await call();
    } catch (e) {
      if (!isRateLimit(e) || attempt >= o.retries) throw e;
      stats.retries += 1;
      await sleep(500 * 2 ** attempt);
    }
  }
}

/* fetchImpl: what the chunk's raw read goes through; the server passes its connection's metered fetch (server/funding.ts). */
export function rpcFundingProvider(connection: Connection, options: Partial<RpcFundingOptions> = {}, fetchImpl: typeof fetch = fetch): FundingProvider & { stats: RpcStats } {
  const o: RpcFundingOptions = { ...RPC_DEFAULTS, ...options };
  const stats: RpcStats = { rpcCalls: 0, signaturePages: 0, signaturesRead: 0, transactionsRead: 0, retries: 0, ms: 0 };
  return {
    stats,
    /* The oldest block this RPC still serves. getSignaturesForAddress returns nothing older, silently, so the report states this floor. */
    async reach() {
      stats.rpcCalls += 1;
      const firstSlot = await withBackoff(() => connection.getFirstAvailableBlock(), o, stats);
      let firstBlockTime: number | null = null;
      /* The first available slot may be a skipped one; try a few forward for a time. */
      for (let s = firstSlot; s < firstSlot + 8 && firstBlockTime === null; s++) {
        try {
          stats.rpcCalls += 1;
          firstBlockTime = await connection.getBlockTime(s);
        } catch {
          firstBlockTime = null;
        }
      }
      return { firstSlot, firstBlockTime };
    },
    async fundersOf(address) {
      const t0 = Date.now();
      try {
        const key = new PublicKey(address);
        const signatures: string[] = [];
        let before: string | undefined;
        let ended = false;
        for (let page = 0; page < o.maxSignaturePages; page++) {
          stats.rpcCalls += 1;
          stats.signaturePages += 1;
          const batch = await withBackoff(() => connection.getSignaturesForAddress(key, { before, limit: 1000 }, "confirmed"), o, stats);
          stats.signaturesRead += batch.length;
          for (const s of batch) signatures.push(s.signature);
          if (batch.length < 1000) {
            ended = true;
            break;
          }
          before = batch[batch.length - 1].signature;
        }
        if (!ended) return null;
        const oldest = signatures.slice(-o.maxTransactions).reverse();
        if (oldest.length === 0) return { hops: [], complete: true };
        const hops: FundingHop[] = [];
        for (let i = 0; i < oldest.length; ) {
          stats.rpcCalls += 1;
          const { chunk, txs } = await withBackoff(
            () =>
              takeTurn(
                connection.rpcEndpoint,
                async (limited) => {
                  const chunk = oldest.slice(i, i + (limited ? 1 : o.batchSize));
                  const txs = await fetchParsed(connection.rpcEndpoint, chunk, fetchImpl);
                  return { value: { chunk, txs }, asked: chunk.length };
                },
                o.pauseMs,
              ),
            o,
            stats,
          );
          stats.transactionsRead += txs.length;
          txs.forEach((tx, j) => {
            if (!tx || tx.meta?.err) return;
            /* A node may answer a batch in any order: the transaction's own signature labels the hop, the position only when it carries none. */
            hops.push(...incomingTransfers(tx, address, tx.transaction.signatures[0] ?? chunk[j]));
          });
          i += chunk.length;
        }
        return { hops, complete: signatures.length <= o.maxTransactions };
      } finally {
        stats.ms += Date.now() - t0;
      }
    },
  };
}

/* The highest transaction version the walk reads (version 1 is on mainnet and devnet; the message shape is the same). */
export const MAX_VERSION = 1;

/*
  The parsed transactions of `signatures`, in their order, null where the node has none or the version is above
  MAX_VERSION. A refusal for rate, the whole request's or one reply's, throws a 429 so withBackoff tries the chunk
  again; any other reply error throws, and the wallet is given up as before.
*/
export async function fetchParsed(endpoint: string, signatures: string[], fetchImpl: typeof fetch = fetch): Promise<(ParsedTransactionWithMeta | null)[]> {
  const body = signatures.map((s, id) => ({ jsonrpc: "2.0", id, method: "getTransaction", params: [s, { encoding: "jsonParsed", maxSupportedTransactionVersion: MAX_VERSION, commitment: "confirmed" }] }));
  const res = await fetchImpl(endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), cache: "no-store" });
  if (res.status === 429) throw new Error("429 Too Many Requests");
  if (!res.ok) throw new Error(`funding read: HTTP ${res.status}`);
  const json: unknown = await res.json();
  const replies = (Array.isArray(json) ? json : [json]) as { id?: unknown; result?: ParsedTransactionWithMeta | null; error?: { code?: number; message?: string } }[];
  const out: (ParsedTransactionWithMeta | null)[] = signatures.map(() => null);
  for (const r of replies) {
    const id = r?.id;
    if (typeof id !== "number" || signatures[id] === undefined) continue;
    if (r.error) {
      const text = `${r.error.code ?? ""} ${r.error.message ?? ""}`;
      if (/(^|\D)(429|-32005)(\D|$)|too many requests|rate limit/i.test(text)) throw new Error(`429 ${text}`);
      if (r.error.code === -32015 || /transaction version .* is not supported/i.test(text)) continue;
      throw new Error(`funding read: ${text}`);
    }
    if (r.result && r.result.transaction?.signatures?.[0] === signatures[id]) out[id] = r.result;
  }
  return out;
}

type Parsed = { type: string; info: Record<string, unknown> };

/* Native SOL that arrived in `address` in this transaction, top level and inner instructions alike. */
export function incomingTransfers(tx: ParsedTransactionWithMeta, address: string, signature: string): FundingHop[] {
  const out: FundingHop[] = [];
  const all: (ParsedInstruction | PartiallyDecodedInstruction)[] = [...tx.transaction.message.instructions];
  for (const inner of tx.meta?.innerInstructions ?? []) all.push(...inner.instructions);
  for (const ix of all) {
    if (!("parsed" in ix) || ix.program !== "system") continue;
    const p = ix.parsed as Parsed;
    const info = p.info ?? {};
    let from: string | undefined;
    if ((p.type === "transfer" || p.type === "transferWithSeed") && info.destination === address) from = String(info.source);
    else if ((p.type === "createAccount" || p.type === "createAccountWithSeed") && info.newAccount === address) from = String(info.source);
    if (!from || from === address) continue;
    out.push({ from, to: address, lamports: BigInt(String(info.lamports ?? 0)), signature, blockTime: tx.blockTime ?? null });
  }
  return out;
}
