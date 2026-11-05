/*
  The admin's same-name notice control (v0.30 item 8, the founder 2026-10-27; the message is ../namesAdminMessage.ts). The
  admin wallet (the ticker release's: TICKER_ADMIN_WALLET_DEVNET or _MAINNET, tickerAdmin.ts adminWallet) signs one
  line; the server checks it field for field, then spends the nonce and appends one line to the audit in ONE Lua
  script (NAMES_SCRIPT). The audit is the state: replaying its hide and show lines, oldest first, gives the hidden
  directions (hiddenFrom), so the two can never disagree and nothing else is written. It never touches the chain, a
  launch, a ticker's hold or the creation gate: it only says which launch's notice stops naming which other launch.

  Keys in the shared store (server/kv.ts):
    nadmin/<g8>/nonce/<nonce>   a spent nonce (expires after twice the message's life)
    nadmin/<g8>/log             the audit: one JSON line per hide or show, never trimmed

  Read publicly (app/api/names): the hidden directions only, never the reasons, the admin or the times.
*/
import { createHash } from "node:crypto";
import { ADMIN_MESSAGE_SECS, hiddenPair, NAMES_HEAD, NAMES_WHY_RE, namesMessage, SEP, type NamesAction, type NamesMessage } from "../namesAdminMessage";
import { kvKey, KvDown, type Kv } from "./kv";
import { isWallet } from "./session";
import { ADMIN_SKEW_SECS, adminSigned } from "./tickerAdmin";

export const NAMES_AUDIT_READ = 20;
const NONCE_RE = /^[A-Za-z0-9_-]{22}$/;

export const nk = {
  nonce: (nonce: string) => kvKey("nadmin", "nonce", nonce),
  log: () => kvKey("nadmin", "log"),
};

/* KEYS: the nonce, the audit. ARGV: the audit line, the nonce's seconds. The nonce is spent and the line appended together, or neither. Answers: nonce (already spent; nothing written), ok. */
export const NAMES_SCRIPT = ["if not redis.call('SET', KEYS[1], '1', 'NX', 'EX', ARGV[2]) then return 'nonce' end", "redis.call('RPUSH', KEYS[2], ARGV[1])", "return 'ok'"].join("\n");

const isoSec = (s: string): number | null => {
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.000Z$/.test(s)) return null;
  const t = Date.parse(s);
  return Number.isFinite(t) ? t / 1000 : null;
};

/* The message, read back exactly: every field in its place, printable ASCII only, and rebuilt to the same text. */
export function parseNamesMessage(text: string): NamesMessage | null {
  if (typeof text !== "string" || text.length > 1000 || !/^[\x20-\x7e]+$/.test(text)) return null;
  const lines = text.split(SEP);
  const action = (Object.keys(NAMES_HEAD) as NamesAction[]).find((a) => NAMES_HEAD[a] === lines[0]);
  if (!action) return null;
  const want = ["Admin", ...(action !== "look" ? ["Launch", "Other"] : []), ...(action === "hide" ? ["Why"] : []), "URI", "Chain ID", "Nonce", "Issued At", "Expiration Time"];
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
  if (action !== "look" && (!isWallet(f.Launch) || !isWallet(f.Other))) return null;
  if (action === "hide" && !NAMES_WHY_RE.test(f.Why)) return null;
  const m: NamesMessage = { action, admin: f.Admin, launch: action !== "look" ? f.Launch : null, other: action !== "look" ? f.Other : null, why: action === "hide" ? f.Why : null, host, cluster: f["Chain ID"], nonce: f.Nonce, issuedAt, expiresAt };
  return namesMessage(m) === text ? m : null;
}

export type NamesRefusal = "signature" | "not-admin" | "wrong-host" | "wrong-cluster" | "expired" | "not-yet" | "too-long" | "same";

/* Everything about the message but the store: the admin, this host and cluster, the times, two different launches. */
export function checkNamesMessage(text: string, signature: Uint8Array, a: { admin: string | null; host: string; cluster: string; nowSec: number }): { ok: true; m: NamesMessage } | { ok: false; why: NamesRefusal } {
  const m = parseNamesMessage(text);
  if (!m || !a.admin) return { ok: false, why: "signature" };
  if (m.admin !== a.admin) return { ok: false, why: "not-admin" };
  if (!adminSigned(a.admin, text, signature)) return { ok: false, why: "signature" };
  if (m.host !== a.host) return { ok: false, why: "wrong-host" };
  if (m.cluster !== a.cluster) return { ok: false, why: "wrong-cluster" };
  if (m.expiresAt - m.issuedAt > ADMIN_MESSAGE_SECS || m.expiresAt <= m.issuedAt) return { ok: false, why: "too-long" };
  if (m.issuedAt > a.nowSec + ADMIN_SKEW_SECS) return { ok: false, why: "not-yet" };
  if (m.expiresAt < a.nowSec) return { ok: false, why: "expired" };
  if (m.action !== "look" && m.launch === m.other) return { ok: false, why: "same" };
  return { ok: true, m };
}

export interface NamesLine {
  v: 1;
  at: string;
  admin: string;
  action: "hide" | "show";
  launch: string;
  other: string;
  why: string | null;
  nonce: string;
  /* The signed text's sha256, first 16 hex (the text itself is never stored). */
  message: string;
}

const parseLine = (s: unknown): NamesLine | null => {
  try {
    const j = JSON.parse(String(s)) as NamesLine;
    return j && j.v === 1 && (j.action === "hide" || j.action === "show") && isWallet(j.launch) && isWallet(j.other) ? j : null;
  } catch {
    return null;
  }
};

/* The whole audit, oldest first; a line that does not read as one is skipped (it hides nothing). */
export async function namesLog(kv: Kv): Promise<NamesLine[]> {
  const r = await kv(["LRANGE", nk.log(), 0, -1]);
  if (!Array.isArray(r)) throw new KvDown();
  return r.map(parseLine).filter((l): l is NamesLine => l !== null);
}

/* The hidden directions after every line in order: a hide adds one, a show removes it. Sorted. */
export function hiddenFrom(lines: readonly NamesLine[]): string[] {
  const hidden = new Set<string>();
  for (const l of lines) {
    const p = hiddenPair(l.launch, l.other);
    if (l.action === "hide") hidden.add(p);
    else hidden.delete(p);
  }
  return [...hidden].sort();
}

/* A hide or a show, after checkNamesMessage. Throws KvDown when the store cannot answer (nothing or everything written). */
export async function setPair(kv: Kv, m: NamesMessage, nowSec: number): Promise<"ok" | "nonce"> {
  if (m.action === "look" || !m.launch || !m.other) throw new KvDown();
  const line: NamesLine = { v: 1, at: new Date(nowSec * 1000).toISOString(), admin: m.admin, action: m.action, launch: m.launch, other: m.other, why: m.why, nonce: m.nonce, message: createHash("sha256").update(namesMessage(m)).digest("hex").slice(0, 16) };
  const out = await kv(["EVAL", NAMES_SCRIPT, 2, nk.nonce(m.nonce), nk.log(), JSON.stringify(line), ADMIN_MESSAGE_SECS * 2]);
  if (out !== "ok" && out !== "nonce") throw new KvDown();
  return out;
}

/* For the page after a signed action or a signed look: the hidden directions and the latest audit lines, newest last. */
export async function namesState(kv: Kv): Promise<{ hidden: string[]; audit: NamesLine[] }> {
  const lines = await namesLog(kv);
  return { hidden: hiddenFrom(lines), audit: lines.slice(-NAMES_AUDIT_READ) };
}

/* A look spends its nonce like the ticker release's (one signature, one answer). */
export async function lookNames(kv: Kv, m: NamesMessage): Promise<{ hidden: string[]; audit: NamesLine[] }> {
  const spent = await kv(["SET", nk.nonce(m.nonce), "1", "NX", "EX", ADMIN_MESSAGE_SECS * 2]);
  if (spent !== "OK") throw new NamesNonceSpent();
  return namesState(kv);
}

export class NamesNonceSpent extends Error {
  constructor() {
    super("nonce");
    this.name = "NamesNonceSpent";
  }
}
