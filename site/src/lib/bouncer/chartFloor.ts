import type { AutoscaleInfo } from "lightweight-charts";

/*
  A market cap is never below $0, so neither is the chart's axis (the founder,
  2026-10-13, IMG_7746: the axis read "$-400.00"). The library pads under
  the lowest point by a share of the pane plus room for the buy arrows, and
  on a line that starts near $0 that padding reached below it.

  The price scale takes no bottom share (scaleMargins.bottom 0, where the
  chart is made); this gives the same padding back in pixels and cuts it to
  what puts the pane's bottom edge exactly on $0. The bottom edge's price is
  min - (max - min) * below / (inner - 1), with inner = height - top - below,
  which is 0 when below = min * (height - top - 1) / max. A flat line (a new
  pool's one opening point, min = max) goes the same way: the cut is then the
  whole pane, so it keeps the whole share, and the library's widening by a
  hair each way leaves its edge a fraction of a cent under the point.
*/
export const CHART_TOP_SHARE = 0.12;
export const CHART_BOTTOM_SHARE = 0.12;

export function floorAtZero(info: AutoscaleInfo | null, paneHeight: number): AutoscaleInfo | null {
  const r = info?.priceRange;
  if (!info || !r || r.minValue < 0 || !(r.maxValue >= r.minValue)) return info;
  const h = Math.max(0, paneHeight);
  const above = info.margins?.above ?? 0;
  const wanted = CHART_BOTTOM_SHARE * h + (info.margins?.below ?? 0);
  const reach = (r.minValue * (h - CHART_TOP_SHARE * h - above - 1)) / r.maxValue;
  return { priceRange: r, margins: { above, below: Math.max(0, Math.min(wanted, reach)) } };
}

/*
  A buy's arrow is drawn under its point, a sell's over it. With the floor,
  a buy near $0 has no room under its point, and its arrow would be cut or
  gone (the review of 2026-10-13). Such a buy draws its arrow over the point
  instead: still the up arrow in the buy colour, so buys and sells are still
  told apart by shape. In lightweight-charts 5.2 an arrow is at most 28 px
  tall (ceiledEven(ceiledOdd(30))), 3 px off its point, and the plugin keeps
  at most 48 px above the line for arrows drawn there (1.5 x 28 + 2 x 3);
  with the edge on $0, a point at value v sits v / top * (height - 1 - top
  share - 48) px over the edge, at the least. One more px for the line.
  top is the highest point drawn; zooming in on time only lowers the visible
  top, which leaves more room, so this errs toward drawing over the point.
*/
const ARROW_PX = 28 + 3 + 1;
const ABOVE_PX = 48;

export function buyArrowAbove(value: number, top: number, paneHeight: number): boolean {
  const room = paneHeight - 1 - CHART_TOP_SHARE * paneHeight - ABOVE_PX;
  if (!(top > 0) || !(room > 0)) return true;
  return (value / top) * room < ARROW_PX;
}

/* Dollar figures on the axis. Four significant digits, so neighbouring ticks on a tight scale never read the same: $24.60, $12.35k, $1.235M. The pane's bottom edge sits on $0; a hair under it from rounding reads $0.00, not "$-0.00". */
export function fmtUsdAxis(raw: number): string {
  if (!Number.isFinite(raw)) return "";
  const v = raw < 0 && raw > -0.005 ? 0 : raw;
  const a = Math.abs(v);
  const sig = (x: number) => Number(x.toPrecision(4)).toString();
  if (a >= 1e9) return `$${sig(v / 1e9)}B`;
  if (a >= 1e6) return `$${sig(v / 1e6)}M`;
  if (a >= 1e3) return `$${sig(v / 1e3)}k`;
  return `$${v.toFixed(2)}`;
}
