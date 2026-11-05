/*
  A launch's history read once for everyone (2026-10-15, the launch data
  path's Phase C). Before, every settlement page read the launch's whole
  history itself, one getTransaction per transaction at 20 a second on a
  keyed RPC: a launch of 1,000 transactions cost each visitor 1,000 credits
  and two visitors at once filled the plan's rate. Here the server reads it
  with Helius's getTransactionsForAddress (full transactions, 1,000 a call,
  10 credits per 100) and the endpoint (app/api/launch/[id]/history) puts
  the result behind the CDN. An RPC without that method (the local board's
  validator, a public endpoint) is read with the browser's own reader at its
  pace, so the local board and the check scripts work unchanged.

  The events are the same objects the browser's reader makes
  (history.ts factsOfTransaction), oldest first, costs filled; the browser
  merges them as it merges its own. Nothing here is used to build a
  transaction.
*/
import { PublicKey } from "@solana/web3.js";
import { decodeLaunch } from "../chain/decode";
import type { DecodedEvent } from "../chain/events";
import { factsOfTransaction, fillCosts, readHistory, type HistoryHints, type RawTransaction } from "../chain/history";
import { getConnection } from "../chain/rpc";
import { isMethodNotFound, UpstreamError } from "../chain/upstreamError";
import { BudgetExhausted, budgetStatus, chargeRpcCredits, HISTORY_PAGE_CREDITS, historyPageCredits, meteredFetch, refundRpcCredits, staleOr } from "./budget";
import { readSnapshot } from "./snapshot";

export interface LaunchHistory {
  id: string;
  events: DecodedEvent[];
  /* True when the read reached the launch's creation. */
  complete: boolean;
  newest: string | null;
  oldest: string | null;
  transactions: number;
  /* Transactions whose log the node cut, and payouts whose amounts the node's answers did not settle. */
  cutLogs: number;
  unsettled: number;
  readAt: number;
  final: boolean;
  /* How it was read: Helius's method, or one transaction at a time. */
  how: "getTransactionsForAddress" | "getTransaction";
  /* The chain, or what this instance last read when the day's budget is spent (server/budget.ts). */
  source: "chain" | "stale";
}

/* How long one instance keeps a history before reading again: short while the launch moves, long once it is final. */
const KEEP_LIVE_MS = 15_000;
const KEEP_FINAL_MS = 10 * 60_000;
const PAGE = 1_000;
const MAX_PAGES = 20;

const histories = new Map<string, { at: number; final: boolean; value: Promise<LaunchHistory> }>();
/* Until when the RPC is taken not to have getTransactionsForAddress: one such answer moves this instance to the slow reader for a while, not for its life (2026-10-16, the adversarial review). */
let noSuchMethodUntil = 0;
const NO_SUCH_METHOD_MS = 10 * 60_000;

function upstream(): string {
  const u = process.env.RPC_UPSTREAM || process.env.BOARD_RPC_UPSTREAM;
  if (!u) throw new UpstreamError("unconfigured");
  return u;
}

/* Every landed transaction that touched the address, newest first, through Helius's method; null when the RPC does not have it. */
async function transactionsFor(address: string): Promise<RawTransaction[] | null> {
  if (Date.now() < noSuchMethodUntil) return null;
  const out: RawTransaction[] = [];
  let paginationToken: string | null = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const options: Record<string, unknown> = { transactionDetails: "full", encoding: "json", maxSupportedTransactionVersion: 1, limit: PAGE, sortOrder: "desc", commitment: "confirmed", filters: { status: "succeeded" } };
    if (paginationToken) options.paginationToken = paginationToken;
    /*
      Charged to the day's budget at the provider's real price (Astra
      2026-10-17c, A3): the worst page, HISTORY_PAGE_CREDITS, is reserved
      before the call and what the page did not use comes back once its
      size is known (historyPageCredits). A page that failed keeps its full
      charge. A history read is browsing (S1 (b)): on a mainnet pin it is
      one of the reads the soft line may refuse (budget.ts countOnly).
    */
    const day = budgetStatus().day;
    if ((await chargeRpcCredits(HISTORY_PAGE_CREDITS, false, true)) === "refused") throw new BudgetExhausted();
    const res = await globalThis.fetch(upstream(), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getTransactionsForAddress", params: [address, options] }),
      cache: "no-store",
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new UpstreamError("http", res.status);
    const json = (await res.json()) as { result?: { data?: unknown[]; paginationToken?: string | null }; error?: { code?: number; message?: string } };
    const got = Array.isArray(json.result?.data) ? json.result.data.length : 0;
    refundRpcCredits(HISTORY_PAGE_CREDITS - historyPageCredits(got), day);
    if (json.error) {
      if (isMethodNotFound(json.error)) {
        noSuchMethodUntil = Date.now() + NO_SUCH_METHOD_MS;
        return null;
      }
      /* The category only (2026-10-16): the provider's message is never kept. */
      throw new UpstreamError("refused");
    }
    for (const item of json.result?.data ?? []) {
      const t = item as Partial<RawTransaction>;
      if (t && t.transaction && typeof t.slot === "number") out.push(t as RawTransaction);
    }
    paginationToken = json.result?.paginationToken ?? null;
    if (!paginationToken) break;
  }
  return out;
}

async function read(id: string): Promise<LaunchHistory> {
  const snapshot = await readSnapshot(id);
  const launch = snapshot.launch ? decodeLaunch(id, Uint8Array.from(Buffer.from(snapshot.launch.data, "base64"))) : null;
  const hints: HistoryHints = { creator: launch?.creator ?? null, feeBps: launch?.deliveryFeeBps ?? null, deliveryTerms: launch?.deliveryTerms ?? null, deliveryReward: launch?.deliveryReward ?? null };
  const txs = await transactionsFor(id);
  if (txs === null) {
    /* The slow reader's transaction batches go through the metered fetch too (server/budget.ts). */
    const r = await readHistory(getConnection(), new PublicKey(id), { ...hints, fetchImpl: meteredFetch });
    const events = r.events.slice().reverse();
    fillCosts(events);
    return { id, events, complete: r.stats.complete === true, newest: r.newest, oldest: r.oldest, transactions: r.stats.transactions, cutLogs: r.stats.cutLogs, unsettled: r.stats.unsettled, readAt: Date.now(), final: snapshot.final, how: "getTransaction", source: snapshot.source };
  }
  const events: DecodedEvent[] = [];
  let cutLogs = 0;
  let unsettled = 0;
  let genesis = false;
  for (const tx of txs) {
    const signature = tx.transaction.signatures[0];
    const facts = factsOfTransaction(tx, id, hints);
    if (facts.cut) cutLogs++;
    if (facts.genesis) genesis = true;
    unsettled += facts.unsettled;
    events.push(...facts.events.map((e) => ({ ...e, signature, slot: tx.slot, blockTime: tx.blockTime ?? null })));
  }
  /* Newest first from the node; the pages keep a history oldest first. */
  events.reverse();
  fillCosts(events);
  /* Built on a stale snapshot, the history is stale too, whatever its own read was. */
  return { id, events, complete: genesis, newest: txs[0]?.transaction.signatures[0] ?? null, oldest: txs[txs.length - 1]?.transaction.signatures[0] ?? null, transactions: txs.length, cutLogs, unsettled, readAt: Date.now(), final: snapshot.final, how: "getTransactionsForAddress", source: snapshot.source };
}

export function readLaunchHistory(id: string): Promise<LaunchHistory> {
  return staleOr(`history:${id}`, () => readFresh(id), (h) => h.complete || h.events.length > 0);
}

function readFresh(id: string): Promise<LaunchHistory> {
  const hit = histories.get(id);
  if (hit && Date.now() - hit.at < (hit.final ? KEEP_FINAL_MS : KEEP_LIVE_MS)) return hit.value;
  const value = read(id);
  const entry = { at: Date.now(), final: false, value };
  histories.set(id, entry);
  value.then(
    (h) => {
      entry.final = h.final;
    },
    () => {
      if (histories.get(id) === entry) histories.delete(id);
    },
  );
  return value;
}
