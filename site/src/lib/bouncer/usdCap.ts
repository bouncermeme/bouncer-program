/*
  Market caps in dollars. the founder, 2026-09-28: "We don't measure mc in SOL.
  It's in usd." Every market cap on the site is a dollar figure; every
  amount (a bid, a deposit, what was raised, what comes back) stays SOL and
  is never converted. Pure functions: a market cap in lamports and a SOL
  price in, dollars out, and the way back to the program's grid.

  The grid is in SOL (0.29: 2,407 steps from the launch's floor, 0.25
  percent apart up to 100 times it, 1 percent above). A dollar cap therefore means a SOL step times a SOL price, and the
  question is always which price:
  - an open launch: the live quote, so its starting cap moves with SOL;
  - a sealed bid: the rate checked against both sources when it was sealed;
  - a settled launch: the price in the minute it settled, frozen.
*/

import { gridTop, tickForMaxValue, valueAtTick } from "./grid";
import type { LaunchAccount } from "./types";
import { mcapAtTick, totalSupply } from "./view";

const LAMPORTS = 1e9;

/* Dollars for a market cap in lamports at a SOL price. */
export function capUsd(mcapLamports: bigint, usdPerSol: number): number {
  return (Number(mcapLamports) / LAMPORTS) * usdPerSol;
}

const whole = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const cents = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/* "$24,836" from a thousand up, "$11.81" under it, three significant digits under a dollar, never in exponent form ("$0.0000248"). */
export function fmtUsd(usd: number): string {
  const abs = Math.abs(usd);
  if (abs >= 1000) return `$${whole.format(usd)}`;
  if (abs >= 1) return `$${cents.format(usd)}`;
  if (abs === 0) return "$0";
  return `$${usd.toLocaleString("en-US", { maximumSignificantDigits: 3, maximumFractionDigits: 20 })}`;
}

/* "$24.8k", "$31.2M": three significant figures, for chips, axis ends and cards. */
export function fmtUsdCompact(usd: number): string {
  const abs = Math.abs(usd);
  const sig = (n: number) => Number(n.toPrecision(3)).toString();
  if (abs >= 1e9) return `$${sig(usd / 1e9)}B`;
  if (abs >= 1e6) return `$${sig(usd / 1e6)}M`;
  if (abs >= 1e3) return `$${sig(usd / 1e3)}k`;
  return fmtUsd(usd);
}

export function fmtCap(mcapLamports: bigint, usdPerSol: number, opts?: { compact?: boolean }): string {
  const usd = capUsd(mcapLamports, usdPerSol);
  return opts?.compact ? fmtUsdCompact(usd) : fmtUsd(usd);
}

/* A dollar price per SOL as printed beside a rate: "$118.24". */
export function fmtRate(usdPerSol: number): string {
  return `$${cents.format(usdPerSol)}`;
}

/*
  The step a typed dollar market cap seals at, at a SOL price. Always the
  step at or below: a sealed bid cannot take back a max higher than the one
  typed. Three answers:
  - "step": an ordinary maximum;
  - "below": under the starting market cap, where nothing can clear;
  - "top": at or above the top of the grid. The top step IS the no limit
    bid, so the control never reaches it from a typed figure; the bidder
    has to choose No limit on purpose.
*/
export type UsdCapTick = { kind: "step"; tick: number } | { kind: "below" } | { kind: "top" };

export function tickForUsdCap(a: LaunchAccount, usd: number, usdPerSol: number): UsdCapTick {
  if (!(usd > 0) || !(usdPerSol > 0)) return { kind: "below" };
  /* Lamports of market cap, rounded down, then the float's share of it: value = mcap × float / supply. */
  const mcap = BigInt(Math.floor((usd / usdPerSol) * LAMPORTS));
  const value = (mcap * a.float) / totalSupply(a);
  if (value >= gridTop(a.floorValue)) return { kind: "top" };
  const tick = tickForMaxValue(a.floorValue, value);
  return tick === null ? { kind: "below" } : { kind: "step", tick };
}

/* The market cap in lamports at a step, and the SOL bids at or above it must total for the launch to clear there (the float's value at that step). */
export function stepFigures(a: LaunchAccount, tick: number): { mcap: bigint; needed: bigint } {
  return { mcap: mcapAtTick(a, tick), needed: valueAtTick(a.floorValue, tick) };
}
