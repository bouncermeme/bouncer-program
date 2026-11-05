"use client";

import { useMemo } from "react";
import Link from "next/link";
import { PublicKey } from "@solana/web3.js";
import { ReadFailed } from "@/components/ui/ReadFailed";
import { useLaunchEvents, useNow, useRecentBids } from "@/lib/bouncer/hooks";
import { fmtAgo, fmtSol, shortAddr } from "@/lib/bouncer/format";
import { isCreatorBid, type BidAccount, type Launch } from "@/lib/bouncer/types";
import { CreatorBidPill } from "@/components/ui/CreatorBid";
import { endedWithoutSale } from "@/lib/bouncer/view";
import { closedBidsFromEvents } from "@/lib/bouncer/book";
import { bidPda } from "@/lib/bouncer/chain/pda";
import type { DecodedEvent } from "@/lib/bouncer/chain/events";
import { allDepositsLink } from "@/lib/bouncer/approvedCopy";

/*
  The list. Public deposits. While the doors are open the tick on every bid
  account is null, by type. The creator pill is the program's own label on
  the bid (Bid.flags bit 1, set by commit when the signer is the launch's
  creator), not a guess.

  2A (the founder, 2026-10-27, review/2026-10-27-v030/FOUNDER-UI-DECISIONS.md item 2):
  from settlement on, a bid's account closes when it is delivered or refunded,
  and its row stays: "Delivered" or "Refunded", the Results labels, from the
  launch's history (the same shared read the Results page makes, so no new
  RPC read). The creator's bid comes first, the rest newest first, and "All
  {N} deposits" leads to the Results table. While bidding is open nothing
  changes. The rows stay at `limit`: the open ones are still the newest few
  only, and an open bid older than those is never among the newest `limit`
  of open and closed together.
*/

type FeedStatus = "sealed" | "opened" | "refunded-ended" | "delivered" | "refunded";
export interface FeedRow {
  bid: string;
  bidder: string;
  deposit: bigint;
  /* Bid.placed_ts for an open bid, the BidCommitted transaction's block time for a closed one; null when the history did not give it. */
  placedTs: number | null;
  creator: boolean;
  status: FeedStatus;
}

/* The rows the feed shows, in order: the creator's bid first (by the program's labels only), then newest first, at most `limit`. */
export function feedRows(recent: readonly BidAccount[], events: readonly DecodedEvent[] | null, opts: { ended: boolean; creatorBid: string | null; limit: number }): FeedRow[] {
  const isCreator = (bid: string, labelled: boolean) => labelled || (opts.creatorBid !== null && bid === opts.creatorBid);
  const rows = new Map<string, FeedRow>();
  for (const b of recent) {
    rows.set(b.address, { bid: b.address, bidder: b.bidder, deposit: b.deposit, placedTs: b.placedTs, creator: isCreator(b.address, isCreatorBid(b)), status: opts.ended && b.state === "done" ? "refunded-ended" : b.tick == null ? "sealed" : "opened" });
  }
  if (events) {
    const committed = new Map<string, DecodedEvent>();
    const revealed = new Set<string>();
    for (const ev of events) {
      if (ev.name === "BidCommitted") committed.set(String(ev.data.bid), ev);
      else if (ev.name === "BidRevealed") revealed.add(String(ev.data.bid));
    }
    for (const c of closedBidsFromEvents(events, recent)) {
      /* The history is handed over while it is read, the payouts first: a row waits until its deposit is known, never "0 SOL". */
      if (c.deposit <= 0n) continue;
      rows.set(c.bid, { bid: c.bid, bidder: c.bidder, deposit: c.deposit, placedTs: committed.get(c.bid)?.blockTime ?? null, creator: isCreator(c.bid, c.creator), status: c.delivered ? "delivered" : "refunded" });
    }
    /* The creator's bid still open but older than the newest few read: from its own BidCommitted line. */
    const cb = opts.creatorBid;
    const line = cb && !rows.has(cb) ? committed.get(cb) : undefined;
    if (cb && line) rows.set(cb, { bid: cb, bidder: String(line.data.bidder), deposit: BigInt(line.data.deposit as string | number | bigint), placedTs: line.blockTime ?? null, creator: true, status: revealed.has(cb) ? "opened" : "sealed" });
  }
  return [...rows.values()]
    .sort((x, y) => Number(y.creator) - Number(x.creator) || (y.placedTs ?? -1) - (x.placedTs ?? -1))
    .slice(0, opts.limit);
}
export function DepositFeed({ launch, limit = 8 }: { launch: Launch; limit?: number }) {
  const a = launch.account;
  const ended = endedWithoutSale(launch);
  const now = useNow(5000);
  /* 24n (plan fix 4): the newest `limit` only, a small shared read, again whenever the launch moves (read every 2 s). */
  const { bids, failed, retry } = useRecentBids(launch.id, `${a.bidCount}:${a.state}:${a.revealedCount}:${a.distributedCount}`, limit);
  /* 2A: from settlement on (a sale, not an ending without one), the closed rows from the launch's history, keyed as the Results page keys it so the two share the read. */
  const paying = a.settled && !ended;
  const events = useLaunchEvents(paying ? launch.id : "", `${a.state}:${a.distributedCount}`);
  /* The creator's bid account by the program's own field (Launch.creator_has_bid), as on Results. */
  const creatorBid = useMemo(() => (a.creatorHasBid ? bidPda(new PublicKey(launch.id), new PublicKey(a.creator)).toBase58() : null), [a.creatorHasBid, a.creator, launch.id]);
  const rows = useMemo(() => feedRows(bids ?? [], paying ? events : null, { ended, creatorBid, limit }), [bids, paying, events, ended, creatorBid, limit]);
  return (
    <section className="panel p-4 md:p-5">
      <div className="flex items-baseline justify-between gap-3 mb-1">
        <h2 className="display text-[1.25rem]">Deposits</h2>
      </div>
      {/* While the launch runs, the sealed line sits beside the clock (ruling D6); this caption speaks only for a launch that ended without a sale. */}
      {ended && (
        <p className="text-text-2 mb-3">
          {a.settled
            ? "Deposits are public. The max market caps were opened at settlement, but no pool came; each deposit is refunded in full."
            : "Deposits are public. The max market caps were not opened on chain; each deposit is refunded in full."}
        </p>
      )}
      {bids === null && failed ? (
        <ReadFailed what="Deposits" onRetry={retry} className="mt-2" />
      ) : bids === null ? (
        <div className="h-40 rounded-[6px] bg-panel-2 animate-pulse" />
      ) : rows.length === 0 ? (
        <DepositsEmpty launch={launch} />
      ) : (
        <ul>
          {rows.map((b, i) => (
            <li
              key={b.bid}
              className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-1 py-[0.6rem] border-t border-line md:grid-cols-[1fr_auto_7rem_5rem] md:items-center"
              style={{ animation: i === 0 ? "reveal 400ms ease-out" : undefined }}
            >
              {/* 2A: the creator pill wraps under the address on a narrow row instead of being cut off with it. */}
              <span className="min-w-0 flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className="mono truncate">{shortAddr(b.bidder, 5, 4)}</span>
                {b.creator && <CreatorBidPill className="" />}
              </span>
              <span className="tab text-right md:order-3">{fmtSol(b.deposit)}</span>
              <span className="md:order-2">
                {b.status === "delivered" ? (
                  <span className="pill pill-good">Delivered</span>
                ) : b.status === "refunded" ? (
                  <span className="pill pill-muted">Refunded</span>
                ) : b.status === "refunded-ended" ? (
                  <span className="pill pill-muted">refunded</span>
                ) : b.status === "sealed" ? (
                  <span className="pill pill-muted">
                    <Lock /> max sealed
                  </span>
                ) : (
                  <span className="pill pill-good">opened</span>
                )}
              </span>
              <span className="text-text-3 tab text-right md:order-4">{now && b.placedTs !== null ? fmtAgo(b.placedTs, now) : ""}</span>
            </li>
          ))}
        </ul>
      )}
      {paying && a.bidCount > 0 && rows.length > 0 && (
        <div className="pt-3 border-t border-line">
          <Link href={`/launch/${launch.id}/settlement`} className="link inline-block">
            {allDepositsLink(a.bidCount)}
          </Link>
        </div>
      )}
    </section>
  );
}

/* Astra's frontend review of 2026-10-21, F3: bid accounts close when they are delivered or refunded, so a finished book reads empty; the panel says why instead of showing a blank list. */
export function DepositsEmpty({ launch }: { launch: Launch }) {
  const a = launch.account;
  const ended = endedWithoutSale(launch);
  return (
    <div className="pt-3 border-t border-line text-text-2 leading-snug" data-deposits-empty>
      {a.bidCount === 0 ? (
        <p>{a.state === "open" ? "No deposits yet." : "No deposits were made."}</p>
      ) : a.settled && !ended ? (
        <>
          <p>Auction settled. Deposits were filled or refunded, see results below.</p>
          <Link href={`/launch/${launch.id}/settlement`} className="link inline-block mt-2">
            Results
          </Link>
        </>
      ) : ended ? (
        <p>Auction ended without a sale. Every deposit was refunded.</p>
      ) : (
        <p>No open bids.</p>
      )}
    </div>
  );
}

function Lock() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
      <rect x="4" y="10" width="16" height="11" rx="2" />
      <path d="M8 10V7a4 4 0 0 1 8 0v3" />
    </svg>
  );
}
