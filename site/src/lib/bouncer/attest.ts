/*
  The bid attestation, 0.29 (docs/V029-DESIGN-2026-10-20.md sections 4 and 6;
  the gate of docs/ADVERSARIAL-GRIEFING-2026-10-20.md section 14). A launch
  created while the config's attest_bids is on carries attest_required, and
  its commit must be preceded, in the same transaction and immediately
  before it, by an Ed25519 signature-verify instruction over this message,
  signed by one of the config's attestor keys:

    "bouncer/attest/bid/v1" (21) || program id (32) || launch (32) || bidder (32) || expiry i64 LE (8)

  125 bytes. The service signs it after the bot check (POST /api/attest,
  app/api/attest/route.ts); the browser checks every byte of what it was
  handed against what it asked for before it builds anything, so a wrong or
  stale answer is refused here, not by the program after the wallet signed.
  The attestor sees the wallet and the launch, never the max, the deposit or
  the transaction.

  The seventh candidate (the founder, 2026-10-20; docs/DIRECT-CALL-SAFETY-0.29.md
  section 8) gates creation the same way, with no waiver: the instruction
  immediately before create_launch verifies, by the same keys, the 40 bytes

    expiry i64 LE (8) || sha256(preimage) (32)
    preimage = "bouncer/attest/create/v1" (24) || program id || creator || launch || params hash || expiry i64 LE

  where the params hash is sha256 of the create_launch data after its
  8-byte discriminator, exactly as sent. The service registers the launch
  (the platform's own list) before it signs; the browser rebuilds every byte
  from what it asked for.

  Shared by the route (server/attest.ts builds the same bytes), the bid page
  and the create flow. No secrets here.
*/
import { Ed25519Program, PublicKey, type TransactionInstruction } from "@solana/web3.js";
import { ATTESTATION, CREATE_ATTESTATION } from "@contract/constants";
import { PROGRAM_ID } from "@contract/active";

/* The route's address. Same origin by default; NEXT_PUBLIC_ATTEST_URL names another service (a Worker beside the site) when there is one. */
export const ATTEST_URL: string = process.env.NEXT_PUBLIC_ATTEST_URL || "/api/attest";
/* The header the bot check's token travels in. */
export const TURNSTILE_HEADER = "x-turnstile-token";
/* The Turnstile site key (public). Unset: the bot check cannot run, and a gated launch says so instead of opening a wallet prompt. */
export const TURNSTILE_SITE_KEY: string = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY ?? "";
/* What the service sets: now plus 600 s (design section 6); the program refuses more than 900 ahead. */
export const ATTEST_LIFE_SECS = 600;

const TAG = new TextEncoder().encode(ATTESTATION.tag);
const CREATE_TAG = new TextEncoder().encode(CREATE_ATTESTATION.tag);
/* The Ed25519 instruction's fixed head: the count, the offsets record, the key and the signature; the message follows at 112. */
const IX_HEAD = ATTESTATION.messageOffset;

const sha256 = async (b: Uint8Array): Promise<Uint8Array> => new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", b as Uint8Array<ArrayBuffer>));

/* The params hash: sha256 of the create_launch data after the discriminator, the bytes the program reads back through the Instructions sysvar. */
export async function createParamsHash(createData: Uint8Array): Promise<Uint8Array> {
  return sha256(createData.subarray(8));
}

/* The 160-byte preimage and the 40 bytes that are signed, exactly as create_launch rebuilds them. */
export function createPreimage(creator: PublicKey, launch: PublicKey, paramsHash: Uint8Array, expiry: number, programId: PublicKey = new PublicKey(PROGRAM_ID)): Uint8Array {
  const m = new Uint8Array(CREATE_ATTESTATION.preimageLen);
  let o = 0;
  for (const part of [CREATE_TAG, programId.toBytes(), creator.toBytes(), launch.toBytes(), paramsHash]) {
    m.set(part, o);
    o += part.length;
  }
  new DataView(m.buffer).setBigInt64(o, BigInt(expiry), true);
  return m;
}
export async function createAttestMessage(creator: PublicKey, launch: PublicKey, createData: Uint8Array, expiry: number, programId: PublicKey = new PublicKey(PROGRAM_ID)): Promise<Uint8Array> {
  const m = new Uint8Array(CREATE_ATTESTATION.messageLen);
  new DataView(m.buffer).setBigInt64(CREATE_ATTESTATION.expiryOffset, BigInt(expiry), true);
  m.set(await sha256(createPreimage(creator, launch, await createParamsHash(createData), expiry, programId)), 8);
  return m;
}

/* The 125 bytes, exactly as the program rebuilds them in commit. */
export function attestMessage(launch: PublicKey, bidder: PublicKey, expiry: number, programId: PublicKey = new PublicKey(PROGRAM_ID)): Uint8Array {
  const m = new Uint8Array(ATTESTATION.messageLen);
  let o = 0;
  m.set(TAG, o);
  o += TAG.length;
  m.set(programId.toBytes(), o);
  o += 32;
  m.set(launch.toBytes(), o);
  o += 32;
  m.set(bidder.toBytes(), o);
  o += 32;
  new DataView(m.buffer).setBigInt64(o, BigInt(expiry), true);
  return m;
}

export interface Permit {
  attestor: string;
  expiry: number;
  message: Uint8Array;
  signature: Uint8Array;
}

/* The service's refusals (design section 6; "unlisted" since the seventh candidate), plus what this page can tell on its own. */
export type AttestReason = "turnstile" | "launch-closed" | "unlisted" | "limit-wallet" | "limit-ip" | "limit-launch" | "limit-budget" | "balance" | "signer-down" | "not-allowed" | "reserved" | "reserved-charset" | "ticker-live" | "ticker-trading" | "ticker-paying" | "ticker-pending" | "ticker-cooldown" | "wallet-pending" | "ticker-unchecked" | "session" | "unreachable" | "bad-answer" | "not-set-up";
/* "not-allowed" and "reserved" since the launch candidate (creationPolicy.ts): genesis mode and the reserved names, creation only. "limit-budget" (the day's signatures spent) and "balance" (a bid wallet under the minimum bid and its costs) since the M2 fix. */
const SERVICE_REASONS: ReadonlySet<string> = new Set(["turnstile", "launch-closed", "unlisted", "limit-wallet", "limit-ip", "limit-launch", "limit-budget", "balance", "signer-down", "not-allowed", "reserved", "reserved-charset", "ticker-live", "ticker-trading", "ticker-paying", "ticker-pending", "ticker-cooldown", "wallet-pending", "ticker-unchecked", "session"]);
export type AttestAction = "bid" | "create";

export class AttestRefused extends Error {
  constructor(
    public readonly reason: AttestReason,
    action: AttestAction = "bid",
  ) {
    super(attestReasonText(reason, action));
    this.name = "AttestRefused";
  }
}

/* One sentence for each, in the page's words: what happened, that nothing was sent, what to do. Creation has no waiver: while the check is down, new launches wait. */
export function attestReasonText(reason: AttestReason, action: AttestAction = "bid"): string {
  if (action === "create") {
    switch (reason) {
      case "turnstile":
        return "The bot check didn't pass. Reload to try again.";
      case "limit-wallet":
        return "This wallet has asked for the bot check too often. Try again later.";
      case "limit-ip":
        return "Too many bot checks from your network just now. Wait a minute and try again.";
      case "signer-down":
      case "unreachable":
        return "The bot check is down right now, so new launches wait. Launches already running are not affected. Try again in a few minutes.";
      case "not-set-up":
        return "This site has no bot check set up, and every new launch needs one.";
      case "not-allowed":
        return "Creating launches is invite-only for now, and this wallet is not on the list. Nothing was sent.";
      case "reserved":
        return "This name or ticker is reserved. Pick another. Nothing was sent.";
      case "reserved-charset":
        return "A ticker is 1 to 10 letters A to Z or digits. Change it. Nothing was sent.";
      /* 22e3, the copycat block (the founder, 2026-10-23): the lines /create shows under the ticker. */
      case "ticker-live":
        return "That ticker is taken by a live launch.";
      case "ticker-trading":
        return "That ticker is taken by a token that's trading.";
      /* P-T2 (the founder, 2026-10-27). */
      case "ticker-paying":
        return "That ticker is taken by a launch paying out.";
      /* 23c (copycat v2; DESIGN.md sections 3, 6 and 8). */
      case "ticker-pending":
        return "That ticker is taken by a launch being created.";
      case "ticker-cooldown":
        return "This wallet's last launches never went live. Wait an hour and try again.";
      case "wallet-pending":
        return "This wallet already has a launch being created. Finish it, or wait 10 minutes.";
      case "session":
        return "Sign in with this wallet first. Nothing was sent.";
      case "ticker-unchecked":
        return "Can't check the ticker right now. Try again in a minute.";
      case "limit-budget":
        return "The bot check has reached today's limit, so new launches wait. Try again later. Nothing was sent.";
      default:
        return "The bot check answered with something this page could not verify. Try again.";
    }
  }
  switch (reason) {
    case "turnstile":
      return "The bot check didn't pass. Reload to try again.";
    case "launch-closed":
      return "This launch is not taking bids right now, so the bot check was not issued.";
    case "unlisted":
      return "This launch was not created through this site, so it takes no bids here.";
    case "limit-wallet":
      return "This wallet has asked for the bot check too often. Try again later.";
    case "limit-ip":
      return "Too many bot checks from your network just now. Wait a minute and try again.";
    case "limit-launch":
      return "This launch is taking a lot of bids at once. Try again in a minute.";
    case "limit-budget":
      return "The bot check has reached today's limit. Try again later. Nothing was sent.";
    case "balance":
      return "This wallet holds less than the minimum bid plus its costs. Add SOL and try again. Nothing was sent.";
    case "signer-down":
    case "unreachable":
      return "The bot check is down right now, so bids on this launch cannot be placed through this site. If it stays down, the operator can switch the check off for this launch, and this page will say so.";
    case "bad-answer":
      return "The bot check answered with something this page could not verify. Try again.";
    case "not-set-up":
      return "This site has no bot check set up, and this launch requires one.";
    case "not-allowed":
    case "reserved":
    case "reserved-charset":
    case "ticker-live":
    case "ticker-trading":
    case "ticker-paying":
    case "ticker-pending":
    case "ticker-cooldown":
    case "wallet-pending":
    case "ticker-unchecked":
    case "session":
      return "The bot check answered with something this page could not verify. Try again.";
  }
}

const b64 = (s: unknown): Uint8Array | null => {
  if (typeof s !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(s)) return null;
  try {
    const bin = atob(s);
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
};
const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);

/*
  The service's answer, checked whole: the message is exactly the bytes for
  this launch and this wallet at the stated expiry, the expiry is ahead and
  within the program's 900 s, the key is one of the config's attestors, and
  the signature is 64 bytes (its validity is the precompile's to check, and a
  bad one fails the whole transaction before anything runs).
*/
export function checkPermit(raw: unknown, want: { launch: PublicKey; bidder: PublicKey; attestors: readonly string[]; nowSec: number }): Permit {
  const p = readAnswer(raw, want.attestors, want.nowSec, "bid");
  if (!sameBytes(p.message, attestMessage(want.launch, want.bidder, p.expiry))) throw new AttestRefused("bad-answer");
  return p;
}

/* The Ed25519 program's single-signature instruction: key at 16, signature at 48, message at 112, every index u16::MAX (the data is in this instruction). 237 bytes for a bid's 125-byte message, 152 for a creation's 40. */
export function attestInstruction(p: Permit): TransactionInstruction {
  const ix = Ed25519Program.createInstructionWithPublicKey({ publicKey: new PublicKey(p.attestor).toBytes(), message: p.message, signature: p.signature });
  const want = p.message.length === CREATE_ATTESTATION.messageLen ? CREATE_ATTESTATION.ixLen : ATTESTATION.ixLen;
  if (ix.data.length !== want || ix.data.length !== IX_HEAD + p.message.length) throw new AttestRefused("bad-answer");
  return ix;
}

/* The answer's common shape: the key in the config's set, the expiry ahead and within 900 s, a 64-byte signature. The message is the caller's to compare. */
function readAnswer(raw: unknown, attestors: readonly string[], nowSec: number, action: AttestAction): Permit {
  const bad = () => new AttestRefused("bad-answer", action);
  if (!raw || typeof raw !== "object") throw bad();
  const r = raw as Record<string, unknown>;
  const message = b64(r.message);
  const signature = b64(r.signature);
  const expiry = r.expiry;
  const attestor = r.attestor;
  if (!message || !signature || signature.length !== 64 || typeof expiry !== "number" || !Number.isSafeInteger(expiry) || typeof attestor !== "string") throw bad();
  let key: PublicKey;
  try {
    key = new PublicKey(attestor);
  } catch {
    throw bad();
  }
  if (!attestors.includes(key.toBase58())) throw bad();
  if (expiry <= nowSec || expiry - nowSec > ATTESTATION.maxLifeSecs) throw bad();
  return { attestor: key.toBase58(), expiry, message, signature };
}

/* A creation permit, checked whole: the 40 bytes rebuilt from this creator, this launch and these exact parameters at the stated expiry. */
export async function checkCreatePermit(raw: unknown, want: { creator: PublicKey; launch: PublicKey; createData: Uint8Array; attestors: readonly string[]; nowSec: number }): Promise<Permit> {
  const p = readAnswer(raw, want.attestors, want.nowSec, "create");
  if (!sameBytes(p.message, await createAttestMessage(want.creator, want.launch, want.createData, p.expiry))) throw new AttestRefused("bad-answer", "create");
  return p;
}

/*
  2026-10-25 (the founder): the site's burst stop (proxy.ts) answers 429 before the route reads the token, so the token is
  still unspent and the same request is sent again after a random, growing wait (1 to 2 s, then 2 to 4, then 4 to 8, or
  the Retry-After asked, at most 8 s), three times at most. The route itself never answers 429.
*/
async function postWithBackoff(url: string, init: RequestInit): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, init);
    if (res.status !== 429 || attempt >= 3) return res;
    const asked = Number(res.headers.get("retry-after"));
    const base = asked > 0 ? Math.min(asked * 1000, 8_000) : Math.min(1_000 * 2 ** attempt, 8_000);
    await new Promise((r) => setTimeout(r, base * (1 + Math.random())));
  }
}

/* Ask the service, with the bot check's token. A refusal comes back typed; anything unreadable is "bad-answer", no answer "unreachable". */
export async function requestPermit(input: { launch: string; bidder: string; token: string; attestors: readonly string[] }, url: string = ATTEST_URL): Promise<Permit> {
  let res: Response;
  try {
    res = await postWithBackoff(url, { method: "POST", headers: { "content-type": "application/json", [TURNSTILE_HEADER]: input.token }, body: JSON.stringify({ launch: input.launch, bidder: input.bidder }), cache: "no-store" });
  } catch {
    throw new AttestRefused("unreachable");
  }
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  if (!res.ok) {
    const reason = body && typeof body === "object" ? (body as { reason?: unknown }).reason : undefined;
    throw new AttestRefused(typeof reason === "string" && SERVICE_REASONS.has(reason) ? (reason as AttestReason) : res.status >= 500 ? "signer-down" : "bad-answer");
  }
  return checkPermit(body, { launch: new PublicKey(input.launch), bidder: new PublicKey(input.bidder), attestors: input.attestors, nowSec: Math.floor(Date.now() / 1000) });
}

/* The creation permit: the creator, the launch it derives and the create_launch data (base64), with the bot check's token. The service registers the launch before it signs. */
export async function requestCreatePermit(input: { creator: string; launch: string; createData: Uint8Array; token: string; attestors: readonly string[] }, url: string = ATTEST_URL): Promise<Permit> {
  let res: Response;
  try {
    res = await postWithBackoff(url, { method: "POST", headers: { "content-type": "application/json", [TURNSTILE_HEADER]: input.token }, body: JSON.stringify({ action: "create", creator: input.creator, launch: input.launch, data: btoa(String.fromCharCode(...input.createData)) }), cache: "no-store" });
  } catch {
    throw new AttestRefused("unreachable", "create");
  }
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  if (!res.ok) {
    const reason = body && typeof body === "object" ? (body as { reason?: unknown }).reason : undefined;
    throw new AttestRefused(typeof reason === "string" && SERVICE_REASONS.has(reason) ? (reason as AttestReason) : res.status >= 500 ? "signer-down" : "bad-answer", "create");
  }
  return checkCreatePermit(body, { creator: new PublicKey(input.creator), launch: new PublicKey(input.launch), createData: input.createData, attestors: input.attestors, nowSec: Math.floor(Date.now() / 1000) });
}
