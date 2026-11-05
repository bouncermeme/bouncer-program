/*
  The admin ticker release (the founder, 2026-10-24; docs/TICKER-RELEASE-DESIGN-2026-10-24.md). the founder's admin wallet signs
  one plain message naming the ticker, its key and the one launch (the hold's generation) whose hold to free; the
  server checks the signature, re-reads a fresh finalized snapshot, and frees that hold in ONE Lua script that also
  spends the nonce and appends the audit line. What it frees:
  - a funded hold (PoolLive, or Finalized with a pool: a trading token): a release mark rsv/<g8>/rel/<launch>, read
    by the gate (reservations.ts tickerGate) beside the committed list (content/tickerReleases.ts, kept as the
    fallback that survives a store loss);
  - a pending reservation, only once every permit issued for it has expired on the chain's clock (none can land: no
    issued permit is ever revoked); the record says released, its pointers go, and no no-show is counted;
  - a free launch's leftover pointer (Failed, Aborted, Finalized without a pool, Initializing past its window).
  It refuses a live launch (Initializing in its window, Open, Closed, Settled), a reserved name (creationPolicy.ts,
  never released here), a launch whose ticker is another key, and anything the snapshot cannot vouch for. It never
  touches the chain, a token or a pool: it only writes the site's store.

  The message (built by scripts/ticker-release.ts or for a wallet's signMessage, checked field for field here) is ONE
  line of printable ASCII, its fields joined by "; ", so the Solana CLI signs it as off-chain format 0 (restricted
  ASCII), the one a Ledger shows as text; a line break would make it format 1, which a Ledger signs only blind:

    bouncer admin: release a ticker hold          (or: bouncer admin: look at a ticker)
    Admin: <wallet>
    Ticker: <as typed>
    Ticker key: <tickerKey of it>
    Launch: <address>                             (release only)
    Why: <1 to 120 printable ASCII characters, no ";", no space at either end>   (release only)
    URI: https://<host>
    Chain ID: <cluster>
    Nonce: <22 base64url characters>
    Issued At: <ISO time>
    Expiration Time: <ISO time, at most ADMIN_MESSAGE_SECS after Issued At>

  Signed as the bytes (a wallet's signMessage) or inside Solana's off-chain message envelope (solana
  sign-offchain-message, the CLI's form, Ledger included). The admin is TICKER_ADMIN_WALLET_DEVNET or
  TICKER_ADMIN_WALLET_MAINNET, the one for this deployment's cluster; unset, the route answers 404.
*/
import { createHash } from "node:crypto";
import { isMainnet } from "../siteCluster";
import { reservedTermOf } from "../creationPolicy";
import { tickerKey } from "../tickerKey";
import { ADMIN_MESSAGE_SECS, adminMessage, HEAD, SEP, type AdminMessage } from "../tickerAdminMessage";
import type { ChainIndex, IndexedLaunch } from "./chainIndex";
import { ed25519Verifies } from "./kmsSigner";
import { kvKey, KvDown, type Kv } from "./kv";
import { RELEASE_MARGIN_SECS, rk } from "./reservations";
import { isWallet } from "./session";
import { launchHold } from "./ticker";

/* A message dated this far ahead of the server's clock is refused (a wrong clock, not a replay). */
export const ADMIN_SKEW_SECS = 60;
export const AUDIT_READ = 20;
/* Printable ASCII without ";" (the field separator), no space at either end. */
const WHY_RE = /^[\x21-\x3a\x3c-\x7e](?:[\x20-\x3a\x3c-\x7e]{0,118}[\x21-\x3a\x3c-\x7e])?$/;
const NONCE_RE = /^[A-Za-z0-9_-]{22}$/;

export const ak = {
  nonce: (nonce: string) => kvKey("tadmin", "nonce", nonce),
  audit: () => kvKey("tadmin", "audit"),
};

/* The admin wallet for this cluster, or null (the route is then closed). Each cluster has its own variable. */
export function adminWallet(cluster: string, env: Record<string, string | undefined> = process.env): string | null {
  const v = (isMainnet(cluster) ? env.TICKER_ADMIN_WALLET_MAINNET : env.TICKER_ADMIN_WALLET_DEVNET)?.trim() ?? "";
  return isWallet(v) ? v : null;
}

/* The message itself is shared with the CLI and the admin page (tickerAdminMessage.ts). */
export { ADMIN_MESSAGE_SECS, adminMessage, type AdminMessage } from "../tickerAdminMessage";

const isoSec = (s: string): number | null => {
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.000Z$/.test(s)) return null;
  const t = Date.parse(s);
  return Number.isFinite(t) ? t / 1000 : null;
};

/* The message, read back exactly: every field in its place, printable ASCII only, and rebuilt to the same text (no extra byte anywhere). */
export function parseAdminMessage(text: string): AdminMessage | null {
  if (typeof text !== "string" || text.length > 1000 || !/^[\x20-\x7e]+$/.test(text)) return null;
  const lines = text.split(SEP);
  const action = lines[0] === HEAD.release ? "release" : lines[0] === HEAD.look ? "look" : null;
  if (!action) return null;
  const want = action === "release" ? ["Admin", "Ticker", "Ticker key", "Launch", "Why", "URI", "Chain ID", "Nonce", "Issued At", "Expiration Time"] : ["Admin", "Ticker", "Ticker key", "URI", "Chain ID", "Nonce", "Issued At", "Expiration Time"];
  if (lines.length !== want.length + 1) return null;
  const f: Record<string, string> = {};
  for (let i = 0; i < want.length; i++) {
    const p = `${want[i]}: `;
    if (!lines[i + 1].startsWith(p)) return null;
    f[want[i]] = lines[i + 1].slice(p.length);
  }
  const issuedAt = isoSec(f["Issued At"]);
  const expiresAt = isoSec(f["Expiration Time"]);
  const host = f.URI.startsWith("https://") ? f.URI.slice(8) : "";
  if (issuedAt === null || expiresAt === null || !host || !isWallet(f.Admin) || !NONCE_RE.test(f.Nonce)) return null;
  if (action === "release" && (!isWallet(f.Launch) || !WHY_RE.test(f.Why))) return null;
  const m: AdminMessage = { action, admin: f.Admin, ticker: f.Ticker, key: f["Ticker key"], launch: action === "release" ? f.Launch : null, why: action === "release" ? f.Why : null, host, cluster: f["Chain ID"], nonce: f.Nonce, issuedAt, expiresAt };
  return adminMessage(m) === text ? m : null;
}

/* Solana's off-chain message envelope, version 0 (Agave's solana-offchain-message): what the CLI and a Ledger sign. */
export function offchainEnvelope(message: Uint8Array, format: 0 | 1): Uint8Array {
  const head = new Uint8Array(20);
  head[0] = 0xff;
  head.set(new TextEncoder().encode("solana offchain"), 1);
  head[16] = 0;
  head[17] = format;
  head[18] = message.length & 0xff;
  head[19] = message.length >> 8;
  const out = new Uint8Array(20 + message.length);
  out.set(head);
  out.set(message, 20);
  return out;
}

/* The signature is the admin's over the message bytes, or over the envelope in format 0 (what the CLI picks for this one ASCII line). */
export function adminSigned(admin: string, text: string, signature: Uint8Array): boolean {
  const m = new TextEncoder().encode(text);
  return ed25519Verifies(admin, m, signature) || ed25519Verifies(admin, offchainEnvelope(m, 0), signature);
}

export type Refusal = "signature" | "not-admin" | "wrong-host" | "wrong-cluster" | "expired" | "not-yet" | "too-long" | "ticker" | "reserved";

/* Everything about the message but the store: the admin, this host and cluster, the times, the ticker's key, the brand list. */
export function checkAdminMessage(text: string, signature: Uint8Array, a: { admin: string | null; host: string; cluster: string; nowSec: number }): { ok: true; m: AdminMessage } | { ok: false; why: Refusal } {
  const m = parseAdminMessage(text);
  if (!m || !a.admin) return { ok: false, why: "signature" };
  if (m.admin !== a.admin) return { ok: false, why: "not-admin" };
  if (!adminSigned(a.admin, text, signature)) return { ok: false, why: "signature" };
  if (m.host !== a.host) return { ok: false, why: "wrong-host" };
  if (m.cluster !== a.cluster) return { ok: false, why: "wrong-cluster" };
  if (m.expiresAt - m.issuedAt > ADMIN_MESSAGE_SECS || m.expiresAt <= m.issuedAt) return { ok: false, why: "too-long" };
  if (m.issuedAt > a.nowSec + ADMIN_SKEW_SECS) return { ok: false, why: "not-yet" };
  if (m.expiresAt < a.nowSec) return { ok: false, why: "expired" };
  if (tickerKey(m.ticker) !== m.key) return { ok: false, why: "ticker" };
  if (reservedTermOf(m.ticker)) return { ok: false, why: "reserved" };
  return { ok: true, m };
}

/*
  The release, one step. KEYS: the nonce, the record, the expiries, the key pointer, the wallet pointer, the release
  mark, the audit list. ARGV: launch, key, kind (pending, funded, free; or live, unknown, other-key: refused), block
  time, margin, slot, the mark's JSON, the audit line's start (a JSON object without its closing brace), the nonce's
  seconds. The nonce is spent first, whatever follows: one signature, one try. Answers: bad (no such kind; nothing
  written), nonce (already spent; nothing written), released, already (that generation holds nothing here), kept (a
  pending reservation's permit can still land), changed (the record is not that pending reservation of that key any
  more), or the refused kind itself. Every answer but bad and nonce appends one audit line with the pointer, the
  record's state and the mark before and after.
*/
export const ADMIN_RELEASE_SCRIPT = [
  "local kinds = {pending = 1, funded = 1, free = 1, live = 1, unknown = 1, ['other-key'] = 1}",
  "if not kinds[ARGV[3]] then return 'bad' end",
  "if not redis.call('SET', KEYS[1], '1', 'NX', 'EX', ARGV[9]) then return 'nonce' end",
  "local function st(r)",
  "  if not r then return 'none' end",
  "  for _, s in ipairs({'pending', 'landed', 'released'}) do",
  "    if string.find(r, '\"state\":\"' .. s .. '\"', 1, true) then return s end",
  "  end",
  "  return 'unknown'",
  "end",
  "local function q(v) if v then return '\"' .. v .. '\"' end return 'null' end",
  "local ptr = redis.call('GET', KEYS[4])",
  "local rec = redis.call('GET', KEYS[2])",
  "local mark = redis.call('EXISTS', KEYS[6])",
  "local before = st(rec)",
  "local result = 'already'",
  "if ARGV[3] == 'pending' then",
  "  if before ~= 'pending' or not string.find(rec, '\"key\":\"' .. ARGV[2] .. '\"', 1, true) then",
  "    result = 'changed'",
  "  else",
  "    local top = redis.call('ZRANGE', KEYS[3], -1, -1, 'WITHSCORES')",
  "    if not top[2] or tonumber(ARGV[4]) <= tonumber(top[2]) + tonumber(ARGV[5]) then",
  "      result = 'kept'",
  "    else",
  "      local s = string.find(rec, '\"state\":\"pending\"', 1, true)",
  "      redis.call('SET', KEYS[2], string.sub(rec, 1, s - 1) .. '\"state\":\"released\",\"slot\":' .. ARGV[6] .. ',\"by\":\"admin\"' .. string.sub(rec, s + 17))",
  "      if ptr == ARGV[1] then redis.call('DEL', KEYS[4]) end",
  "      if redis.call('GET', KEYS[5]) == ARGV[1] then redis.call('DEL', KEYS[5]) end",
  "      result = 'released'",
  "    end",
  "  end",
  "elseif ARGV[3] == 'funded' then",
  "  if mark == 0 then",
  "    redis.call('SET', KEYS[6], ARGV[7])",
  "    result = 'released'",
  "  end",
  "  if ptr == ARGV[1] then redis.call('DEL', KEYS[4]) end",
  "elseif ARGV[3] == 'free' then",
  "  if ptr == ARGV[1] then",
  "    redis.call('DEL', KEYS[4])",
  "    result = 'released'",
  "  end",
  "else",
  "  result = ARGV[3]",
  "end",
  "local aptr = redis.call('GET', KEYS[4])",
  "local after = st(redis.call('GET', KEYS[2]))",
  "local amark = redis.call('EXISTS', KEYS[6])",
  "redis.call('RPUSH', KEYS[7], ARGV[8] .. ',\"result\":\"' .. result .. '\",\"before\":{\"pointer\":' .. q(ptr) .. ',\"record\":\"' .. before .. '\",\"released\":' .. tostring(mark == 1) .. '},\"after\":{\"pointer\":' .. q(aptr) .. ',\"record\":\"' .. after .. '\",\"released\":' .. tostring(amark == 1) .. '}}')",
  "return result",
].join("\n");

export type HoldKind = "live" | "funded" | "pending" | "free" | "unknown" | "other-key";

/* What the named launch holds on `key`, read from a finalized snapshot and the store. */
export async function holdOf(kv: Kv, key: string, launch: string, index: Pick<ChainIndex, "launches" | "records" | "blockTime">): Promise<{ kind: HoldKind; until?: number }> {
  const l: IndexedLaunch | undefined = index.launches.find((x) => x.address === launch);
  if (l) {
    if (l.key !== key) return { kind: "other-key" };
    const h = launchHold(l, index.records.get(l.address), index.blockTime ?? 0);
    return { kind: h === "live" ? "live" : h === "funded" ? "funded" : "free" };
  }
  const r = await kv(["GET", rk.record(launch)]);
  if (r === null || r === undefined) return { kind: "unknown" };
  if (typeof r !== "string") throw new KvDown();
  let rec: { key?: unknown; state?: unknown };
  try {
    rec = JSON.parse(r) as typeof rec;
  } catch {
    return { kind: "unknown" };
  }
  if (rec.key !== key) return { kind: "other-key" };
  if (rec.state === "released") return { kind: "free" };
  /* Landed but not in this snapshot (a slower node): not judged now. */
  if (rec.state !== "pending") return { kind: "unknown" };
  const top = await kv(["ZRANGE", rk.expiries(launch), -1, -1, "WITHSCORES"]);
  if (!Array.isArray(top)) throw new KvDown();
  return { kind: "pending", until: top.length >= 2 ? Number(top[1]) + RELEASE_MARGIN_SECS : undefined };
}

export type ReleaseResult = "released" | "already" | "kept" | "changed" | "nonce" | "live" | "unknown" | "other-key";
const RESULTS: readonly ReleaseResult[] = ["released", "already", "kept", "changed", "nonce", "live", "unknown", "other-key"];

/* The release itself, after checkAdminMessage. Throws KvDown when the store cannot answer (nothing or everything written). */
export async function releaseHold(kv: Kv, m: AdminMessage, index: Pick<ChainIndex, "launches" | "records" | "blockTime" | "slot">, nowSec: number): Promise<{ result: ReleaseResult; kind: HoldKind; until?: number }> {
  const launch = m.launch!;
  const hold = await holdOf(kv, m.key, launch, index);
  /* A refused kind (live, unknown, other-key) runs the same script: the nonce is spent and the try written down, in one step. */
  const mark = JSON.stringify({ v: 1, key: m.key, launch, by: m.admin, at: new Date(nowSec * 1000).toISOString(), why: m.why, nonce: m.nonce });
  const out = await kv(["EVAL", ADMIN_RELEASE_SCRIPT, 7, ak.nonce(m.nonce), rk.record(launch), rk.expiries(launch), rk.key(m.key), rk.wallet(walletOfRecord(await kv(["GET", rk.record(launch)]))), rk.released(launch), ak.audit(), launch, m.key, hold.kind, index.blockTime ?? 0, RELEASE_MARGIN_SECS, index.slot, mark, auditStart(m, hold.kind, index.slot, nowSec), ADMIN_MESSAGE_SECS * 2]);
  if (!RESULTS.includes(out as ReleaseResult)) throw new KvDown();
  return { result: out as ReleaseResult, kind: hold.kind, until: hold.until };
}

/* The record's wallet (its pointer is freed with a pending release); a record without one names a pointer that cannot exist. */
function walletOfRecord(r: unknown): string {
  if (typeof r !== "string") return "-";
  try {
    const w = (JSON.parse(r) as { wallet?: unknown }).wallet;
    return typeof w === "string" ? w : "-";
  } catch {
    return "-";
  }
}

/*
  The route's log line for a release (24n, E5-L1, review/2026-10-25-astra-e2e/E5-AUDIT.md): the log's scrubber turns any
  address into "[token]", so the launch also goes as its first 8 characters, enough to find its audit line.
*/
export function releaseLogLine(m: AdminMessage, r: { result: ReleaseResult; kind: HoldKind }, slot: number): Record<string, unknown> {
  return { event: "TICKER_ADMIN_RELEASE", result: r.result, kind: r.kind, key: m.key, launch: m.launch, launch8: m.launch ? m.launch.slice(0, 8) : null, slot };
}

/* The audit line's start: who, what, when, and the message's hash (the signed text is never stored whole). */
function auditStart(m: AdminMessage, kind: HoldKind, slot: number, nowSec: number): string {
  return JSON.stringify({ v: 1, at: new Date(nowSec * 1000).toISOString(), admin: m.admin, ticker: m.ticker, key: m.key, launch: m.launch, kind, why: m.why, nonce: m.nonce, message: createHash("sha256").update(adminMessage(m)).digest("hex").slice(0, 16), slot }).slice(0, -1);
}

/* For "look": every launch with the key in the snapshot and the key's pointer, with what each holds, and the latest audit lines. */
export async function lookKey(kv: Kv, m: AdminMessage, index: Pick<ChainIndex, "launches" | "records" | "blockTime" | "slot">): Promise<{ holds: { launch: string; kind: HoldKind; released: boolean; until?: number }[]; audit: unknown[] }> {
  const spent = await kv(["SET", ak.nonce(m.nonce), "1", "NX", "EX", ADMIN_MESSAGE_SECS * 2]);
  if (spent !== "OK") throw new NonceSpent();
  const launches = index.launches.filter((l) => l.key === m.key).map((l) => l.address);
  const ptr = await kv(["GET", rk.key(m.key)]);
  if (typeof ptr === "string" && ptr && !launches.includes(ptr)) launches.push(ptr);
  const holds = [];
  for (const launch of launches) {
    const h = await holdOf(kv, m.key, launch, index);
    const rel = await kv(["EXISTS", rk.released(launch)]);
    holds.push({ launch, kind: h.kind, released: Number(rel) === 1, ...(h.until !== undefined ? { until: h.until } : {}) });
  }
  const lines = await kv(["LRANGE", ak.audit(), -AUDIT_READ, -1]);
  if (!Array.isArray(lines)) throw new KvDown();
  const audit = lines.map((s) => {
    try {
      return JSON.parse(String(s)) as unknown;
    } catch {
      return { unreadable: true };
    }
  });
  return { holds, audit };
}

export class NonceSpent extends Error {
  constructor() {
    super("nonce");
    this.name = "NonceSpent";
  }
}
