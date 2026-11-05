"use client";

import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import { useNow } from "./hooks";

/*
  The SOL price in the browser: one shared fetch loop for every component
  that prices a market cap, through the site's own /api/sol-price (which
  caches the public quote for 30 seconds).

  the founder, 2026-09-28: every market cap is a dollar figure, every amount stays
  SOL. So this quote is no longer decoration. It prices open launches' caps
  and the bid control's steps, and three rules follow:
  - never stale: once the newest quote is older than SOL_PRICE_STALE_MS the
    hook returns null and every live cap reads "price unavailable", because
    a missing figure is honest where an old one is not;
  - no fallback: nothing ever shows a SOL market cap in its place, and a
    priced bid waits (the bid control disables itself);
  - never the seal: sealing reads both sources fresh (checkQuote), and a
    settled launch is priced once, at the minute it settled (useFrozenRate).
*/

/* How often the browser asks for a quote. The server caches for 30 s, so a quote is at most about a minute old in normal running. */
export const SOL_PRICE_REFRESH_MS = 30_000;
/* Two missed refreshes: after this the dollars are hidden rather than shown from an old quote. */
export const SOL_PRICE_STALE_MS = 120_000;

export interface SolQuote {
  usdPerSol: number;
  /* Unix milliseconds the server read it. */
  at: number;
  source: string;
}

interface Store {
  quote: SolQuote | null;
  /* True once a fetch has finished, with or without a quote: the footer then knows whether "no quote" is a fact or just "not yet". */
  attempted: boolean;
  listeners: Set<() => void>;
  timer: ReturnType<typeof setInterval> | null;
  inflight: boolean;
}

const store: Store = { quote: null, attempted: false, listeners: new Set(), timer: null, inflight: false };

async function refresh() {
  if (store.inflight) return;
  store.inflight = true;
  try {
    const res = await fetch("/api/sol-price", { cache: "no-store" });
    if (res.ok) {
      const j = (await res.json()) as Partial<SolQuote>;
      if (typeof j.usdPerSol === "number" && Number.isFinite(j.usdPerSol) && j.usdPerSol > 0 && typeof j.at === "number") {
        store.quote = { usdPerSol: j.usdPerSol, at: j.at, source: String(j.source ?? "") };
      }
    }
  } catch {
    /* the last quote stands until it is stale */
  } finally {
    store.inflight = false;
    store.attempted = true;
    store.listeners.forEach((l) => l());
  }
}

function subscribe(fn: () => void) {
  store.listeners.add(fn);
  if (!store.timer) {
    refresh();
    store.timer = setInterval(refresh, SOL_PRICE_REFRESH_MS);
  }
  return () => {
    store.listeners.delete(fn);
    if (store.listeners.size === 0 && store.timer) {
      clearInterval(store.timer);
      store.timer = null;
    }
  };
}

const getQuote = () => store.quote;
const getAttempted = () => store.attempted;
const serverNull = () => null;
const serverFalse = () => false;

export function isFresh(q: SolQuote | null, nowMs: number): q is SolQuote {
  return q !== null && nowMs - q.at <= SOL_PRICE_STALE_MS;
}

/* The current quote, or null before the first one arrives, after the feed fails, or once the newest quote is stale. Re-judged every five seconds. */
export function useSolPrice(): SolQuote | null {
  const quote = useSyncExternalStore(subscribe, getQuote, serverNull);
  const now = useNow(5000);
  if (!now) return null;
  return isFresh(quote, now) ? quote : null;
}

/* Whether the browser has finished at least one attempt, so a missing figure can be told apart from one still loading. */
export function useSolPriceAttempted(): boolean {
  const s = useCallback((fn: () => void) => subscribe(fn), []);
  return useSyncExternalStore(s, getAttempted, serverFalse);
}

/*
  The SOL price at one past moment, frozen: the one-minute candle containing
  ts (unix seconds), through /api/sol-price/at. Used for a settled launch
  (SettlementRecord.settled_ts) and for a bid's "when you bid" figure
  (Bid.placed_ts). One request per minute per page load, shared.
*/
export type FrozenRate = { state: "loading" } | { state: "ok"; usdPerSol: number; minute: number; source: string } | { state: "unavailable"; retryAt: number; pending: boolean };

/* The page's status for its market caps. "pending": a settled launch's minute is recent and its price is not frozen yet (rehearsal item 6, the founder 2026-10-28: "Please wait", not "price unavailable"). */
export type RateStatus = "ok" | "loading" | "pending" | "unavailable";

/* How long after its minute a settle-minute price counts as not confirmed yet rather than missing. */
const FROZEN_PENDING_SECS = 300;
/* While pending, the next ask: when the server says, at least 3 s and at most 10 s away. */
const FROZEN_PENDING_RETRY = { minSecs: 3, maxSecs: 10 };

const frozen = new Map<number, FrozenRate>();
const frozenListeners = new Set<() => void>();
const frozenInflight = new Set<number>();

async function loadFrozen(minute: number) {
  if (frozenInflight.has(minute)) return;
  frozenInflight.add(minute);
  let next: FrozenRate;
  try {
    const res = await fetch(`/api/sol-price/at?ts=${minute}`);
    const j = (await res.json()) as { usdPerSol?: number; minute?: number; source?: string; retryAfterSecs?: number };
    const pending = Date.now() / 1000 < minute + FROZEN_PENDING_SECS;
    const wait = pending ? Math.min(FROZEN_PENDING_RETRY.maxSecs, Math.max(FROZEN_PENDING_RETRY.minSecs, j.retryAfterSecs ?? FROZEN_PENDING_RETRY.maxSecs)) : Math.max(15, j.retryAfterSecs ?? 60);
    next =
      res.ok && typeof j.usdPerSol === "number" && j.usdPerSol > 0
        ? { state: "ok", usdPerSol: j.usdPerSol, minute, source: String(j.source ?? "") }
        : { state: "unavailable", retryAt: Date.now() + wait * 1000, pending };
  } catch {
    const pending = Date.now() / 1000 < minute + FROZEN_PENDING_SECS;
    next = { state: "unavailable", retryAt: Date.now() + (pending ? FROZEN_PENDING_RETRY.maxSecs * 1000 : 60_000), pending };
  } finally {
    frozenInflight.delete(minute);
  }
  frozen.set(minute, next);
  frozenListeners.forEach((l) => l());
}

function subscribeFrozen(fn: () => void) {
  frozenListeners.add(fn);
  return () => {
    frozenListeners.delete(fn);
  };
}

export function useFrozenRate(ts: number | null): FrozenRate | null {
  const minute = ts == null || ts <= 0 ? null : ts - (ts % 60);
  const get = useCallback(() => (minute == null ? null : (frozen.get(minute) ?? LOADING)), [minute]);
  const rate = useSyncExternalStore(subscribeFrozen, get, serverNull);
  /* Asked once, then again exactly when the last answer said (item 6: no 15 s tick on top of the server's wait). */
  useEffect(() => {
    if (minute == null) return;
    const cur = frozen.get(minute);
    if (!cur) {
      void loadFrozen(minute);
      return;
    }
    if (cur.state !== "unavailable") return;
    const t = setTimeout(() => void loadFrozen(minute), Math.max(0, cur.retryAt - Date.now()));
    return () => clearTimeout(t);
  }, [minute, rate]);
  return rate;
}
const LOADING: FrozenRate = { state: "loading" };

/*
  The check before a priced bid is sealed: both sources read fresh by the
  server, in parallel. ok carries the rate to seal at (the higher of the two,
  so the sealed cap is at or below the typed one at either source's price).
*/
export type QuoteCheck =
  | { ok: true; usdPerSol: number; coinbase: number; kraken: number; gapPct: number; limitPct: number; at: number }
  | { ok: false; reason: "missing" | "disagree" | "off" | "budget" | "network"; coinbase: number | null; kraken: number | null; gapPct?: number; limitPct?: number };

export async function checkQuote(): Promise<QuoteCheck> {
  try {
    const res = await fetch("/api/sol-price/check", { cache: "no-store" });
    return (await res.json()) as QuoteCheck;
  } catch {
    return { ok: false, reason: "network", coinbase: null, kraken: null };
  }
}

/* Why a priced bid cannot be sealed right now, in one sentence. */
export function quoteProblem(c: Extract<QuoteCheck, { ok: false }>): string {
  if (c.reason === "disagree" && c.coinbase && c.kraken) {
    return `Coinbase says $${c.coinbase.toFixed(2)} and Kraken $${c.kraken.toFixed(2)} per SOL, ${c.gapPct?.toFixed(2)}% apart. We only seal a market cap when they agree within ${c.limitPct}%. Try again in a moment.`;
  }
  if (c.reason === "missing") {
    const got = c.coinbase ? "Kraken" : c.kraken ? "Coinbase" : "Coinbase or Kraken";
    return `No SOL price from ${got} just now, and a market cap is only sealed when both answer. Try again in a moment.`;
  }
  if (c.reason === "budget") return "Today's SOL price checks are used up, so no market cap can be sealed until midnight UTC.";
  return "The SOL price could not be checked just now, so no market cap can be sealed. Try again in a moment.";
}

/*
  The one rate a page prices its market caps at. A settled launch (settledTs
  given): the frozen minute it settled, never today's price. Otherwise the
  live quote. Null while loading or when unavailable; status says which.
*/
export interface CapRate {
  usdPerSol: number;
  kind: "live" | "settled";
  source: string;
}

export function useCapRate(settledTs: number | null): { rate: CapRate | null; status: RateStatus } {
  const live = useSolPrice();
  const attempted = useSolPriceAttempted();
  const settled = useFrozenRate(settledTs);
  const frozen = settledTs != null;
  const usdPerSol = frozen ? (settled?.state === "ok" ? settled.usdPerSol : null) : (live?.usdPerSol ?? null);
  const source = frozen ? (settled?.state === "ok" ? settled.source : "") : (live?.source ?? "");
  /* The same object while the figures are the same: it is a prop of the bid table, which is memoised (a new object each render redrew a thousand rows every few seconds, 2026-10-02). */
  const rate = useMemo<CapRate | null>(() => (usdPerSol == null ? null : { usdPerSol, kind: frozen ? "settled" : "live", source }), [usdPerSol, frozen, source]);
  if (frozen) return { rate, status: rate ? "ok" : settled?.state === "unavailable" ? (settled.pending ? "pending" : "unavailable") : "loading" };
  return { rate, status: rate ? "ok" : attempted ? "unavailable" : "loading" };
}
