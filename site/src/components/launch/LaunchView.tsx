"use client";

import { solExact } from "@/lib/bouncer/amountInput";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Stat } from "@/components/ui/Stat";
import { CreatorBidPill } from "@/components/ui/CreatorBid";
import { Cap, RateNote } from "@/components/ui/Cap";
import { useCapRate, type CapRate, type RateStatus } from "@/lib/bouncer/solPrice";
import { bidsOpenAt } from "@/lib/bouncer/beacon";
import { fmtBids, fmtDuration, fmtPct, fmtSol, fmtTime, fmtTokens, shortAddr } from "@/lib/bouncer/format";
import { useLaunch, useLaunchList, useLaunchMissing, useNowSec, useSettlement, useLeastSent } from "@/lib/bouncer/hooks";
import { MissingLaunch } from "@/components/launch/MissingLaunch";
import type { Launch, SettlementRecord } from "@/lib/bouncer/types";
import { bookOpen, endedWithoutSale, hasRecord, mcapForValue, openingMcap, poolPremium, raiseFeeOf, ratio, recoverable, setupFinishable, shareOfSupply } from "@/lib/bouncer/view";
import { RecoverNotice } from "./RecoverNotice";
import { Countdown, StageLine } from "./Countdown";
import { CopycatNotice, CreatorPanel } from "./CreatorPanel";
import { DepositFeed } from "./DepositFeed";
import { DrivePanel } from "./DrivePanel";
import { phaseOf } from "./phase";
import { RefundView } from "./RefundView";
import { SetupPending } from "./SetupPending";
import { MyBid } from "./MyBid";
import { mintIsLive } from "./ShareSlot";
import { TokenIdentity } from "./TokenIdentity";
import { CreatorLinks } from "./CreatorLinks";
import { reviewHref } from "@/lib/review";
import { tradingFrozen, tradingOpen } from "@/lib/bouncer/v030";

export function LaunchView({ id }: { id: string }) {
  const launch = useLaunch(id);
  const missingAt = useLaunchMissing(id);
  const nowSec = useNowSec(1000);
  const { record } = useSettlement(id, launch?.account.state);
  /* The board's list, for the creator panel and the copycat line (the founder, 2026-10-20). */
  const { list, failed: listFailed } = useLaunchList();
  /* One rate per page: live while the launch is open, the minute it settled once it has a record. */
  const { rate, status } = useCapRate(record ? record.settledTs : null);
  const ctaOffScreen = useTradeCtaOffScreen(launch !== null && tradingOpen(launch, record?.pool ?? launch.record?.pool), record);
  /* The minimum as a bidder sends it, the deposit plus its costs (the founder, 2026-10-23: one clean number, as on /fees). Before the early returns: a hook. */
  const leastSentHere = useLeastSent(launch?.readable ? launch.account.minBid : null, launch?.readable ? { processingCharge: launch.account.processingCharge, attestRequired: launch.account.attestRequired } : null);
  /*
    the founder, 2026-10-08: "people want to get to trading instantly, not show the
    working." Once the pool is live the coin's URL is the trading page: a fresh
    visit is redirected on the server (app/launch/[id]/page.tsx); a page
    already open, or one the server could not read in time, moves itself the
    moment the pool is live. At /launch/<id>/auction (behind "How it cleared"
    on the trading page) the auction stays put.
  */
  const router = useRouter();
  const pathname = usePathname();
  /* The rent of an empty account: whether a raise fee part is sure to be paid (view.ts, raiseFeeMayStay). */
  const onAuctionRoute = pathname?.endsWith("/auction") ?? false;
  /* v0.30 (the founder, 2026-10-27): the move to trading waits for the open (v030.ts tradingOpen), and happens the moment the launch reads it. */
  const tradableNow = launch !== null && tradingOpen(launch, record?.pool ?? launch.record?.pool);
  useEffect(() => {
    if (tradableNow && !onAuctionRoute) router.replace(reviewHref(`/launch/${id}/trade`));
  }, [tradableNow, onAuctionRoute, router, id]);

  if (launch === null) return missingAt !== null ? <MissingLaunch id={id} checkedAt={missingAt} /> : <Skeleton />;
  if (!launch.readable) return <Unreadable launch={launch} />;

  const a = launch.account;
  /* One record for every row: the settlement read, else the one the launch read carried (the settlement read is keyed by state, so it is null after each change until read again; a row that read only it stated the pre-open "1% under" after the pool had opened). */
  const rec = record ?? launch.record ?? null;
  /* Open by the clock: the book closes at open_ts plus the window whatever the state byte still reads. */
  const open = nowSec != null ? bookOpen(a, nowSec) : a.state === "open";
  /* 0.29: no bid until the second step of genesis lands (HistogramNotReady 6071; state Initializing since the seventh candidate); the window runs regardless. */
  const setupPending = setupFinishable(a, nowSec);
  const canBid = open && a.histogramGrown;
  const ended = endedWithoutSale(launch);
  const phase = phaseOf(launch, nowSec ?? undefined);
  const expired = nowSec != null && recoverable(a, nowSec);
  const opensAt = bidsOpenAt(a.revealRound);
  /* Collapse historical bid terms only after a successful auction is finalized. */
  const settled = a.state === "finalized" && rec !== null;
  const auctionDetails = (
    <dl className="grid grid-cols-2 gap-x-4 gap-y-5">
      <Stat label="For sale" value={<>{fmtTokens(a.float, launch.token.decimals)} <span className="wrap-any">{launch.token.symbol}</span></>} sub="half the supply" />
      {/* A launch that never cleared has no market cap to show, in any unit: its page speaks in amounts. */}
      {ended ? (
        <Stat label="Needs to launch" value={fmtSol(a.floorValue)} sub="in deposits by close" />
      ) : (
        /* the founder, 2026-10-23 (his iPhone): no minimum market cap row in this card; the deposits block states what the launch needs, and the bid form keeps the minimum market cap. The clearing market cap is set at close (the record's figures replace it on the settlement page). */
        !rec && <Stat label="Clearing market cap" value="Set at close" />
      )}
      <Stat label="Window" value={fmtDuration(a.windowSecs)} />
      <Stat label="Bids revealed" value={fmtTime(opensAt)} />
      {/* Item 19: the launch's own minimum, a clean figure; the costs inside a bid are on the bid page. */}
      <Stat label="Minimum bid" value={leastSentHere !== null ? solExact(leastSentHere) : fmtSol(a.minBid)} />
    </dl>
  );
  /* the founder, 2026-10-07: the way to the trading page is obvious from the moment the pool is open, on the phone as a fixed bar like Bid. */
  const tradable = tradingOpen(launch, record?.pool ?? launch.record?.pool);
  /* v0.30, 2B: while everyone is being paid, nothing leads to trading; one disabled button says when it opens. */
  const payingOut = tradingFrozen(launch);

  return (
    <div className={`pt-5 md:pt-8 ${canBid || tradable ? "pb-16 lg:pb-0" : ""}`}>
      <div className="reveal" style={{ "--i": 0 } as React.CSSProperties}>
        {tradable && (
          <Link href={`/launch/${id}/trade`} className="text-text-2 inline-flex items-center gap-1 mb-3 hover:text-text max-w-full wrap-any" data-back-to-trading>
            <svg className="shrink-0" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M15 5l-7 7 7 7" />
            </svg>
            {launch.token.symbol} trading
          </Link>
        )}
        <TokenIdentity launch={launch} />
        <CopycatNotice launch={launch} list={list} />
        {launch.token.description && <p className="mt-3 leading-relaxed text-text-2 max-w-[62ch] wrap-any whitespace-pre-line">{launch.token.description}</p>}
        <CreatorLinks links={launch.token.links} className="mt-2" />
      </div>

      <div className="mt-6 grid grid-cols-1 gap-4 lg:grid-cols-12 lg:gap-5">
        <div className="lg:col-span-7 flex flex-col gap-4 min-w-0">
          {/* Pass 2 (2026-10-10): while bids are open the panel is the live surface, as on the board's card (globals.css, .door-live). */}
          <section className={`panel door ${open ? "door-live" : ""} p-4 md:p-5 reveal`} style={{ "--i": 1 } as React.CSSProperties} data-live-panel={open ? "" : undefined}>
            {ended ? (
              <RefundView launch={launch} />
            ) : a.state === "finalized" && record ? (
              <>
                <SettledSummary launch={launch} record={record} rate={rate} status={status} />
                <MyBid launch={launch} record={rec} />
              </>
            ) : (
              <>
                <Countdown launch={launch} />
                {!expired && <StageLine launch={launch} />}
                {setupPending && <SetupPending launch={launch} />}
                {/* Ruling D6: three lines only, each beside its figure. One: sealed, beside the clock that unseals. */}
                {open && (
                  <p className="text-text-2 mt-2 leading-snug flex items-start gap-2">
                    <LockGlyph />
                    Max market caps are sealed until close, from us too.
                  </p>
                )}
                <div className="mt-4 pt-4 hairline flex items-end justify-between gap-4">
                  <div>
                    <p className="text-text-3">Deposited</p>
                    <p className="figure text-[1.875rem] md:text-[2.25rem] mt-1.5 whitespace-nowrap">{fmtSol(a.totalDeposits)}</p>
                  </div>
                  <div className="text-right">
                    <p className="text-text-3 num">{fmtBids(a.bidCount)}</p>
                  </div>
                </div>
                {/* the founder, 2026-10-20: the creator's own bid, from the program's field (Launch.creator_has_bid), wherever bids show. */}
                {a.creatorHasBid && (
                  <p className="mt-2 leading-snug flex items-center gap-2 flex-wrap" data-creator-has-bid>
                    <CreatorBidPill className="" />
                    <span className="text-text-2">The creator has a bid in this auction.</span>
                  </p>
                )}
                {open && (
                  <div className="mt-3 flex flex-col gap-1 text-text-2">
                    {/* Three: the floor's consequence, as an amount in the unit Deposited is in (the founder, 2026-10-22). No market cap in this block while bidding is open. */}
                    <p className="leading-snug" data-needs-to-launch>
                      Needs <span className="num text-text">{fmtSol(a.floorValue)}</span> by close, <span className="text-text-3">or all refundable.</span>
                    </p>
                    {a.bidCount > 0 && <Row k="Largest deposit" v={`${fmtSol(a.largestDeposit)} (${fmtPct(ratio(a.largestDeposit, a.totalDeposits), 0)})`} />}
                  </div>
                )}

                {/* After the window, one status line per phase, not an explanation. */}
                {/* Past the recovery deadline the notice below says what happens instead. */}
                {/* 24o (Astra's 24n R1): only before the scheduled time; after it the clock above says how many bids have opened, and no time already past is promised. the founder kept this interim (W3, 2026-10-26). */}
                {phase.kind === "closed" && !expired && !(nowSec != null && nowSec >= opensAt) && <p className="text-text-2 mt-4 leading-snug">Closed. Every bid opens at {fmtTime(opensAt)}, all at once.</p>}
                {/* Copy pass, 2026-10-02: the clock above already says the pool is opening and that refunds can be taken, and that the pool is live; this line keeps only the figure. */}
                {(phase.kind === "settled" || payingOut) && !expired && record && (
                  <p className="text-text-2 mt-4 leading-snug">
                    Cleared at <Cap lamports={mcapForValue(a, record.floatValue)} rate={rate} status={status} />.
                  </p>
                )}

                <MyBid launch={launch} record={rec} />
                <RecoverNotice launch={launch} />

                {/* Pool open, launch not yet finalized (the lock or the finalize step still due): trading is on already. */}
                {tradable && (
                  <Link href={`/launch/${id}/trade`} className="btn btn-primary w-full mt-4" data-trade-cta>
                    Trade {launch.token.symbol}
                  </Link>
                )}
                {payingOut && (
                  <button type="button" className="btn btn-primary w-full mt-4" disabled data-trade-waiting>
                    Trading opens when everyone is paid
                  </button>
                )}

                {canBid && (
                  <div className="hidden lg:block mt-4">
                    <Link href={`/launch/${id}/bid`} className="btn btn-primary w-full text-[1.125rem]">
                      Bid
                    </Link>
                  </div>
                )}
                {hasRecord(a.state) && (
                  <Link href={`/launch/${id}/settlement`} className="btn btn-secondary w-full mt-4">
                    Open settlement
                  </Link>
                )}
              </>
            )}
          </section>

          {/* The chart, the swap and the holder map live on the trading view since 2026-10-06 (the "Trade" button above leads there); the copies that sat here went in the sweep of 2026-10-07. */}
          <DrivePanel launch={launch} record={record} />

          <div className="reveal" style={{ "--i": 3 } as React.CSSProperties}>
            <DepositFeed launch={launch} />
          </div>
        </div>

        <aside className="lg:col-span-5 flex flex-col gap-4 min-w-0">
          <section className="panel p-4 md:p-5 reveal" style={{ "--i": 2 } as React.CSSProperties}>
            {settled ? (
              <details data-auction-details>
                <summary className="display text-[1.25rem] cursor-pointer py-2 min-h-11">Auction details</summary>
                <div className="mt-3">{auctionDetails}</div>
              </details>
            ) : (
              <>
                <h2 className="display text-[1.25rem] mb-3">The Auction</h2>
                {auctionDetails}
              </>
            )}
            {/* The settled minute's rate, a figure the footer does not carry; the live rate's line went in the sweep of 2026-10-07 (the footer says it). */}
            {record && <RateNote rate={rate} status={status} className="mt-3" />}
            {/* the founder's item 19 (2026-10-16): the allocation, push cost, pool and raise fee rows are gone; the founder, 2026-10-23: the liquidity and trading fee rows too. /fees and the guide carry them. The mint is shown once the pool is open, never before (the share slot rule). */}
            {mintIsLive(launch) && (
              <div className="hairline mt-4 pt-4 flex flex-col gap-2 text-text-2">
                <Row k="Mint" v={<CopyAddr value={launch.token.mint} />} />
              </div>
            )}
          </section>

          <div className="reveal" style={{ "--i": 3 } as React.CSSProperties}>
            <CreatorPanel launch={launch} list={list} listFailed={listFailed} />
          </div>

        </aside>
      </div>

      {/* The bars' see-through top strips take no taps (2026-10-13, the iPhone double tap): a tap there reaches what shows through. The rest of each bar still takes every tap (the empty span), so nothing a bar hides can be pressed. */}
      {canBid && (
        <div data-sticky-bar className="lg:hidden fixed inset-x-0 bottom-0 z-30 p-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] pointer-events-none" style={{ background: "linear-gradient(to top, var(--bg) 65%, transparent)" }}>
          <span aria-hidden="true" className="absolute inset-x-0 top-3 bottom-0 pointer-events-auto" data-bar-shield />
          <Link href={`/launch/${id}/bid`} className="btn btn-primary w-full text-[1.125rem] relative pointer-events-auto">
            Bid
          </Link>
        </div>
      )}
      {!open && tradable && ctaOffScreen && (
        <div data-sticky-bar className="lg:hidden fixed inset-x-0 bottom-0 z-30 p-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] pointer-events-none" style={{ background: "linear-gradient(to top, var(--bg) 65%, transparent)" }}>
          <span aria-hidden="true" className="absolute inset-x-0 top-3 bottom-0 pointer-events-auto" data-bar-shield />
          <Link href={`/launch/${id}/trade`} className="btn btn-primary w-full text-[1.125rem] relative pointer-events-auto" data-trade-bar>
            Trade {launch.token.symbol}
          </Link>
        </div>
      )}
    </div>
  );
}

/* The phone's fixed Trade bar shows only while none of the page's own Trade buttons (the summary's, or the one under the terms) is on screen, so one screen never carries the same button twice. Hidden until the first measurement. */
function useTradeCtaOffScreen(enabled: boolean, record: unknown): boolean {
  const [off, setOff] = useState(false);
  useEffect(() => {
    if (!enabled || typeof IntersectionObserver === "undefined") return;
    const targets = Array.from(document.querySelectorAll<HTMLElement>("[data-trade-cta]"));
    if (targets.length === 0) return;
    const seen = new Map<Element, boolean>();
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) seen.set(e.target, e.isIntersecting);
        setOff(![...seen.values()].some(Boolean));
      },
      { threshold: 0.4 },
    );
    targets.forEach((t) => io.observe(t));
    return () => io.disconnect();
    /* The record's arrival swaps the panel that holds the button, so the buttons are looked up again then. */
  }, [enabled, record]);
  return off;
}

function SettledSummary({ launch, record, rate, status }: { launch: Launch; record: SettlementRecord; rate: CapRate | null; status: RateStatus }) {
  const a = launch.account;
  /* Largest allocation won at the auction = largest_fill_tokens / total supply: the record's immutable figure, what that wallet received at settlement, never what it holds now (Astra's review of 2026-10-17c, B3: the winner had sold everything and the page said "holds"). */
  const share = shareOfSupply(a, record.largestFillTokens);
  const fee = raiseFeeOf(a, record);
  return (
    <div>
      <p className="text-text-3">Cleared at</p>
      <p className="figure text-[2rem] md:text-[2.4rem] mt-1.5">
        <Cap lamports={mcapForValue(a, record.floatValue)} rate={rate} status={status} />
      </p>
      <p className="text-text-2 mt-3">
        {fmtSol(a.totalDeposits)} deposited by {a.bidCount} {a.bidCount === 1 ? "bidder" : "bidders"}. The largest bidder won{" "}
        <span className="num font-medium text-accent">{fmtPct(share)}</span> of supply at the auction.
        {/* 7 (the founder, 2026-10-27, revised shot approved): "The pool opened at X." and nothing after it; the fee is on Results. */}
        {record.poolSolAtOpen > 0n &&
          (poolPremium(record) === 0n && !fee ? (
            <> The pool opened at the same market cap.</>
          ) : (
            <>
              {" "}
              The pool opened at <Cap lamports={openingMcap(record)} rate={rate} status={status} />.
            </>
          ))}
      </p>
      {/* the founder, 2026-10-20: the creator's own bid, from the record (creator_bid_state, written at settle). */}
      {record.creatorBidState !== 0 && (
        <p className="mt-2 leading-snug flex items-center gap-2 flex-wrap" data-creator-has-bid>
          <CreatorBidPill className="" />
          <span className="text-text-2">{record.creatorBidState === 2 ? `${fmtSol(record.creatorDeposit)}, did not open, refunded.` : record.creatorTokens > 0n ? `${fmtSol(record.creatorDeposit)} deposited, won ${fmtPct(shareOfSupply(a, record.creatorTokens))} of supply.` : `${fmtSol(record.creatorDeposit)} deposited, won nothing, refunded.`}</span>
        </p>
      )}
      {/* the founder, 2026-10-06: the chart, the holder map and the swap one tap away from the coin. */}
      <div className="flex flex-col gap-2 mt-4 sm:flex-row">
        <Link href={`/launch/${launch.id}/trade`} className="btn btn-primary flex-1" data-trade-cta>
          Trade {launch.token.symbol}
        </Link>
        <Link href={`/launch/${launch.id}/settlement`} className="btn btn-secondary flex-1">
          Open settlement
        </Link>
      </div>
    </div>
  );
}

/* C-31: an account shorter than the v0.18 layout was created under an older program version. The program refuses it (Anchor 3003); the page decodes nothing. */
function Unreadable({ launch }: { launch: Launch }) {
  return (
    <div className="pt-8 max-w-[34rem]">
      <div className="panel p-4 md:p-5">
        <p className="display text-[1.5rem] leading-tight">This launch was created under an older program version and cannot be read.</p>
        <p className="text-text-2 mt-2">
          The program refuses every instruction at it, so nothing here can be bid on, refunded or settled. Address <span className="mono">{shortAddr(launch.account.address, 6, 6)}</span>.
        </p>
        <Link href="/" className="btn btn-secondary w-full mt-4">
          Back to launches
        </Link>
      </div>
    </div>
  );
}

function LockGlyph() {
  return (
    <svg className="mt-[3px] shrink-0 text-brand-text" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
      <rect x="4" y="10" width="16" height="11" rx="2" />
      <path d="M8 10V7a4 4 0 0 1 8 0v3" />
    </svg>
  );
}

function Row({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      {/* The key never wraps; a long value wraps on the right ("A push costs" broke into three lines beside its sentence, 2026-10-07). */}
      <span className="text-text-3 shrink-0">{k}</span>
      <span className="num text-right min-w-0">{v}</span>
    </div>
  );
}

function CopyAddr({ value }: { value: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="mono link"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setDone(true);
          setTimeout(() => setDone(false), 1200);
        } catch {}
      }}
    >
      {done ? "Copied" : shortAddr(value, 6, 6)}
    </button>
  );
}

function Skeleton() {
  return (
    <div className="pt-8 animate-pulse">
      <div className="h-12 w-72 rounded-[12px] bg-panel-2" />
      <div className="mt-6 h-64 rounded-[14px] bg-panel-2" />
      <div className="mt-4 h-48 rounded-[14px] bg-panel-2" />
    </div>
  );
}
