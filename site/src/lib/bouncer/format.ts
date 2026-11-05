/* Display formatting. SOL is the only quote asset (INTERFACE v0.18, N-01); lamports have nine decimals. */

import { LAMPORTS_PER_SOL } from "@contract/constants";
import { networkNowMs } from "./netClock";

const nf = (min: number, max: number) =>
  new Intl.NumberFormat("en-US", { minimumFractionDigits: min, maximumFractionDigits: max });

export const SOL_DECIMALS: number = LAMPORTS_PER_SOL.toString().length - 1;

/* Atoms to a plain number for display. Precision loss is fine here; nothing settles on it. */
export function atomsToNumber(atoms: bigint, decimals: number): number {
  return Number(atoms) / 10 ** decimals;
}

export function numberToAtoms(n: number, decimals: number): bigint {
  return BigInt(Math.round(n * 10 ** decimals));
}

export function fmtSolNumber(n: number, opts?: { compact?: boolean }): string {
  const abs = Math.abs(n);
  let digits: [number, number];
  if (abs === 0) digits = [0, 0];
  else if (abs >= 100) digits = [0, 1];
  else if (abs >= 1) digits = [0, 2];
  else if (abs >= 0.01) digits = [0, 3];
  else if (abs >= 0.001) digits = [0, 4];
  /* Under a thousandth: two significant digits, down to the lamport, so 36,000 lamports reads 0.000036 and never 0. */
  else digits = [0, Math.min(SOL_DECIMALS, Math.ceil(-Math.log10(abs)) + 1)];
  const s = nf(digits[0], digits[1]).format(n);
  return opts?.compact ? s : `${s} SOL`;
}

export function fmtSol(lamports: bigint, opts?: { compact?: boolean }): string {
  return fmtSolNumber(atomsToNumber(lamports, SOL_DECIMALS), opts);
}


export function fmtTokenNumber(n: number, opts?: { long?: boolean }): string {
  if (opts?.long) return nf(0, 0).format(Math.round(n));
  const abs = Math.abs(n);
  if (abs >= 1e9) return nf(0, 2).format(n / 1e9) + "B";
  if (abs >= 1e6) return nf(0, 1).format(n / 1e6) + "M";
  if (abs >= 1e3) return nf(0, 1).format(n / 1e3) + "K";
  return nf(0, 0).format(n);
}

export function fmtTokens(atoms: bigint, decimals: number, opts?: { long?: boolean }): string {
  return fmtTokenNumber(atomsToNumber(atoms, decimals), opts);
}

/* For a quote or a confirmation, where "about" and "at least" must never read the same: two decimals on K, M and B, two under a thousand. Passive figures keep fmtTokens. */
export function fmtTokensPrecise(atoms: bigint, decimals: number): string {
  const n = atomsToNumber(atoms, decimals);
  const abs = Math.abs(n);
  if (abs >= 1e9) return nf(0, 2).format(n / 1e9) + "B";
  if (abs >= 1e6) return nf(0, 2).format(n / 1e6) + "M";
  if (abs >= 1e3) return nf(0, 2).format(n / 1e3) + "K";
  return nf(0, abs >= 1 ? 2 : 4).format(n);
}

/* SOL for a quote or a confirmation: four significant digits, down to the lamport (0.004938 and 0.004889 stay apart; fmtSol would show both as 0.0049). */
export function fmtSolPrecise(lamports: bigint, opts?: { compact?: boolean }): string {
  const n = atomsToNumber(lamports, SOL_DECIMALS);
  const abs = Math.abs(n);
  const digits = abs === 0 ? 0 : Math.min(SOL_DECIMALS, Math.max(2, Math.ceil(-Math.log10(abs)) + 3));
  const s = nf(0, digits).format(n);
  return opts?.compact ? s : `${s} SOL`;
}

/* A count of atoms (the smallest unit), for the rounding remainder that burns. Never converted to whole tokens, which would round a few atoms to zero. */
export function fmtAtoms(atoms: bigint): string {
  return `${nf(0, 0).format(Number(atoms))} ${atoms === 1n ? "atom" : "atoms"}`;
}

/* Astra's frontend review of 2026-10-21, F4: a positive share too small for the digits reads "<0.1%" (at one digit), never "0.0%"; a true zero stays 0. */
export function fmtPct(n: number, digits = 1): string {
  const f = nf(digits, digits);
  const pct = n * 100;
  const unit = 10 ** -digits;
  if (pct > 0 && pct < unit / 2) return `<${f.format(unit)}%`;
  return f.format(pct) + "%";
}

export function fmtMultiple(n: number): string {
  return nf(1, 2).format(n) + "x";
}

/* Per token prices in SOL are tiny. Enough digits to be exact, no scientific notation. */
export function fmtPrice(price: number): string {
  if (price === 0) return "0 SOL";
  const digits = Math.max(2, Math.min(12, Math.ceil(-Math.log10(price)) + 2));
  return `${price.toFixed(digits).replace(/0+$/, "").replace(/\.$/, "")} SOL`;
}

export function shortAddr(a: string, head = 4, tail = 4): string {
  if (!a) return "";
  if (a.length <= head + tail + 1) return a;
  return `${a.slice(0, head)}…${a.slice(-tail)}`;
}

/* "1 bid", "3 bids". */
export function fmtBids(n: number): string {
  return `${nf(0, 0).format(n)} ${n === 1 ? "bid" : "bids"}`;
}

export function fmtCountdown(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

export function fmtDuration(sec: number): string {
  if (sec % 3600 === 0) return `${sec / 3600} h`;
  if (sec >= 3600) return `${Math.floor(sec / 3600)} h ${Math.round((sec % 3600) / 60)} min`;
  return `${Math.round(sec / 60)} min`;
}

/*
  24o (the founder's approved mock, 2026-10-26): a cleared card's age since trading opened, whole units rounded down, one unit
  only: under an hour in minutes (0m to 59m), under a day in hours (1h to 23h), then days (1d, 2d, ...). A clock a little
  behind the chain reads 0m, never a negative age.
*/
export function fmtCardAge(sinceSec: number, nowSec: number): string {
  const s = Math.max(0, Math.floor(nowSec - sinceSec));
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86_400)}d`;
}

/*
  24o: the launch's auction length in minutes, "15 min". v0.31: the window a launch records is its close less its landing
  time, so a 30 minute launch whose approval took 12 s records 1,788 s: whole minutes, rounded, as the creator picked
  them (Dispatch for the founder, 2026-10-28, pending his OK; was one decimal off the minute).
*/
export function fmtWindowMin(windowSecs: number): string {
  return `${Math.round(windowSecs / 60)} min`;
}

export function fmtTime(tsSec: number): string {
  return new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" }).format(new Date(tsSec * 1000));
}

/* A day, "Oct 30" (22e3: when a held ticker is free again). */
export function fmtDay(tsSec: number): string {
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" }).format(new Date(tsSec * 1000));
}

export function fmtDateTime(tsSec: number): string {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(tsSec * 1000));
}

export function fmtAgo(tsSec: number, nowMs = networkNowMs()): string {
  const s = Math.max(0, Math.floor(nowMs / 1000 - tsSec));
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} h ago`;
  return `${Math.floor(h / 24)} d ago`;
}

/* The minimum bid as one clean number (the founder, 2026-10-23): "≈ 0.022" for 0.02231616 SOL; an exact figure keeps no sign. */
export function solApprox(lamports: bigint): string {
  const v = Number(lamports) / 1e9;
  const r = Math.round(v * 1000) / 1000;
  return `${Math.abs(r - v) > 1e-12 ? "≈ " : ""}${r}`;
}
