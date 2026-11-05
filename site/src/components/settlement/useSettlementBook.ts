"use client";

/*
  The settled book of a launch, read from the chain: the open bids, the histogram, the paid bids from the launch's
  history, their tally, and the winners' funding trace (the 0.28 triage's F6). One hook for the two pages that show
  it: Results (SettlementView) and, since the founder's 3A follow-up (2026-10-27: the funding links and the holder map move
  to the trading page), the trading page's funding panel. The reads are the shared client's, so both pages share them.
*/
import { useEffect, useMemo, useState } from "react";
import { closedBidsFromEvents, deliveriesByBid, fundingWinners } from "@/lib/bouncer/book";
import { useBidsRead, useFundingReport, useHistogram, useLaunchEventsRead } from "@/lib/bouncer/hooks";
import type { Launch, SettlementRecord } from "@/lib/bouncer/types";
import { buildSettlementView, shareOfSupply } from "@/lib/bouncer/view";

/*
  The final E2E's S3 (2026-10-30): the shared history is kept at the CDN for up to a minute (api/launch/[id]/history),
  so a page opened just after the payouts could read one from before them, and it was asked again only when the
  payout count moved: the trading page then said "Not traced" for good. While the book is short of the record's
  count after a read that finished, the history is asked again every 20 seconds, up to 9 times (three minutes).
*/
export const HISTORY_REREAD_MS = 20_000;
export const HISTORY_REREADS = 9;

export function useSettlementBook(id: string, launch: Launch | null, record: SettlementRecord | null) {
  const state = launch?.account.state;
  const { bids, failed: bidsFailed, retry: retryBids } = useBidsRead(id, `${state}:${launch?.account.revealedCount ?? 0}:${launch?.account.distributedCount ?? 0}`);
  const counts = useHistogram(id, !!launch?.account.settled);
  const view = useMemo(() => (launch && record && bids ? buildSettlementView(launch, record, bids, counts) : null), [launch, record, bids, counts]);
  /* Bid accounts close on delivery and refund; the rest of the book is in the launch's transactions, read back to its creation (chain/history.ts). */
  const [reread, setReread] = useState(0);
  const { events, read: eventsRead, progress } = useLaunchEventsRead(id, `${state}:${launch?.account.distributedCount ?? 0}:${reread}`);
  /* How far the read has got, as a count: a busy launch takes minutes on a rate-limited RPC. */
  const readSoFar = progress && progress.total > 0 && progress.read < progress.total ? ` (${progress.read.toLocaleString("en-US")} of ${progress.total.toLocaleString("en-US")} transactions read)` : "";
  /* Why paid bids are missing from the page, when they are: a read still running, a refused read (resumed), or history this RPC no longer keeps. */
  const closed = useMemo(() => closedBidsFromEvents(events ?? [], bids ?? []), [events, bids]);
  const deliveries = useMemo(() => deliveriesByBid(events ?? []), [events]);
  /* A node that returns transactions without their inner instructions and token balances: the payouts are known, their amounts are not (history.ts). */
  const amountsMissing = closed.some((c) => (c.delivered && !c.delivered.settled) || (c.refunded && !c.refunded.settled));
  const gapWhy = (one: boolean) =>
    amountsMissing
      ? `this RPC returned the ${one ? "payment" : "payments"} without the amounts`
      : eventsRead === "limited"
        ? `the RPC is turning requests away just now (rate limited), so the history of ${one ? "that payment" : "those payments"} could not be read${readSoFar}; the page goes on from there every 20 seconds`
        : eventsRead === "failed"
          ? `the history of ${one ? "that payment" : "those payments"} could not be read just now${readSoFar}; the page goes on from there every 20 seconds`
          : eventsRead === "loading"
            ? `the history of ${one ? "that payment" : "those payments"} is still being read${readSoFar}`
            : `this RPC no longer serves the ${one ? "transaction that paid it" : "transactions that paid them"}`;
  /* The book as a whole: the open bids' predicted fills plus what the closed ones were paid. */
  const tally = useMemo(() => {
    if (!view || !launch) return null;
    const a0 = launch.account;
    let refunded = view.refunded;
    let winners = view.winners;
    /* cost is null for a delivery read from its transaction whose commit is not in the history: the tokens are known, what was paid is not. */
    let largest: { bidder: string | null; tokens: bigint; cost: bigint | null } | null = view.largest ? { bidder: view.largest.bidder, tokens: view.largest.tokens, cost: view.largest.cost } : null;
    for (const c of closed) {
      if (c.delivered) {
        /* A delivery whose amounts the node did not return is a winner with unknown figures: counted, never summed. */
        if (!c.delivered.settled) {
          winners++;
          continue;
        }
        refunded += c.delivered.refund;
        if (c.delivered.tokens > 0n) winners++;
        if (c.delivered.tokens > 0n && (!largest || c.delivered.tokens > largest.tokens)) largest = { bidder: c.bidder, tokens: c.delivered.tokens, cost: c.delivered.cost };
      } else if (c.refunded && c.refunded.settled) {
        refunded += c.refunded.amount;
      }
    }
    /* Bid accounts close as they are paid. When the book is short, or the node returned payouts without amounts, the record's own totals speak (largest_fill_tokens, distributed_bids). */
    const settledBids = record ? record.revealedBids + record.invalidBids : 0;
    const complete = view.rows.length + closed.length >= settledBids;
    if (record && record.largestFillTokens > (largest?.tokens ?? 0n)) largest = { bidder: null, tokens: record.largestFillTokens, cost: null };
    return {
      bids: complete ? view.rows.length + closed.length : settledBids,
      complete,
      winners,
      /* Every lamport not spent comes back; the costs sum to the float value within one lamport per marginal bidder. */
      refunded: complete ? refunded : launch.account.totalDeposits - view.clearing.floatValue,
      largest: largest ? { ...largest, shareOfSupply: shareOfSupply(a0, largest.tokens) } : null,
    };
  }, [view, launch, closed, record]);
  const short = !!tally && !tally.complete && eventsRead === "ok";
  useEffect(() => {
    if (!short || reread >= HISTORY_REREADS) return;
    const timer = setTimeout(() => setReread((n) => n + 1), HISTORY_REREAD_MS);
    return () => clearTimeout(timer);
  }, [short, reread]);
  /* The winners to trace (the 0.28 triage's F6): open fills plus closed deliveries, the creator left out. Traced once the book is whole or the history read is done, so a read still running does not start a walk on part of it. */
  const traceWinners = useMemo(() => (launch && view ? fundingWinners(launch.account.creator, view.rows, closed) : []), [launch, view, closed]);
  const traceReady = !!tally && (tally.complete || eventsRead === "ok");
  const traceKey = traceReady && traceWinners.length > 0 ? traceWinners.map((w) => w.bidder) : null;
  const { report: funding, loading: fundingLoading, failed: fundingFailed } = useFundingReport(id, traceKey);
  const linked = useMemo(() => new Set((funding?.traces ?? []).filter((t) => t.status === "linked").map((t) => t.bidder)), [funding]);
  return { bids, bidsFailed, retryBids, counts, view, events, eventsRead, progress, readSoFar, closed, deliveries, amountsMissing, gapWhy, tally, traceWinners, traceReady, traceKey, funding, fundingLoading, fundingFailed, linked };
}
