/*
  The site's RPC route (2026-10-15, the launch data path's Phase B). The
  browser's every chain read and send comes here when the build's
  NEXT_PUBLIC_RPC_URL is "/api/rpc"; the route forwards it to RPC_UPSTREAM,
  the keyed endpoint, which is a server variable and never ships to a
  browser. The local board (scripts/local-board.sh) sets BOARD_RPC_UPSTREAM
  instead, its own validator. With neither set the route does not exist
  (404), as on today's devnet build.

  What passes, and nothing else:
  - the methods below, each with its arguments checked: addresses and
    signatures by shape, numbers as unsigned integers, options by name and
    value. A call with any other key, or a method not listed, is refused
    and the whole batch with it, and nothing is forwarded;
  - getProgramAccounts only for the Bouncer program in the two shapes the
    site asks: the board (Launch accounts by size and discriminator, keys
    only or whole) and a launch's bids (Bid accounts by size and launch);
  - sendTransaction and simulateTransaction, a transaction's bytes.
  Then by ACCOUNT (server/scope.ts, Astra 2026-10-17c: the founder's Bouncer-only
  rule): an address must be the program, a fixed companion, a launch the
  program created, an account derived from one, or the context wallet's
  own account on a launch; a signature one the site handed out or one the
  caller proves with its signed transaction; a transaction one that calls
  the program (or the pool program on a launch's pool). A call outside that
  is refused with the batch and nothing is forwarded; the only paid call a
  stranger can cause is the site's own scan of its launches, once per 15 s.
  Caps, before anything is parsed: a body of 64 KB in UTF-8 bytes
  (content-length first, then the bytes as they arrive, stopped at the cap
  whatever the header said or omitted), 20 calls in a batch, and (24e) a
  send at most SEND_FALLBACK_PER_SECOND a second per instance
  (server/sendBudget.ts), refused as busy before anything is forwarded. The upstream
  has 10 s to answer. A refusal for rate (HTTP 429 or the node's -32005), a
  dropped connection or a 5xx is retried with a short backoff for up to 5 s:
  every method here is safe to repeat, a send included, because the bytes
  are the same and the network keeps one copy. Sends and the pin's reads
  skip the instance's queue; everything else waits for one of its slots.

  Nothing of the upstream's own words reaches a browser (2026-10-16, after
  GPT-6's final review): this file constructs no Response and writes no
  log line. Every failure is a kind named to the output policy
  (server/output.ts rpcFail), and a 2xx answer is rebuilt there from its
  envelope (rpcAnswer): a result as it came, with the node's free-text
  places (a transaction error, the program log lines) re-rendered from a
  typed grammar; an error with a code and a sentence rendered from its
  typed err, never the provider's message. Every forwarded call is charged
  to the day's budget first (server/budget.ts): on devnet, past the soft line
  only a send and its surroundings go through, past the budget nothing does;
  on a mainnet pin the charge counts, and only a browsing read is refused,
  past the soft line. The client's totals (lib/rateLimit.ts) are counted in
  credits: the proxy counted the request, the rest is counted here.
  The only log line is the accepted method names and their counts, per
  invocation: no params, no addresses, no client.
*/
import { createHash } from "node:crypto";
import { ACCOUNTS } from "@contract/constants";
import { fail, log, relay, route, rpcAnswer, rpcFail, rpcFailEach, type Json, type Sent } from "@/lib/bouncer/server/output";
import { charge, creditsOf, isBudgetExhausted } from "@/lib/bouncer/server/budget";
import { clientOf, rpcCredits, totalsConfig } from "@/lib/rateLimit";
import { callAllowed, contextOf, keysNamed, learnFromAnswer, parseHints } from "@/lib/bouncer/server/scope";
import { DEPLOYMENT as deployment } from "@contract/active";
import { sendBucket, sendRateFromEnv, type SendBucket } from "@/lib/bouncer/server/sendBudget";

export const maxDuration = 30;

const MAX_BODY = 64 * 1024;
const MAX_BATCH = 20;
const UPSTREAM_MS = 10_000;
const RETRY_WINDOW_MS = 5_000;
const RETRY_BACKOFF_MS = [250, 500, 1_000, 2_000];
/* Requests this instance forwards at once besides the urgent ones, and how long a request waits for a slot before it is told the site is busy. */
const SLOTS = 32;
const QUEUE_WAIT_MS = 8_000;
/* A transaction is at most 1,232 bytes, 1,644 characters in base64; the cap leaves room for the encoding web3.js chooses. */
const MAX_TX_CHARS = 1_800;
const MAX_KEYS = 100;
const MAX_SIGNATURES = 256;

const PROGRAM_ID = deployment.program_id;
const PROGRAM_DATA = deployment.program_data_account;
const B58 = /^[1-9A-HJ-NP-Za-km-z]+$/;
const B64 = /^[A-Za-z0-9+/]+={0,2}$/;
const COMMITMENTS = new Set(["processed", "confirmed", "finalized"]);
/* The encodings web3.js sends for the site's reads: bytes for accounts, json or jsonParsed for transactions (a transaction result is typed by the policy whatever its encoding). */
const ENCODINGS = new Set(["base64", "base58", "base64+zstd", "json", "jsonParsed"]);

type Call = { jsonrpc?: Json; id?: Json; method?: Json; params?: Json };
type Check = (v: Json | undefined) => boolean;

const isObj = (v: Json | undefined): v is { [k: string]: Json } => typeof v === "object" && v !== null && !Array.isArray(v);
const isUint = (v: Json | undefined): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= Number.MAX_SAFE_INTEGER;
const isBool = (v: Json | undefined): v is boolean => typeof v === "boolean";
const isPubkey = (v: Json | undefined): v is string => typeof v === "string" && v.length >= 32 && v.length <= 44 && B58.test(v);
const isSignature = (v: Json | undefined): v is string => typeof v === "string" && v.length >= 86 && v.length <= 88 && B58.test(v);
const isCommitment: Check = (v) => typeof v === "string" && COMMITMENTS.has(v);
const isEncoding: Check = (v) => typeof v === "string" && ENCODINGS.has(v);
const isTxBytes: Check = (v) => typeof v === "string" && v.length <= MAX_TX_CHARS && (B64.test(v) || B58.test(v));
const listOf =
  (item: Check, max: number): Check =>
  (v) =>
    Array.isArray(v) && v.length >= 1 && v.length <= max && v.every(item);
const optional =
  (c: Check): Check =>
  (v) =>
    v === undefined || c(v);
/* An options object with only the named keys, each passing its check. */
const options =
  (keys: Record<string, Check>): Check =>
  (v) =>
    v === undefined || (isObj(v) && Object.entries(v).every(([k, x]) => k in keys && keys[k](x)));
const isDataSlice = options({ offset: isUint, length: isUint });
const read = { commitment: isCommitment, encoding: isEncoding, minContextSlot: isUint };
const accountRead = options({ ...read, dataSlice: isDataSlice });

/* The site's two getProgramAccounts shapes: a size filter and one memcmp, on the Bouncer program. */
const isFilter: Check = (f) => {
  if (!isObj(f)) return false;
  const keys = Object.keys(f);
  if (keys.length !== 1) return false;
  if (keys[0] === "dataSize") return f.dataSize === ACCOUNTS.Launch.len || f.dataSize === ACCOUNTS.Bid.len;
  if (keys[0] === "memcmp") {
    const m = f.memcmp;
    return isObj(m) && (m.offset === 0 || m.offset === ACCOUNTS.Bid.fields.launch.offset) && typeof m.bytes === "string" && m.bytes.length <= 44 && B58.test(m.bytes) && Object.keys(m).every((k) => k === "offset" || k === "bytes" || (k === "encoding" && m.encoding === "base58"));
  }
  return false;
};
const isProgramFilters: Check = (v) => Array.isArray(v) && v.length === 2 && v.every(isFilter) && v.some((f) => isObj(f) && "dataSize" in f) && v.some((f) => isObj(f) && "memcmp" in f);

/* Each method: the check of each positional parameter, in order; a parameter past the list refuses the call. */
const METHODS: Record<string, Check[]> = {
  getAccountInfo: [isPubkey, accountRead],
  getMultipleAccounts: [listOf(isPubkey, MAX_KEYS), accountRead],
  getProgramAccounts: [(v) => v === PROGRAM_ID, (v) => isObj(v) && "filters" in v && options({ ...read, dataSlice: isDataSlice, filters: isProgramFilters, withContext: isBool })(v)],
  getBalance: [isPubkey, options(read)],
  getTokenAccountBalance: [isPubkey, options(read)],
  getMinimumBalanceForRentExemption: [isUint, options({ commitment: isCommitment })],
  getGenesisHash: [],
  getLatestBlockhash: [options(read)],
  getBlockHeight: [options(read)],
  getSlot: [options(read)],
  /* 24i (Claude L1): the height and the slot from one node, for the expiry verdict (chain/signer.ts settle). */
  getEpochInfo: [options(read)],
  getBlockTime: [isUint],
  getFirstAvailableBlock: [],
  getSignatureStatuses: [listOf(isSignature, MAX_SIGNATURES), options({ searchTransactionHistory: isBool })],
  getSignaturesForAddress: [isPubkey, options({ ...read, limit: (v) => isUint(v) && v <= 1000, before: isSignature, until: isSignature })],
  getTransaction: [isSignature, options({ ...read, maxSupportedTransactionVersion: isUint })],
  sendTransaction: [isTxBytes, options({ encoding: isEncoding, skipPreflight: isBool, preflightCommitment: isCommitment, maxRetries: (v) => isUint(v) && v <= 5, minContextSlot: isUint })],
  simulateTransaction: [isTxBytes, options({ ...read, sigVerify: isBool, replaceRecentBlockhash: isBool, innerInstructions: isBool, accounts: options({ encoding: isEncoding, addresses: listOf(isPubkey, MAX_KEYS) }) })],
};

/* Calls that go ahead of the queue and past the budget's soft line: a send and every read the signer makes around it (the cluster check's genesis hash, the balance it requires, the rent it prices, the blockhash, the confirmation), and the pin's reads of the program data account. */
const URGENT = new Set(["sendTransaction", "simulateTransaction", "getLatestBlockhash", "getBlockHeight", "getEpochInfo", "getSignatureStatuses", "getGenesisHash", "getBalance", "getMinimumBalanceForRentExemption"]);
function urgent(c: Call): boolean {
  if (typeof c.method !== "string") return false;
  if (URGENT.has(c.method)) return true;
  return c.method === "getAccountInfo" && Array.isArray(c.params) && c.params[0] === PROGRAM_DATA;
}

/* 24e: the fallback send's budget on this instance (server/sendBudget.ts). */
let takeSend: SendBucket | null = null;

/*
  24i (Astra R8-M1, Claude M1): the sends this instance has forwarded, by a hash of their signed bytes. A refusal made
  before forwarding is marked notForwarded only when this instance never forwarded those bytes: a resend of bytes that
  already reached the node (the browser's own retries come back with the same bytes) stays uncertain. Another
  instance's forward is the browser's to remember (chain/rpc.ts fetchWithBackoff, chain/signer.ts broadcast).
  24j (Astra R9-L1; the founder's final rule): the mark is a hint the browser may use to read the chain less often, never proof
  of anything. Once this instance has forgotten a send (past FORWARDED_SENDS_MAX), any send it does not hold may be one
  it forgot, so nothing is marked from then on.
*/
const FORWARDED_SENDS_MAX = 4_096;
const forwardedSends = new Set<string>();
let forgotSends = false;
const sendKeys = (calls: Call[]): string[] =>
  calls.filter((c) => c.method === "sendTransaction" && Array.isArray(c.params)).map((c) => createHash("sha256").update(String((c.params as unknown[])[0])).digest("hex").slice(0, 32));
function noteForwarded(keys: string[]): void {
  for (const k of keys) {
    forwardedSends.delete(k);
    forwardedSends.add(k);
  }
  while (forwardedSends.size > FORWARDED_SENDS_MAX) {
    forwardedSends.delete(forwardedSends.values().next().value as string);
    forgotSends = true;
  }
}
const neverForwarded = (keys: string[]): boolean => !forgotSends && keys.every((k) => !forwardedSends.has(k));

/* Whether a call is one the site sends. The reason stays here; the browser gets the kind. */
function accepted(c: Call): boolean {
  if (typeof c.method !== "string") return false;
  const checks = METHODS[c.method];
  if (!checks) return false;
  const params = c.params === undefined ? [] : c.params;
  if (!Array.isArray(params)) return false;
  if (params.length > checks.length) return false;
  for (let i = 0; i < checks.length; i++) if (!(i < params.length ? checks[i](params[i]) : optional(checks[i])(undefined))) return false;
  if (c.id !== undefined && c.id !== null && typeof c.id !== "string" && typeof c.id !== "number") return false;
  if (c.jsonrpc !== undefined && c.jsonrpc !== "2.0") return false;
  return true;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/* The instance's slots for the reads that are not urgent, first come first served. */
let inFlight = 0;
const waiting: (() => void)[] = [];
async function slot(): Promise<boolean> {
  if (inFlight < SLOTS) {
    inFlight++;
    return true;
  }
  const got = await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      const i = waiting.indexOf(wake);
      if (i >= 0) waiting.splice(i, 1);
      resolve(false);
    }, QUEUE_WAIT_MS);
    const wake = () => {
      clearTimeout(timer);
      inFlight++;
      resolve(true);
    };
    waiting.push(wake);
  });
  return got;
}
function release(): void {
  inFlight--;
  const next = waiting.shift();
  if (next) next();
}

/* The rebuild of a 2xx answer, by name, for the probes that call it as the route's own (review/2026-10-16-gpt6-final). */
export const safeAnswer = (text: string): string | null => rpcAnswer(text);

/* Forward the checked calls, retrying a refusal for rate, a 5xx or a dropped connection within the window; every attempt is charged to the day. */
async function forward(upstream: string, body: string, methods: string[], sent: Sent, isUrgent: boolean, sends = 0, keys: string[] = []): Promise<Response> {
  const started = Date.now();
  for (let attempt = 0; ; attempt++) {
    const decision = await charge(methods, isUrgent);
    /* 24g (Astra 24f F5, F3): refused before the first try, nothing was forwarded: the sends' tokens go back, and the refusal says so. */
    if (decision === "refused") {
      if (attempt === 0 && sends > 0) takeSend?.back(sends);
      return rpcFail("budget", { notForwarded: attempt === 0 && neverForwarded(keys) });
    }
    let res: Response | null = null;
    let text = "";
    /* From here the bytes may reach the node, whatever the answer. */
    noteForwarded(keys);
    try {
      res = await fetch(upstream, { method: "POST", headers: { "content-type": "application/json" }, body, cache: "no-store", signal: AbortSignal.timeout(UPSTREAM_MS) });
      text = await res.text();
    } catch (e) {
      if ((e as Error)?.name === "TimeoutError") return rpcFail("timeout");
      res = null;
    }
    const limited = res !== null && (res.status === 429 || (text.length < 2_000 && /"code":\s*-32005\b/.test(text)));
    const down = res === null || res.status >= 500;
    if (!limited && !down) {
      if (res!.ok) {
        const safe = rpcAnswer(text, sent);
        if (safe === null) return rpcFail("shape");
        /* What this answer handed out (a send's signature, a signature list) may be asked for next (server/scope.ts). */
        learnFromAnswer(safe, (id) => sent.get(id)?.method);
        return relay(safe, decision);
      }
      /* Any other refusal (a key refused, a path not found, a method the provider blocks): the kind with the status number; the provider's body goes nowhere. */
      return rpcFail("refusedHttp", { n: res!.status });
    }
    const wait = RETRY_BACKOFF_MS[Math.min(attempt, RETRY_BACKOFF_MS.length - 1)];
    if (Date.now() - started + wait > RETRY_WINDOW_MS) return rpcFail(limited ? "busy" : "down");
    await sleep(wait);
  }
}

/*
  The body, read chunk by chunk and stopped at the cap in UTF-8 bytes, not
  characters (a three-byte character counts three), whatever content-length
  said or omitted (2026-10-16, GPT-6's A5). "tooLarge" once the cap is
  passed, the rest of the stream cancelled unread; "body" when the client's
  own stream fails mid-way (the adversarial review: that exception used to
  leave the handler).
*/
async function readBody(req: Request): Promise<{ ok: true; text: string } | { ok: false; why: "tooLarge" | "body" }> {
  if (!req.body) return { ok: true, text: "" };
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY) {
        await reader.cancel().catch(() => undefined);
        return { ok: false, why: "tooLarge" };
      }
      chunks.push(value);
    }
  } catch {
    return { ok: false, why: "body" };
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.byteLength;
  }
  return { ok: true, text: new TextDecoder().decode(all) };
}

export const POST = route(async (req: Request): Promise<Response> => {
  const upstream = process.env.RPC_UPSTREAM || process.env.BOARD_RPC_UPSTREAM;
  if (!upstream) return fail("notFound");
  const declared = Number(req.headers.get("content-length") ?? 0);
  if (declared > MAX_BODY) return rpcFail("tooLarge");
  const read = await readBody(req);
  if (!read.ok) return rpcFail(read.why);
  let body: Json;
  try {
    body = JSON.parse(read.text);
  } catch {
    return rpcFail("parse");
  }
  const batch = Array.isArray(body);
  const calls = (batch ? body : [body]) as Call[];
  if (calls.length === 0 || calls.length > MAX_BATCH || !calls.every(isObj)) return rpcFail("batch", { n: MAX_BATCH });
  const ok = calls.map(accepted);
  if (ok.some((x) => !x)) return rpcFailEach(calls.map((c, i) => ({ kind: ok[i] ? "refusedWithBatch" : "notServed", id: c.id })), batch);
  /* By account (server/scope.ts): Bouncer data only, judged before any paid call. The scan it may need is charged to the day; a refused scan is the budget's refusal. */
  let scoped: boolean[];
  try {
    const hints = parseHints(req.headers);
    const ctx = await contextOf(hints, keysNamed(calls));
    scoped = [];
    for (const c of calls) scoped.push(await callAllowed(c, hints, ctx));
  } catch (e) {
    /* 24j (Claude I-1): refused before anything was forwarded, so marked like the other refusals made here. */
    if (isBudgetExhausted(e)) return rpcFail("budget", { notForwarded: neverForwarded(sendKeys(calls)) });
    throw e;
  }
  if (scoped.some((x) => !x)) return rpcFailEach(calls.map((c, i) => ({ kind: scoped[i] ? "refusedWithBatch" : "outOfScope", id: c.id })), batch);
  /*
    One line per invocation for the runtime log (2026-10-15): the accepted
    JSON-RPC method names and how many of each, nothing else. No params, no
    addresses, no signatures, no client. So a minute's sends through the
    route can be counted later (a wallet that sends itself leaves no
    sendTransaction here), on mainnet as on devnet. Only after the allowlist
    check, so every name logged is one the route serves.
  */
  const methods = calls.map((c) => String(c.method));
  const counts: Record<string, number> = {};
  for (const m of methods) counts[m] = (counts[m] ?? 0) + 1;
  log("info", { rpc: counts });
  /* S1 (b): the client's totals in credits; the proxy counted one for the request. */
  rpcCredits(clientOf(req.headers), creditsOf(methods) - 1, totalsConfig());
  /* The checked calls as the site sent them, nothing more: a call's known keys only. */
  const clean = calls.map((c) => ({ jsonrpc: "2.0", id: c.id ?? null, method: c.method, params: c.params ?? [] }));
  const forwarded = JSON.stringify(batch ? clean : clean[0]);
  /* What was sent under each id: the method types the answer, the id goes back as sent. */
  const sent: Sent = new Map(clean.map((c) => [String(c.id), { method: String(c.method), id: c.id ?? null }]));
  const isUrgent = calls.every(urgent);
  const sends = methods.filter((m) => m === "sendTransaction").length;
  const keys = sendKeys(clean as Call[]);
  if (sends > 0 && !(takeSend ??= sendBucket(sendRateFromEnv()))(sends)) return rpcFail("busy", { notForwarded: neverForwarded(keys) });
  if (isUrgent) return forward(upstream, forwarded, methods, sent, true, sends, keys);
  if (!(await slot())) {
    if (sends > 0) takeSend?.back(sends);
    return rpcFail("siteBusy", { notForwarded: neverForwarded(keys) });
  }
  try {
    return await forward(upstream, forwarded, methods, sent, false, sends, keys);
  } finally {
    release();
  }
}, "rpc");

export const GET = route(async (): Promise<Response> => fail("notFound"));
