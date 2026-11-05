/*
  The site's one output policy (2026-10-16, after GPT-6's final review).

  Three times an upstream's words reached a browser or a log through a gap
  in a per-route fix: a 4xx body (A1), a 200 JSON-RPC error with only
  "api-key=" blanked (N1), then node-shaped sentences, program log lines
  and err objects carrying an invented token past a prefix match (F1), the
  volume job's report and log (F2). Instance fixes end here. Every byte the
  server emits, a response body or a log line, leaves through this module,
  and the module knows only four ways to make one:

  1. A fixed sentence from the closed table below (fail, rpcFail). No route
     writes error text; a route names a kind, and the table has the words.
     The only variables are numbers.
  2. A typed body the site built itself (answer): the chain's bytes, slots,
     addresses, counts, closed enums. Before it leaves, the serialised text
     is checked against the server's own secrets (the keyed URL, its host
     and segments, the cron secret, the store token) and the shapes a key
     travels in (api-key, bearer, authorization). A body that carries one
     is withheld whole and a scrubbed line is logged. The check cannot
     catch a stranger's text, which is why nothing untyped reaches a body:
  3. The chain's answer relayed by the RPC route (rpcAnswer, relay). The
     envelope is rebuilt, never passed. A result passes as it came except
     in the two places the node writes free text: a transaction error is
     re-rendered from its typed form (TX_ERRORS, IX_ERRORS: a closed
     vocabulary, numbers for indices and codes) and a program log line is
     kept only when it parses in the runtime's grammar (LOG_LINE). An
     error's message is rendered from its typed `err`, never taken from the
     provider; a message with no typed err is the fixed sentence with the
     code.
  4. A log line (log): a JSON record whose every string is scrubbed of URLs,
     query values, header-like pairs, token-shaped runs and the known
     secrets, and capped.

  scripts/check-output-policy.cjs holds the whole tree to this: no route
  constructs a Response or writes to console; no server module writes to
  console or interpolates into an Error; GPT-6's probes and planted tokens
  run through every route at build time. The build fails on any of it.
*/
import bs58 from "bs58";
import { toJson } from "../chain/json";
import { categoryOf } from "../chain/upstreamError";
import { budgetStatus, type BudgetState } from "./budget";

export type Json = string | number | boolean | null | Json[] | { [k: string]: Json };
export const isObj = (v: Json | undefined): v is { [k: string]: Json } => typeof v === "object" && v !== null && !Array.isArray(v);
const isU8 = (v: Json | undefined): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 255;
const isU32 = (v: Json | undefined): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 0xffffffff;

/* ------------------------------------------------------------------ */
/* 1. The closed table of failures.                                    */
/* ------------------------------------------------------------------ */

interface Failure {
  status: number;
  text: string;
  /* text/plain, as the two paths that predate the JSON bodies answer. */
  plain?: boolean;
  retryAfter?: number;
  /* Fixed extra fields beside `error`, booleans only. */
  fields?: Record<string, boolean | string>;
  /* 0.29: the attestation route's machine-readable refusal (design section 6), a fixed word from this table. */
  reason?: string;
}
const FAILURES = {
  notFound: { status: 404, text: "Not found", plain: true },
  unauthorized: { status: 401, text: "Unauthorized", plain: true },
  /* A cron route whose secret is not set does nothing (GPT-6's F3). */
  notConfigured: { status: 500, text: "Not configured." },
  badAddress: { status: 400, text: "Not a launch address." },
  /* 24e: the shared status read (app/api/tx/[signature]). */
  badSignature: { status: 400, text: "Not a transaction signature." },
  badList: { status: 400, text: "Not a launch address and its winners." },
  notWinners: { status: 400, text: "Not this launch's winners." },
  historyIncomplete: { status: 409, text: "The launch's history is not complete yet. Try again in a moment.", retryAfter: 20, fields: { complete: false } },
  rpcDown: { status: 502, text: "The RPC did not answer." },
  /* 24e: the endpoint refused for rate after the server's own retries; the browser waits and asks again (chain/rpc.ts fetchWithBackoff). */
  rpcBusy: { status: 429, text: "The RPC is busy. Try again in a moment.", retryAfter: 2 },
  volumeNone: { status: 503, text: "No volume summary yet." },
  volumeUnreadable: { status: 503, text: "The volume summary could not be read." },
  volumeRefreshFailed: { status: 503, text: "The volume refresh failed." },
  priceOff: { status: 503, text: "The SOL price feed is turned off." },
  priceNone: { status: 503, text: "No SOL quote from any source." },
  priceBadTs: { status: 400, text: "ts must be unix seconds" },
  priceNotYet: { status: 425, text: "not yet" },
  priceNoHistory: { status: 503, text: "No price history answered for that minute." },
  /* The day's chain read budget is spent and nothing is kept to serve (server/budget.ts). */
  budgetSpent: { status: 503, text: "Today's chain reads are used up. Try again after midnight UTC.", retryAfter: 60 },
  /* The day's external price reads are used up (server/budget.ts, the price meter). */
  priceBudgetSpent: { status: 503, text: "Today's price reads are used up. Try again after midnight UTC.", retryAfter: 60 },
  /* The token store (api/token, the founder's item 7 / S8): what an upload or a relay can refuse, each its own sentence. */
  uploadNotConfigured: { status: 500, text: "Uploads are not configured on this site." },
  uploadBody: { status: 400, text: "The upload could not be read." },
  /* 24h: field "image" marks a refusal of the picture itself; the create page says it under the picture's field. */
  uploadTooLarge: { status: 413, text: "Keep the image under 2 MB.", fields: { field: "image" } },
  uploadBadName: { status: 400, text: "The name or ticker is not valid." },
  uploadBadImage: { status: 400, text: "The image could not be read. Use a PNG, JPEG or WebP.", fields: { field: "image" } },
  uploadNotSquare: { status: 400, text: "The image must be square, at least 64 pixels a side.", fields: { field: "image" } },
  /* 2026-10-20 (the founder, upload hardening): an SVG says so by name; a header past the side limit is refused before it is decoded. */
  uploadSvg: { status: 400, text: "SVG pictures are not accepted. Use a PNG, JPEG or WebP.", fields: { field: "image" } },
  /* 24h (the founder, 2026-10-25): no GIFs for now, by their bytes (lib/bouncer/imagePolicy.ts), whatever name or type they came with. */
  uploadGif: { status: 400, text: "GIF pictures are not accepted. Use a PNG, JPEG or WebP.", fields: { field: "image" } },
  uploadTooManyPixels: { status: 400, text: "Keep the image under 4096 pixels a side.", fields: { field: "image" } },
  uploadBudgetSpent: { status: 503, text: "Today's uploads are used up. Try again after midnight UTC.", retryAfter: 60 },
  uploadStoreDown: { status: 503, text: "The picture store did not answer. Try again in a minute.", retryAfter: 60 },
  /* Socials A (review/2026-10-30-mainnet-steps/SOCIALS-A-SPEC.md section 2, SOCIALS-A-ANSWER.md R1 to R12): the four optional boxes' refusals, each the sentence lib/bouncer/socialLinks.ts SOCIAL_WORDS says under the box (scripts/check-socials.ts holds them equal); sent only through failField, which adds the box's name (ask 2). */
  uploadDescriptionLong: { status: 400, text: "Use at most 280 characters." },
  uploadDescriptionHidden: { status: 400, text: "The description has characters that cannot be shown. Remove them and try again." },
  uploadDescriptionBreaks: { status: 400, text: "Use at most 3 line breaks." },
  uploadWebsiteHttps: { status: 400, text: "Use a link that starts with https://" },
  uploadWebsiteAddress: { status: 400, text: "That is not a website address." },
  uploadWebsiteSocial: { status: 400, text: "Put X and Telegram links in their own boxes." },
  uploadLinkLong: { status: 400, text: "Keep the link to 200 characters or fewer." },
  uploadX: { status: 400, text: "Use an X handle (@name) or an x.com link." },
  uploadTelegram: { status: 400, text: "Use a Telegram name (@name) or a t.me link." },
  uploadOfficialLink: { status: 400, text: "Links to Bouncer's own site and accounts are for $BOUNCER only." },
  /* Socials A, the overwrite lock (server/tokenStore.ts putToken): a file is already at the path with other bytes; nothing was written. */
  uploadTaken: { status: 409, text: "A different file is already stored under this name. Nothing was stored." },
  /* A body that carried one of the server's own secrets: never sent. */
  withheld: { status: 500, text: "The answer was withheld." },
  /* A handler threw something the policy did not expect (route()): the fixed answer, a scrubbed line, never the platform's own page. */
  failed: { status: 500, text: "The request failed." },
  /* A minute before the first launch has no market cap to price. */
  priceTooOld: { status: 400, text: "ts is before the first launch." },
  /* 0.29: the attestation route (app/api/attest/route.ts; docs/V029-DESIGN-2026-10-20.md section 6). */
  /* 22e3: the copycat check behind /create (app/api/ticker/route.ts). */
  tickerBody: { status: 400, text: "Not a ticker and a wallet." },
  attestBody: { status: 400, text: "Not a launch and a wallet." },
  attestTurnstile: { status: 403, text: "The bot check did not pass.", reason: "turnstile" },
  attestLaunchClosed: { status: 403, text: "This launch is not taking bids.", reason: "launch-closed" },
  attestUnlisted: { status: 403, text: "This launch was not created through this site.", reason: "unlisted" },
  attestLimitWallet: { status: 403, text: "This wallet has asked too often.", reason: "limit-wallet", retryAfter: 600 },
  attestLimitIp: { status: 403, text: "Too many requests from this address.", reason: "limit-ip", retryAfter: 60 },
  attestLimitLaunch: { status: 403, text: "This launch is taking too many bids at once.", reason: "limit-launch", retryAfter: 60 },
  attestSignerDown: { status: 503, text: "The attestation service is down.", reason: "signer-down", retryAfter: 60 },
  /* The launch candidate (creationPolicy.ts): genesis mode and the reserved names. */
  attestNotAllowed: { status: 403, text: "Creating launches is invite-only for now.", reason: "not-allowed" },
  attestReserved: { status: 403, text: "This name or ticker is reserved.", reason: "reserved" },
  attestReservedCharset: { status: 403, text: "A ticker is 1 to 10 letters A to Z or digits.", reason: "reserved-charset" },
  /* The adversarial review's M2: the day's signature budget spent, and a bidder wallet holding less than a bid takes. */
  attestLimitBudget: { status: 503, text: "The bot check has reached today's limit.", reason: "limit-budget", retryAfter: 3600 },
  attestBalance: { status: 403, text: "This wallet holds less than the minimum bid and its costs.", reason: "balance" },
  /* 22e3, the copycat block (server/ticker.ts): who holds a ticker is never said, only how. */
  attestTickerLive: { status: 403, text: "That ticker is taken by a live launch.", reason: "ticker-live" },
  attestTickerTrading: { status: 403, text: "That ticker is taken by a token that's trading.", reason: "ticker-trading" },
  /* P-T2 (the founder, 2026-10-27): a v0.30 launch paying out holds its ticker too. */
  attestTickerPaying: { status: 403, text: "That ticker is taken by a launch paying out.", reason: "ticker-paying" },
  /* 23c (copycat v2): a pending reservation, the no-show cooldown, the wallet's one pending launch, and no sign-in. */
  attestTickerPending: { status: 403, text: "That ticker is taken by a launch being created.", reason: "ticker-pending" },
  attestTickerCooldown: { status: 403, text: "This wallet is cooling down.", reason: "ticker-cooldown", retryAfter: 3600 },
  attestWalletPending: { status: 403, text: "This wallet already has a launch being created.", reason: "wallet-pending", retryAfter: 600 },
  attestSession: { status: 401, text: "Sign in with this wallet first.", reason: "session" },
  /* 23c: the creator sign-in (app/api/session/route.ts). */
  sessionBody: { status: 400, text: "Not a sign-in request." },
  sessionRefused: { status: 403, text: "The sign-in did not verify." },
  sessionDown: { status: 503, text: "Sign-in is unavailable just now.", retryAfter: 60 },
  attestTickerUnchecked: { status: 503, text: "The ticker could not be checked just now.", reason: "ticker-unchecked", retryAfter: 60 },
  /* The admin ticker release (app/api/admin/ticker-release/route.ts): a signature that is not the admin's says nothing more. */
  adminBody: { status: 400, text: "Not an admin request." },
  adminRefused: { status: 403, text: "The signature did not verify." },
  adminDown: { status: 503, text: "The release is unavailable just now.", retryAfter: 60 },
  /* v0.30 item 8: the same-name notice list (app/api/names, app/api/admin/names) when the shared store does not answer. */
  namesDown: { status: 503, text: "The same-name list is unavailable just now.", retryAfter: 60 },
} as const satisfies Record<string, Failure>;
export type FailureKind = keyof typeof FAILURES;

/* The RPC route's failures: a JSON-RPC envelope with a code. The only variable is a number. */
interface RpcFailure {
  status: number;
  code: number;
  text: (n: number) => string;
  retryAfter?: number;
}
const RPC_FAILURES = {
  tooLarge: { status: 413, code: -32600, text: () => "The request is too large." },
  parse: { status: 400, code: -32700, text: () => "Parse error" },
  batch: { status: 400, code: -32600, text: (n) => `A batch holds 1 to ${n} calls.` },
  notServed: { status: 200, code: -32601, text: () => "The method or a parameter is not one the site sends." },
  /* The account, signature or transaction is not Bouncer data (server/scope.ts): refused before any paid call. */
  outOfScope: { status: 200, code: -32601, text: () => "Not an account, signature or transaction of this site's launches." },
  refusedWithBatch: { status: 200, code: -32600, text: () => "Refused with the batch: another call in it is not one the site sends." },
  timeout: { status: 504, code: -32000, text: () => "The RPC did not answer in time." },
  shape: { status: 502, code: -32000, text: () => "The RPC answered in a shape the site does not read." },
  refusedHttp: { status: 502, code: -32000, text: (n) => `The RPC refused the request (HTTP ${n}).` },
  busy: { status: 429, code: -32005, text: () => "The RPC is busy. Try again in a moment.", retryAfter: 2 },
  siteBusy: { status: 503, code: -32005, text: () => "The site is busy. Try again in a moment.", retryAfter: 3 },
  down: { status: 502, code: -32000, text: () => "The RPC did not answer." },
  budget: { status: 503, code: -32000, text: () => "Today's chain reads are used up. Try again after midnight UTC.", retryAfter: 60 },
  withheld: { status: 500, code: -32000, text: () => "The answer was withheld." },
  /* The client's own stream failed mid-body: nothing of it is read. */
  body: { status: 400, code: -32600, text: () => "The request body could not be read." },
  failed: { status: 500, code: -32000, text: () => "The request failed." },
} as const satisfies Record<string, RpcFailure>;
export type RpcFailureKind = keyof typeof RPC_FAILURES;

/* The sentence a rebuilt JSON-RPC error carries when its err is not typed: the code, a number, is the only variable. */
export const refusedCall = (code: number): string => `The RPC refused the call (${code}).`;

const NO_STORE = { "cache-control": "no-store" } as const;

/* A fixed failure. `numbers` are the only extra values a route may add beside the sentence. */
export function fail(kind: FailureKind, opts: { numbers?: Record<string, number>; retryAfter?: number } = {}): Response {
  const f: Failure = FAILURES[kind];
  const headers: Record<string, string> = { ...NO_STORE, "x-bouncer-budget": budgetStatus().state };
  const retry = opts.retryAfter ?? f.retryAfter;
  if (retry !== undefined) headers["retry-after"] = String(retry);
  if (f.plain) return new Response(f.text, { status: f.status, headers: { ...headers, "content-type": "text/plain; charset=utf-8" } });
  const body: Record<string, Json> = { error: f.text, ...(f.fields ?? {}) };
  if (f.reason) body.reason = f.reason;
  for (const [k, v] of Object.entries(opts.numbers ?? {})) if (typeof v === "number" && Number.isFinite(v)) body[k] = v;
  return new Response(JSON.stringify(body), { status: f.status, headers: { ...headers, "content-type": "application/json" } });
}

/*
  Socials A (SOCIALS-A-ANSWER.md ask 2): a refusal of one of the upload's four optional boxes names the box, so the
  create form says it under that box. The field is set when sent, from this closed list only (the same four as
  lib/bouncer/socialLinks.ts SOCIAL_FIELDS); any other value is left out, and only the kinds in SOCIAL_FAILURES carry
  one. One kind per sentence, as every refusal here. scripts/check-output-policy.cjs probes both rules.
*/
export const UPLOAD_FIELDS = ["description", "website", "x", "telegram"] as const;
export type UploadField = (typeof UPLOAD_FIELDS)[number];
export const SOCIAL_FAILURES = ["uploadDescriptionLong", "uploadDescriptionHidden", "uploadDescriptionBreaks", "uploadWebsiteHttps", "uploadWebsiteAddress", "uploadWebsiteSocial", "uploadLinkLong", "uploadX", "uploadTelegram", "uploadOfficialLink"] as const satisfies readonly FailureKind[];
export type SocialFailureKind = (typeof SOCIAL_FAILURES)[number];
export function failField(kind: SocialFailureKind, field: UploadField): Response {
  if (!(SOCIAL_FAILURES as readonly string[]).includes(kind)) return fail("failed");
  const f: Failure = FAILURES[kind];
  const body: Record<string, Json> = { error: f.text };
  if ((UPLOAD_FIELDS as readonly string[]).includes(field)) body.field = field;
  return new Response(JSON.stringify(body), { status: f.status, headers: { ...NO_STORE, "x-bouncer-budget": budgetStatus().state, "content-type": "application/json" } });
}

/* 24g (Astra 24f F3): notForwarded marks a refusal made before anything reached the node; the signer then knows nothing was sent (chain/signer.ts notForwarded). It is data, never shown. */
const rpcEnvelope = (kind: RpcFailureKind, id: Json | undefined, n = 0, notForwarded = false) => ({ jsonrpc: "2.0", id: id ?? null, error: { code: RPC_FAILURES[kind].code, message: RPC_FAILURES[kind].text(n), ...(notForwarded ? { data: { notForwarded: true } } : {}) } });

/* A JSON-RPC failure for the RPC route: one envelope, the kind's status and code, a number at most. */
export function rpcFail(kind: RpcFailureKind, opts: { id?: Json; n?: number; notForwarded?: boolean } = {}): Response {
  const f: RpcFailure = RPC_FAILURES[kind];
  const headers: Record<string, string> = { ...NO_STORE, "content-type": "application/json", "x-bouncer-budget": budgetStatus().state };
  if (f.retryAfter !== undefined) headers["retry-after"] = String(f.retryAfter);
  return new Response(JSON.stringify(rpcEnvelope(kind, opts.id, opts.n, !!opts.notForwarded)), { status: f.status, headers });
}

/* A batch refused before anything is forwarded: one envelope per call, each its own kind, HTTP 200 as the route has always answered a refused call. */
export function rpcFailEach(items: { kind: RpcFailureKind; id: Json | undefined }[], batch: boolean): Response {
  const body = items.map((i) => rpcEnvelope(i.kind, i.id));
  return new Response(JSON.stringify(batch ? body : body[0]), { status: 200, headers: { ...NO_STORE, "content-type": "application/json", "x-bouncer-budget": budgetStatus().state } });
}

/*
  Every route's handler is exported through this (the gate requires it): an
  exception that escapes the handler becomes the fixed answer and a
  scrubbed log line, never the platform's own 500 page and its unscrubbed
  log of the exception (2026-10-16, the adversarial review: a client stream
  that died mid-body left the policy).
*/
export function route<A extends unknown[]>(fn: (...args: A) => Promise<Response>, envelope: "json" | "rpc" = "json"): (...args: A) => Promise<Response> {
  return async (...args: A) => {
    try {
      return await fn(...args);
    } catch (e) {
      log("error", { unhandled: "a route handler threw; the fixed answer went out", category: categoryOf(e), why: noteOf(e) });
      return envelope === "rpc" ? rpcFail("failed") : fail("failed");
    }
  };
}

/* ------------------------------------------------------------------ */
/* 2. Typed bodies, checked against the server's own secrets.          */
/* ------------------------------------------------------------------ */

/* Every string the server must never emit: the keyed URL whole, its host, its long path segments and query values, the cron secret, the store token, the board password. Read at each call: tests set them late. */
export function secretFragments(env: NodeJS.ProcessEnv = process.env): string[] {
  const out = new Set<string>();
  const decoded = (s: string): string | null => {
    try {
      const d = decodeURIComponent(s);
      return d !== s ? d : null;
    } catch {
      return null;
    }
  };
  const addUrl = (u: string | undefined) => {
    if (!u || u.length < 8) return;
    out.add(u);
    const d = decoded(u);
    if (d) out.add(d);
    try {
      const p = new URL(u);
      if (p.host) out.add(p.host);
      for (const seg of p.pathname.split("/")) if (seg.length >= 8) out.add(seg);
      p.searchParams.forEach((v) => {
        if (v.length >= 8) out.add(v);
      });
      /* a URL's userinfo is a secret too, as written and decoded */
      for (const part of [p.username, p.password]) {
        if (part.length >= 8) out.add(part);
        const pd = decoded(part);
        if (pd && pd.length >= 8) out.add(pd);
      }
    } catch {
      /* not a URL: the string itself is in the set */
    }
  };
  addUrl(env.RPC_UPSTREAM);
  addUrl(env.BOARD_RPC_UPSTREAM);
  addUrl(env.RPC_SERVER_URL);
  addUrl(env.RPC_SERVER_FALLBACK_URL);
  for (const k of ["CRON_SECRET", "BLOB_READ_WRITE_TOKEN", "BOARD_PASSWORD", "SPEND_COUNTER_TOKEN", "KV_REST_API_TOKEN", "UPSTASH_REDIS_REST_TOKEN", "BOUNCER_AWS_SECRET_ACCESS_KEY", "BOUNCER_AWS_DEVNET_SECRET_ACCESS_KEY", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "VERCEL_OIDC_TOKEN", "ATTEST_SIGNER_KEY", "TURNSTILE_SECRET_KEY", "SESSION_SECRET", "COMING_SOON_KEY", "REVIEW_KEY"]) {
    const v = env[k];
    if (v && v.length >= 8) out.add(v);
  }
  return [...out];
}

/*
  The shapes a key travels in, the name with a token-length value beside
  it: a key the server did not enumerate but a provider echoed. The name
  alone is not one (a creator may call a token "Bearer Market", a program
  may log the word; 2026-10-16, the adversarial review: the bare words
  withheld a launch's whole history).
*/
const KEY_SHAPES = /(?:api[-_]?key|x-api-key|access[-_]token|client[-_]secret)\s*[=:]\s*["']?[A-Za-z0-9._~+/=-]{8,}|\bbearer\s+[A-Za-z0-9._~+/=-]{16,}|authorization\s*:\s*(?:[A-Za-z]+\s+)?[A-Za-z0-9._~+/=-]{16,}/i;

/* True when a text carries one of the server's secrets (as written or percent-decoded) or a key's shape with a value. For bodies: nothing typed the site builds has either. */
export function leaks(text: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (KEY_SHAPES.test(text)) return true;
  const lower = text.toLowerCase();
  let decodedLower = lower;
  try {
    decodedLower = decodeURIComponent(lower);
  } catch {
    /* not decodable as a whole: the raw text is checked */
  }
  return secretFragments(env).some((s) => {
    const needle = s.toLowerCase();
    return lower.includes(needle) || decodedLower.includes(needle);
  });
}

export interface AnswerOptions {
  status?: number;
  cache?: string;
  headers?: Record<string, string>;
}

/* A typed body the site built. Serialised with the site's JSON (bigints kept), checked, and headed with the budget's state. */
export function answer(body: unknown, opts: AnswerOptions = {}): Response {
  const text = toJson(body) ?? "null";
  if (leaks(text)) {
    log("error", { withheld: "a response body carried a secret or a key shape", bytes: text.length });
    return fail("withheld");
  }
  return new Response(text, {
    status: opts.status ?? 200,
    headers: { "content-type": "application/json", "cache-control": opts.cache ?? "no-store", "x-bouncer-budget": budgetStatus().state, ...(opts.headers ?? {}) },
  });
}

/* The kinds a stored file can be: the four the upload route sniffs, and the metadata file it writes. */
const STORED_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif", "application/json"]);

/*
  A file the site stored itself (a launch's picture or its metadata file,
  api/token/[file]), relayed as stored under a long cache: its name is its
  content's hash, so what it serves never changes. The type is the one the
  upload route sniffed from the bytes and wrote with the file; anything else
  goes out as plain bytes. Open to every origin: wallets and explorers read
  the metadata file from theirs.
*/
export function relayStored(stream: ReadableStream<Uint8Array>, contentType: string, opts: { size?: number | null } = {}): Response {
  const headers: Record<string, string> = {
    "content-type": STORED_TYPES.has(contentType) ? contentType : "application/octet-stream",
    "cache-control": "public, max-age=86400, s-maxage=31536000, immutable",
    "x-content-type-options": "nosniff",
    "access-control-allow-origin": "*",
  };
  if (opts.size != null && opts.size > 0) headers["content-length"] = String(opts.size);
  return new Response(stream, { status: 200, headers });
}

/* The RPC route's relay of a rebuilt envelope (rpcAnswer's text). The same secret check, then out. */
export function relay(text: string, budget: BudgetState = budgetStatus().state): Response {
  if (leaks(text)) {
    log("error", { withheld: "a relayed RPC answer carried a secret or a key shape", bytes: text.length });
    return rpcFail("withheld");
  }
  return new Response(text, { status: 200, headers: { ...NO_STORE, "content-type": "application/json", "x-bouncer-budget": budget } });
}

/* ------------------------------------------------------------------ */
/* 3. The chain's answer: a typed grammar for its two free-text places. */
/* ------------------------------------------------------------------ */

/* solana_sdk::transaction::TransactionError, the variants without a payload. */
const TX_ERRORS = new Set([
  "AccountInUse", "AccountLoadedTwice", "AccountNotFound", "ProgramAccountNotFound", "InsufficientFundsForFee", "InvalidAccountForFee", "AlreadyProcessed", "BlockhashNotFound", "CallChainTooDeep", "MissingSignatureForFee", "InvalidAccountIndex", "SignatureFailure", "InvalidProgramForExecution", "SanitizeFailure", "ClusterMaintenance", "AccountBorrowOutstanding", "WouldExceedMaxBlockCostLimit", "UnsupportedVersion", "InvalidWritableAccount", "WouldExceedMaxAccountCostLimit", "WouldExceedAccountDataBlockLimit", "TooManyAccountLocks", "AddressLookupTableNotFound", "InvalidAddressLookupTableOwner", "InvalidAddressLookupTableIndex", "InvalidAddressLookupTableData", "InvalidRentPayingAccount", "WouldExceedMaxVoteCostLimit", "WouldExceedAccountDataTotalLimit", "MaxLoadedAccountsDataSizeExceeded", "InvalidLoadedAccountsDataSizeLimit", "ResanitizationNeeded", "UnbalancedTransaction", "ProgramCacheHitMaxLimit", "CommitCancelled",
]);
/* The node's own sentence for the variants the signer reads (signer.ts, errors.ts); the variant's name for the rest. */
const TX_SENTENCES: Record<string, string> = {
  BlockhashNotFound: "Blockhash not found",
  AccountNotFound: "Attempt to debit an account but found no record of a prior credit.",
  InsufficientFundsForFee: "Insufficient funds for fee",
  AlreadyProcessed: "This transaction has already been processed",
};
/* solana_sdk::instruction::InstructionError, the variants without a payload. */
const IX_ERRORS = new Set([
  "GenericError", "InvalidArgument", "InvalidInstructionData", "InvalidAccountData", "AccountDataTooSmall", "InsufficientFunds", "IncorrectProgramId", "MissingRequiredSignature", "AccountAlreadyInitialized", "UninitializedAccount", "UnbalancedInstruction", "ModifiedProgramId", "ExternalAccountLamportSpend", "ExternalAccountDataModified", "ReadonlyLamportChange", "ReadonlyDataModified", "DuplicateAccountIndex", "ExecutableModified", "RentEpochModified", "NotEnoughAccountKeys", "AccountDataSizeChanged", "AccountNotExecutable", "AccountBorrowFailed", "AccountBorrowOutstanding", "DuplicateAccountOutOfSync", "InvalidError", "ExecutableDataModified", "ExecutableLamportChange", "ExecutableAccountNotRentExempt", "UnsupportedProgramId", "CallDepth", "MissingAccount", "ReentrancyNotAllowed", "MaxSeedLengthExceeded", "InvalidSeeds", "InvalidRealloc", "ComputationalBudgetExceeded", "PrivilegeEscalation", "ProgramEnvironmentSetupFailure", "ProgramFailedToComplete", "ProgramFailedToCompile", "Immutable", "IncorrectAuthority", "AccountNotRentExempt", "InvalidAccountOwner", "ArithmeticOverflow", "UnsupportedSysvar", "IllegalOwner", "MaxAccountsDataAllocationsExceeded", "MaxAccountsExceeded", "MaxInstructionTraceLengthExceeded", "BuiltinProgramsMustConsumeComputeUnits",
]);
const IX_SENTENCES: Record<string, string> = {
  InsufficientFunds: "insufficient funds for instruction",
  ComputationalBudgetExceeded: "Computational budget exceeded",
  ProgramFailedToComplete: "Program failed to complete",
  AccountNotRentExempt: "An account does not have enough lamports to be rent-exempt",
  MaxInstructionTraceLengthExceeded: "Max instruction trace length exceeded",
};

function safeIxError(v: Json | undefined): Json | undefined {
  if (typeof v === "string") return IX_ERRORS.has(v) ? v : undefined;
  if (!isObj(v) || Object.keys(v).length !== 1) return undefined;
  if ("Custom" in v) return isU32(v.Custom) ? { Custom: v.Custom } : undefined;
  /* BorshIoError carries the runtime's text; the name alone is kept. */
  if ("BorshIoError" in v) return "BorshIoError";
  return undefined;
}

/* A transaction error in its typed form, or undefined when it is not one. */
export function safeTxError(err: Json | undefined): Json | undefined {
  if (typeof err === "string") return TX_ERRORS.has(err) ? err : undefined;
  if (!isObj(err) || Object.keys(err).length !== 1) return undefined;
  const k = Object.keys(err)[0];
  const v = err[k];
  if (k === "InstructionError") {
    if (!Array.isArray(v) || v.length !== 2 || !isU8(v[0])) return undefined;
    const ie = safeIxError(v[1]);
    return ie === undefined ? undefined : { InstructionError: [v[0], ie] };
  }
  if (k === "DuplicateInstruction") return isU8(v) ? { DuplicateInstruction: v } : undefined;
  if ((k === "InsufficientFundsForRent" || k === "ProgramExecutionTemporarilyRestricted") && isObj(v) && Object.keys(v).length === 1 && isU8(v.account_index)) return { [k]: { account_index: v.account_index } };
  return undefined;
}

/* The node's sentence for a typed error, rendered here, never taken from the provider. */
export function sentenceOf(err: Json): string {
  if (typeof err === "string") return TX_SENTENCES[err] ?? err;
  if (isObj(err) && Array.isArray(err.InstructionError)) {
    const [n, ie] = err.InstructionError as [number, Json];
    const reason = isObj(ie) && typeof ie.Custom === "number" ? `custom program error: 0x${ie.Custom.toString(16)}` : typeof ie === "string" ? (IX_SENTENCES[ie] ?? ie) : "instruction error";
    return `Error processing Instruction ${n}: ${reason}`;
  }
  if (isObj(err)) return Object.keys(err)[0];
  return "transaction error";
}

/* A typed error that stays truthy: a failed transaction must never read as landed because its err did not parse. */
const errOrUnknown = (v: Json | undefined): Json | undefined => (v === undefined || v === null ? v : (safeTxError(v) ?? "UnknownError"));

/* A base58 string that decodes to 32 bytes: an address, not a token of the same alphabet. */
const B58_KEY = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
export function isAddress(s: string): boolean {
  if (!B58_KEY.test(s)) return false;
  try {
    return bs58.decode(s).length === 32;
  } catch {
    return false;
  }
}

/*
  The runtime's log lines (events.ts reads the invoke and return lines and the
  data lines; signer.ts reads the failed lines and Anchor's error line) and a
  program's own line in a plain shape. A line is kept only when it parses.
  Program and runtime text can carry anything a program prints; a provider
  could print anything at all. Plain text is letters, digits, spaces and the
  punctuation of a sentence, at most 160 characters, with no run of twelve or
  more letters-and-digits (a token's shape; an address is one, and the lines
  that name one are the typed ones above).
*/
const PK = "([1-9A-HJ-NP-Za-km-z]{32,44})";
const B64 = "([A-Za-z0-9+/]+={0,2})";
const LOG_LINE = {
  invoke: new RegExp(`^Program ${PK} invoke \\[(\\d{1,3})\\]$`),
  success: new RegExp(`^Program ${PK} success$`),
  failed: new RegExp(`^Program ${PK} failed: (.{1,200})$`),
  consumed: new RegExp(`^Program ${PK} consumed (\\d{1,12}) of (\\d{1,12}) compute units$`),
  log: /^Program log: (.{0,400})$/,
  data: new RegExp(`^Program data: ${B64}$`),
  returned: new RegExp(`^Program return: ${PK} ${B64}$`),
  truncated: /^Log truncated$/,
  transfer: /^Transfer: insufficient lamports (\d{1,20}), need (\d{1,20})$/,
};
const CUSTOM = /^custom program error: 0x([0-9a-fA-F]{1,8})$/;
const TOKEN_RUN = /(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{12,}/;
const PLAIN = /^[A-Za-z0-9 .,:;!'()%+-]{1,160}$/;
const plain = (s: string): boolean => PLAIN.test(s) && !TOKEN_RUN.test(s);
/* Anchor's error line: "AnchorError thrown in programs/x/src/lib.rs:12. Error Code: Name. Error Number: 6001. Error Message: words." and its "occurred" and "caused by account: name" forms. */
const ANCHOR = /^AnchorError (thrown in (programs\/[A-Za-z0-9_./-]{1,120}\.rs:\d{1,6})|occurred|caused by account: ([a-z0-9_]{1,64}))\. Error Code: ([A-Za-z0-9_]{1,64})\. Error Number: (\d{1,6})\.( Error Message: (.{1,200}))?$/;

/* A failed line's reason: the custom code, or a plain runtime sentence; anything else drops the reason and keeps the program. */
function failedReason(reason: string): string | null {
  const c = CUSTOM.exec(reason);
  if (c) return `custom program error: 0x${c[1].toLowerCase()}`;
  return plain(reason) ? reason : null;
}

export function safeLogLine(line: string, where: "result" | "error"): string | null {
  if (typeof line !== "string" || line.length > 2_000) return null;
  let m: RegExpExecArray | null;
  if ((m = LOG_LINE.invoke.exec(line))) return isAddress(m[1]) ? `Program ${m[1]} invoke [${Number(m[2])}]` : null;
  if ((m = LOG_LINE.success.exec(line))) return isAddress(m[1]) ? `Program ${m[1]} success` : null;
  if ((m = LOG_LINE.failed.exec(line))) {
    if (!isAddress(m[1])) return null;
    const reason = failedReason(m[2]);
    return reason ? `Program ${m[1]} failed: ${reason}` : `Program ${m[1]} failed`;
  }
  if ((m = LOG_LINE.consumed.exec(line))) return isAddress(m[1]) ? `Program ${m[1]} consumed ${Number(m[2])} of ${Number(m[3])} compute units` : null;
  if (LOG_LINE.truncated.test(line)) return line;
  if ((m = LOG_LINE.transfer.exec(line))) return `Transfer: insufficient lamports ${Number(m[1])}, need ${Number(m[2])}`;
  if ((m = LOG_LINE.log.exec(line))) {
    const text = m[1];
    const a = ANCHOR.exec(text);
    if (a) {
      const head = a[2] ? `thrown in ${a[2]}` : a[3] ? `caused by account: ${a[3]}` : "occurred";
      const message = a[7] && plain(a[7]) ? ` Error Message: ${a[7]}` : "";
      return `Program log: AnchorError ${head}. Error Code: ${a[4]}. Error Number: ${Number(a[5])}.${message}`;
    }
    if (/^Instruction: [A-Za-z0-9_]{1,64}$/.test(text)) return `Program log: ${text}`;
    return plain(text) ? `Program log: ${text}` : null;
  }
  /* The chain's event and return bytes: read by the history parser from a result; nothing reads them from an error. */
  if (where === "result") {
    if ((m = LOG_LINE.data.exec(line))) return `Program data: ${m[1]}`;
    if ((m = LOG_LINE.returned.exec(line))) return isAddress(m[1]) ? `Program return: ${m[1]} ${m[2]}` : null;
  }
  return null;
}

const safeLogs = (v: Json | undefined, where: "result" | "error"): string[] | undefined => (Array.isArray(v) ? v.filter((l): l is string => typeof l === "string").map((l) => safeLogLine(l, where)).filter((l): l is string => l !== null).slice(0, 256) : undefined);

/* A JSON-RPC error rebuilt: the code, the sentence rendered from the typed err, the typed err, the parsed program lines, the units. Nothing of the provider's own words. */
export function rpcErrorOf(e: Json | undefined): Json {
  const o = isObj(e) ? e : {};
  const code = typeof o.code === "number" && Number.isInteger(o.code) ? o.code : -32000;
  const data = isObj(o.data) ? o.data : {};
  const err = safeTxError(data.err);
  const out: { [k: string]: Json } = { code, message: err !== undefined ? `Transaction simulation failed: ${sentenceOf(err)}` : refusedCall(code) };
  if (isObj(o.data)) {
    const d: { [k: string]: Json } = {};
    const logs = safeLogs(data.logs, "error");
    if (logs) d.logs = logs;
    if (err !== undefined) d.err = err;
    else if (data.err !== undefined && data.err !== null) d.err = "UnknownError";
    if (typeof data.unitsConsumed === "number") d.unitsConsumed = data.unitsConsumed;
    out.data = d;
  }
  return out;
}

const STATUSES = new Set(["processed", "confirmed", "finalized"]);
const B58_SIG = /^[1-9A-HJ-NP-Za-km-z]{86,88}$/;
const isNum = (v: Json | undefined): v is number => typeof v === "number" && Number.isFinite(v);
/* A typed object rebuilt from a key list: the keys named, as they came; anything else dropped (2026-10-16, the adversarial review: a spread kept a provider's extra keys and the deprecated `status` twin of `err`). */
const pick = (o: { [k: string]: Json }, keys: readonly string[]): { [k: string]: Json } => {
  const out: { [k: string]: Json } = {};
  for (const k of keys) if (k in o) out[k] = o[k];
  return out;
};
/* solana's EncodedConfirmedTransactionWithStatusMeta and the other typed answers: the keys the site and web3.js read. */
const TX_KEYS = ["slot", "blockTime", "version", "meta", "transaction"] as const;
const META_KEYS = ["err", "fee", "preBalances", "postBalances", "preTokenBalances", "postTokenBalances", "innerInstructions", "logMessages", "loadedAddresses", "computeUnitsConsumed", "rewards", "returnData"] as const;
const SIM_KEYS = ["err", "logs", "accounts", "unitsConsumed", "returnData", "innerInstructions", "replacementBlockhash"] as const;
const SIG_KEYS = ["signature", "slot", "err", "memo", "blockTime", "confirmationStatus"] as const;
const STATUS_KEYS = ["slot", "confirmations", "err", "confirmationStatus"] as const;
const statusOf = (v: Json | undefined): Json => (typeof v === "string" && STATUSES.has(v) ? v : null);

type Kind = "transaction" | "simulation" | "signatures" | "statuses" | "bytes";
const KIND_OF_METHOD: Record<string, Kind> = { getTransaction: "transaction", simulateTransaction: "simulation", getSignaturesForAddress: "signatures", getSignatureStatuses: "statuses" };
/* The kind by the answer's own shape, for a method that is not typed or an upstream that swapped a batch's ids: anything that carries log lines or an err is typed whatever it was asked as. */
function kindOfShape(result: Json): Kind {
  if (isObj(result) && isObj(result.meta) && ("logMessages" in result.meta || "err" in result.meta)) return "transaction";
  if (isObj(result) && isObj(result.value) && ("logs" in result.value || "err" in result.value)) return "simulation";
  if (Array.isArray(result) && result.some((i) => isObj(i) && "signature" in i && "err" in i)) return "signatures";
  if (isObj(result) && Array.isArray(result.value) && result.value.some((s) => isObj(s) && "confirmationStatus" in s)) return "statuses";
  return "bytes";
}

function safeTransaction(result: Json): Json {
  if (!isObj(result)) return result;
  const out = pick(result, TX_KEYS);
  if (isObj(result.meta)) {
    const meta = pick(result.meta, META_KEYS);
    if ("logMessages" in meta) meta.logMessages = meta.logMessages === null ? null : (safeLogs(meta.logMessages, "result") ?? []);
    if ("err" in meta) meta.err = errOrUnknown(meta.err) ?? null;
    out.meta = meta;
  }
  return out;
}
function safeSimulation(result: Json): Json {
  if (!isObj(result) || !isObj(result.value)) return result;
  const value = pick(result.value, SIM_KEYS);
  if ("logs" in value) value.logs = value.logs === null ? null : (safeLogs(value.logs, "result") ?? []);
  if ("err" in value) value.err = errOrUnknown(value.err) ?? null;
  return { ...pick(result, ["context"]), value };
}
function safeSignatures(result: Json): Json {
  if (!Array.isArray(result)) return result;
  /* An item whose signature is not one is dropped whole: nothing else in it is worth keeping. */
  return result
    .filter((i): i is { [k: string]: Json } => isObj(i) && typeof i.signature === "string" && B58_SIG.test(i.signature))
    .map((i) => {
      const o = pick(i, SIG_KEYS);
      return { ...o, slot: isNum(o.slot) ? o.slot : 0, err: errOrUnknown(o.err) ?? null, memo: null, blockTime: isNum(o.blockTime) ? o.blockTime : null, confirmationStatus: statusOf(o.confirmationStatus) };
    });
}
function safeStatuses(result: Json): Json {
  if (!isObj(result) || !Array.isArray(result.value)) return result;
  const value = result.value.map((s) => (isObj(s) ? { ...pick(s, STATUS_KEYS), err: errOrUnknown(s.err) ?? null, confirmationStatus: statusOf(s.confirmationStatus) } : null));
  return { ...pick(result, ["context"]), value };
}

/* The result of the methods whose answers carry free text, typed, by the method the site sent and by the answer's own shape; every other method's result is the chain's bytes as they came. */
export function safeResult(method: string, result: Json): Json {
  const kind = KIND_OF_METHOD[method] ?? kindOfShape(result);
  if (kind === "transaction") return safeTransaction(result);
  if (kind === "simulation") return safeSimulation(result);
  if (kind === "signatures") return safeSignatures(result);
  if (kind === "statuses") return safeStatuses(result);
  return result;
}

/* What the site sent, by the id's string form: the method (to type the result) and the id as sent (what the browser matches on). */
export type Sent = Map<string, { method: string; id: Json }>;

/*
  An upstream 2xx answer rebuilt from its envelope, item by item for a
  batch. With `sent` (the route always passes it) an item whose id the site
  did not send is refused (null, so the route answers "shape"), and the id
  goes out as the site sent it, never as the upstream wrote it. Without
  `sent` (the bare rebuild the review probes call) the ids pass as they came
  and results are typed by shape alone. Null when the text is not an envelope.
*/
export function rpcAnswer(text: string, sent?: Sent): string | null {
  let body: Json;
  try {
    body = JSON.parse(text);
  } catch {
    return null;
  }
  const one = (v: Json): Json | null => {
    if (!isObj(v)) return null;
    const raw = typeof v.id === "string" || typeof v.id === "number" ? v.id : null;
    const known = sent?.get(String(raw));
    if (sent && !known) return null;
    const id = known ? known.id : raw;
    if ("error" in v) return { jsonrpc: "2.0", id, error: rpcErrorOf(v.error) };
    if ("result" in v) return { jsonrpc: "2.0", id, result: safeResult(known?.method ?? "", v.result) };
    return null;
  };
  if (Array.isArray(body)) {
    const items = body.map(one);
    return items.every((x) => x !== null) ? JSON.stringify(items) : null;
  }
  const item = one(body);
  return item === null ? null : JSON.stringify(item);
}

/* ------------------------------------------------------------------ */
/* 4. The one log writer.                                              */
/* ------------------------------------------------------------------ */

const URL_RE = /[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi;
const QUERY_RE = /([?&][A-Za-z0-9_-]+=)[^&\s"'<>]+/g;
const HEADER_RE = /\b(authorization|x-api-key|api[-_]?key|access[-_]token|client[-_]secret|token|secret)(\s*[:=]\s*)(?:[A-Za-z]+\s+)?[^\s"',;]+/gi;
const BEARER_RE = /\bbearer\s+[^\s"',;]+/gi;
const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const HEX_RE = /\b[0-9a-f]{24,}\b/gi;
/* A token's shape: sixteen or more letters, digits, dots, dashes or underscores with both a letter and a digit in them. */
const TOKEN_RE = /\b(?=[A-Za-z0-9_.-]*\d)(?=[A-Za-z0-9_.-]*[A-Za-z])[A-Za-z0-9_.-]{16,}\b/g;
const LOG_CAP = 300;

/* Free text for a log line: the known secrets, URLs, query values, header-like pairs and token-shaped runs replaced, the length capped. */
export function scrub(text: string, env: NodeJS.ProcessEnv = process.env): string {
  let s = String(text);
  for (const f of secretFragments(env)) {
    let i: number;
    const lower = () => s.toLowerCase();
    const needle = f.toLowerCase();
    while ((i = lower().indexOf(needle)) >= 0) s = s.slice(0, i) + "[secret]" + s.slice(i + f.length);
  }
  s = s.replace(URL_RE, "[url]").replace(QUERY_RE, "$1[value]").replace(HEADER_RE, "$1$2[value]").replace(BEARER_RE, "bearer [value]").replace(UUID_RE, "[token]").replace(HEX_RE, "[token]").replace(TOKEN_RE, "[token]");
  return s.length > LOG_CAP ? s.slice(0, LOG_CAP) + "…" : s;
}

function scrubDeep(v: unknown, depth = 0): Json {
  if (depth > 6) return "[deep]";
  if (typeof v === "string") return scrub(v);
  if (typeof v === "number" || typeof v === "boolean" || v === null) return v;
  if (typeof v === "bigint") return v.toString();
  if (v === undefined) return null;
  if (Array.isArray(v)) return v.slice(0, 64).map((x) => scrubDeep(x, depth + 1));
  if (v instanceof Error) return { name: scrub(v.name), message: scrub(v.message) };
  if (typeof v === "object") {
    const out: { [k: string]: Json } = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>).slice(0, 64)) out[scrub(k)] = scrubDeep(x, depth + 1);
    return out;
  }
  return scrub(String(v));
}

/* The only console writer in the server's code: one JSON record, every string scrubbed. */
export function log(level: "info" | "error", record: Record<string, unknown>): void {
  const line = JSON.stringify(scrubDeep(record));
  if (level === "error") console.error(line);
  else console.info(line);
}

/* A thrown value's note for a log line: its name and a scrubbed, capped message. Never for a body. */
export function noteOf(e: unknown): string {
  if (e instanceof Error) return scrub(`${e.name}: ${e.message}`).slice(0, 160);
  return scrub(typeof e === "string" ? e : JSON.stringify(e) ?? "").slice(0, 160);
}
