"use client";

import { useSearchParams } from "next/navigation";
import Script from "next/script";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { mintIsLive } from "@/components/launch/ShareSlot";
import { DevnetMarket } from "@/components/trade/DevnetMarket";
import { MARKET_HEIGHT, MarketGrid, MarketTitle } from "@/components/trade/MarketGrid";
import { Info } from "@/components/ui/Info";
import { useAccount } from "@/components/wallet/AccountProvider";
import { explorerUrl } from "@/lib/bouncer/chain/rpc";
import { shortAddr } from "@/lib/bouncer/format";
import type { Launch, SettlementRecord } from "@/lib/bouncer/types";
import { CLUSTER } from "@contract/active";

/*
  The market panel of the trading view (the founder's decisions 2, 3 and 4 of
  2026-09-30, DECISIONS-competitor-review-2026-09-30.md; the trading view
  since 2026-10-06; this layout the founder's, 2026-10-07): Dexscreener's chart
  for the pool and Jupiter's swap, side by side from 1024 px, the chart
  above the swap on a phone, both on this domain so a first trade does not
  leave the site. Nothing of this before the pool: there is no price until
  the auction clears, so no chart, zeroed or otherwise.

  Both are mainnet services. Dexscreener indexes mainnet pools only and
  Jupiter routes mainnet tokens only, so on devnet and on the local test
  chain this panel is the site's own (the founder, 2026-10-07: "I can't see
  anything with trading at all on the site"): a chart from the pool's own
  swaps and a swap straight against the launch's Meteora pool
  (trade/DevnetMarket.tsx), in the same two columns. A developer can see the
  mainnet rendering on a devnet page by adding
  ?market=<mainnet pool>:<mainnet mint> to the URL; that override exists only
  in `next dev`, is compiled out of every production build, and labels itself
  as not this launch's data.

  Third-party code, on purpose and disclosed: the chart is Dexscreener's own
  page in an iframe, in its origin, not ours. The swap is Jupiter's script,
  loaded from plugin.jup.ag onto this page beside the connected wallet. The
  wallet still signs each swap, but the form that builds it is Jupiter's and
  updates when Jupiter publishes (the "i" beside Swap says so). the founder
  confirmed both on 2026-09-30. Docs: developers.jup.ag/docs/tool-kits/plugin
  (script, init, wallet passthrough); the option names were read from
  @jup-ag/plugin 1.0.16's index.d.ts, not remembered.
*/

const JUPITER_SCRIPT = "https://plugin.jup.ag/plugin-v1.js";
const TARGET_ID = "jupiter-plugin";
const MAINNET = (CLUSTER as string) === "mainnet-beta" || (CLUSTER as string) === "mainnet";
/* One height for the chart and the swap, so they sit level side by side (MarketGrid.tsx). */
const HEIGHT = MARKET_HEIGHT;
/*
  Dexscreener's narrow layout (a frame under about 1,000 px wide, ours at
  every width: the chart column is at most about 950 px) closes with its own
  Info | Chart tab bar and a "Tracked by" strip, 88 px together at 390 and
  at 1440 (measured in the headed previews of 2026-10-23). A first cut drew the
  frame this much taller than its box to clip it; the founder's final call (below)
  keeps it.
*/
/* the founder, 2026-10-23 (final batch, H): their attribution is not ours to clip. The whole frame shows, strip included: the box is
   DEX_TABS taller than the chart, so the chart keeps its 440 px; on desktop the swap box grows the same so the row's two boxes
   end on one line (the locked layout); on phones the chart panel runs 88 px longer. */
/* The box adds its two 1 px borders (+ 2 below), so the frame's whole 528 px shows inside it. */
const DEX_TABS = 88;

type WalletState = ReturnType<typeof useWallet>;

interface JupiterPlugin {
  init: (props: {
    displayMode?: "modal" | "integrated" | "widget";
    integratedTargetId?: string;
    containerStyles?: Record<string, string>;
    formProps?: { swapMode?: "ExactInOrOut" | "ExactIn" | "ExactOut"; initialInputMint?: string; initialOutputMint?: string; fixedMint?: string };
    defaultExplorer?: "Solscan";
    enableWalletPassthrough?: boolean;
    passthroughWalletContextState?: WalletState;
    onRequestConnectWallet?: () => void | Promise<void>;
  }) => void | Promise<void>;
  syncProps: (props: { passthroughWalletContextState?: WalletState }) => void;
  close: () => void;
}

declare global {
  interface Window {
    Jupiter?: JupiterPlugin;
  }
}

/* Wrapped SOL, the input side of a first buy. */
const WSOL = "So11111111111111111111111111111111111111112";

/*
  Dexscreener's own "Embed this chart" URL with the info column on. `info=0`
  stalls Dexscreener's embed at "Loading pair..." (measured in a real browser
  on three mainnet pairs, measure/dexscreener-embed-2026-10-07/report.md),
  so the column stays and part of it repeats our figures. the founder, 2026-10-07:
  "I would rather the dexscreener work with duplicated info than have a
  broken chart." Trades list off, the chart's left drawing toolbar off, dark,
  15-minute USD candles. In a frame narrower than about 1,000 px (ours is 640
  at 1280 and about 290 on a phone) Dexscreener lays the pair out as two tabs,
  Info and Chart, and opens on Info unless chartDefaultOnMobile=1 (measured
  in a headed browser, measure/dexscreener-fix-2026-10-07); with it the chart
  shows first and the info sits behind its tab.
*/
function dexscreenerEmbed(pool: string): string {
  return `https://dexscreener.com/solana/${encodeURIComponent(pool)}?embed=1&loadChartSettings=0&trades=0&chartLeftToolbar=0&chartDefaultOnMobile=1&chartTheme=dark&theme=dark&chartStyle=0&chartType=usd&interval=15`;
}

/* Solana's own explorer renders devnet accounts (Solscan refused an automated reader on 2026-10-07); the cluster rides in the query. */
function solanaExplorerUrl(address: string): string {
  const c = CLUSTER as string;
  const q = c === "mainnet" || c === "mainnet-beta" ? "" : `?cluster=${encodeURIComponent(c)}`;
  return `https://explorer.solana.com/address/${encodeURIComponent(address)}${q}`;
}

export function TokenMarket({ launch, record, chartHeader, marketDetails, holders }: { launch: Launch; record: SettlementRecord | null; chartHeader?: ReactNode; marketDetails?: ReactNode; holders?: ReactNode }) {
  const account = useAccount();
  const wallet = useWallet();
  const params = useSearchParams();
  const [scriptReady, setScriptReady] = useState(false);
  const [chartVisible, setChartVisible] = useState(false);
  const chartRef = useRef<HTMLDivElement | null>(null);
  const live = mintIsLive(launch);

  /* The dev-only override. Dead code in a production build. */
  const preview = ((): { pool: string; mint: string } | null => {
    if (process.env.NODE_ENV !== "development") return null;
    const [pool, mint] = (params.get("market") ?? "").split(":");
    return pool && mint ? { pool, mint } : null;
  })();

  /* The chart iframe mounts once it is near the viewport; it is heavy on a phone. */
  useEffect(() => {
    const el = chartRef.current;
    if (!el) return;
    if (!("IntersectionObserver" in window)) {
      const t = setTimeout(() => setChartVisible(true), 0);
      return () => clearTimeout(t);
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setChartVisible(true);
          io.disconnect();
        }
      },
      { rootMargin: "400px 0px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [live, record?.pool]);

  const pool = preview?.pool ?? record?.pool ?? null;
  const mint = preview?.mint ?? launch.token.mint;
  const onMainnet = MAINNET || preview !== null;
  const drawn = live && onMainnet && pool !== null;

  /* Jupiter: initialised once its script is on the page, re-synced whenever the wallet changes, closed when the page goes. */
  useEffect(() => {
    if (!drawn || !scriptReady || !window.Jupiter) return;
    const J = window.Jupiter;
    void J.init({
      displayMode: "integrated",
      integratedTargetId: TARGET_ID,
      /* the founder, 2026-10-23: Jupiter at its content's height, centred in the box (which keeps the chart's height so the rows
         align). Its default is a fixed 550 px black panel with the form at the top and the space below it empty. */
      containerStyles: { height: "auto" },
      formProps: { swapMode: "ExactInOrOut", initialInputMint: WSOL, initialOutputMint: mint, fixedMint: mint },
      defaultExplorer: "Solscan",
      enableWalletPassthrough: true,
      passthroughWalletContextState: wallet,
      onRequestConnectWallet: account.openConnect,
    });
    return () => {
      try {
        J.close();
      } catch {}
    };
    // The wallet is synced below, not re-initialised on every change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drawn, scriptReady, mint]);

  useEffect(() => {
    if (!drawn || !scriptReady || !window.Jupiter) return;
    window.Jupiter.syncProps({ passthroughWalletContextState: wallet });
  }, [drawn, scriptReady, wallet]);

  if (!live) return null;

  const poolLine = record?.pool && (
    <p className="text-text-3 mt-2">
      Pool <span className="mono">{shortAddr(record.pool, 4, 4)}</span>{" "}
      <a href={explorerUrl("account", record.pool)} target="_blank" rel="noreferrer" className="link-accent">
        Solscan
      </a>
    </p>
  );

  const previewNote = preview && (
    <p className="mb-3 text-text-2 leading-snug" role="note">
      Preview: a mainnet pool ({shortAddr(preview.pool, 4, 4)}) and mint ({shortAddr(preview.mint, 4, 4)}), not this launch&apos;s. Development only.
    </p>
  );

  /* The grid's cells are panels of their own (MarketGrid.tsx); only the messages before a market sit in one panel here. */
  if (drawn) {
    return (
      <div aria-label={`${launch.token.symbol} on the market`} role="region">
        {previewNote}
        <MarketGrid
          header={chartHeader}
          chart={
            <div ref={chartRef}>
              {/* the founder, 2026-10-13, "bring it back": the Open link at the chart's top right. */}
              <MarketTitle
                end={
                  <a href={`https://dexscreener.com/solana/${encodeURIComponent(pool!)}`} target="_blank" rel="noreferrer" className="chip shrink-0" data-dexscreener-open>
                    Open
                  </a>
                }
              >
                Chart <span className="text-text-3 font-normal">Dexscreener</span>
              </MarketTitle>
              <div className="bg-bg-2 border border-line rounded-[8px] overflow-hidden" style={{ height: HEIGHT + DEX_TABS + 2 }} data-chart-box>
                {chartVisible ? (
                  <iframe src={dexscreenerEmbed(pool!)} title={`Dexscreener chart for ${launch.token.symbol}`} loading="lazy" style={{ width: "100%", height: HEIGHT + DEX_TABS, border: "none", display: "block" }} />
                ) : (
                  <div className="h-full w-full flex items-center justify-center text-text-3">Loading chart</div>
                )}
              </div>
              {poolLine}
            </div>
          }
          swap={
            <>
              <MarketTitle end={<Info text="Jupiter's swap, loaded onto this page. Your wallet signs each swap; the quote and the form are Jupiter's." label="About the swap" />}>
                Swap <span className="text-text-3 font-normal">Jupiter</span>
              </MarketTitle>
              <div id={TARGET_ID} className="bg-bg-2 border border-line rounded-[8px] overflow-hidden h-[440px] lg:h-[530px] [&>#jupiter-plugin-instance]:flex [&>#jupiter-plugin-instance]:flex-col [&>#jupiter-plugin-instance]:justify-center" data-swap-box>
                {!scriptReady && (
                  <div className="w-full h-full flex items-center justify-center text-text-3">
                    Loading swap
                  </div>
                )}
              </div>
              <Script id="jupiter-plugin-script" src={JUPITER_SCRIPT} strategy="lazyOnload" onReady={() => setScriptReady(true)} onError={() => setScriptReady(false)} />
            </>
          }
          holders={holders}
          aside={marketDetails}
        />
      </div>
    );
  }

  /* Off mainnet: the site's own chart and swap against the pool, in the same grid (the "mainnet only" fallback of 2026-10-06 went with it). */
  if (pool !== null && record) return <DevnetMarket launch={launch} record={record} chartHeader={chartHeader} marketDetails={marketDetails} holders={holders} />;

  return (
    <section className="panel p-4 md:p-5" aria-label={`${launch.token.symbol} on the market`}>
      {previewNote}
      {pool === null ? (
          <p className="text-text-2 leading-snug">The chart and the swap appear once the pool is open.</p>
        ) : (
          <div data-market-fallback>
            <p className="text-text-2 leading-snug">Reading the pool.</p>
            <div className="mt-3 flex flex-wrap gap-2">
              <a href={solanaExplorerUrl(mint)} target="_blank" rel="noreferrer" className="chip">
                The mint
              </a>
              <a href={solanaExplorerUrl(pool)} target="_blank" rel="noreferrer" className="chip">
                The pool
              </a>
            </div>
            {poolLine}
          </div>
        )}
    </section>
  );
}
