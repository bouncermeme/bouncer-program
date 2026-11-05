/*
  The book after the accounts are gone. deliver, refund and claim close the
  Bid account to the bidder (INTERFACE, Bid account), so on a distributed
  launch the table is rebuilt from the launch's history: BidCommitted
  (deposit, creator flag), BidRevealed (tick), BidInvalid, Delivered (what
  left, fee included) and Refunded. Commits and payouts are read from the
  transactions themselves, never from a log line; the step a bid opened at
  and the lifecycle rows from the program's log lines (chain/history.ts).
  Bid accounts still open are read directly and win over the history.
*/
import type { DecodedEvent } from "./chain/events";
import { isCreatorBid, type BidAccount, type ClosedBid, type Delivery } from "./types";
import type { SettledRow } from "./view";

/*
  The bid table's one order, "highest max first" (Astra's e2e pass of 2026-10-22: closed rows had been appended in
  history order, ticks 300, 90, 90, 0, 200). Applied to the combined open and closed rows before they are paged:
  the higher tick first, an unknown tick (sealed, never opened) last; then the larger deposit; then the wallet, then
  the bid address, so equal bids keep one order on every read.
*/
export interface OrderKey {
  tick: number | null;
  deposit: bigint;
  bidder: string;
  bid: string;
}
const cmpStr = (x: string, y: string) => (x < y ? -1 : x > y ? 1 : 0);
export function byHighestMax(x: OrderKey, y: OrderKey): number {
  if (x.tick !== y.tick) {
    if (x.tick === null) return 1;
    if (y.tick === null) return -1;
    return y.tick - x.tick;
  }
  if (x.deposit !== y.deposit) return y.deposit > x.deposit ? 1 : -1;
  return cmpStr(x.bidder, y.bidder) || cmpStr(x.bid, y.bid);
}

function delivery(ev: DecodedEvent): Delivery {
  const d = ev.data;
  return { bid: String(d.bid), bidder: String(d.bidder), tokens: BigInt(d.tokens), cost: d.cost === undefined ? null : BigInt(d.cost), refund: BigInt(d.refund), feeTokens: BigInt(d.fee_tokens), settled: d.settled !== false, claimed: d.claimed === true, signature: ev.signature, blockTime: ev.blockTime };
}

export function closedBidsFromEvents(events: readonly DecodedEvent[], live: readonly BidAccount[]): ClosedBid[] {
  const open = new Set(live.map((b) => b.address));
  const by = new Map<string, ClosedBid>();
  const get = (bid: string, bidder: string): ClosedBid => {
    let c = by.get(bid);
    if (!c) {
      c = { bid, bidder, deposit: 0n, tick: null, invalid: false, delivered: null, refunded: null, creator: false };
      by.set(bid, c);
    }
    return c;
  };
  for (const ev of events) {
    const d = ev.data;
    switch (ev.name) {
      case "BidCommitted": {
        const c = get(String(d.bid), String(d.bidder));
        if (!c.bidder) c.bidder = String(d.bidder);
        c.deposit = BigInt(d.deposit);
        c.creator = Boolean(d.creator);
        break;
      }
      /* BidRevealed and BidInvalid carry no bidder; the entry is created here and the bidder filled in by Delivered or Refunded, which the row needs anyway. */
      case "BidRevealed": {
        const c = get(String(d.bid), "");
        c.tick = Number(d.tick);
        if (c.deposit === 0n) c.deposit = BigInt(d.deposit);
        break;
      }
      case "BidInvalid": {
        const c = get(String(d.bid), "");
        c.invalid = true;
        if (c.deposit === 0n) c.deposit = BigInt(d.deposit);
        break;
      }
      case "Delivered": {
        const dl = delivery(ev);
        const c = get(dl.bid, dl.bidder);
        c.bidder = dl.bidder;
        /* A loser's claim on a node that left the tokens out (history.ts, fillCosts): the whole deposit came back. */
        if (d.loser === true) {
          c.refunded = { amount: dl.refund, signature: ev.signature, settled: true };
          if (c.deposit === 0n) c.deposit = dl.refund;
          break;
        }
        c.delivered = dl;
        if (c.deposit === 0n && dl.cost !== null) c.deposit = dl.cost + dl.refund;
        break;
      }
      case "Refunded": {
        const c = get(String(d.bid), String(d.bidder));
        c.bidder = String(d.bidder);
        c.refunded = { amount: BigInt(d.amount), signature: ev.signature, settled: d.settled !== false };
        if (c.deposit === 0n && d.settled !== false) c.deposit = BigInt(d.amount);
        break;
      }
    }
  }
  /* Only bids whose account is gone and that actually left (a delivery or a refund landed). */
  return [...by.values()].filter((c) => !open.has(c.bid) && (c.delivered || c.refunded));
}

/* A closed bid that won: tokens delivered, or a delivery whose amounts this RPC did not return. */
export function closedWon(c: ClosedBid): boolean {
  return c.delivered !== null && (!c.delivered.settled || c.delivered.tokens > 0n);
}

export interface FundingWinner {
  bidder: string;
  /* Lamports deposited; 0 when this RPC returned neither the commit nor the delivery's amounts. */
  deposit: bigint;
  /* Atoms won; null when this RPC returned the delivery without its amounts. */
  tokens: bigint | null;
}

/*
  Every winner but the creator (the 0.28 triage's F6): the open rows' fills
  and the closed bids' deliveries. Winners are fixed at settle and a payout
  only moves one from the first list to the second, so the count holds
  through the payouts. One bid per bidder (pda.ts), so a bidder in both lists
  (delivered after the bids were read) counts once, the open row first. The
  creator is dropped by address, which is exact (lib.rs:1333), so a creator's
  bid whose commit is outside the history read is dropped too.
*/
export function fundingWinners(creator: string, rows: readonly SettledRow[], closed: readonly ClosedBid[]): FundingWinner[] {
  const out = new Map<string, FundingWinner>();
  for (const r of rows) {
    const b = r.bid.bidder;
    if (r.fill.tokens > 0n && b && b !== creator && !isCreatorBid(r.bid) && !out.has(b)) out.set(b, { bidder: b, deposit: r.bid.deposit, tokens: r.fill.tokens });
  }
  for (const c of closed) {
    if (!closedWon(c) || !c.bidder || c.bidder === creator || c.creator || out.has(c.bidder)) continue;
    out.set(c.bidder, { bidder: c.bidder, deposit: c.deposit, tokens: c.delivered!.settled ? c.delivered!.tokens : null });
  }
  return [...out.values()];
}

/* Deliveries by bid address, for rows whose account is still listed (a winner delivered since the bid list was read). */
export function deliveriesByBid(events: readonly DecodedEvent[]): Map<string, Delivery> {
  const out = new Map<string, Delivery>();
  for (const ev of events) if (ev.name === "Delivered") out.set(String(ev.data.bid), delivery(ev));
  return out;
}
