"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { AutoscaleInfo, IChartApi, ISeriesApi, ISeriesMarkersPluginApi, Time, UTCTimestamp } from "lightweight-charts";
import { buyArrowAbove, CHART_TOP_SHARE, floorAtZero, fmtUsdAxis } from "@/lib/bouncer/chartFloor";
import { swapMcapLamports, type PoolSwap } from "@/lib/bouncer/chain/poolSwaps";
import { fmtAgo, fmtTime } from "@/lib/bouncer/format";
import type { CapRate, RateStatus } from "@/lib/bouncer/solPrice";
import type { PoolSwaps } from "@/lib/bouncer/swaps";
import { fmtCap } from "@/lib/bouncer/usdCap";

/*
  The price chart off mainnet: the market cap after every swap on the pool,
  read from the pool's own transactions (lib/bouncer/chain/poolSwaps.ts),
  drawn with lightweight-charts. The first point is the market cap the pool
  opened at (the record's), at the time of the pool's first transaction. In
  dollars, like every market cap on the site (the founder, 2026-09-28), at the
  page's live rate; without a rate the chart waits and says so.

  Colours come from the page's own tokens at mount (the library draws on a
  canvas and cannot read a CSS variable).
*/
interface Point {
  time: UTCTimestamp;
  mcapLamports: bigint;
  swap: PoolSwap | null;
}

function cssVar(name: string): string {
  if (typeof window === "undefined") return "#000";
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || "#000";
}

export function DevnetChart({ swaps, openingMcap, supply, symbol, rate, rateStatus, height }: { swaps: PoolSwaps; openingMcap: bigint; supply: bigint; symbol: string; rate: CapRate | null; rateStatus: RateStatus; height: number }) {
  const box = useRef<HTMLDivElement | null>(null);
  const chart = useRef<IChartApi | null>(null);
  const series = useRef<ISeriesApi<"Line"> | null>(null);
  const markers = useRef<ISeriesMarkersPluginApi<Time> | null>(null);
  const [hover, setHover] = useState<Point | null>(null);
  const [ready, setReady] = useState(false);
  const [, setTick] = useState(0);

  /* One point per swap, strictly increasing in time (two swaps in one second are a second apart on the axis). */
  const points = useMemo<Point[]>(() => {
    const out: Point[] = [];
    let last = 0;
    const push = (t: number | null, mcapLamports: bigint, swap: PoolSwap | null) => {
      if (t === null) return;
      const time = Math.max(t, last + 1);
      last = time;
      out.push({ time: time as UTCTimestamp, mcapLamports, swap });
    };
    if (swaps.openedAt !== null) push(swaps.openedAt, openingMcap, null);
    for (const s of swaps.swaps) {
      const m = swapMcapLamports(s, supply);
      if (m !== null) push(s.blockTime, m, s);
    }
    return out;
  }, [swaps, openingMcap, supply]);

  const usd = rate?.usdPerSol ?? null;
  const toValue = (lamports: bigint) => (usd === null ? 0 : (Number(lamports) / 1e9) * usd);
  /* The points as the crosshair handler, made once, reads them. */
  const pointsRef = useRef<Point[]>(points);
  useEffect(() => {
    pointsRef.current = points;
  }, [points]);

  /* The readout refreshes its "ago" every 30 s. */
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 30_000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    const el = box.current;
    if (!el || usd === null) return;
    let disposed = false;
    let ro: ResizeObserver | null = null;
    (async () => {
      const lw = await import("lightweight-charts");
      if (disposed || !box.current) return;
      const text3 = cssVar("--text-3");
      const line = cssVar("--line");
      const accent = cssVar("--accent");
      const c = lw.createChart(el, {
        width: el.clientWidth,
        height,
        layout: { background: { type: lw.ColorType.Solid, color: "transparent" }, textColor: text3, fontSize: 14, fontFamily: getComputedStyle(document.body).fontFamily, attributionLogo: false },
        grid: { vertLines: { color: line, style: lw.LineStyle.Dotted }, horzLines: { color: line, style: lw.LineStyle.Dotted } },
        /* No bottom share: the series pads under its lowest point itself, never below $0 (chartFloor.ts). A label that would be cut at the pane's edge (the $0.00 on the bottom edge) is left out. */
        rightPriceScale: { borderColor: line, scaleMargins: { top: CHART_TOP_SHARE, bottom: 0 }, entireTextOnly: true },
        /* The axis and the crosshair in the reader's own time zone, like the readout under the chart (the library's default is UTC). */
        timeScale: {
          borderColor: line,
          timeVisible: true,
          secondsVisible: false,
          rightOffset: 2,
          tickMarkFormatter: (time: unknown, kind: number) => {
            if (typeof time !== "number") return null;
            const d = new Date(time * 1000);
            return kind >= lw.TickMarkType.Time ? d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : d.toLocaleDateString([], { month: "short", day: "numeric" });
          },
        },
        crosshair: { mode: lw.CrosshairMode.Magnet, vertLine: { color: text3, labelBackgroundColor: cssVar("--panel-3") }, horzLine: { color: text3, labelBackgroundColor: cssVar("--panel-3") } },
        handleScale: { axisPressedMouseMove: false },
        localization: {
          priceFormatter: (v: number) => fmtUsdAxis(v),
          timeFormatter: (time: unknown) => (typeof time === "number" ? new Date(time * 1000).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : ""),
        },
      });
      const s = c.addSeries(lw.LineSeries, { color: accent, lineWidth: 2, priceLineVisible: false, lastValueVisible: true, crosshairMarkerRadius: 5, priceFormat: { type: "custom", formatter: (v: number) => fmtUsdAxis(v), minMove: 0.0001 }, autoscaleInfoProvider: (original: () => AutoscaleInfo | null) => floorAtZero(original(), c.paneSize().height) });
      const m = lw.createSeriesMarkers(s, []);
      c.subscribeCrosshairMove((p) => {
        if (!p.time) {
          setHover(null);
          return;
        }
        const t = p.time as UTCTimestamp;
        setHover((prev) => (prev && prev.time === t ? prev : (pointsRef.current.find((q) => q.time === t) ?? null)));
      });
      chart.current = c;
      series.current = s;
      markers.current = m;
      ro = new ResizeObserver(() => c.applyOptions({ width: el.clientWidth }));
      ro.observe(el);
      setReady(true);
    })();
    return () => {
      disposed = true;
      ro?.disconnect();
      chart.current?.remove();
      chart.current = null;
      series.current = null;
      markers.current = null;
      setReady(false);
    };
    // The chart is built once per rate availability and height; the data effect below feeds it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [usd === null, height]);

  useEffect(() => {
    const s = series.current;
    if (!s || !ready || usd === null) return;
    /* A point the library cannot draw (a value past its range would be a decoding fault upstream) is left out and named in the console; the page never falls over a chart. */
    const drawable = points.filter((p) => {
      const v = toValue(p.mcapLamports);
      const ok = Number.isFinite(v) && v >= 0 && v < 1e12;
      if (!ok) console.warn("[chart] point left out", p.swap?.signature ?? "opening", v);
      return ok;
    });
    try {
      s.setData(drawable.map((p) => ({ time: p.time, value: toValue(p.mcapLamports) })));
      const good = cssVar("--good");
      /* A sell is the bad tone: the brand blue is the line itself in the new look (it was the claret, 2026-10-10). */
      const sell = cssVar("--bad");
      /* A buy near the $0 floor draws its up arrow over its point, where there is room (chartFloor.ts). */
      const top = drawable.reduce((m, p) => Math.max(m, toValue(p.mcapLamports)), 0);
      const paneHeight = chart.current?.paneSize().height ?? 0;
      markers.current?.setMarkers(
        drawable
          .filter((p) => p.swap)
          .map((p) => {
            const buy = p.swap!.side === "buy";
            const under = buy && !buyArrowAbove(toValue(p.mcapLamports), top, paneHeight);
            return { time: p.time, position: under ? ("belowBar" as const) : ("aboveBar" as const), shape: buy ? ("arrowUp" as const) : ("arrowDown" as const), color: buy ? good : sell, size: 1 };
          }),
      );
      chart.current?.timeScale().fitContent();
    } catch (e) {
      console.warn("[chart] could not draw", e);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [points, ready, usd]);

  const last = points.length ? points[points.length - 1] : null;
  const shown = hover ?? last;
  const n = swaps.swaps.length;
  const readLine =
    swaps.read === "loading" && swaps.progress.total > 0
      ? `Reading swaps, ${swaps.progress.read} of ${swaps.progress.total}.`
      : swaps.read === "loading"
        ? "Reading the pool's transactions."
        : swaps.read === "limited"
          ? "The RPC is rate-limiting the read; trying again."
          : swaps.read === "failed"
            ? "The pool's transactions could not be read; trying again."
            : null;
  /* The site's loading pulse while the first read runs (the measured pass waits for it, like every other loading state). */
  const pulse = swaps.read === "loading" ? " animate-pulse" : "";

  return (
    <div className="h-full flex flex-col" data-devnet-chart={n}>
      {usd === null ? (
        <div className="flex-1 flex items-center justify-center text-text-3 text-center px-4">{rateStatus === "loading" ? "Waiting for the SOL price." : "No SOL price, so no dollar chart yet. Trying again."}</div>
      ) : (
        <div ref={box} className="flex-1 min-h-0" style={{ height }} />
      )}
      <div className="px-3 pb-2 pt-1 flex flex-wrap items-baseline gap-x-4 gap-y-1 leading-snug" aria-live="polite">
        {shown && usd !== null ? (
          <>
            <span className="figure text-[1.125rem]">{fmtCap(shown.mcapLamports, usd, { compact: true })}</span>
            <span className="text-text-2">
              {shown.swap ? (
                <>
                  {shown.swap.side === "buy" ? "Buy" : "Sell"} at {fmtTime(shown.time)}
                  {shown.swap.source === "balances" ? ", from the vaults" : ""}
                </>
              ) : (
                <>Opened at {fmtTime(shown.time)}</>
              )}
            </span>
            {!hover && last?.swap?.blockTime ? <span className="text-text-3">{fmtAgo(last.swap.blockTime)}</span> : null}
            <span className="text-text-3">
              {n} {n === 1 ? "swap" : "swaps"}
            </span>
          </>
        ) : (
          <span className={`text-text-3${pulse}`}>{readLine ?? `No swaps yet. The first ${symbol} trade draws the line.`}</span>
        )}
        {shown && readLine && <span className={`text-text-3${pulse}`}>{readLine}</span>}
      </div>
    </div>
  );
}
