"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { ACCOUNTS } from "@contract/constants";
import { getClient } from "./client";
import { leastSent, SETUP_ACCOUNT_BYTES, setupCost, type SetupCost } from "./product";
import { bidCosts, boundedPrice, FINAL_WINDOW_SECS, type BidTerms } from "./terms";
import { fetchWithBackoff, SITE_ROUTES } from "./chain/rpc";
import type { DecodedEvent } from "./chain/events";
import { networkNowMs, syncNetworkClock } from "./netClock";
import type { FundingReport } from "./funding";
import type { WalletAge } from "./walletAge";
import type { BidAccount, ConfigAccount, HistoryProgress, Launch, SettlementRecord } from "./types";

/* Live launch state, through the client seam (never a store behind it). Server snapshot is null so the shell renders, then the client fills it in. */
export function useLaunch(id: string): Launch | null {
  const subscribe = useCallback((cb: () => void) => getClient().subscribeLaunch(id, cb), [id]);
  const getSnapshot = useCallback(() => getClient().peekLaunch(id), [id]);
  const getServerSnapshot = useCallback(() => null, []);
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

/* The time the RPC answered that it holds no launch at this address, or null: the page shows a skeleton while null and the launch is null, and the missing panel once this is set. Shares the launch subscription, which asks again every poll. */
export function useLaunchMissing(id: string): number | null {
  const subscribe = useCallback((cb: () => void) => getClient().subscribeLaunch(id, cb), [id]);
  const getSnapshot = useCallback(() => getClient().peekMissing(id), [id]);
  const getServerSnapshot = useCallback(() => null, []);
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

/*
  A shared clock. One interval per tick size, any number of subscribers.
  The snapshot is the time rounded to the tick so it is stable between renders.
  The server snapshot is 0, so anything on the clock renders blank until mount.
  Round 28c (Opus M1, Fable F4, Terra T12): the time is the network clock's (netClock.ts), read from the cluster when
  the first clock mounts and again every few minutes while one runs; the device's until the cluster answers.
*/
const clocks = new Map<number, { listeners: Set<() => void>; timer: ReturnType<typeof setInterval> | null }>();
function subscribeClock(intervalMs: number, fn: () => void) {
  let c = clocks.get(intervalMs);
  if (!c) {
    c = { listeners: new Set(), timer: null };
    clocks.set(intervalMs, c);
  }
  c.listeners.add(fn);
  void syncNetworkClock();
  if (!c.timer)
    c.timer = setInterval(() => {
      void syncNetworkClock();
      c!.listeners.forEach((l) => l());
    }, intervalMs);
  return () => {
    c!.listeners.delete(fn);
    if (c!.listeners.size === 0 && c!.timer) {
      clearInterval(c!.timer);
      c!.timer = null;
    }
  };
}

export function useNow(intervalMs = 1000): number {
  const subscribe = useCallback((fn: () => void) => subscribeClock(intervalMs, fn), [intervalMs]);
  const getSnapshot = useCallback(() => Math.floor(networkNowMs() / intervalMs) * intervalMs, [intervalMs]);
  const getServerSnapshot = useCallback(() => 0, []);
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

/* The clock in unix seconds, or null before mount. */
export function useNowSec(intervalMs = 1000): number | null {
  const now = useNow(intervalMs);
  return now ? Math.floor(now / 1000) : null;
}

/* How long a failed read waits before the page reads again by itself (the house retry, as the history reader's). */
const READ_RETRY_MS = 20_000;

/*
  State that belongs to one wallet (the 0.28 triage's F14, 2026-10-09):
  shown only while the wallet that set it is the page's account. The setter
  carries the address it was made with, so a result that lands after a
  switch is kept for its own wallet, shown again if that wallet comes back,
  and never shown under another wallet's address.
*/
export function useWalletScoped<T>(address: string | null): [T | null, (v: T | null) => void] {
  const [s, setS] = useState<{ owner: string | null; value: T } | null>(null);
  const set = useCallback((v: T | null) => setS(v === null ? null : { owner: address, value: v }), [address]);
  return [s && s.owner === address ? s.value : null, set];
}

/*
  Bids for a launch. Re-read whenever the launch account changes (a new
  deposit, a reveal). The last list for this launch stays up while the next
  read runs and through a failed one; `failed` says the latest read failed
  (F14), and a failed read is tried again every 20 s, or at once by `retry`.
*/
export function useBidsRead(id: string, version: string): { bids: BidAccount[] | null; failed: boolean; retry: () => void } {
  const [state, setState] = useState<{ id: string; bids: BidAccount[] | null; failed: boolean } | null>(null);
  const [bump, setBump] = useState(0);
  const key = `${id}:${version}:${bump}`;
  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    getClient()
      .getBids(id)
      .then(
        (bids) => {
          if (live) setState({ id, bids, failed: false });
        },
        () => {
          if (!live) return;
          setState((prev) => ({ id, bids: prev && prev.id === id ? prev.bids : null, failed: true }));
          timer = setTimeout(() => live && setBump((n) => n + 1), READ_RETRY_MS);
        },
      );
    return () => {
      live = false;
      if (timer) clearTimeout(timer);
    };
  }, [id, key]);
  const retry = useCallback(() => setBump((n) => n + 1), []);
  const own = state && state.id === id ? state : null;
  return { bids: own ? own.bids : null, failed: !!own && own.failed, retry };
}

export function useBids(id: string, version: string): BidAccount[] | null {
  return useBidsRead(id, version).bids;
}

/*
  24n (plan fix 4): the newest `count` deposits, for the deposit feed: read again whenever `version` moves (the launch
  page reads its launch every 2 s, so a new bid shows within a launch read and this small read). As useBidsRead: the
  last list stays up through the next read and a failed one, `failed` says so, and a failed read is tried again after
  1 s, then every 20 s.
*/
export function useRecentBids(id: string, version: string, count: number): { bids: BidAccount[] | null; failed: boolean; retry: () => void } {
  const [state, setState] = useState<{ id: string; bids: BidAccount[] | null; failed: boolean } | null>(null);
  const [bump, setBump] = useState(0);
  const fails = useRef(0);
  const key = `${id}:${version}:${count}:${bump}`;
  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    getClient()
      .getRecentBids(id, count)
      .then(
        (bids) => {
          if (!live) return;
          fails.current = 0;
          setState({ id, bids, failed: false });
        },
        () => {
          if (!live) return;
          fails.current++;
          setState((prev) => ({ id, bids: prev && prev.id === id ? prev.bids : null, failed: true }));
          timer = setTimeout(() => live && setBump((n) => n + 1), fails.current <= 1 ? 1_000 : READ_RETRY_MS);
        },
      );
    return () => {
      live = false;
      if (timer) clearTimeout(timer);
    };
  }, [id, count, key]);
  const retry = useCallback(() => setBump((n) => n + 1), []);
  const own = state && state.id === id ? state : null;
  return { bids: own ? own.bids : null, failed: !!own && own.failed, retry };
}

/* The launches on which this wallet still has a bid account (its deposit is in the vault). Null until read, or with no wallet. The last set for this wallet stays through a failed read, which sets `failed` (F14). */
export function useMyBidsRead(ids: string[], bidder: string | null, version = ""): { mine: Set<string> | null; failed: boolean; retry: () => void } {
  const [state, setState] = useState<{ key: string; bidder: string; mine: Set<string> | null; failed: boolean } | null>(null);
  const [bump, setBump] = useState(0);
  /* 24d: read again when the set or a launch's version changes, not on every board read (the list is a new array each time). */
  const idList = ids.join(",");
  const key = `${bidder ?? ""}:${idList}:${version}`;
  useEffect(() => {
    const list = idList ? idList.split(",") : [];
    if (!bidder || list.length === 0) return;
    let live = true;
    getClient()
      .getMyBids(list, bidder)
      .then(
        (mine) => {
          if (live) setState({ key, bidder, mine, failed: false });
        },
        () => {
          if (live) setState((prev) => ({ key, bidder, mine: prev && prev.bidder === bidder ? prev.mine : null, failed: true }));
        },
      );
    return () => {
      live = false;
    };
  }, [bidder, idList, key, bump]);
  const retry = useCallback(() => setBump((n) => n + 1), []);
  const own = bidder && state && state.bidder === bidder ? state : null;
  return { mine: own && (own.key === key || own.mine) ? own.mine : null, failed: !!own && own.failed, retry };
}

export function useMyBids(ids: string[], bidder: string | null): Set<string> | null {
  return useMyBidsRead(ids, bidder).mine;
}

/*
  The launch's settlement record. `loading` is "no answer for this launch and
  state yet", so a page that ignores `failed` shows a skeleton, never "no
  record". A failed read sets `failed` and is tried again every 20 s, or at
  once by `retry` (F14).
*/
export function useSettlement(id: string, state?: string): { record: SettlementRecord | null; loading: boolean; failed: boolean; retry: () => void } {
  const key = `${id}:${state ?? ""}`;
  const [s, setS] = useState<{ key: string; record: SettlementRecord | null }>({ key: "", record: null });
  const [failedKey, setFailedKey] = useState<string | null>(null);
  const [bump, setBump] = useState(0);
  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    getClient()
      .getSettlement(id)
      .then(
        (record) => {
          if (!live) return;
          setS({ key, record });
          setFailedKey(null);
        },
        () => {
          if (!live) return;
          setFailedKey(key);
          timer = setTimeout(() => live && setBump((n) => n + 1), READ_RETRY_MS);
        },
      );
    return () => {
      live = false;
      if (timer) clearTimeout(timer);
    };
  }, [id, key, bump]);
  const retry = useCallback(() => setBump((n) => n + 1), []);
  return { record: s.key === key ? s.record : null, loading: s.key !== key, failed: s.key !== key && failedKey === key, retry };
}

/* The Config account: the cluster's floor, minimum bid, valve, bond and the emergency update pause. Re-read on a slow clock so a pause shows within a minute. */
export function useConfig(): ConfigAccount | null {
  const tick = useNow(30_000);
  const [config, setConfig] = useState<ConfigAccount | null>(null);
  useEffect(() => {
    let live = true;
    getClient()
      .getConfig()
      .then((c) => live && setConfig(c));
    return () => {
      live = false;
    };
  }, [tick]);
  return config;
}

/*
  The config for a page whose signer agrees to it (the create page, 0.25):
  the latest read, the first read this page made, and a way to read again at
  once. The page compares the two to tell a creator when the terms moved
  while they were looking. `failed` is set while the latest read failed
  (2026-10-09); the last good config stays through a failed refresh, the
  launch list's rule, and the 30 s clock reads again.
*/
export function useConfigLive(): { config: ConfigAccount | null; first: ConfigAccount | null; failed: boolean; refresh: () => void } {
  const tick = useNow(30_000);
  const [bump, setBump] = useState(0);
  const [state, setState] = useState<{ config: ConfigAccount; first: ConfigAccount } | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    getClient()
      .getConfig()
      .then((c) => {
        if (!live) return;
        setState((s) => ({ config: c, first: s?.first ?? c }));
        setFailed(false);
      })
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
  }, [tick, bump]);
  const refresh = useCallback(() => setBump((n) => n + 1), []);
  return { config: state?.config ?? null, first: state?.first ?? null, failed, refresh };
}

export function useLaunches(): Launch[] | null {
  return useLaunchList().list;
}

/*
  The board, and whether the last read failed. A failed first read is not an
  empty board: public devnet refuses bursts (429), and "no launch exists" would
  then be false. The last good list stands through a failed refresh.

  24n (the founder's notes; review/2026-10-26-24n-PLAN.md fix 2): one board read per page, shared by every part that shows it
  (the home boards, the launch page's creator panel and copycat line), at the fastest cadence any of them asks for:
  every 3 s (plus or minus 0.5 s) on the home page, every 30 s elsewhere. One read at a time; a read is never
  overtaken by an older one. A hidden tab reads nothing and reads at once when shown again. A failed read is tried once
  more after 1 s; while there is no list yet the board says it tries every 30 seconds, and does.
*/
export const BOARD_LIVE_MS = 3_000;
export const BOARD_SLOW_MS = 30_000;
const BOARD_JITTER_MS = 500;
type BoardRead = { list: Launch[] | null; failed: boolean };
const NO_BOARD: BoardRead = { list: null, failed: false };
const boardStore = {
  state: NO_BOARD as BoardRead,
  listeners: new Set<() => void>(),
  wants: new Map<object, number>(),
  timer: null as ReturnType<typeof setTimeout> | null,
  retry: null as ReturnType<typeof setTimeout> | null,
  inflight: false,
  onShown: null as (() => void) | null,
};
const boardEmit = () => boardStore.listeners.forEach((fn) => fn());
const boardWait = () => {
  if (boardStore.state.list === null && boardStore.state.failed) return BOARD_SLOW_MS;
  const ms = Math.min(...boardStore.wants.values());
  return ms <= BOARD_LIVE_MS ? ms + (Math.random() * 2 - 1) * BOARD_JITTER_MS : ms;
};
function boardRead(again = true): void {
  if (boardStore.inflight || boardStore.wants.size === 0) return;
  boardStore.inflight = true;
  getClient()
    .listLaunches()
    .then(
      (list) => {
        boardStore.state = { list, failed: false };
        boardEmit();
      },
      () => {
        boardStore.state = { list: boardStore.state.list, failed: true };
        boardEmit();
        if (again && !boardStore.retry)
          boardStore.retry = setTimeout(() => {
            boardStore.retry = null;
            boardRead(false);
          }, 1_000);
      },
    )
    .finally(() => {
      boardStore.inflight = false;
    });
}
function boardSchedule(): void {
  if (boardStore.timer) clearTimeout(boardStore.timer);
  boardStore.timer = null;
  if (boardStore.wants.size === 0) return;
  boardStore.timer = setTimeout(() => {
    if (typeof document === "undefined" || !document.hidden) boardRead();
    boardSchedule();
  }, boardWait());
}
function boardSubscribe(intervalMs: number, fn: () => void): () => void {
  const me = {};
  const first = boardStore.wants.size === 0;
  const faster = !first && intervalMs < Math.min(...boardStore.wants.values());
  boardStore.wants.set(me, intervalMs);
  boardStore.listeners.add(fn);
  if (first) {
    boardRead();
    if (typeof document !== "undefined") {
      boardStore.onShown = () => {
        if (!document.hidden) boardRead();
      };
      document.addEventListener("visibilitychange", boardStore.onShown);
    }
  }
  if (first || faster) boardSchedule();
  return () => {
    boardStore.wants.delete(me);
    boardStore.listeners.delete(fn);
    if (boardStore.wants.size > 0) return;
    if (boardStore.timer) clearTimeout(boardStore.timer);
    if (boardStore.retry) clearTimeout(boardStore.retry);
    boardStore.timer = null;
    boardStore.retry = null;
    if (boardStore.onShown && typeof document !== "undefined") document.removeEventListener("visibilitychange", boardStore.onShown);
    boardStore.onShown = null;
  };
}
/* The poller and its last read, for scripts/check-24n-live.cjs. */
export const subscribeBoard = boardSubscribe;
export const peekBoard = (): BoardRead => boardStore.state;
export function useLaunchList(intervalMs: number = BOARD_SLOW_MS): BoardRead {
  const subscribe = useCallback((cb: () => void) => boardSubscribe(intervalMs, cb), [intervalMs]);
  const getSnapshot = useCallback(() => boardStore.state, []);
  const getServerSnapshot = useCallback(() => NO_BOARD, []);
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

/*
  The funding graph for a settled launch's winners, once the page knows them
  (null waits; the 0.28 triage's F6). A failed walk ends the wait with
  `failed` and is tried again every 20 s (F14); the last report for the same
  winners stays meanwhile.
*/
export function useFundingReport(id: string, bidders: readonly string[] | null): { report: FundingReport | null; loading: boolean; failed: boolean } {
  const key = bidders ? `${id}:${[...bidders].sort().join(",")}` : null;
  const [s, setS] = useState<{ key: string; report: FundingReport | null; failed: boolean }>({ key: "", report: null, failed: false });
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (key === null) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const list = key.slice(id.length + 1).split(",").filter(Boolean);
    getClient()
      .getFundingReport(id, list)
      .then(
        (report) => {
          if (live) setS({ key, report, failed: false });
        },
        () => {
          if (!live) return;
          setS((prev) => ({ key, report: prev.key === key ? prev.report : null, failed: true }));
          timer = setTimeout(() => live && setRetry((n) => n + 1), 20_000);
        },
      );
    return () => {
      live = false;
      if (timer) clearTimeout(timer);
    };
  }, [id, key, retry]);
  const mine = key !== null && s.key === key;
  return { report: mine ? s.report : null, loading: !mine, failed: mine && s.failed };
}

/* The creator wallet's age (the founder, 2026-10-20, the launch page's creator panel): one read per creator per session, through the site's cached route. A failed read says so and is tried again every 60 s. */
export function useCreatorAge(id: string, creator: string | null): { age: WalletAge | null; failed: boolean } {
  const [s, setS] = useState<{ key: string; age: WalletAge | null; failed: boolean }>({ key: "", age: null, failed: false });
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (!creator) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    getClient()
      .getCreatorAge(id, creator)
      .then(
        (age) => {
          if (live) setS({ key: creator, age, failed: false });
        },
        () => {
          if (!live) return;
          setS({ key: creator, age: null, failed: true });
          timer = setTimeout(() => live && setRetry((n) => n + 1), 60_000);
        },
      );
    return () => {
      live = false;
      if (timer) clearTimeout(timer);
    };
  }, [id, creator, retry]);
  const mine = creator !== null && s.key === creator;
  return { age: mine ? s.age : null, failed: mine && s.failed };
}

/* 0.29: a settled launch's histogram (its own account), for the settlement page's figures and self check. Null until read or when it cannot be; read once a record exists. */
export function useHistogram(id: string, settled: boolean): readonly bigint[] | null {
  const [s, setS] = useState<{ id: string; counts: readonly bigint[] | null }>({ id: "", counts: null });
  useEffect(() => {
    if (!settled) return;
    let live = true;
    getClient()
      .getHistogram(id)
      .then(
        (h) => live && setS({ id, counts: h ? h.counts : null }),
        () => {},
      );
    return () => {
      live = false;
    };
  }, [id, settled]);
  return s.id === id ? s.counts : null;
}

/* Every pinned event on a launch, oldest first. Re-read when the version changes (state, counts). The previous list stays up while the next read runs. */
export function useLaunchEvents(id: string, version: string): DecodedEvent[] | null {
  return useLaunchEventsRead(id, version).events;
}

/*
  The events plus why a read came back short. A refused read is not the same
  fact as history the RPC no longer keeps: "limited" is the RPC turning
  requests away (HTTP 429), "failed" any other refusal, and either one is
  retried every 20 seconds. "ok" means the read succeeded, so anything still
  missing is history this RPC does not serve.
*/
export type EventsRead = "loading" | "ok" | "limited" | "failed";

/*
  A launch's whole history is one request per eight transactions on a keyed
  RPC and one per transaction, a second apart, on the public devnet one, so
  the first read of a busy launch takes from seconds to many minutes. While
  it runs the hook hands out what has been read so far (newest transactions
  first, so the payouts come early) with read "loading" and the progress.
  A transaction the node listed and did not return is asked for again, three
  times at most.
*/
export function useLaunchEventsRead(id: string, version: string): { events: DecodedEvent[] | null; read: EventsRead; progress: HistoryProgress | null } {
  const [s, setS] = useState<{ key: string; events: DecodedEvent[]; read: EventsRead } | null>(null);
  const [progress, setProgress] = useState<HistoryProgress | null>(null);
  const [retry, setRetry] = useState(0);
  const key = `${id}:${version}`;
  useEffect(() => {
    let live = true;
    let done = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const client = getClient();
    const started = Date.now();
    let shown = 0;
    const peek = () => {
      if (!live || done) return;
      const p = client.historyProgress(id);
      setProgress(p);
      /* The count moves at every look; the rows are handed over every 2.5 seconds for the first half minute (the payouts are read first) and every 15 seconds after. A table of a thousand rows redrawn at every look made the read of launch F take 300 seconds in the page instead of 82 (2026-10-02; the table is memoised as well). */
      const every = Date.now() - started < 30_000 ? 2_500 : 15_000;
      if (p && p.total > 0 && p.read < p.total && Date.now() - shown >= every - 100) {
        shown = Date.now();
        const events = client.peekEvents(id);
        setS((prev) => (prev && prev.read === "ok" && prev.events.length >= events.length ? prev : { key, events, read: "loading" }));
      }
    };
    const ticker = setInterval(peek, 2_500);
    client
      .getEvents(id)
      .then((events) => {
        done = true;
        if (!live) return;
        const p = client.historyProgress(id);
        setProgress(p);
        setS({ key, events, read: "ok" });
        if (p && p.missing > 0 && retry < 3) timer = setTimeout(() => live && setRetry((n) => n + 1), 20_000);
      })
      .catch((e) => {
        done = true;
        if (!live) return;
        const limited = /429|too many requests/i.test(String((e as Error)?.message ?? e));
        /* What the read had found before it was refused stays on the page; the retry resumes from there. */
        setS({ key, events: client.peekEvents(id), read: limited ? "limited" : "failed" });
        setProgress(client.historyProgress(id));
        timer = setTimeout(() => live && setRetry((n) => n + 1), 20_000);
      });
    return () => {
      live = false;
      clearInterval(ticker);
      if (timer) clearTimeout(timer);
    };
  }, [id, key, retry]);
  return s ? { events: s.events, read: s.read, progress } : { events: null, read: "loading", progress };
}

/*
  The events of one wallet's own bid on a launch, from the bid account's few
  transactions: a bidder's outcome does not wait for the launch's whole
  history. Null until read; re-read when the version changes, the last list
  for this launch and wallet staying up meanwhile, never another wallet's
  (F14). `failed` while the latest read failed; it is tried again every 20 s.
*/
export function useBidEventsRead(id: string, bidder: string | null, version: string): { events: DecodedEvent[] | null; failed: boolean; retry: () => void } {
  const owner = `${id}:${bidder ?? ""}`;
  const key = `${owner}:${version}`;
  const [s, setS] = useState<{ owner: string; events: DecodedEvent[] | null; failed: boolean } | null>(null);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (!bidder) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    getClient()
      .getBidEvents(id, bidder)
      .then((events) => live && setS({ owner, events, failed: false }))
      .catch(() => {
        if (!live) return;
        setS((prev) => ({ owner, events: prev && prev.owner === owner ? prev.events : null, failed: true }));
        timer = setTimeout(() => live && setRetry((n) => n + 1), READ_RETRY_MS);
      });
    return () => {
      live = false;
      if (timer) clearTimeout(timer);
    };
  }, [id, bidder, owner, key, retry]);
  const own = bidder && s && s.owner === owner ? s : null;
  const again = useCallback(() => setRetry((n) => n + 1), []);
  return { events: own ? own.events : null, failed: !!own && own.failed, retry: again };
}

export function useBidEvents(id: string, bidder: string | null, version: string): DecodedEvent[] | null {
  return useBidEventsRead(id, bidder, version).events;
}

/* Rent for an account of this many bytes, read from the cluster once. Null until read; a failed read is tried again every 20 s (9A: the recover button waits on it). */
export function useRent(bytes: number): bigint | null {
  const [rent, setRent] = useState<bigint | null>(null);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    getClient()
      .getRent(bytes)
      .then((r) => live && setRent(r))
      .catch(() => {
        if (live) timer = setTimeout(() => live && setRetry((n) => n + 1), READ_RETRY_MS);
      });
    return () => {
      live = false;
      if (timer) clearTimeout(timer);
    };
  }, [bytes, retry]);
  return rent;
}

/* 0.29, the ninth candidate: whether the live pool's mint still has its authority (finish_mint due). Read when the launch is pool live, again on `key`; null otherwise. */
export function useMintAuthorityHeld(launchId: string, live: boolean, key: string): boolean | null {
  const [held, setHeld] = useState<{ key: string; value: boolean | null } | null>(null);
  useEffect(() => {
    if (!live) return;
    let on = true;
    getClient()
      .mintAuthorityHeld(launchId, true)
      .then((v) => on && setHeld({ key, value: v }))
      .catch(() => {});
    return () => {
      on = false;
    };
  }, [launchId, live, key]);
  return live && held && held.key === key ? held.value : null;
}

/* 0.29: the launch cost genesis leaves on chain for good (product.ts, setupCost), from this cluster's rent. Null until the three rents are read. */
export function useSetupCost(): SetupCost | null {
  const histogram = useRent(SETUP_ACCOUNT_BYTES.histogram);
  const launch = useRent(SETUP_ACCOUNT_BYTES.launch);
  const vault = useRent(SETUP_ACCOUNT_BYTES.vault);
  return histogram !== null && launch !== null && vault !== null ? setupCost({ histogram, launch, vault }) : null;
}

/*
  The least the bid field takes for a launch with this minimum bid, which is
  what every page shows as "Minimum bid" (the founder, 2026-10-08: users only ever
  see the amount they send): the minimum bid plus the costs that come out of
  it, with the bid account's rent read from the cluster: a flat 0.02 SOL on a
  launch made under the 22e3 Config (product.ts, leastSent). Null until the rent is read.
*/
export function useLeastSent(minBid: bigint | null, terms: BidTerms | null): bigint | null {
  const bidRent = useRent(ACCOUNTS.Bid.len);
  return minBid !== null && terms !== null && bidRent !== null ? leastSent(minBid, bidCosts(bidRent, terms)) : null;
}

/*
  24g (the founder's cost line, 2026-10-25): the priority price the site sends with a bid in the auction's last
  FINAL_WINDOW_SECS, from the launch's shared send context (app/api/launch/[id]/send, kept a second at the CDN), read
  every 2 s from 10 s before that window until the close. 0 outside it, while unread, on a read that fails, and on a
  page that does not read through the site (the local board): the bid then carries no priority fee, as chainClient's
  commit does without the route.
*/
export function useFinalPrice(launchId: string | null, closeTs: number | null, nowSec: number | null): number {
  const [price, setPrice] = useState(0);
  const near = launchId !== null && closeTs !== null && nowSec !== null && closeTs - nowSec <= FINAL_WINDOW_SECS + 10 && closeTs - nowSec > 0;
  useEffect(() => {
    if (!near || !SITE_ROUTES || launchId === null) return;
    let live = true;
    const read = () =>
      fetchWithBackoff(`/api/launch/${launchId}/send`, { cache: "no-store" })
        .then((r) => (r.ok ? r.json() : null))
        .then((j: { priorityMicroLamports?: unknown } | null) => {
          if (live) setPrice(j && typeof j.priorityMicroLamports === "number" ? j.priorityMicroLamports : 0);
        })
        .catch(() => {
          if (live) setPrice(0);
        });
    void read();
    const t = setInterval(read, 2_000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [near, launchId]);
  return near && SITE_ROUTES && closeTs !== null && nowSec !== null ? boundedPrice(price, closeTs - nowSec) : 0;
}
