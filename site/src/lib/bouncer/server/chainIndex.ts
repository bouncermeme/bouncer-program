/*
  Every launch and settlement record, read from the server's RPC for the whole site (22e3; 23c for the copycat rules,
  review/2026-10-24-23c-morning/DESIGN.md section 5). /stats totals them and the ticker rules (server/tickerHolds.ts)
  look a ticker up in them. Nothing here is used to build a transaction.

  23c:
  - Finalized commitment, both reads with their context slots, and the block time of the older one (getBlockTime),
    so a release can be judged against a permit's expiry on the chain's own clock.
  - Every Launch account by its discriminator, not only the current size: an account of another size is read at a
    known older layout's offsets (devnet's 0.28 launches, 9568 bytes) or counted as unreadable, so a launch can never
    drop out of the index because its size changed. The ticker is read from symbol_len/symbol whatever the name is
    (an empty name hid it before).
  - A record's pool (SettlementRecord.pool, written with PoolLive by create_pool) is the funding evidence; a record
    alone is not (settle, then abort).
  - Never backward: an instance refuses a read older than one it already used, and the fleet's watermark in the store
    refuses one more than WATERMARK_SLOTS behind the newest any instance saw (a lagging node after a failover).
  - Coalesced: one read per instance a minute (simultaneous misses share it), at most FLEET_READS_PER_MIN fresh reads a
    minute across the fleet (a store count), and a failed read remembered for FAIL_BACKOFF_MS.
  When the day's read budget is spent the last index is served as "stale" (server/budget.ts staleOr) for /stats; the
  ticker rules take only a "chain" index younger than TICKER_FRESH_MS (fail closed).
*/
import { PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import { ACCOUNTS } from "@contract/constants";
import { CLUSTER } from "@contract/active";
import { decodeLaunch, decodeRecord } from "../chain/decode";
import { PROGRAM } from "../chain/pda";
import { getConnection } from "../chain/rpc";
import { isMainnet } from "../siteCluster";
import { tickerKey } from "../tickerKey";
import { LAUNCH_STATE_BY_BYTE, type LaunchState } from "../types";
import { staleOr } from "./budget";
import { kvFromEnv, kvKey, type Kv } from "./kv";
import { serverHasRpc } from "./snapshot";

export interface IndexedLaunch {
  address: string;
  state: LaunchState;
  creator: string;
  /* The ticker as created (read whatever the name is), or null when the account carries none (a 0.18 launch). */
  symbol: string | null;
  /* The copycat key (tickerKey.ts), or null without a ticker. */
  key: string | null;
  openTs: number;
  windowSecs: number;
  closeTs: number;
  abortAfterSecs: number;
  totalDeposits: bigint;
  bidCount: number;
  /* "legacy": an older layout read at its own offsets (devnet); its money fields read 0. */
  layout: "current" | "legacy";
  /* v0.30: Launch.trading_state (1: the pool frozen while everyone is paid); 0 on a legacy layout. P-T2's refusal line. */
  tradingState?: number;
}

export interface IndexedRecord {
  launch: string;
  floatValue: bigint;
  winningDeposits: bigint;
  /* 24c (fresh L7): deposits above the marginal tick (filled in full) and at it (rationed); the rest of the book lost. */
  aboveDeposits: bigint;
  atDeposits: bigint;
  poolSolAtOpen: bigint;
  raiseFeeCreator: bigint;
  raiseFeePlatform: bigint;
  /* create_pool wrote the pool: the launch is funded. */
  funded: boolean;
}

export interface ChainIndex {
  /* The older of the two reads' context slots, at finalized commitment. */
  slot: number;
  /* That slot's block time (unix seconds), or null when the RPC did not give it. */
  blockTime: number | null;
  readAt: number;
  launches: IndexedLaunch[];
  /* By launch address. */
  records: Map<string, IndexedRecord>;
  source: "chain" | "stale";
  /* Launch accounts whose ticker could not be read: an unknown size, or an older layout without a ticker. */
  unreadable: number;
}

export const INDEX_TTL_MS = 60_000;
export const TICKER_FRESH_MS = 120_000;
export const FAIL_BACKOFF_MS = 30_000;
export const FLEET_READS_PER_MIN = 6;
export const WATERMARK_SLOTS = 300;

/* Older Launch layouts by size, at their own offsets (contract/constants.json history: 0.28 at 824866a). */
export const LEGACY_LAYOUTS: Readonly<Record<number, { nameLen: number; symbolLen: number; symbol: number }>> = {
  9568: { nameLen: 8552, symbolLen: 8553, symbol: 8592 },
};

export class IndexUnavailable extends Error {
  constructor(readonly why: string) {
    super(`index ${why}`);
    this.name = "IndexUnavailable";
  }
}
export const isIndexUnavailable = (e: unknown): boolean => e instanceof IndexUnavailable || (e instanceof Error && e.name === "IndexUnavailable");

const LAUNCH_DISC = bs58.encode(Uint8Array.from(ACCOUNTS.Launch.discriminator));
/* 24d (24b I2): records are scanned by their size and their discriminator, so no other account of that size is sent. */
const RECORD_DISC = bs58.encode(Uint8Array.from(ACCOUNTS.SettlementRecord.discriminator));
const rd64 = (d: Uint8Array, at: number): number => Number(new DataView(d.buffer, d.byteOffset, d.byteLength).getBigInt64(at, true));
const ALNUM = /^[A-Za-z0-9]{1,10}$/;

/* The ticker at a layout's offsets: a length of at most 10 and A-Z or 0-9 only, else null. */
export function tickerAt(data: Uint8Array, symbolLen: number, symbol: number): string | null {
  if (data.length < symbol + 10) return null;
  const len = data[symbolLen];
  if (len < 1 || len > 10) return null;
  const s = new TextDecoder().decode(data.subarray(symbol, symbol + len));
  return ALNUM.test(s) ? s : null;
}

/* One Launch account of any size: the indexed launch, or null when its ticker cannot be read (counted as unreadable). */
export function indexLaunch(address: string, data: Uint8Array): IndexedLaunch | null {
  if (data.length === ACCOUNTS.Launch.len) {
    const a = decodeLaunch(address, data);
    if (!a) return null;
    const f = ACCOUNTS.Launch.fields;
    const symbol = tickerAt(data, f.symbol_len.offset, f.symbol.offset);
    return { address, state: a.state, creator: a.creator, symbol, key: symbol ? tickerKey(symbol) : null, openTs: a.openTs, windowSecs: a.windowSecs, closeTs: a.closeTs, abortAfterSecs: a.abortAfterSecs, totalDeposits: a.totalDeposits, bidCount: a.bidCount, layout: "current", tradingState: a.tradingState ?? 0 };
  }
  const legacy = LEGACY_LAYOUTS[data.length];
  if (!legacy) return null;
  const symbol = tickerAt(data, legacy.symbolLen, legacy.symbol);
  const state = LAUNCH_STATE_BY_BYTE[data[10]];
  if (!symbol || !state) return null;
  return { address, state, creator: new PublicKey(data.subarray(16, 48)).toBase58(), symbol, key: tickerKey(symbol), openTs: rd64(data, 136), windowSecs: rd64(data, 144), closeTs: rd64(data, 152), abortAfterSecs: 0, totalDeposits: 0n, bidCount: 0, layout: "legacy" };
}

/* What the index needs from an RPC connection (web3.js Connection; a fake in the checks). */
export interface IndexConn {
  getProgramAccounts(program: PublicKey, config: object): Promise<unknown>;
  getBlockTime(slot: number): Promise<number | null>;
}

type Gpa = { context: { slot: number }; value: { pubkey: PublicKey; account: { data: Uint8Array } }[] };

/* One read of the whole index from a connection, at finalized commitment. */
export async function readIndexFrom(conn: IndexConn, now: () => number = Date.now): Promise<ChainIndex> {
  const [launches, records] = (await Promise.all([
    conn.getProgramAccounts(PROGRAM, { commitment: "finalized", filters: [{ memcmp: { offset: 0, bytes: LAUNCH_DISC } }], withContext: true }),
    conn.getProgramAccounts(PROGRAM, { commitment: "finalized", filters: [{ dataSize: ACCOUNTS.SettlementRecord.len }, { memcmp: { offset: 0, bytes: RECORD_DISC } }], withContext: true }),
  ])) as [Gpa, Gpa];
  const out: IndexedLaunch[] = [];
  let unreadable = 0;
  for (const { pubkey, account } of launches.value) {
    const l = indexLaunch(pubkey.toBase58(), account.data);
    if (l) out.push(l);
    else unreadable += 1;
  }
  const recs = new Map<string, IndexedRecord>();
  for (const { pubkey, account } of records.value) {
    const r = decodeRecord(pubkey.toBase58(), account.data);
    if (!r) continue;
    recs.set(r.launch, { launch: r.launch, floatValue: r.floatValue, winningDeposits: r.winningDeposits, aboveDeposits: r.aboveDeposits, atDeposits: r.atDeposits, poolSolAtOpen: r.poolSolAtOpen, raiseFeeCreator: r.raiseFeeCreator, raiseFeePlatform: r.raiseFeePlatform, funded: r.pool !== null });
  }
  const slot = Math.min(launches.context.slot, records.context.slot);
  let blockTime: number | null = null;
  try {
    const t = await conn.getBlockTime(slot);
    blockTime = typeof t === "number" && Number.isFinite(t) ? t : null;
  } catch {
    blockTime = null;
  }
  return { slot, blockTime, readAt: now(), launches: out, records: recs, source: "chain", unreadable };
}

/* The fleet's side: a count of fresh reads per minute, and the newest slot any instance used. Null when unanswered. */
export interface IndexFleet {
  countRead(minute: string): Promise<number | null>;
  watermark(slot: number): Promise<number | null>;
}
export function fleetOf(kv: Kv | null): IndexFleet | null {
  if (!kv) return null;
  return {
    async countRead(minute) {
      try {
        const n = Number(await kv(["EVAL", "local n = redis.call('INCR', KEYS[1]); if n == 1 then redis.call('EXPIRE', KEYS[1], 120) end; return n", 1, kvKey("idx-reads", minute)]));
        return Number.isFinite(n) ? n : null;
      } catch {
        return null;
      }
    },
    async watermark(slot) {
      try {
        const n = Number(await kv(["EVAL", "local w = tonumber(redis.call('GET', KEYS[1]) or '0'); local s = tonumber(ARGV[1]); if s > w then redis.call('SET', KEYS[1], ARGV[1]); return s end; return w", 1, kvKey("idx-watermark"), slot]));
        return Number.isFinite(n) ? n : null;
      } catch {
        return null;
      }
    },
  };
}

interface State {
  memo: { at: number; value: Promise<ChainIndex> } | null;
  good: ChainIndex | null;
  lastSlot: number;
  failedAt: number;
}
const st: State = { memo: null, good: null, lastSlot: 0, failedAt: -Infinity };

export interface IndexDeps {
  conn: () => IndexConn;
  fleet: IndexFleet | null;
  now: () => number;
}
const defaultDeps = (): IndexDeps => ({ conn: () => getConnection() as unknown as IndexConn, fleet: fleetOf(kvFromEnv()), now: Date.now });

async function readChecked(d: IndexDeps): Promise<ChainIndex> {
  const t = d.now();
  if (t - st.failedAt < FAIL_BACKOFF_MS) throw new IndexUnavailable("backoff");
  if (d.fleet) {
    const n = await d.fleet.countRead(new Date(t).toISOString().slice(0, 16));
    if (n !== null && n > FLEET_READS_PER_MIN) {
      if (st.good && t - st.good.readAt < TICKER_FRESH_MS) return st.good;
      throw new IndexUnavailable("fleet-budget");
    }
  }
  let v: ChainIndex;
  try {
    v = await readIndexFrom(d.conn(), d.now);
  } catch (e) {
    st.failedAt = d.now();
    throw e;
  }
  if (v.slot < st.lastSlot) throw new IndexUnavailable("backward");
  if (d.fleet) {
    const w = await d.fleet.watermark(v.slot);
    if (w !== null && v.slot + WATERMARK_SLOTS < w) throw new IndexUnavailable("behind-fleet");
  }
  st.lastSlot = v.slot;
  st.good = v;
  return v;
}

/* The index, at most a minute old. Throws when the RPC cannot be read and nothing is kept (callers fail closed). */
export function readChainIndex(deps: Partial<IndexDeps> = {}): Promise<ChainIndex> {
  const d = { ...defaultDeps(), ...deps };
  return staleOr("chain-index", () => {
    const t = d.now();
    if (st.memo && t - st.memo.at < INDEX_TTL_MS) return st.memo.value;
    const value = readChecked(d);
    st.memo = { at: t, value };
    value.catch(() => {
      if (st.memo?.value === value) st.memo = null;
    });
    return value;
  });
}

/*
  The index the ticker rules may decide on: read at finalized commitment from the chain (never "stale"), younger than
  TICKER_FRESH_MS, with its block time, and on mainnet with every Launch account read. Anything else: IndexUnavailable.
*/
export async function readTickerIndex(deps: Partial<IndexDeps> = {}, cluster: string = CLUSTER): Promise<ChainIndex> {
  const d = { ...defaultDeps(), ...deps };
  const v = await readChainIndex(d);
  if (v.source !== "chain") throw new IndexUnavailable("stale");
  if (d.now() - v.readAt > TICKER_FRESH_MS) throw new IndexUnavailable("old");
  if (v.blockTime === null) throw new IndexUnavailable("no-block-time");
  if (isMainnet(cluster) && v.unreadable > 0) throw new IndexUnavailable("unknown-layout");
  return v;
}

export const chainIndexAvailable = (): boolean => serverHasRpc();

/* For the checks: forget the kept index, the slot floor and the backoff. */
export function resetChainIndex(): void {
  st.memo = null;
  st.good = null;
  st.lastSlot = 0;
  st.failedAt = -Infinity;
}
