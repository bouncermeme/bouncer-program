"use client";

import { BubblemapsLink } from "@/components/Bubblemaps";
import { FundingLinks } from "@/components/settlement/FundingLinks";
import { useSettlementBook } from "@/components/settlement/useSettlementBook";
import type { Launch, SettlementRecord } from "@/lib/bouncer/types";

/*
  the founder, 2026-10-27 (3A follow-up, FOUNDER-UI-DECISIONS.md): the funding links leave Show the working on Results for the
  trading page, beside its holder map. The same panel and the same reads as Results (useSettlementBook.ts); it shows
  once the book's tally is known, as it did there. B7 (the approved mock 1d98d36, option B): it takes the holder map's
  cell, and the holder map is a link in its heading row (Bubblemaps.tsx), mainnet only. FL5 (review/2026-11-05-floor5): the
  trading page reads the book once and hands it here, since its figures show the book's winner count too.
*/
export function TradeFunding({ launch, record, book, className = "mt-4" }: { launch: Launch; record: SettlementRecord; book: ReturnType<typeof useSettlementBook>; className?: string }) {
  const { tally, traceWinners, traceReady, funding, fundingLoading, fundingFailed, gapWhy } = book;
  if (!tally) return null;
  return (
    <div className={className} data-trade-funding>
      <FundingLinks headEnd={<BubblemapsLink mint={launch.token.holderMapAddress ?? launch.token.mint} />} launch={launch} winners={traceWinners} record={record} report={funding} loading={fundingLoading} failed={fundingFailed} waiting={!traceReady} complete={tally.complete} gapWhy={gapWhy(false)} />
    </div>
  );
}
