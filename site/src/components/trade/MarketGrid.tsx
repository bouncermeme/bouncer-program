"use client";

import type { ReactNode } from "react";
import { useOverflows } from "@/lib/useOverflows";

/*
  The trading page's grid (the founder, 2026-10-23, from the mainnet-mode preview),
  shared by the mainnet panel (Dexscreener and Jupiter, TokenMarket.tsx) and
  the devnet one (DevnetMarket.tsx) so the page reads the same on every
  cluster. From 1024 px: the header across both columns; then the chart on the
  left and the swap on the right, their titles on one line and their boxes one
  height, so the tops and the bottoms meet; under the chart the funding panel
  (the holder map's cell until B7),
  under the swap the auction's figures and the creator's history. On a phone
  one column in that order: the chart, the swap, the funding panel, the figures.
  the founder, 2026-10-23: the lower row is one height too. From 1024 px the right
  cell takes no part in the row's height (its column is absolutely placed in
  it), so the holder map sets the row and the figures and the creator's card
  end at its bottom edge; the creator's launch list scrolls inside its card
  when it does not fit (CreatorPanel's fill). Without a holder map (devnet)
  the right cell is in the flow as before.
*/
export const MARKET_HEIGHT = 440;

export function MarketTitle({ children, end }: { children: ReactNode; end?: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 min-h-10 mb-3" data-chart-row>
      <h2 className="display text-[1.25rem]">{children}</h2>
      {end}
    </div>
  );
}

/* The right column beside the holder map: it scrolls inside its cell from 1024 px, and is a named, focusable region only while it overflows (23c; fresh 23b L7). */
function AsideFill({ children }: { children: ReactNode }) {
  const [ref, scrolls] = useOverflows<HTMLDivElement>(true);
  return (
    <div ref={ref} className="flex flex-col gap-4 lg:absolute lg:inset-0 lg:gap-3 lg:overflow-y-auto lg:overflow-x-hidden" data-market-aside-scroll {...(scrolls ? { role: "region", "aria-label": "Launch details", tabIndex: 0 } : {})}>
      {children}
    </div>
  );
}

/* fill: the right column ends at the left cell's bottom edge (the holder map's fixed height, before B7); off by default since the embed went, so the funding panel and the right column each take their own height. */
export function MarketGrid({ header, chart, swap, holders, aside, fill = false }: { header?: ReactNode; chart: ReactNode; swap: ReactNode; holders?: ReactNode; aside?: ReactNode; fill?: boolean }) {
  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_24rem] lg:gap-x-5 lg:gap-y-5" data-market-grid>
      {header && <div className="min-w-0 lg:col-span-2">{header}</div>}
      <section className="panel p-4 md:p-5 min-w-0 lg:col-start-1" data-market-chart>
        {chart}
      </section>
      {/* id="swap": the Trade chip's target (TradeView.tsx). */}
      <section className="panel p-4 md:p-5 min-w-0 lg:col-start-2 scroll-mt-24" id="swap" tabIndex={-1} aria-label="Buy or sell tokens" data-market-swap>
        {swap}
      </section>
      {holders && <div className="min-w-0 lg:col-start-1 lg:self-start" data-market-holders>{holders}</div>}
      {aside &&
        (holders && fill ? (
          <div className="min-w-0 lg:col-start-2 lg:relative" data-market-aside data-market-aside-fill>
            <AsideFill>{aside}</AsideFill>
          </div>
        ) : (
          <div className="min-w-0 lg:col-start-2 lg:self-start flex flex-col gap-4" data-market-aside>
            {aside}
          </div>
        ))}
    </div>
  );
}
