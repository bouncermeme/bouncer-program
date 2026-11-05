"use client";

import { type ReactNode, useCallback } from "react";
import { DevnetChart } from "@/components/trade/DevnetChart";
import { DevnetSwap } from "@/components/trade/DevnetSwap";
import { MARKET_HEIGHT, MarketGrid, MarketTitle } from "@/components/trade/MarketGrid";
import { Info } from "@/components/ui/Info";
import { explorerUrl } from "@/lib/bouncer/chain/rpc";
import { shortAddr } from "@/lib/bouncer/format";
import { useCapRate } from "@/lib/bouncer/solPrice";
import { refreshPoolSwaps, usePoolSwaps } from "@/lib/bouncer/swaps";
import type { Launch, SettlementRecord } from "@/lib/bouncer/types";
import { openingMcap, totalSupply } from "@/lib/bouncer/view";
import { CLUSTER } from "@contract/active";

/*
  The market panel off mainnet (the founder, 2026-10-07: "I can't see anything
  with trading at all on the site"): the chart from the pool's own swaps and
  a swap straight against the pool, laid out like the mainnet panel (the
  chart and the swap side by side from 1024 px, one height; MarketGrid.tsx)
  so the page reads the same on every cluster. Dexscreener and Jupiter stay
  the mainnet panel (TokenMarket.tsx).
*/
const HEIGHT = MARKET_HEIGHT;

/* Solana's own explorer renders devnet accounts; the cluster rides in the query. */
function solanaExplorerUrl(address: string): string {
  const c = CLUSTER as string;
  const q = c === "mainnet" || c === "mainnet-beta" ? "" : `?cluster=${encodeURIComponent(c)}`;
  return `https://explorer.solana.com/address/${encodeURIComponent(address)}${q}`;
}

export function DevnetMarket({ launch, record, chartHeader, marketDetails, holders }: { launch: Launch; record: SettlementRecord; chartHeader?: ReactNode; marketDetails?: ReactNode; holders?: ReactNode }) {
  const pool = record.pool!;
  const swaps = usePoolSwaps(pool, launch.token.mint);
  const { rate, status } = useCapRate(null);
  const sym = launch.token.symbol;
  const onSwapped = useCallback(() => {
    void refreshPoolSwaps(pool);
  }, [pool]);

  return (
    <div data-devnet-market>
      <MarketGrid
        header={chartHeader}
        chart={
          <>
            {/* the founder, 2026-10-13: the Pool chip at the chart's top right, on one line at phone width. "Chart", not "Market cap": the header above carries the market cap; the axis says dollars and the line under the chart counts the swaps. */}
            <MarketTitle
              end={
                <a href={solanaExplorerUrl(pool)} target="_blank" rel="noreferrer" className="chip shrink-0" data-pool-chip>
                  Pool
                </a>
              }
            >
              Chart
            </MarketTitle>
            <div className="bg-bg-2 border border-line rounded-[8px] overflow-hidden" style={{ height: HEIGHT }} data-chart-box>
              <DevnetChart swaps={swaps} openingMcap={openingMcap(record)} supply={totalSupply(launch.account)} symbol={sym} rate={rate} rateStatus={status} height={HEIGHT - 56} />
            </div>
            <p className="text-text-3 mt-2">
              Pool <span className="mono">{shortAddr(pool, 4, 4)}</span>{" "}
              <a href={explorerUrl("account", pool)} target="_blank" rel="noreferrer" className="link-accent">
                Solscan
              </a>
            </p>
          </>
        }
        swap={
          <>
            <MarketTitle
              end={
                <Info text={`A swap straight against this launch's Meteora pool, built by Meteora's own library on this page. The quote is the pool's state a moment ago; your wallet signs, and the swap lands only if you get at least the figure shown. Dexscreener and Jupiter index mainnet only, so this stands in for them on ${(CLUSTER as string) === "devnet" ? "devnet" : "this cluster"}.`} label="About the swap" />
              }
            >
              Swap <span className="text-text-3 font-normal">Meteora pool</span>
            </MarketTitle>
            <div className="bg-bg-2 border border-line rounded-[8px] p-3 md:p-4 lg:h-[var(--swap-h)] lg:overflow-y-auto" style={{ ["--swap-h" as string]: `${HEIGHT}px` }} data-swap-box>
              <DevnetSwap launch={launch} pool={pool} onSwapped={onSwapped} />
            </div>
          </>
        }
        holders={holders}
        aside={marketDetails}
      />
    </div>
  );
}
