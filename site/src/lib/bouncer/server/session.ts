/*
  The creator sign-in (23c; review/2026-10-24-23c-morning/DESIGN.md section 8, option (a)). A creation permit reserves
  a ticker, so the server needs proof the creator's wallet asked for it before it signs: the wallet signs one plain
  message once a day (Sign In With Solana form; no transaction, no fee), and the server keeps that as an httpOnly
  cookie.

  - POST {action:"nonce", wallet}: the server writes the whole message (this host, the wallet, the cluster, a one-time
    nonce, issued and expiry times) and keeps it in the store for NONCE_SECS under the wallet AND the nonce, never
    replacing another (24c, fresh M2: a request for someone else's wallet no longer overwrites their message). It
    answers the message and the nonce. The client only signs what it is given.
  - POST {action:"verify", wallet, nonce, signature}: the message is read for that wallet and nonce, its lines and
    times checked, the Ed25519 signature checked against the wallet (over the message, or its off-chain envelope for
    a Ledger, B22), and only then spent (DEL, which must answer 1:
    one cookie per message). A wrong signature spends nothing (24c, M2). Then the cookie: {w, c, h, i, exp} with an
    HMAC-SHA256 under SESSION_SECRET, httpOnly, Secure, SameSite=Strict, SESSION_SECS. h is the host it was made for
    (24c, I3: a cookie from one host is not read on another); i is its id, so sign-out can revoke it (24c, I4).
  - POST {action:"out"}: the cookie is cleared and its id kept as revoked until its own expiry (sessionRevoked).
  - The permit (attest.ts issueCreate) needs the cookie's wallet to be the creator, on this cluster and host, before
    exp, and not revoked.
  Without SESSION_SECRET (at least 32 characters) no cookie is made or accepted, and creation permits refuse
  (decision D5).
*/
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import bs58 from "bs58";
import { ed25519Verifies } from "./kmsSigner";
import { kvKey, type Kv } from "./kv";

export const SESSION_COOKIE = "bouncer_creator";
export const SESSION_SECS = 86_400;
export const NONCE_SECS = 300;
const SECRET_MIN = 32;

export const sessionSecret = (env: NodeJS.ProcessEnv = process.env): string | null => {
  const s = (env.SESSION_SECRET ?? "").trim();
  return s.length >= SECRET_MIN ? s : null;
};

const b64u = (b: Buffer): string => b.toString("base64url");
const mac = (secret: string, body: string): Buffer => createHmac("sha256", secret).update(body).digest();

export interface Session {
  wallet: string;
  cluster: string;
  host: string;
  /* The cookie's own id (revocable at sign-out). */
  id: string;
  exp: number;
}

export function sessionCookieValue(secret: string, s: Session): string {
  const body = b64u(Buffer.from(JSON.stringify({ w: s.wallet, c: s.cluster, h: s.host, i: s.id, exp: s.exp })));
  return `${body}.${b64u(mac(secret, body))}`;
}

/* The cookie's wallet when its MAC, cluster, host and expiry hold; null otherwise. */
export function readSession(secret: string | null, value: string | undefined | null, cluster: string, host: string, nowSec: number): string | null {
  return readSessionFull(secret, value, cluster, host, nowSec)?.wallet ?? null;
}

/* The whole cookie when it holds (the route needs its id and expiry for revocation). */
export function readSessionFull(secret: string | null, value: string | undefined | null, cluster: string, host: string, nowSec: number): Session | null {
  if (!secret || !value || value.length > 512) return null;
  const dot = value.indexOf(".");
  if (dot <= 0) return null;
  const body = value.slice(0, dot);
  let given: Buffer;
  try {
    given = Buffer.from(value.slice(dot + 1), "base64url");
  } catch {
    return null;
  }
  const want = mac(secret, body);
  if (given.length !== want.length || !timingSafeEqual(given, want)) return null;
  try {
    const j = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as { w?: unknown; c?: unknown; h?: unknown; i?: unknown; exp?: unknown };
    if (typeof j.w !== "string" || j.c !== cluster || j.h !== host || typeof j.i !== "string" || typeof j.exp !== "number" || j.exp < nowSec) return null;
    return { wallet: j.w, cluster: j.c, host: j.h, id: j.i, exp: j.exp };
  } catch {
    return null;
  }
}

/* The cookie from a Cookie header. */
export function cookieOf(header: string | null, name: string = SESSION_COOKIE): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

/* The Chain ID line as Sign In With Solana spells it (mainnet, devnet, testnet, localnet): a wallet that parses the message
   (Phantom) refuses "mainnet-beta" and opens no prompt (SI, 2026-11-04). */
export const siwsChainId = (cluster: string): string => (cluster === "mainnet-beta" ? "mainnet" : cluster);
export function signInMessage(a: { host: string; wallet: string; cluster: string; nonce: string; issuedAt: number; expiresAt: number }): string {
  return [
    `${a.host} wants you to sign in with your Solana account:`,
    a.wallet,
    "",
    "Sign in to create a launch. This is not a transaction and costs nothing.",
    "",
    `URI: https://${a.host}`,
    "Version: 1",
    `Chain ID: ${siwsChainId(a.cluster)}`,
    `Nonce: ${a.nonce}`,
    `Issued At: ${new Date(a.issuedAt * 1000).toISOString()}`,
    `Expiration Time: ${new Date(a.expiresAt * 1000).toISOString()}`,
  ].join("\n");
}

const NONCE_RE = /^[A-Za-z0-9_-]{22}$/;
const nonceKey = (wallet: string, nonce: string) => kvKey("session", "nonce", wallet, nonce);
const revokedKey = (id: string) => kvKey("session", "out", id);

export const isWallet = (s: unknown): s is string => {
  if (typeof s !== "string" || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s)) return false;
  try {
    return bs58.decode(s).length === 32;
  } catch {
    return false;
  }
};

/* A new message for the wallet to sign, kept for NONCE_SECS under its own nonce. Throws when the store cannot keep it. */
export async function newSignIn(kv: Kv, a: { host: string; wallet: string; cluster: string; nowSec: number }): Promise<{ text: string; nonce: string }> {
  const nonce = b64u(randomBytes(16));
  const message = signInMessage({ ...a, nonce, issuedAt: a.nowSec, expiresAt: a.nowSec + NONCE_SECS });
  /* NX: a nonce is never written over (16 random bytes; a collision is refused, not replaced). */
  const r = await kv(["SET", nonceKey(a.wallet, nonce), message, "EX", NONCE_SECS, "NX"]);
  if (r !== "OK") throw new Error("nonce");
  return { text: message, nonce };
}

/*
  B22 (PD8, 2026-11-03: a Ledger behind Phantom could not sign in). A Ledger signs a message only inside Solana's
  off-chain message envelope, so its signature is over the envelope, not the bare text. The signature is accepted over
  the bare message (as before) or over a version-0 envelope wrapping exactly the same bytes, built here from the stored
  message (the first form: only the signature comes from the client): "\xffsolana offchain", version 0, a format byte,
  then the length (u16, little-endian) and the message. Two v0 header layouts are in use: the Solana CLI's and older
  Ledger apps' (nothing else in the header) and the current spec's, which adds a 32-byte application domain (zero here)
  and the signer list (this wallet alone).
  B22 v3 (2026-11-04: v2 failed too; Phantom reports the plain message as signed while the Ledger signs an envelope):
  every envelope the server can build from the message is tried, each format byte 0, 1 and 2 in both v0 layouts, the
  spec layout with no signer list too, and v1 (domain | 1 | 1 | this wallet | message). Each wraps exactly the stored
  message under the off-chain signing domain, so none can be a transaction; at most one can verify. The match is named.
  PD8 (2026-11-04 04:20 UTC): the founder's Ledger behind Phantom signed "v0-spec-f0" (spec layout, zero domain,
  format 0 although the message has line feeds).
*/
const OFFCHAIN_DOMAIN = Buffer.from("\xffsolana offchain", "latin1");
const u16le = (n: number): Buffer => Buffer.from([n & 0xff, n >> 8]);

export function signInPayloads(message: string, wallet: string): { name: string; bytes: Uint8Array }[] {
  const m = Buffer.from(message, "utf8");
  const w = Buffer.from(bs58.decode(wallet));
  const out: { name: string; bytes: Uint8Array }[] = [{ name: "raw", bytes: m }];
  if (m.length === 0 || m.length > 0xffff) return out;
  for (const f of [0, 1, 2]) {
    out.push({ name: `v0-cli-f${f}`, bytes: Buffer.concat([OFFCHAIN_DOMAIN, Buffer.from([0, f]), u16le(m.length), m]) });
    out.push({ name: `v0-spec-f${f}`, bytes: Buffer.concat([OFFCHAIN_DOMAIN, Buffer.from([0]), Buffer.alloc(32), Buffer.from([f, 1]), w, u16le(m.length), m]) });
    out.push({ name: `v0-spec-nosigner-f${f}`, bytes: Buffer.concat([OFFCHAIN_DOMAIN, Buffer.from([0]), Buffer.alloc(32), Buffer.from([f, 0]), u16le(m.length), m]) });
  }
  out.push({ name: "v1", bytes: Buffer.concat([OFFCHAIN_DOMAIN, Buffer.from([1, 1]), w, m]) });
  return out;
}

/*
  B22, second form (2026-11-04: the built envelopes did not match the founder's Ledger): the browser also sends the bytes
  the wallet says it signed (Wallet Standard signMessage's signedMessage). They count only when the signature verifies
  over them for this wallet AND they are the stored message exactly, or a valid off-chain envelope whose message is the
  stored message exactly and whose signer list, where it has one, is this wallet alone:
    v0, the CLI's layout:  domain | 0 | format | u16 LE length | message
    v0, the spec's layout: domain | 0 | application domain (32, any) | format | signer count | signers | u16 LE length | message
    v1:                    domain | 1 | signer count | signers | message
  The format byte is 0, 1 or 2 (v3: any of them, as the built envelopes; the message itself is checked byte for byte).
*/
const SIGNED_FORMS = new Set(["raw", "v0-cli", "v0-spec", "v1"]);
const formatAllows = (fmt: number): boolean => fmt === 0 || fmt === 1 || fmt === 2;

/* What the signed bytes are: one of SIGNED_FORMS when they hold, otherwise why not (for the refusal's log line). */
export function signedForm(bytes: Uint8Array, message: string, wallet: string): string {
  const m = Buffer.from(message, "utf8");
  const s = Buffer.from(bytes);
  if (s.equals(m)) return "raw";
  if (s.length < 17 || !s.subarray(0, 16).equals(OFFCHAIN_DOMAIN)) return "not-an-envelope";
  const w = Buffer.from(bs58.decode(wallet));
  const judge = (form: string, fmt: number | null, signers: Buffer | null, len: number | null, body: Buffer): string => {
    if (signers !== null && !signers.equals(w)) return "signer-differs";
    if (len !== null && len !== body.length) return "length-differs";
    if (!body.equals(m)) return "body-differs";
    if (fmt !== null && !formatAllows(fmt)) return "format-differs";
    return form;
  };
  const signersAt = (at: number): { signers: Buffer; end: number } | null => {
    const n = s[at];
    const end = at + 1 + 32 * n;
    return n >= 1 && s.length >= end ? { signers: s.subarray(at + 1, end), end } : null;
  };
  if (s[16] === 1) {
    const g = signersAt(17);
    return g ? judge("v1", null, g.signers, null, s.subarray(g.end)) : "short";
  }
  if (s[16] !== 0) return `version-${s[16]}`;
  const cli = s.length >= 20 ? judge("v0-cli", s[17], null, s.readUInt16LE(18), s.subarray(20)) : "short";
  if (SIGNED_FORMS.has(cli)) return cli;
  const g = s.length >= 51 ? signersAt(50) : null;
  const spec = g && s.length >= g.end + 2 ? judge("v0-spec", s[49], g.signers, s.readUInt16LE(g.end), s.subarray(g.end + 2)) : "short";
  return SIGNED_FORMS.has(spec) ? spec : `${cli}/${spec}`;
}

/*
  A refusal's detail (Verified.detail), bytes as spaced hex: the signed bytes' first 40, the lengths, the signature, the
  wallet, the nonce and the issue time, what scripts/b22-offline-check.ts needs. B22's temporary devnet log line that
  wrote it was removed after PD8 (2026-11-04); nothing logs it now.
*/
export interface SignInDetail {
  step: "lines" | "signature";
  form: string;
  sigLen: number | null;
  signedLen: number | null;
  messageLen: number;
  head: string | null;
  sig: string | null;
  wallet: string;
  nonce: string;
  issuedAt: number | null;
  tried: number;
}
const hexOf = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join(" ");
const headOf = (b: Uint8Array | undefined): string | null => (b ? hexOf(b.subarray(0, 40)) : null);

export type Verified = { ok: true; cookie: string; exp: number; matched: string } | { ok: false; why: "no-nonce" | "expired" | "signature" | "config"; detail?: SignInDetail };

/* Check the signature over the wallet's message for this nonce, then spend the message once; the cookie value when it holds. */
export async function verifySignIn(kv: Kv, secret: string | null, a: { wallet: string; nonce: string; signature: string; signedMessage?: Uint8Array; cluster: string; host: string; nowSec: number }): Promise<Verified> {
  if (!secret) return { ok: false, why: "config" };
  if (!NONCE_RE.test(a.nonce)) return { ok: false, why: "no-nonce" };
  const key = nonceKey(a.wallet, a.nonce);
  const message = await kv(["GET", key]);
  if (typeof message !== "string") return { ok: false, why: "no-nonce" };
  const lines = message.split("\n");
  const exp = Date.parse((lines.find((l) => l.startsWith("Expiration Time: ")) ?? "").slice(17)) / 1000;
  const payloads = signInPayloads(message, a.wallet);
  const issued = Date.parse((lines.find((l) => l.startsWith("Issued At: ")) ?? "").slice(11)) / 1000;
  const detail = (step: SignInDetail["step"], got: Uint8Array | null): SignInDetail => ({
    step,
    form: a.signedMessage ? signedForm(a.signedMessage, message, a.wallet) : "none-sent",
    sigLen: got?.length ?? null,
    signedLen: a.signedMessage?.length ?? null,
    messageLen: Buffer.byteLength(message),
    head: headOf(a.signedMessage),
    sig: got ? hexOf(got) : null,
    wallet: hexOf(bs58.decode(a.wallet)),
    nonce: hexOf(Buffer.from(a.nonce, "utf8")),
    issuedAt: Number.isFinite(issued) ? issued : null,
    tried: payloads.length,
  });
  if (lines[0] !== `${a.host} wants you to sign in with your Solana account:` || lines[1] !== a.wallet || !lines.includes(`Chain ID: ${siwsChainId(a.cluster)}`) || !lines.includes(`Nonce: ${a.nonce}`)) return { ok: false, why: "signature", detail: detail("lines", null) };
  if (!Number.isFinite(exp) || exp < a.nowSec) return { ok: false, why: "expired" };
  let sig: Uint8Array;
  try {
    sig = bs58.decode(a.signature);
  } catch {
    return { ok: false, why: "signature", detail: detail("signature", null) };
  }
  const built = payloads.find((p) => ed25519Verifies(a.wallet, p.bytes, sig));
  const sent = !built && !!a.signedMessage && SIGNED_FORMS.has(signedForm(a.signedMessage, message, a.wallet)) && ed25519Verifies(a.wallet, a.signedMessage, sig);
  if (!built && !sent) return { ok: false, why: "signature", detail: detail("signature", sig) };
  const matched = built ? built.name : `sent-${signedForm(a.signedMessage!, message, a.wallet)}`;
  /* Spent only now, and only once: of two verifies racing with the right signature, one gets the cookie. */
  if (Number(await kv(["DEL", key])) !== 1) return { ok: false, why: "no-nonce" };
  const sessionExp = a.nowSec + SESSION_SECS;
  return { ok: true, cookie: sessionCookieValue(secret, { wallet: a.wallet, cluster: a.cluster, host: a.host, id: b64u(randomBytes(12)), exp: sessionExp }), exp: sessionExp, matched };
}

/* Sign-out (24c, I4): the cookie's id is refused until the cookie would have expired anyway. Throws unless the store acknowledged the write (24d, Astra R5-M1). */
export async function revokeSession(kv: Kv, s: Session, nowSec: number): Promise<void> {
  const left = s.exp - nowSec;
  if (left > 0 && (await kv(["SET", revokedKey(s.id), "1", "EX", left])) !== "OK") throw new Error("kv");
}

/*
  24d (Astra R5-M1, the founder: success only once the server acknowledges the revocation). "done": no session to end, or
  its revocation written and acknowledged, so the cookie may be cleared. "retry": a session exists and its revocation
  is not known to be written (no store, a refused or failed write, an unanswered one); the cookie stays, so the same
  sign-out can be sent again (the write is idempotent).
*/
export async function signOut(kv: Kv | null, s: Session | null, nowSec: number): Promise<"done" | "retry"> {
  if (!s) return "done";
  if (!kv) return "retry";
  try {
    await revokeSession(kv, s, nowSec);
    return "done";
  } catch {
    return "retry";
  }
}

/* The wallet a request is signed in as, for a permit (the attest route): a cookie that holds and is not revoked; a store that cannot say is no session. */
export async function sessionWallet(kv: Kv | null, cookie: Session | null): Promise<string | null> {
  if (!cookie) return null;
  try {
    return kv && !(await sessionRevoked(kv, cookie)) ? cookie.wallet : null;
  } catch {
    return null;
  }
}

/* Whether a cookie was signed out. Throws when the store cannot answer (the caller fails closed). */
export async function sessionRevoked(kv: Kv, s: Session): Promise<boolean> {
  const r = await kv(["GET", revokedKey(s.id)]);
  if (r !== null && r !== undefined && typeof r !== "string") throw new Error("kv");
  return r !== null && r !== undefined;
}
