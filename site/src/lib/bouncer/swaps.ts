"use client";

import { useCallback, useSyncExternalStore } from "react";
import { PublicKey } from "@solana/web3.js";
import { getHistoryConnection } from "./chain/rpc";
import { readPoolSwaps, type PoolSwap } from "./chain/poolSwaps";

/*
  A pool's swaps for the page: one read per pool, shared by the chart, the
  swap panel and the figures, kept while the page lives and extended with
  the newer transactions every 15 seconds and after a swap from this page
  lands (refreshPoolSwaps). The first read of a busy pool on the public
  devnet endpoint takes about a second a transaction (history.ts), so the
  page gets what has been read so far with the progress.
*/
export type SwapsRead = "loading" | "ok" | "limited" | "failed";

export interface PoolSwaps {
  /* Oldest first. */
  swaps: PoolSwap[];
  /* When the pool opened (its first transaction's block time), once the listing reached it. */
  openedAt: number | null;
  read: SwapsRead;
  progress: { read: number; total: number };
  /* Points whose price came from the vaults' balances because the node's answer carried no swap event. */
  fromBalances: number;
  readAt: number;
}

interface Entry {
  pool: string;
  mint: string;
  state: PoolSwaps;
  newest: string | null;
  have: Map<string, PoolSwap[]>;
  inflight: Promise<void> | null;
  listeners: Set<() => void>;
  timer: ReturnType<typeof setInterval> | null;
}

const entries = new Map<string, Entry>();
const POLL_MS = 15_000;

function entryFor(pool: string, mint: string): Entry {
  let e = entries.get(pool);
  if (!e) {
    e = { pool, mint, state: { swaps: [], openedAt: null, read: "loading", progress: { read: 0, total: 0 }, fromBalances: 0, readAt: 0 }, newest: null, have: new Map(), inflight: null, listeners: new Set(), timer: null };
    entries.set(pool, e);
  }
  /* The first subscriber may not know the mint yet (a page whose launch is still loading); the first one that does names it. */
  if (!e.mint && mint) e.mint = mint;
  return e;
}

function set(e: Entry, patch: Partial<PoolSwaps>) {
  e.state = { ...e.state, ...patch };
  e.listeners.forEach((l) => l());
}

const byTime = (x: PoolSwap, y: PoolSwap) => x.slot - y.slot || (x.blockTime ?? 0) - (y.blockTime ?? 0);

/* Reads what is newer than the last read (everything, the first time). One read at a time per pool; a second call joins the first. */
export function refreshPoolSwaps(pool: string, mint?: string): Promise<void> {
  const e = entries.get(pool) ?? (mint ? entryFor(pool, mint) : null);
  if (!e) return Promise.resolve();
  if (e.inflight) return e.inflight;
  const first = e.newest === null;
  e.inflight = (async () => {
    try {
      const r = await readPoolSwaps(getHistoryConnection(), new PublicKey(e.pool), e.mint, {
        until: e.newest ?? undefined,
        have: e.have,
        onProgress: (read, total) => {
          if (!first) return;
          /* What has been read so far, oldest first, while the first read runs. */
          const partial = [...e.have.values()].flat().sort(byTime);
          set(e, { progress: { read, total }, swaps: partial, read: "loading" });
        },
      });
      if (r.stats.missing.length === 0) e.newest = r.newest ?? e.newest;
      const merged = new Map<string, PoolSwap>();
      for (const s of [...e.state.swaps, ...r.swaps]) merged.set(`${s.signature}:${s.tokenAtoms}:${s.solLamports}:${s.side}`, s);
      const swaps = [...merged.values()].sort(byTime);
      set(e, { swaps, openedAt: r.openedAt ?? e.state.openedAt, read: "ok", progress: { read: swaps.length, total: swaps.length }, fromBalances: swaps.filter((s) => s.source === "balances").length, readAt: Date.now() });
    } catch (err) {
      const limited = /429|too many requests/i.test(String((err as Error)?.message ?? err));
      set(e, { read: limited ? "limited" : "failed", readAt: Date.now() });
    } finally {
      e.inflight = null;
    }
  })();
  return e.inflight;
}

function subscribe(e: Entry, fn: () => void): () => void {
  e.listeners.add(fn);
  if (!e.timer) {
    void refreshPoolSwaps(e.pool);
    e.timer = setInterval(() => void refreshPoolSwaps(e.pool), POLL_MS);
  }
  return () => {
    e.listeners.delete(fn);
    if (e.listeners.size === 0 && e.timer) {
      clearInterval(e.timer);
      e.timer = null;
    }
  };
}

const EMPTY: PoolSwaps = { swaps: [], openedAt: null, read: "loading", progress: { read: 0, total: 0 }, fromBalances: 0, readAt: 0 };

/* The swaps of a pool, oldest first, with how the read is going. Nothing is read until both the pool and the launch's mint are known. */
export function usePoolSwaps(pool: string | null, mint: string): PoolSwaps {
  const e = pool && mint ? entryFor(pool, mint) : null;
  const sub = useCallback((fn: () => void) => (e ? subscribe(e, fn) : () => {}), [e]);
  const get = useCallback(() => (e ? e.state : EMPTY), [e]);
  const server = useCallback(() => EMPTY, []);
  return useSyncExternalStore(sub, get, server);
}

/* What the shared read holds for a pool right now, oldest first. */
export function peekPoolSwaps(pool: string): PoolSwap[] {
  return entries.get(pool)?.state.swaps ?? [];
}

/* The SOL that went through a pool in the last 24 hours, lamports, from its swaps: both sides counted once each, in the SOL the trader paid or received. */
export function volume24h(swaps: PoolSwap[], nowSec = Math.floor(Date.now() / 1000)): bigint {
  let sum = 0n;
  for (const s of swaps) if (s.blockTime !== null && s.blockTime >= nowSec - 86_400) sum += s.solLamports;
  return sum;
}
