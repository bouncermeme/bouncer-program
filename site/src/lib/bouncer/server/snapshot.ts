/*
  The shared reads behind the site's launch endpoints (2026-10-15, the launch
  data path's Phase C): one launch's accounts, its bid list, and the Config,
  read from the server's RPC once per cache period for everyone instead of
  by every visitor's browser. The endpoints (app/api/launch/[id], .../bids,
  app/api/config) put these behind Vercel's CDN; this module reads the chain,
  combines simultaneous misses in one instance into one read, and keeps the
  last answer for a moment. Accounts travel as their bytes, so the browser
  decodes them with the same code it decodes an RPC answer with, and the
  full cache can serve the same shape later from its store.

  Nothing here is used to build a transaction: the signer reads fresh.
*/
import { PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import { ACCOUNTS } from "@contract/constants";
import { decodeLaunch, decodeRecord } from "../chain/decode";
import { configPda, histogramPda, PROGRAM, settlementPda } from "../chain/pda";
import { getConnection, setServerFetch } from "../chain/rpc";
import type { LaunchAccount, LaunchState } from "../types";
import { meteredFetch, staleOr } from "./budget";
import { isLaunch, knownLaunches, OutOfScope } from "./scope";

/* Every read this server makes to the keyed endpoint is charged to the day (server/budget.ts); a check's setConnection still wins. */
setServerFetch(meteredFetch);

/* An account as the endpoint hands it over: its bytes in base64. */
export interface AccountBytes {
  address: string;
  lamports: number;
  data: string;
}

export interface LaunchSnapshot {
  id: string;
  /* The slot the accounts were read at, and when, by the server's clock. */
  slot: number;
  /* 24n: the slot of the read that brought the launch account itself (slot can be a later read's, of the pool or mint). */
  launchSlot?: number;
  readAt: number;
  launch: AccountBytes | null;
  record: AccountBytes | null;
  config: AccountBytes | null;
  /* The trading pool the record names, once there is one. */
  pool: AccountBytes | null;
  /* 24d: the token mint while finish_mint can still be due (pool live or finalized, the mint not finished), for the drive panel's check; the signer reads it fresh. */
  mint?: AccountBytes | null;
  state: LaunchState | null;
  /* A final launch never changes again: the endpoints cache it for long. */
  final: boolean;
  /* Where the answer came from: the chain, or what this instance last read when the day's budget is spent (server/budget.ts). */
  source: "chain" | "stale";
}

export interface BidsSnapshot {
  id: string;
  /* The slot the bid list itself was read at: its own getProgramAccounts context (2026-10-16, GPT-6's D). */
  slot: number;
  /* The slot of the launch read beside it. Two reads, not one: a bid can close between them, so neither slot pins the other. */
  launchSlot: number;
  readAt: number;
  bids: AccountBytes[];
  state: LaunchState | null;
  final: boolean;
  source: "chain" | "stale";
  /* The route's page (bidPages.ts): the address to continue after, null on the last page, and the list's whole length. Absent on the server's own whole-list read. */
  next?: string | null;
  total?: number;
}

/*
  Finalized only (2026-10-16, GPT-6's A3). A failed or aborted launch still
  moves: refunds close its bids one by one and finalize moves its state, so
  its snapshot and bid list stay on the live period until then. v0.32: so
  does a finalized launch with a payout parked (Launch.parked_count): its
  collect or push closes a bid and changes the launch, and was served from
  the final period's caches for up to half an hour (the final E2E's S2).
*/
const FINAL: ReadonlySet<LaunchState> = new Set(["finalized"]);
export const isFinal = (launch: Pick<LaunchAccount, "state" | "parkedCount"> | null): boolean => launch !== null && FINAL.has(launch.state) && !launch.parkedCount;
/* How long one instance keeps an answer before reading again, under the CDN's own period. 24n: 1 s (was 2 s), so a page polling every 2 s sees every read. */
export const KEEP_MS = 1_000;
/* 24n (plan fix 4): the bid accounts are scanned again only when the launch account moved since the last scan, and at most this often. */
export const BID_SCAN_MIN_MS = 2_000;
/* ... and a held list is scanned again after this long whatever the launch did (a backstop: one scan a launch per 30 s while someone looks). */
export const BID_HELD_MAX_MS = 30_000;

const bytes = (address: PublicKey, info: { lamports: number; data: Uint8Array | Buffer } | null): AccountBytes | null => (info ? { address: address.toBase58(), lamports: info.lamports, data: Buffer.from(info.data).toString("base64") } : null);

export function isPubkey(s: string): boolean {
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s)) return false;
  try {
    return bs58.decode(s).length === 32;
  } catch {
    return false;
  }
}

/* One read in flight per key, and the last answer for KEEP_MS. */
function once<T>(store: Map<string, { at: number; value: Promise<T> }>, key: string, read: () => Promise<T>): Promise<T> {
  const hit = store.get(key);
  if (hit && Date.now() - hit.at < KEEP_MS) return hit.value;
  const value = read();
  store.set(key, { at: Date.now(), value });
  value.catch(() => {
    if (store.get(key)?.value === value) store.delete(key);
  });
  return value;
}

const snapshots = new Map<string, { at: number; value: Promise<LaunchSnapshot> }>();
const bidLists = new Map<string, { at: number; value: Promise<BidsSnapshot> }>();
export interface ConfigSnapshot {
  config: AccountBytes | null;
  slot: number;
  readAt: number;
  source: "chain" | "stale";
}
const configs = new Map<string, { at: number; value: Promise<ConfigSnapshot> }>();

/* Bouncer data only (server/scope.ts): an id that is not one of the program's launches is refused before any read. The endpoints check first with the request's hints; this is the backstop for every path. */
async function requireLaunch(id: string): Promise<void> {
  if (!(await isLaunch(id))) throw new OutOfScope();
}

export function readSnapshot(id: string): Promise<LaunchSnapshot> {
  return staleOr(`snapshot:${id}`, () => once(snapshots, id, async () => {
    await requireLaunch(id);
    const key = new PublicKey(id);
    const conn = getConnection();
    const recordKey = settlementPda(key);
    const configKey = configPda();
    const first = await conn.getMultipleAccountsInfoAndContext([key, recordKey, configKey], "confirmed");
    const [launchInfo, recordInfo, configInfo] = first.value;
    const owned = launchInfo && launchInfo.owner.equals(PROGRAM) ? launchInfo : null;
    const launch = owned ? decodeLaunch(id, Uint8Array.from(owned.data)) : null;
    const record = recordInfo ? decodeRecord(recordKey.toBase58(), Uint8Array.from(recordInfo.data)) : null;
    let pool: AccountBytes | null = null;
    let mint: AccountBytes | null = null;
    let slot = first.context.slot;
    const poolKey = record && record.pool && record.pool !== PublicKey.default.toBase58() ? new PublicKey(record.pool) : null;
    const mintKey = launch && (launch.state === "poolLive" || launch.state === "finalized") && !launch.mintFinished ? new PublicKey(launch.tokenMint) : null;
    const second = [poolKey, mintKey].filter((k): k is PublicKey => k !== null);
    if (second.length) {
      const r = await conn.getMultipleAccountsInfoAndContext(second, "confirmed");
      if (poolKey) pool = bytes(poolKey, r.value[0]);
      if (mintKey) mint = bytes(mintKey, r.value[poolKey ? 1 : 0]);
      slot = Math.max(slot, r.context.slot);
    }
    const state = launch?.state ?? null;
    return { id, slot, launchSlot: first.context.slot, readAt: Date.now(), launch: bytes(key, owned), record: bytes(recordKey, recordInfo), config: bytes(configKey, configInfo), pool, mint, state, final: isFinal(launch), source: "chain" as const };
  }), (s) => s.launch !== null);
}

/*
  24n (plan fix 4): the bid list this instance last scanned, by launch, with the launch account's bytes it was scanned
  beside. Every write to a bid account (commit, reveal, refund, claim, delivery) also writes the launch account, so a
  launch whose bytes have not moved has the same bid accounts: the held list is served and no scan (10 credits) runs.
  A launch that moved is scanned again, at most every BID_SCAN_MIN_MS; in between the held list is served, and its
  launchSlot says how old it is (the browser reads again when that is older than its own copy of the launch).
*/
const heldBids = new Map<string, { launch: string; at: number; list: BidsSnapshot }>();

export function readBids(id: string): Promise<BidsSnapshot> {
  return staleOr(`bids:${id}`, () => once(bidLists, id, async () => {
    await requireLaunch(id);
    const key = new PublicKey(id);
    const snapshot = await readSnapshot(id);
    const launchBytes = snapshot.launch?.data ?? "";
    const held = heldBids.get(id);
    const age = held ? Date.now() - held.at : Infinity;
    if (held && snapshot.source === "chain" && ((held.launch === launchBytes && age < BID_HELD_MAX_MS) || age < BID_SCAN_MIN_MS)) return { ...held.list, readAt: Date.now(), state: held.launch === launchBytes ? snapshot.state : held.list.state, final: held.launch === launchBytes ? snapshot.final : held.list.final };
    const accounts = await getConnection().getProgramAccounts(PROGRAM, {
      commitment: "confirmed",
      filters: [{ dataSize: ACCOUNTS.Bid.len }, { memcmp: { offset: ACCOUNTS.Bid.fields.launch.offset, bytes: key.toBase58() } }],
      withContext: true,
    });
    /* Built on a stale snapshot, the list is stale too, whatever its own read was. */
    const list: BidsSnapshot = { id, slot: accounts.context.slot, launchSlot: snapshot.launchSlot ?? snapshot.slot, readAt: Date.now(), bids: accounts.value.map((a) => bytes(a.pubkey, a.account)!), state: snapshot.state, final: snapshot.final, source: snapshot.source };
    if (snapshot.source === "chain") heldBids.set(id, { launch: launchBytes, at: Date.now(), list });
    return list;
  }), (b) => b.state !== null);
}

/* 24n (plan fix 4): the newest `count` bid accounts by placed_ts (ties by address), for the deposit feed. */
export const RECENT_MAX = 20;
export function recentOf(bids: AccountBytes[], count: number): AccountBytes[] {
  const placed = (a: AccountBytes) => {
    const d = Buffer.from(a.data, "base64");
    const at = ACCOUNTS.Bid.fields.placed_ts.offset;
    return d.length >= at + 8 ? d.readBigInt64LE(at) : 0n;
  };
  return bids
    .map((a) => ({ a, t: placed(a) }))
    .sort((x, y) => (x.t === y.t ? (x.a.address < y.a.address ? -1 : 1) : x.t > y.t ? -1 : 1))
    .slice(0, Math.max(0, Math.min(RECENT_MAX, count)))
    .map((x) => x.a);
}

export function readConfig(): Promise<ConfigSnapshot> {
  return staleOr("config", () => once(configs, "config", async () => {
    const key = configPda();
    const r = await getConnection().getAccountInfoAndContext(key, "confirmed");
    return { config: bytes(key, r.value), slot: r.context.slot, readAt: Date.now(), source: "chain" as const };
  }));
}

/*
  The board (24d, the founder: "everything that people will be looking at that updates live should be cached"): every
  launch and its settlement record, as bytes, for the home page's cards and the launch page's creator panel, which
  each browser used to read from the RPC itself every 30 s. The keys come from scope.ts's scan (at most once per
  15 s an instance); a finalized launch never changes again, so this instance keeps it and reads only the others,
  one getMultipleAccounts per BOARD_PAGE launches. "live" carries the launches not finalized and the finalized ids;
  "final" the finalized launches' bytes (the browser asks for them when it meets an id it does not hold as final).
*/
export interface BoardEntry {
  launch: AccountBytes;
  record: AccountBytes | null;
  /* 24n: the slot of the read that brought this entry (the board's own slot is the latest of its pages). */
  slot?: number;
}
export interface BoardSnapshot {
  slot: number;
  readAt: number;
  live: BoardEntry[];
  finals: string[];
  source: "chain" | "stale";
}
const BOARD_PAGE = 50;
const finalBoard = new Map<string, BoardEntry>();
const boards = new Map<string, { at: number; value: Promise<BoardSnapshot> }>();

export function readBoard(): Promise<BoardSnapshot> {
  return staleOr("board", () => once(boards, "board", async () => {
    const ids = await knownLaunches();
    const todo = ids.filter((id) => !finalBoard.has(id)).map((id) => new PublicKey(id));
    const conn = getConnection();
    const live: BoardEntry[] = [];
    let slot = 0;
    for (let i = 0; i < todo.length; i += BOARD_PAGE) {
      const page = todo.slice(i, i + BOARD_PAGE);
      const records = page.map((k) => settlementPda(k));
      const r = await conn.getMultipleAccountsInfoAndContext([...page, ...records], "confirmed");
      slot = Math.max(slot, r.context.slot);
      page.forEach((key, k) => {
        const info = r.value[k];
        if (!info || !info.owner.equals(PROGRAM)) return;
        const entry = { launch: bytes(key, info)!, record: bytes(records[k], r.value[page.length + k]), slot: r.context.slot };
        if (isFinal(decodeLaunch(key.toBase58(), Uint8Array.from(info.data)))) finalBoard.set(key.toBase58(), entry);
        else live.push(entry);
      });
    }
    return { slot, readAt: Date.now(), live, finals: [...finalBoard.keys()], source: "chain" as const };
  }));
}

/*
  The board's pools (24d): every trading pool a board record names, as bytes, for the home cards' market caps,
  which each browser read from the RPC itself on every visit. Pools trade after a launch is final, so they are read
  every period, one getMultipleAccounts per 100.
*/
export interface PoolsSnapshot {
  slot: number;
  readAt: number;
  pools: AccountBytes[];
  source: "chain" | "stale";
}
const POOL_PAGE = 100;
const poolSets = new Map<string, { at: number; value: Promise<PoolsSnapshot> }>();

export function readBoardPools(): Promise<PoolsSnapshot> {
  return staleOr("board-pools", () => once(poolSets, "pools", async () => {
    const b = await readBoard();
    const entries = [...b.live, ...b.finals.map((id) => finalBoard.get(id)).filter((e): e is BoardEntry => !!e)];
    const keys: PublicKey[] = [];
    for (const e of entries) {
      const r = e.record ? decodeRecord(e.record.address, Buffer.from(e.record.data, "base64")) : null;
      if (r && r.pool && r.pool !== PublicKey.default.toBase58()) keys.push(new PublicKey(r.pool));
    }
    const conn = getConnection();
    const pools: AccountBytes[] = [];
    let slot = 0;
    for (let i = 0; i < keys.length; i += POOL_PAGE) {
      const page = keys.slice(i, i + POOL_PAGE);
      const r = await conn.getMultipleAccountsInfoAndContext(page, "confirmed");
      slot = Math.max(slot, r.context.slot);
      page.forEach((k, j) => {
        const a = bytes(k, r.value[j]);
        if (a) pools.push(a);
      });
    }
    return { slot, readAt: Date.now(), pools, source: b.source };
  }));
}

/* The finalized launches' bytes (read by readBoard; this instance's copy is complete once a board read has run). */
export async function readFinalBoard(): Promise<{ launches: BoardEntry[]; source: "chain" | "stale" }> {
  const b = await readBoard();
  return { launches: b.finals.map((id) => finalBoard.get(id)).filter((e): e is BoardEntry => !!e), source: b.source };
}

/*
  A launch's histogram (24d, the caching directive: the settlement page's clearing figures), 19,272 bytes, read with
  the launch in one call. Nothing writes it after settle, so a settled launch's answer is kept at the CDN for an hour.
*/
export interface HistogramSnapshot {
  id: string;
  slot: number;
  readAt: number;
  histogram: AccountBytes | null;
  settled: boolean;
  source: "chain" | "stale";
}
const histograms = new Map<string, { at: number; value: Promise<HistogramSnapshot> }>();

export function readHistogram(id: string): Promise<HistogramSnapshot> {
  return staleOr(`histogram:${id}`, () => once(histograms, id, async () => {
    await requireLaunch(id);
    const key = new PublicKey(id);
    const hKey = histogramPda(key);
    const r = await getConnection().getMultipleAccountsInfoAndContext([key, hKey], "confirmed");
    const [launchInfo, hInfo] = r.value;
    const launch = launchInfo && launchInfo.owner.equals(PROGRAM) ? decodeLaunch(id, Uint8Array.from(launchInfo.data)) : null;
    const owned = hInfo && hInfo.owner.equals(PROGRAM) ? hInfo : null;
    return { id, slot: r.context.slot, readAt: Date.now(), histogram: bytes(hKey, owned), settled: !!launch?.settled, source: "chain" as const };
  }));
}

/* Whether the server has an RPC to read from: the endpoints answer 404 without one, as the RPC route does. */
export function serverHasRpc(): boolean {
  return Boolean(process.env.RPC_UPSTREAM || process.env.BOARD_RPC_UPSTREAM);
}
