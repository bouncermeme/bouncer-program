"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { reviewHref } from "@/lib/review";
import { tradingFrozen, tradingOpen, V030 } from "@/lib/bouncer/v030";
import { MissingLaunch } from "@/components/launch/MissingLaunch";
import { ShareSlot } from "@/components/launch/ShareSlot";
import { TokenAvatar } from "@/components/launch/TokenIdentity";
import { CreatorLinks } from "@/components/launch/CreatorLinks";
import { TokenMarket } from "@/components/token/TokenMarket";
import { CreatorFees } from "@/components/trade/CreatorFees";
import { ParkedBid } from "@/components/trade/ParkedBid";
import { TradeFunding } from "@/components/trade/TradeFunding";
import { useSettlementBook } from "@/components/settlement/useSettlementBook";
import { CopycatNotice, CreatorPanel } from "@/components/launch/CreatorPanel";
import { Cap } from "@/components/ui/Cap";
import { ReadFailed } from "@/components/ui/ReadFailed";
import { Stat } from "@/components/ui/Stat";
import { solExact } from "@/lib/bouncer/amountInput";
import { fmtSol } from "@/lib/bouncer/format";
import { useLaunch, useLaunchList, useLaunchMissing, useNow, useSettlement } from "@/lib/bouncer/hooks";
import { ON_MAINNET, useVolumes, volumeText } from "@/lib/bouncer/market";
import { useCapRate } from "@/lib/bouncer/solPrice";
import { useLiveMcap } from "@/lib/bouncer/liveMcap";
import { fmtRate } from "@/lib/bouncer/usdCap";
import { mcapForValue, openingMcap, raiseFeeOf, totalSupply, underClearingText } from "@/lib/bouncer/view";

/*
  The trading view (the founder, 2026-10-06: "clicking on a closed coin should
  instantly bring you to trading"; the chart, the holder map and the swap
  "easily accessible by clicking on the coin"). the founder, 2026-10-07: the
  ticker leads, the name under it; the four figures in one compact row with
  their explanations behind an "i" each; on a desktop the chart and the swap
  side by side above the fold, the holder map and the two buttons below; on a
  phone the figures, then the chart, then the swap. The market cap is the
  pool's own price (chain/pool.ts), live on devnet too. On mainnet the volume
  is Dexscreener's, the chart Dexscreener's, the swap Jupiter's; off mainnet
  (the founder, 2026-10-07) the chart comes from the pool's own swap transactions,
  the volume from the server's sum of them (market.ts, the board's figure
  too) and the swap goes straight against the pool (trade/DevnetMarket.tsx).
  The holder map is a link to Bubblemaps' own page in the funding panel's
  heading, mainnet only, and the funding panel sits under the chart (B7,
  the approved mock 1d98d36, option B: the embed is gone). The founder, 2026-10-07 (review hold
  2): under 1024 px, where the swap sits below the chart, a Swap chip beside
  the figures scrolls to it. the founder, 2026-10-08: this is where every path to a
  live coin lands (the coin's own URL redirects here once the pool is open);
  the auction's working sits behind one small link, "How it cleared", under
  the cleared-at figure, and the back link goes to the board.
*/
export function TradeView({ id }: { id: string }) {
  const launch = useLaunch(id);
  const missingAt = useLaunchMissing(id);
  const { record, loading, failed: recordFailed, retry: retryRecord } = useSettlement(id, launch?.account.state);
  /* Two rates: the live one for the market cap now, the settled minute's for what the auction cleared at. */
  const { rate: liveRate, status: liveStatus } = useCapRate(null);
  const { rate: settledRate, status: settledStatus } = useCapRate(record ? record.settledTs : null);
  const pool = record?.pool ?? null;
  const tick = useNow(5_000);
  const mcap = useLiveMcap(pool, launch?.token.mint ?? "", launch ? totalSupply(launch.account) : 0n, launch?.id ?? null);
  const volumes = useVolumes(useMemo(() => (pool ? [pool] : []), [pool]));
  /* The board's list, for the creator panel and the copycat line (the founder, 2026-10-20). */
  const { list, failed: listFailed } = useLaunchList();
  /* The settled book (the funding panel's, and the winner count beside the pool's opening SOL: FL5 safeguard 2). */
  const book = useSettlementBook(id, launch, record ?? null);
  /*
    the founder, 2026-10-23: the phone's full-width "Buy / Sell" bar becomes a slim
    Trade chip, shown only while the swap is off screen (it sits right under
    the chart, so the chip is for a reader below it, or above it on a tall
    header). Hidden, it leaves the page, so the corner controls drop back.
  */
  const [swapInView, setSwapInView] = useState(true);
  const marketOpen = launch !== null && tradingOpen(launch, record?.pool);
  /* v0.30 (the founder, 2026-10-27): before the open nothing leads here; a visit (an old link) goes to the launch page, which comes back the moment trading opens. */
  const router = useRouter();
  const frozen = launch !== null && tradingFrozen(launch);
  useEffect(() => {
    if (frozen) router.replace(reviewHref(`/launch/${id}`));
  }, [frozen, router, id]);
  useEffect(() => {
    if (!marketOpen) return;
    const el = document.getElementById("swap");
    if (!el || !("IntersectionObserver" in window)) return;
    const io = new IntersectionObserver((entries) => setSwapInView(entries.some((e) => e.isIntersecting)), { rootMargin: "0px 0px -15% 0px" });
    io.observe(el);
    return () => io.disconnect();
  }, [marketOpen]);

  if (launch === null) return missingAt !== null ? <MissingLaunch id={id} checkedAt={missingAt} /> : <div className="pt-8 animate-pulse h-96 rounded-[14px] bg-panel-2" />;
  const a = launch.account;
  /* 0.28: the raise fee from the record (view.ts); null on a launch that pays none. */
  const fee = record ? raiseFeeOf(a, record) : null;
  const sym = launch.token.symbol;
  const live = tradingOpen(launch, pool);
  const vol = volumeText(pool ? volumes.get(pool) : undefined);
  const source = (s: "kraken" | "coinbase" | string) => (s === "kraken" ? "Kraken" : "Coinbase");

  const clearedInfo = settledRate
    ? settledRate.kind === "settled"
      ? `The auction's one price, paid by every buyer. In dollars at ${fmtRate(settledRate.usdPerSol)} per SOL, the price in the minute this launch settled (${source(settledRate.source)}).`
      : `The auction's one price, paid by every buyer, at about ${fmtRate(settledRate.usdPerSol)} per SOL.`
    : settledStatus === "unavailable"
      ? "The auction's one price, paid by every buyer. No SOL price for the minute it settled yet, so no dollar figure; trying again."
      : "The auction's one price, paid by every buyer.";

  /*
    the founder, 2026-10-13 (IMG_7746): the market cap sits at the header's top
    right, beside the ticker, and the line under it about pool reads is gone.
    The avatar and the ticker keep one line together; the figure stays on it
    while the whole ticker fits beside it, otherwise it drops under the
    ticker, still on the right (a ticker breaks only when it alone is wider
    than the row). The token's name never decides this ([contain:inline-size]);
    when it wraps, the avatar and the figure stay level with the ticker (the
    avatar sits 4 px down, centred on the ticker and a one-line name). Freshness
    is at most a tiny dot (the founder's words): grey, before "Market cap", once the
    pool has not been read for a minute. Its place is always kept and the
    label keeps its one line, so going stale moves nothing. Until the SOL price is in, the figure reads "Reading market
    cap", never a bare "…".
  */
  const identity = (cap?: React.ReactNode) => (
      <header className="flex flex-wrap items-center gap-3 reveal" style={{ "--i": 0 } as React.CSSProperties}>
        {cap ? (
          <div className="flex min-w-0 flex-auto items-start gap-3" data-trade-identity>
            <div className="mt-1 shrink-0">
              <TokenAvatar launch={launch} size={48} />
            </div>
            <div className="min-w-0 flex-auto">
              <h1 className="display text-[1.75rem] md:text-[2rem] leading-tight wrap-any">{sym}</h1>
              <p className="text-text-2 leading-tight wrap-any [contain:inline-size]">{launch.token.name}</p>
            </div>
          </div>
        ) : (
          <>
            <TokenAvatar launch={launch} size={48} />
            <div className="min-w-0 flex-1 basis-40">
              <h1 className="display text-[1.75rem] md:text-[2rem] leading-tight wrap-any">{sym}</h1>
              <p className="text-text-2 leading-tight wrap-any">{launch.token.name}</p>
            </div>
          </>
        )}
        {cap}
        {launch.token.links && (
          <div className="basis-full -mt-2">
            <CreatorLinks links={launch.token.links} />
          </div>
        )}
        {live && <ShareSlot launch={launch} ticker={false} solscan className={cap ? "basis-full" : "basis-full sm:basis-auto"} />}
      </header>
  );
  const age = mcap?.readAt && tick !== null ? Math.max(0, Math.floor((tick - mcap.readAt) / 1000)) : null;
  const stale = age !== null && age > 60;
  const capBlock = (
    <div className="ml-auto self-start text-right" title={stale ? "Last known market cap: no pool read for over a minute" : undefined} data-trade-mcap-block data-stale={stale ? "1" : undefined}>
      <p className="text-text-2 leading-tight whitespace-nowrap">
        <span aria-hidden="true" className={`mr-1.5 inline-block size-2 rounded-full bg-text-3 align-middle ${stale ? "" : "invisible"}`} data-stale-dot />
        Market cap{stale && <span className="sr-only"> (last known)</span>}
      </p>
      <p className="display text-[1.75rem] md:text-[2rem] leading-tight" data-trade-mcap={mcap?.mcapLamports?.toString() ?? ""}>
        {!mcap || !mcap.readAt || (!liveRate && liveStatus === "loading") ? <span className="text-text-3 font-sans text-[1rem]">Reading market cap</span> : mcap.mcapLamports === null ? <span className="text-text-3 font-sans text-[1rem]">unreadable</span> : <Cap lamports={mcap.mcapLamports} rate={liveRate} status={liveStatus} about={false} compact={false} />}
      </p>
    </div>
  );
  const chartHeader = <div data-trade-chart-header>{identity(capBlock)}</div>;
  /* Under the swap (the founder, 2026-10-23): the auction's figures, then the creator's history. */
  const marketDetails = record ? (
          <section className="panel p-4 md:p-5" style={{ "--i": 1 } as React.CSSProperties} aria-label="Market figures" data-market-figures>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-4 sm:grid-cols-3 lg:grid-cols-1">
              <Stat
                label="Volume 24h"
                value={vol.muted ? <span className="text-text-3 font-sans text-[1rem]">{vol.text}</span> : vol.text}
                info={ON_MAINNET ? "The last 24 hours of trades in the pool, from Dexscreener." : "The SOL that went through the pool in the last 24 hours, read from its swap transactions: what buyers paid and sellers received, summed on the server once a minute. The board's card shows the same figure. On mainnet it is Dexscreener's."}
              />
              <Stat
                label="Raised"
                value={fmtSol(record.floatValue)}
                info={fee && fee.open ? `What the winning bids paid: ${solExact(fee.toPool)} went into the pool and ${solExact(fee.total)} was the fee.` : "The SOL the auction put into the pool at settlement: what the winning bids paid."}
              />
              {record.poolSolAtOpen > 0n && (
                <Stat
                  label="Pool at open"
                  value={<span data-pool-at-open={record.poolSolAtOpen.toString()}>{fmtSol(record.poolSolAtOpen)}</span>}
                  sub={<span data-winner-count={book.tally?.winners ?? ""}>{book.tally ? `${book.tally.winners} ${book.tally.winners === 1 ? "winner" : "winners"}` : "Counting winners"}</span>}
                  info="The SOL the pool opened with, and how many bids won tokens. A small pool or few winners make a thin market."
                />
              )}
              <Stat
                label="Cleared at"
                value={<Cap lamports={mcapForValue(a, record.floatValue)} rate={settledRate} status={settledStatus} />}
                info={clearedInfo}
                sub={
                  <Link href={`/launch/${id}/auction`} className="link-accent" data-how-it-cleared>
                    How it cleared
                  </Link>
                }
              />
            </dl>
            {/* 0.28, design section 6 as approved: where the pool opened against where it cleared, and why, at the settled minute's rate. */}
            {fee && fee.open && (
              <details className="mt-2" data-opening-details>
                <summary className="cursor-pointer min-h-11 py-2 text-text-2">Opening price &amp; fee</summary>
                <p className="text-text-2 leading-snug" data-raise-fee-line>
                {settledRate ? (
                  <>
                    Opened at <Cap lamports={openingMcap(record)} rate={settledRate} status={settledStatus} />, {underClearingText(fee, record.floatValue)} under the <Cap lamports={mcapForValue(a, record.floatValue)} rate={settledRate} status={settledStatus} /> it cleared at (the fee).
                  </>
                ) : (
                  <>Opened {underClearingText(fee, record.floatValue)} under where it cleared (the fee).</>
                )}
                </p>
              </details>
            )}
          </section>
  ) : null;
  const aside = (
    <>
      {marketDetails}
      <CreatorPanel launch={launch} list={list} listFailed={listFailed} />
    </>
  );
  /* B7 (option B): the funding panel in the cell the holder map had, under the chart; on a phone right after the swap. */
  const holders = record ? <TradeFunding launch={launch} record={record} book={book} className="" /> : null;

  return (
    /* the founder, 2026-10-23: the trading page runs wider than the site's 1120 px column from 1024 px, up to 1360 (the header bar too, AppHeader.tsx), centred on the same axis (a margin, not a transform: a transform would hold the fixed chip and popovers inside it). */
    <div className="pt-5 md:pt-8 pb-20 lg:pb-0 lg:relative lg:left-1/2 lg:w-[min(1360px,calc(100vw-4rem))] lg:ml-[calc(-1*min(680px,calc(50vw-2rem)))]" data-trade-wide>
      <Link href="/" className="text-text-2 inline-flex items-center gap-1 mb-3 hover:text-text max-w-full wrap-any">
        <svg className="shrink-0" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M15 5l-7 7 7 7" />
        </svg>
        Launches
      </Link>

      {(!live || !record) && identity()}

      {!live || !record ? (
        <section className="panel p-4 md:p-5 mt-4 reveal" style={{ "--i": 1 } as React.CSSProperties}>
          {/* A failed read says so with Try again, never "Reading this launch…" for good (F14). */}
          {loading && !record && recordFailed ? <ReadFailed what="This launch" onRetry={retryRecord} /> : <p className="display text-[1.5rem] leading-tight">{loading && !record ? "Reading this launch…" : "No market yet."}</p>}
          {!(loading && !record) && (
            <p className="text-text-2 mt-2 leading-snug">
              {a.state === "failed" || a.state === "aborted"
                ? "This launch did not clear: every deposit is refunded and no token exists to trade."
                : a.state === "finalized" && !launch.recordExists
                  ? "This launch ended without a sale: nothing was minted to trade."
                  : V030
                    ? "Trading opens when everyone is paid; the chart and the swap appear here then."
                    : "The pool opens when the launch settles; the chart and the swap appear here then."}
            </p>
          )}
          <Link href={`/launch/${id}/auction`} className="btn btn-secondary w-full mt-4">
            Back to the auction
          </Link>
        </section>
      ) : (
        <>


          <CopycatNotice launch={launch} list={list} />

          {/* v0.32: a payout held for this wallet, first (the founder's approved mock, p7). Nothing for anyone else. */}
          <ParkedBid launch={launch} record={record} />

          <div className="mt-4 reveal" style={{ "--i": 2 } as React.CSSProperties}>
            <TokenMarket launch={launch} record={record} chartHeader={chartHeader} marketDetails={aside} holders={holders} />
          </div>

          {/* The creator's trading fees, for the creator's wallet holding the position NFT only (the founder, 2026-10-14); nothing for anyone else. */}
          <CreatorFees launch={launch} record={record} />

          {/* The slim Trade chip (phones and tablets): only the chip takes taps, nothing beside it is covered. */}
          {!swapInView && (
            <div data-sticky-bar className="lg:hidden fixed inset-x-0 bottom-[calc(1rem+env(safe-area-inset-bottom))] z-30 flex justify-center pointer-events-none">
              <a href="#swap" className="btn btn-primary pointer-events-auto min-h-11 rounded-full px-5 py-2 shadow-lg" aria-label={`Go to buy or sell ${sym}`} data-mobile-trade-jump>
                Trade {sym}
              </a>
            </div>
          )}

        </>
      )}
    </div>
  );
}
