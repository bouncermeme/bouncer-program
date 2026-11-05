/*
  POST /api/attest (0.29, docs/V029-DESIGN-2026-10-20.md section 6): the bot
  check at the door. A bid on a gated launch: body { launch, bidder }. A new
  launch (the seventh candidate's creation permit, docs/DIRECT-CALL-SAFETY-0.29.md
  section 8): body { action: "create", creator, launch, data (the
  create_launch data, base64) }. The Turnstile token in the
  x-turnstile-token header either way. Answers
    200 { attestor, expiry, message (base64: 125 bytes for a bid, 40 for a creation), signature (base64, 64 bytes) }
    403 { reason: "turnstile" | "launch-closed" | "unlisted" | "limit-wallet" | "limit-ip" | "limit-launch" | "balance" | "not-allowed" | "reserved" | "reserved-charset" | "ticker-live" | "ticker-trading" | "ticker-paying" | "ticker-held" }
    503 { reason: "signer-down" | "limit-budget" | "ticker-unchecked" }
  The steps, the limits, the registry and the signer are server/attest.ts.
  The attestor learns that this wallet asked to bid on this launch, or to
  create this one with these parameters, from this address; never a max, a
  deposit or a transaction. Never cached.
*/
import { PublicKey } from "@solana/web3.js";
import { ACCOUNTS } from "@contract/constants";
import { decodeConfig, decodeLaunch } from "@/lib/bouncer/chain/decode";
import { getConnection } from "@/lib/bouncer/chain/rpc";
import { clientOf } from "@/lib/rateLimit";
import { readTickerIndex } from "@/lib/bouncer/server/chainIndex";
import { kvFromEnv } from "@/lib/bouncer/server/kv";
import { cookieOf, readSessionFull, sessionSecret, sessionWallet } from "@/lib/bouncer/server/session";
import { CLUSTER } from "@contract/active";
import { batchedBalanceReader, cachedBalanceReader, depsFromEnv, issue, issueCreate, permitLine, TOKEN_MAX, type AttestFailure, type LaunchFacts } from "@/lib/bouncer/server/attest";
import { answer, fail, log, route, type FailureKind } from "@/lib/bouncer/server/output";
import { readConfig, readSnapshot, serverHasRpc } from "@/lib/bouncer/server/snapshot";
import { closeAtTs } from "@/lib/bouncer/view";

export const maxDuration = 15;

/* A creation's body carries the create_launch data: 566 bytes at the longest name, ticker and URI, 756 in base64. */
const BODY_MAX = 1_536;

const KIND: Record<AttestFailure, FailureKind> = {
  body: "attestBody",
  turnstile: "attestTurnstile",
  "launch-closed": "attestLaunchClosed",
  unlisted: "attestUnlisted",
  "limit-wallet": "attestLimitWallet",
  "limit-ip": "attestLimitIp",
  "limit-launch": "attestLimitLaunch",
  "limit-budget": "attestLimitBudget",
  balance: "attestBalance",
  "signer-down": "attestSignerDown",
  "not-allowed": "attestNotAllowed",
  reserved: "attestReserved",
  "reserved-charset": "attestReservedCharset",
  "ticker-live": "attestTickerLive",
  "ticker-trading": "attestTickerTrading",
  "ticker-paying": "attestTickerPaying",
  "ticker-pending": "attestTickerPending",
  "ticker-cooldown": "attestTickerCooldown",
  "wallet-pending": "attestWalletPending",
  session: "attestSession",
  "ticker-unchecked": "attestTickerUnchecked",
};


/* Open by the clock (state Open: an Initializing launch is not), the second step of genesis landed, and the attestor keys the config lists now. */
async function readLaunch(id: string): Promise<LaunchFacts | null> {
  const s = await readSnapshot(id);
  const raw = (b64: string | undefined) => (b64 ? Uint8Array.from(Buffer.from(b64, "base64")) : null);
  const l = raw(s.launch?.data);
  const c = raw(s.config?.data);
  const launch = l ? decodeLaunch(id, l) : null;
  const config = c ? decodeConfig(s.config!.address, c) : null;
  if (!launch || !config) return null;
  return { open: launch.state === "open" && Math.floor(Date.now() / 1000) < closeAtTs(launch), grown: launch.histogramGrown, attestors: config.attestors, minBid: launch.minBid, processingCharge: launch.processingCharge, attestRequired: launch.attestRequired };
}

/* The bidder's lamports (kept 15 s per instance; since 24e, wallets asked for within 25 ms share one getMultipleAccounts through the server's metered RPC), and the bid account's rent (kept an hour). */
const balanceOnce = cachedBalanceReader(
  /* 24g (Astra 24f F6): lamports only; a zero-length slice, so no account's data is read or paid for. */
  batchedBalanceReader(async (wallets) => (await getConnection().getMultipleAccountsInfo(wallets.map((w) => new PublicKey(w)), { commitment: "confirmed", dataSlice: { offset: 0, length: 0 } })).map((a) => BigInt(a?.lamports ?? 0))),
);
/* 2026-10-25 (the founder): a balance the RPC would not give (a refusal for rate past the metered fetch's own retries) is asked twice more, 1 to 2 s apart. The bot check's token is spent by now, so the browser cannot ask again with it. */
async function readBalance(wallet: string): Promise<bigint | null> {
  for (let round = 0; ; round++) {
    const held = await balanceOnce(wallet);
    if (held !== null || round >= 2) return held;
    await new Promise((r) => setTimeout(r, 1_000 * (1 + Math.random())));
  }
}
let rentKept: { at: number; lamports: bigint } | null = null;
async function readBidRent(): Promise<bigint | null> {
  if (rentKept && Date.now() - rentKept.at < 3_600_000) return rentKept.lamports;
  try {
    const lamports = BigInt(await getConnection().getMinimumBalanceForRentExemption(ACCOUNTS.Bid.len, "confirmed"));
    rentKept = { at: Date.now(), lamports };
    return lamports;
  } catch {
    return null;
  }
}

/* A creation has no launch to read yet: the config's attestor keys alone. */
async function readAttestors(): Promise<readonly string[] | null> {
  const s = await readConfig();
  const config = s.config ? decodeConfig(s.config.address, Uint8Array.from(Buffer.from(s.config.data, "base64"))) : null;
  return config ? config.attestors : null;
}

export const POST = route(async (req: Request): Promise<Response> => {
  if (!serverHasRpc()) return fail("attestSignerDown");
  let body: { action?: unknown; launch?: unknown; bidder?: unknown; creator?: unknown; data?: unknown } | null = null;
  try {
    const text = await req.text();
    if (text.length <= BODY_MAX) body = JSON.parse(text) as { action?: unknown; launch?: unknown; bidder?: unknown; creator?: unknown; data?: unknown };
  } catch {
    body = null;
  }
  if (!body || typeof body !== "object" || (body.action !== undefined && body.action !== "bid" && body.action !== "create")) return fail("attestBody");
  const header = req.headers.get("x-turnstile-token");
  const token = header && header.length <= TOKEN_MAX ? header : null;
  const ip = clientOf(req.headers);
  /* 23c: the copycat rules (the reservations' store and the finalized index; no store, no permit) and the creator's sign-in cookie. */
  const kv = kvFromEnv();
  const secret = sessionSecret();
  const ticker = kv ? { kv, readIndex: () => readTickerIndex(), log: (r: Record<string, unknown>) => log("info", r) } : { kv: async () => { throw new Error("no store"); }, readIndex: () => readTickerIndex() };
  /* 24c: the cookie is read on the host it was made for (I3) and refused once signed out (I4); a store that cannot say is no session. */
  const cookie = readSessionFull(secret, cookieOf(req.headers.get("cookie")), CLUSTER, new URL(req.url).host, Math.floor(Date.now() / 1000));
  const wallet = await sessionWallet(kv, cookie);
  const session = { configured: secret !== null, wallet };
  const deps = { ...depsFromEnv({ readLaunch, readAttestors, readBalance, readBidRent }), ticker, session };
  const create = body.action === "create";
  const r = create ? await issueCreate({ creator: body.creator, launch: body.launch, data: body.data, token, ip }, deps) : await issue({ launch: body.launch, bidder: body.bidder, token, ip }, deps);
  /* Every permit issued or refused, bid and create, one line (server/attest.ts permitLine says what is in it and what never is). */
  const line = permitLine(create ? "create" : "bid", create ? body.creator : body.bidder, body.launch, r);
  log(line.level, line.record);
  if (!r.ok) return fail(KIND[r.why]);
  /* The body is the Issued shape and nothing else (server/attest.ts builds it field by field). */
  return answer(r.issued, { cache: "no-store" });
});
