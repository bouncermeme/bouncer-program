/*
  The durable ticker reservation an issued creation permit commits before it leaves the server (23c;
  review/2026-10-24-23c-morning/DESIGN.md section 4). With the chain's rules (server/ticker.ts) it decides whether a
  ticker key is free: tickerGate is the one answer for the permit (server/attest.ts issueCreate) and /api/ticker.

  Keys in the shared store (server/kv.ts), never given a timer:
    rsv/<g8>/k/<key>                  the launch holding the key (one holder)
    rsv/<g8>/r/<launch>               the record {v, key, wallet, launch, createdAt, state, slot?} (JSON, state last)
    rsv/<g8>/x/<launch>               a sorted set: attempt id → permit expiry; its maximum is the max issued expiry
    rsv/<g8>/p/<launch>/<paramHash>   the permit issued for exactly these parameters (an identical retry gets it back)
    rsv/<g8>/w/<wallet>               the wallet's one pending launch
    rsv/<g8>/n/<wallet>, c/<wallet>   no-shows in 24 h, and the cooldown after NO_SHOW_LIMIT of them (these two expire)
    rsv/<g8>/h/<launch>               a permit was returned for the launch (24d: a no-show counts only then)
    rsv/<g8>/rel/<launch>             an admin release of that funded launch's hold (server/tickerAdmin.ts; never deleted)
  An admin release of a pending record (tickerAdmin.ts ADMIN_RELEASE_SCRIPT) writes it released with "by":"admin" after
  its slot, counts no no-show, and is allowed only once every permit for it has expired on the chain's clock.

  24c (the round-4 reviews: fresh H1, M1, M4; Astra's two reservation points): every change of state is ONE Lua
  script, so no reader ever sees half of one and no crash leaves half of one.
  - COMMIT_SCRIPT, after the permit is signed and before it is returned: checks the record is still pending, the
    wallet's slot and the key are free or this launch's, then writes the expiry, both pointers, the record and the
    permit together. An unanswered call is "try again": the script ran whole or not at all, and the identical retry
    recovers the permit. A record no longer pending (released or landed meanwhile) refuses, so a renewal can never
    recreate pointers under a released record (M4).
  - A renewal is the same wallet and launch with new parameters. Its ticker may change only once every earlier permit
    for the launch has expired on the chain's clock (none of them can land any more); the script then moves the
    reservation: the old pointer goes, the new one and the record's key are written, in the same step (H1).
  - RELEASE_SCRIPT, a no-show: re-reads the max issued expiry and the record in the same step that marks it released
    and clears its pointers, so a renewal committed a moment earlier keeps its hold (M4).
  - LAND_SCRIPT: the launch is on chain; the record says landed and the wallet's slot is freed.
  - Pointers the 23c code could leave (a commit cut before its record: M1; a renewal with another ticker: H1) are
    cleared on the gate's next read: ORPHAN_SCRIPT (no record, every permit expired on the chain's clock) and
    FREED_PTR_SCRIPT (the record released). A pointer naming a launch on chain under another ticker is cleared too.

  Reconciliation is lazy, on every gate that meets a pointer, and only on a finalized snapshot (chainIndex.ts):
  - the launch is in the snapshot: landed; the chain governs from then, and the key pointer stays until the chain frees
    the launch, so protection passes from pending to live with no gap;
  - absent, and the snapshot's block time is past the max issued expiry plus RELEASE_MARGIN_SECS: a no-show, released;
  - anything else (absent before the expiry, absent after landing, an unreadable answer): kept, the ticker taken.

  The scripts use only GET, SET, DEL, EXISTS, INCR, EXPIRE, ZADD and ZRANGE and plain string search on a record this
  module writes itself (no JSON library in the script). prepare also reads ZCOUNT (the permits still alive).

  Rehearsal item 2 (the founder, 2026-10-28: more tries and a quicker reset): a launch address takes up to MAX_ATTEMPTS (5)
  permits that are still alive, and once the last one has expired unlanded it starts fresh (RESTART_SCRIPT: its
  renewal window counts again from now). A retry the page makes with the same instruction gets the stored permit and
  counts nothing.
  v0.31 (Dispatch for the founder, 2026-10-28): a permit counts as alive only while its instruction can still land: its score
  is the earlier of its expiry and the moment its close_ts falls under the program's 240 s landing floor (plus 30 s for
  the cluster clock), so the try a slow wallet approval lost (CloseTooSoon) does not take one of the five.
*/
import { createHash } from "node:crypto";
import type { TickerRelease } from "@/content/tickerReleases";
import { TICKER_RELEASES } from "@/content/tickerReleases";
import { IndexUnavailable, type ChainIndex } from "./chainIndex";
import { chainHold, launchFrees, launchHold, type ChainHold } from "./ticker";
import { kvKey, KvDown, type Kv } from "./kv";

/* Five permits still alive per launch address (attest.ts LIMITS.walletCreate allows the same); rehearsal item 2, the founder 2026-10-28 (was 3, counted for good). */
export const MAX_ATTEMPTS = 5;
export const RENEW_WINDOW_SECS = 20 * 60;
export const RELEASE_MARGIN_SECS = 30;
export const NO_SHOW_LIMIT = 2;
export const NO_SHOW_WINDOW_SECS = 86_400;
export const COOLDOWN_SECS = 3_600;
/* An identical retry is handed the stored permit only while it has at least this long left. */
export const RETRY_MIN_LEFT_SECS = 60;

/* A fresh start (item 2): the record is rewritten with a new createdAt only while it is still the one read. KEYS: record. ARGV: the record read, the new one. */
export const RESTART_SCRIPT = "if redis.call('GET', KEYS[1]) == ARGV[1] then redis.call('SET', KEYS[1], ARGV[2]); return 'ok' end; return 'changed'";

/* Compare-and-delete: the key is removed only while it still names this holder (never someone else's pointer). */
export const CAS_DEL_SCRIPT = "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end; return 0";

/*
  The commit. KEYS: record, expiries, wallet pointer, key pointer, permit, the old key's pointer (a move; else the key
  pointer again). ARGV: launch, key, attempt id, expiry, the new record, the permit, its seconds, the snapshot's block
  time, the release margin, the old key (a move; else the key).
  Answers: ok, stale (the record is no longer pending), key-changed (another ticker while an earlier permit can still
  land), changed (the record's key is not the one read: try again), wallet-pending, lost (another launch holds the key).
*/
export const COMMIT_SCRIPT = [
  "local rec = redis.call('GET', KEYS[1])",
  "local moving = false",
  "if rec then",
  "  if not string.find(rec, '\"state\":\"pending\"', 1, true) then return 'stale' end",
  "  if not string.find(rec, '\"key\":\"' .. ARGV[2] .. '\"', 1, true) then",
  "    if not string.find(rec, '\"key\":\"' .. ARGV[10] .. '\"', 1, true) then return 'changed' end",
  "    local top = redis.call('ZRANGE', KEYS[2], -1, -1, 'WITHSCORES')",
  "    if top[2] and tonumber(ARGV[8]) <= tonumber(top[2]) + tonumber(ARGV[9]) then return 'key-changed' end",
  "    moving = true",
  "  end",
  "end",
  "local w = redis.call('GET', KEYS[3])",
  "if w and w ~= ARGV[1] then return 'wallet-pending' end",
  "local k = redis.call('GET', KEYS[4])",
  "if k and k ~= ARGV[1] then return 'lost' end",
  "if moving then",
  "  if redis.call('GET', KEYS[6]) == ARGV[1] then redis.call('DEL', KEYS[6]) end",
  "  local s, e = string.find(rec, '\"key\":\"', 1, true)",
  "  local q = string.find(rec, '\"', e + 1, true)",
  "  redis.call('SET', KEYS[1], string.sub(rec, 1, e) .. ARGV[2] .. string.sub(rec, q))",
  "end",
  "redis.call('ZADD', KEYS[2], ARGV[4], ARGV[3])",
  "redis.call('SET', KEYS[3], ARGV[1])",
  "redis.call('SET', KEYS[4], ARGV[1])",
  "if not rec then redis.call('SET', KEYS[1], ARGV[5]) end",
  "redis.call('SET', KEYS[5], ARGV[6], 'EX', ARGV[7])",
  "return 'ok'",
].join("\n");

/*
  A no-show. KEYS: record, expiries, key pointer, wallet pointer, no-show counter, cooldown, the handed mark. ARGV:
  launch, key, wallet, block time, margin, slot, the counter's window, the limit, the cooldown's seconds.
  24d (fresh I3, the founder): the no-show is counted only when the handed mark exists, that is when the server returned a
  permit for the launch (markHanded); a commit that applied but whose answer was lost returned none, so its release
  costs the wallet nothing.
  Answers: none, released (now or before), kept (landed, or the max expiry not yet past), changed (moved meanwhile).
*/
export const RELEASE_SCRIPT = [
  "local rec = redis.call('GET', KEYS[1])",
  "if not rec then return 'none' end",
  "if string.find(rec, '\"state\":\"released\"', 1, true) then return 'released' end",
  "local s = string.find(rec, '\"state\":\"pending\"', 1, true)",
  "if not s then return 'kept' end",
  "if not string.find(rec, '\"key\":\"' .. ARGV[2] .. '\"', 1, true) or not string.find(rec, '\"wallet\":\"' .. ARGV[3] .. '\"', 1, true) then return 'changed' end",
  "local top = redis.call('ZRANGE', KEYS[2], -1, -1, 'WITHSCORES')",
  "if not top[2] or tonumber(ARGV[4]) <= tonumber(top[2]) + tonumber(ARGV[5]) then return 'kept' end",
  "redis.call('SET', KEYS[1], string.sub(rec, 1, s - 1) .. '\"state\":\"released\",\"slot\":' .. ARGV[6] .. string.sub(rec, s + 17))",
  "if redis.call('GET', KEYS[3]) == ARGV[1] then redis.call('DEL', KEYS[3]) end",
  "if redis.call('GET', KEYS[4]) == ARGV[1] then redis.call('DEL', KEYS[4]) end",
  "if redis.call('EXISTS', KEYS[7]) == 1 then",
  "  local n = redis.call('INCR', KEYS[5])",
  "  if n == 1 then redis.call('EXPIRE', KEYS[5], ARGV[7]) end",
  "  if n >= tonumber(ARGV[8]) then redis.call('SET', KEYS[6], '1', 'EX', ARGV[9]) end",
  "end",
  "return 'released'",
].join("\n");

/* On chain. KEYS: record, wallet pointer. ARGV: launch, slot. Answers: none, landed, released. */
export const LAND_SCRIPT = [
  "local rec = redis.call('GET', KEYS[1])",
  "if not rec then return 'none' end",
  "local s = string.find(rec, '\"state\":\"pending\"', 1, true)",
  "if s then redis.call('SET', KEYS[1], string.sub(rec, 1, s - 1) .. '\"state\":\"landed\",\"slot\":' .. ARGV[2] .. string.sub(rec, s + 17)) end",
  "if redis.call('GET', KEYS[2]) == ARGV[1] then redis.call('DEL', KEYS[2]) end",
  "if string.find(rec, '\"state\":\"released\"', 1, true) then return 'released' end",
  "return 'landed'",
].join("\n");

/*
  A pointer with no record (a 23c commit cut before its record write, M1). KEYS: record, expiries, the pointer. ARGV:
  launch, block time, margin. Cleared once every permit recorded for the launch has expired on the chain's clock (or
  none was recorded). Answers: record (one exists: not an orphan), gone (the pointer names another launch), kept, cleared.
*/
export const ORPHAN_SCRIPT = [
  "if redis.call('EXISTS', KEYS[1]) == 1 then return 'record' end",
  "if redis.call('GET', KEYS[3]) ~= ARGV[1] then return 'gone' end",
  "local top = redis.call('ZRANGE', KEYS[2], -1, -1, 'WITHSCORES')",
  "if top[2] and tonumber(ARGV[2]) <= tonumber(top[2]) + tonumber(ARGV[3]) then return 'kept' end",
  "redis.call('DEL', KEYS[3])",
  "return 'cleared'",
].join("\n");

/* A pointer to a released record (a 23c renewal under another ticker, H1). KEYS: record, the pointer. ARGV: launch. */
export const FREED_PTR_SCRIPT = [
  "local rec = redis.call('GET', KEYS[1])",
  "if not rec or not string.find(rec, '\"state\":\"released\"', 1, true) then return 'kept' end",
  "if redis.call('GET', KEYS[2]) ~= ARGV[1] then return 'gone' end",
  "redis.call('DEL', KEYS[2])",
  "return 'cleared'",
].join("\n");

export const rk = {
  key: (key: string) => kvKey("rsv", "k", key),
  record: (launch: string) => kvKey("rsv", "r", launch),
  expiries: (launch: string) => kvKey("rsv", "x", launch),
  permit: (launch: string, paramHash: string) => kvKey("rsv", "p", launch, paramHash),
  wallet: (wallet: string) => kvKey("rsv", "w", wallet),
  noShows: (wallet: string) => kvKey("rsv", "n", wallet),
  cooldown: (wallet: string) => kvKey("rsv", "c", wallet),
  /* 24d: the server returned a permit for this launch (a no-show is counted only then). */
  handed: (launch: string) => kvKey("rsv", "h", launch),
  /* An admin release of one funded launch's hold (server/tickerAdmin.ts): written once, never deleted. */
  released: (launch: string) => kvKey("rsv", "rel", launch),
};

/*
  The admin releases in the store for the funded launches with `key` (tickerAdmin.ts), as release entries. A mark that
  does not read as this launch and key is ignored: the hold stays (fail closed).
*/
export async function storeReleases(kv: Kv, key: string, index: Pick<ChainIndex, "launches" | "records" | "blockTime">): Promise<TickerRelease[]> {
  const out: TickerRelease[] = [];
  for (const l of index.launches) {
    if (l.key !== key || launchHold(l, index.records.get(l.address), index.blockTime ?? 0) !== "funded") continue;
    const r = await kv(["GET", rk.released(l.address)]);
    if (r === null || r === undefined) continue;
    if (typeof r !== "string") throw new KvDown();
    try {
      const j = JSON.parse(r) as { launch?: unknown; key?: unknown; by?: unknown; at?: unknown; why?: unknown };
      if (j.launch === l.address && j.key === key) out.push({ launch: l.address, key, by: String(j.by), at: String(j.at), why: String(j.why) });
    } catch {
      /* unreadable: no release */
    }
  }
  return out;
}

export interface Reservation {
  v: 1;
  key: string;
  wallet: string;
  launch: string;
  createdAt: number;
  state: "pending" | "landed" | "released";
  /* The snapshot slot that landed or released it. */
  slot?: number;
}

/* The record as the scripts expect it: these fields in this order, "state" last (they search it as plain text). */
export const recordJson = (r: Pick<Reservation, "key" | "wallet" | "launch" | "createdAt">): string =>
  JSON.stringify({ v: 1, key: r.key, wallet: r.wallet, launch: r.launch, createdAt: r.createdAt, state: "pending" });

export const paramHash = (creator: string, launch: string, data: Uint8Array): string => createHash("sha256").update(creator).update("|").update(launch).update("|").update(data).digest("hex");

function parseRecord(s: unknown): Reservation | null {
  if (typeof s !== "string") return null;
  try {
    const j = JSON.parse(s) as Reservation;
    return j && j.v === 1 && typeof j.key === "string" && typeof j.wallet === "string" && typeof j.launch === "string" && typeof j.createdAt === "number" ? j : null;
  } catch {
    return null;
  }
}

async function maxExpiry(kv: Kv, launch: string): Promise<number | null> {
  const r = await kv(["ZRANGE", rk.expiries(launch), -1, -1, "WITHSCORES"]);
  if (!Array.isArray(r)) throw new KvDown();
  if (r.length < 2) return null;
  const n = Number(r[1]);
  return Number.isFinite(n) ? n : null;
}

/* A script's answer: one of the strings it can return, else the store did not answer as it should. */
async function script<T extends string>(kv: Kv, text: string, keys: string[], args: (string | number)[], answers: readonly T[]): Promise<T> {
  const r = await kv(["EVAL", text, keys.length, ...keys, ...args]);
  if (typeof r === "string" && (answers as readonly string[]).includes(r)) return r as T;
  throw new KvDown();
}

export type Reconciled = "landed" | "released" | "kept" | "none";

/*
  One reservation against a finalized snapshot. "landed": the launch is on chain (the chain decides its key now);
  "released": a no-show, pointers cleared; "kept": still protecting; "none": no record.
*/
export async function reconcile(kv: Kv, launch: string, index: Pick<ChainIndex, "launches" | "slot" | "blockTime">, log: (r: Record<string, unknown>) => void = () => undefined): Promise<Reconciled> {
  for (let tries = 0; tries < 2; tries++) {
    const rec = parseRecord(await kv(["GET", rk.record(launch)]));
    if (!rec) return "none";
    if (rec.state === "released") return "released";
    if (index.launches.some((l) => l.address === launch)) {
      if (rec.state === "pending") await script(kv, LAND_SCRIPT, [rk.record(launch), rk.wallet(rec.wallet)], [launch, index.slot], ["none", "landed", "released"] as const);
      return "landed";
    }
    if (rec.state === "landed" || index.blockTime === null) return "kept";
    const r = await script(kv, RELEASE_SCRIPT, [rk.record(launch), rk.expiries(launch), rk.key(rec.key), rk.wallet(rec.wallet), rk.noShows(rec.wallet), rk.cooldown(rec.wallet), rk.handed(launch)], [launch, rec.key, rec.wallet, index.blockTime, RELEASE_MARGIN_SECS, index.slot, NO_SHOW_WINDOW_SECS, NO_SHOW_LIMIT, COOLDOWN_SECS], ["none", "released", "kept", "changed"] as const);
    if (r === "changed") continue;
    if (r === "released") log({ event: "ticker-reservation", result: "no-show", key: rec.key, slot: index.slot });
    return r === "none" ? "none" : r;
  }
  return "kept";
}

/*
  A pointer whose holder is not on chain: free it when nothing can still use it. No record and every recorded permit
  expired on the chain's clock (ORPHAN_SCRIPT), or a released record (FREED_PTR_SCRIPT). True when the pointer is gone.
*/
async function clearDeadPointer(kv: Kv, pointer: string, holder: string, reconciled: Reconciled, blockTime: number): Promise<boolean> {
  if (reconciled === "none") await script(kv, ORPHAN_SCRIPT, [rk.record(holder), rk.expiries(holder), pointer], [holder, blockTime, RELEASE_MARGIN_SECS], ["record", "gone", "kept", "cleared"] as const);
  else if (reconciled === "released") await script(kv, FREED_PTR_SCRIPT, [rk.record(holder), pointer], [holder], ["kept", "gone", "cleared"] as const);
  else return false;
  /* Free only when nothing is there now: a pointer that meanwhile names another launch is that launch's. */
  const now = await kv(["GET", pointer]);
  if (now !== null && now !== undefined && now !== "" && typeof now !== "string") throw new KvDown();
  return !now;
}

export type Gate =
  | { taken: false; own: boolean }
  | { taken: true; why: ChainHold | "pending"; paying?: boolean };

/*
  Whether `key` is free for a create of `launch`, against a finalized snapshot: the chain's hold, then the key's
  reservation (reconciled first). `own` is true when the reservation is this launch's (a renewal or a retry).
  Throws KvDown when the store cannot answer (the caller fails closed).
*/
export async function tickerGate(kv: Kv, key: string, launch: string | null, index: ChainIndex, releases: readonly TickerRelease[] = TICKER_RELEASES, log: (r: Record<string, unknown>) => void = () => undefined): Promise<Gate> {
  /* No block time, no decision: a release is judged on the chain's clock (chainIndex.ts readTickerIndex refuses it too). */
  if (index.blockTime === null || index.source !== "chain") throw new IndexUnavailable("no-block-time");
  /* The committed list and the store's admin releases together (the committed file survives a store loss). */
  releases = [...releases, ...(await storeReleases(kv, key, index))];
  const status = chainHold(key, index, releases);
  for (const r of status.ignoredReleases) log({ event: "TICKER_RELEASE_IGNORED", key: r.key, launch: r.launch });
  const holder = await kv(["GET", rk.key(key)]);
  let own = false;
  if (typeof holder === "string" && holder) {
    const onChain = index.launches.find((l) => l.address === holder);
    if (onChain) {
      await reconcile(kv, holder, index, log);
      /*
        The chain governs a landed launch; once it frees it, the pointer goes (compare-and-delete). A pointer naming a
        launch whose ticker on chain is another one is stale (a 23c renewal under a second ticker, H1): it goes too.
      */
      if (onChain.key !== key || launchFrees(onChain, index, releases)) await kv(["EVAL", CAS_DEL_SCRIPT, 1, rk.key(key), holder]);
      else if (holder === launch) own = true;
    } else if (holder === launch) {
      own = true;
    } else {
      const r = await reconcile(kv, holder, index, log);
      if (r !== "released" && r !== "none") return { taken: true, why: "pending" };
      if (!(await clearDeadPointer(kv, rk.key(key), holder, r, index.blockTime))) return { taken: true, why: "pending" };
    }
  } else if (holder !== null && holder !== undefined && holder !== "") {
    throw new KvDown();
  }
  if (status.hold && !(own && status.launches.every((l) => l.address === launch))) return { taken: true, why: status.hold, paying: status.hold === "funded" && status.paying };
  return { taken: false, own };
}

export type Prepared =
  | { ok: true; retry: StoredPermit | null; renewal: boolean; moveFrom: string | null }
  | { ok: false; why: "ticker-cooldown" | "wallet-pending" | "renew-limit" };

/* The stored permit: [attestor, expiry, message base64, signature base64] (attest.ts's form). */
export type StoredPermit = [string, number, string, string];

function parsePermit(s: unknown): StoredPermit | null {
  if (typeof s !== "string") return null;
  try {
    const j: unknown = JSON.parse(s);
    if (Array.isArray(j) && j.length === 4 && typeof j[0] === "string" && typeof j[1] === "number" && typeof j[2] === "string" && typeof j[3] === "string") return j as StoredPermit;
  } catch {
    /* unreadable: treated as absent */
  }
  return null;
}

/*
  Before signing: the identical retry (a stored permit for these exact parameters with RETRY_MIN_LEFT_SECS left), the
  cooldown, the wallet's one pending launch (reconciled first; a dead pointer cleared), and the renewal bounds. A
  renewal under another ticker waits until every earlier permit has expired on the chain's clock ("wallet-pending":
  this wallet has a launch being created), then moves the reservation (moveFrom, the old key).
*/
export async function prepare(kv: Kv, a: { wallet: string; launch: string; key: string; paramHash: string; nowSec: number }, index: ChainIndex, log: (r: Record<string, unknown>) => void = () => undefined): Promise<Prepared> {
  const stored = parsePermit(await kv(["GET", rk.permit(a.launch, a.paramHash)]));
  if (stored && stored[1] - a.nowSec >= RETRY_MIN_LEFT_SECS) return { ok: true, retry: stored, renewal: true, moveFrom: null };
  if ((await kv(["GET", rk.cooldown(a.wallet)])) !== null) return { ok: false, why: "ticker-cooldown" };
  const pending = await kv(["GET", rk.wallet(a.wallet)]);
  if (typeof pending === "string" && pending && pending !== a.launch) {
    const r = await reconcile(kv, pending, index, log);
    if (r !== "landed" && !(await clearDeadPointer(kv, rk.wallet(a.wallet), pending, r, index.blockTime ?? 0))) return { ok: false, why: "wallet-pending" };
  }
  const raw = await kv(["GET", rk.record(a.launch)]);
  const rec = parseRecord(raw);
  if (!rec) return { ok: true, retry: null, renewal: false, moveFrom: null };
  if (rec.state !== "pending") return { ok: false, why: "renew-limit" };
  /* Item 2: only the permits still alive count, and with none left the address starts fresh (a new renewal window). */
  const alive = Number(await kv(["ZCOUNT", rk.expiries(a.launch), a.nowSec + 1, "+inf"]));
  if (!Number.isFinite(alive) || alive >= MAX_ATTEMPTS) return { ok: false, why: "renew-limit" };
  if (alive === 0) {
    const restarted = await script(kv, RESTART_SCRIPT, [rk.record(a.launch)], [String(raw), recordJson({ ...rec, createdAt: a.nowSec })], ["ok", "changed"] as const);
    if (restarted === "changed") throw new KvDown();
  } else if (a.nowSec > rec.createdAt + RENEW_WINDOW_SECS) return { ok: false, why: "renew-limit" };
  if (rec.key === a.key) return { ok: true, retry: null, renewal: true, moveFrom: null };
  const exp = await maxExpiry(kv, a.launch);
  if (index.blockTime === null || (exp !== null && index.blockTime <= exp + RELEASE_MARGIN_SECS)) return { ok: false, why: "wallet-pending" };
  return { ok: true, retry: null, renewal: true, moveFrom: rec.key };
}

/*
  24d (fresh I3): mark that a permit for the launch is being returned (after a commit answered ok, or an identical
  retry handed the stored one). Best effort: if it cannot be written the permit still goes out, and a later no-show of
  that launch is not counted (the lenient side; both failures together are rare).
*/
export async function markHanded(kv: Kv, launch: string): Promise<void> {
  try {
    await kv(["SET", rk.handed(launch), "1"]);
  } catch {
    /* see above */
  }
}

export type Committed = "ok" | "lost" | "wallet-pending" | "stale" | "uncertain";

/*
  After signing, before returning: one script, every check and every write (COMMIT_SCRIPT). "lost": another launch
  holds the key; "wallet-pending": another launch holds the wallet's slot, or a ticker change while an earlier permit
  can still land; "stale": the record was released or landed meanwhile. The caller discards the signature on each.
  "uncertain": no definite answer (nothing or everything was written); the caller says try again.
*/
export async function commit(kv: Kv, a: { key: string; wallet: string; launch: string; paramHash: string; attemptId: string; nowSec: number; permit: StoredPermit; blockTime: number; moveFrom?: string | null; landsUntil?: number | null }): Promise<Committed> {
  const old = a.moveFrom ?? a.key;
  /* v0.31: alive until it expires or can no longer land, whichever is first (see the head of this file). */
  const alive = a.landsUntil != null ? Math.min(a.permit[1], a.landsUntil) : a.permit[1];
  try {
    const r = await script(
      kv,
      COMMIT_SCRIPT,
      [rk.record(a.launch), rk.expiries(a.launch), rk.wallet(a.wallet), rk.key(a.key), rk.permit(a.launch, a.paramHash), rk.key(old)],
      [a.launch, a.key, a.attemptId, alive, recordJson({ key: a.key, wallet: a.wallet, launch: a.launch, createdAt: a.nowSec }), JSON.stringify(a.permit), Math.max(60, a.permit[1] - a.nowSec + 60), a.blockTime, RELEASE_MARGIN_SECS, old],
      ["ok", "stale", "key-changed", "changed", "wallet-pending", "lost"] as const,
    );
    return r === "key-changed" ? "wallet-pending" : r === "changed" ? "uncertain" : r;
  } catch {
    return "uncertain";
  }
}
