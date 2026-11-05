/*
  One connection for the site. The URL is the deployment's (NEXT_PUBLIC_RPC_URL),
  devnet by default because the pinned program is on devnet (CLUSTER in the
  pin). Scripts may swap the connection in.

  A path ("/api/rpc") is this site's own route (app/api/rpc): the browser
  resolves it against the page's origin, and the server, which has no
  origin, reads the upstream the route forwards to (RPC_UPSTREAM on Vercel,
  BOARD_RPC_UPSTREAM on the local board).

  A refusal for rate (HTTP 429, from the route's WAF rule or the RPC) is
  tried again after a random wait, three times at most (2026-10-15):
  one to two seconds, then two to four, then four to eight, or what a
  Retry-After header asks, so a crowd refused together does not return
  together. web3.js's own retry (five tries half a second apart) is off.
*/
import { Connection } from "@solana/web3.js";
import { isMainnet } from "../siteCluster";
import { CLUSTER } from "@contract/active";

/*
  The RPC a build uses when NEXT_PUBLIC_RPC_URL is not set (2026-10-16,
  GPT-6's A4). On the devnet pin the public devnet endpoint, the local
  tooling's default. On a mainnet pin the site's own route and never a
  public endpoint: a mainnet browser must not read devnet by omission. The
  build guard (scripts/deploy-guard.mjs) refuses a mainnet build without the
  variable set to a path anyway; this is the second lock.
*/
export function defaultRpcFor(cluster: string): string {
  return isMainnet(cluster) ? "/api/rpc" : "https://api.devnet.solana.com";
}
export function configuredRpc(cluster: string, fromEnv: string | undefined): string {
  return fromEnv || defaultRpcFor(cluster);
}

function resolveRpc(u: string): string {
  if (!u.startsWith("/")) return u;
  /* globalThis.location, not window: the build replaces typeof window on its own, and a prerender has no page origin. */
  const origin = (globalThis as { location?: { origin?: string } }).location?.origin;
  if (origin && origin.startsWith("http")) return origin + u;
  return process.env.RPC_UPSTREAM || process.env.BOARD_RPC_UPSTREAM || "http://127.0.0.1:18899";
}

const RATE_RETRIES = 3;
const RATE_WAIT_MS = 1_000;
const RATE_WAIT_MAX_MS = 8_000;

/*
  The browser's context for the site's Bouncer-only rule (server/scope.ts,
  Astra 2026-10-17c): what the page is looking at, so the route can judge
  each call by account. x-bouncer-scope carries the connected wallet (w),
  the launches in view (l), a launch just created by its derivation (m:
  creator and salt) and the address a signature list came from (f);
  x-bouncer-sent carries the signed transactions this tab sent, for their
  status and read-back on another instance. The headers prove nothing by
  themselves: the server checks every hint arithmetically and opens only
  what derives from a launch of the program. The site's own endpoints get
  the same headers (a launch endpoint needs the derivation of a launch
  created a moment ago).
*/
const MAX_HINTED_LAUNCHES = 12;
const MAX_DERIVATIONS = 2;
const MAX_SENT = 6;
const MAX_SIGNATURE_SOURCES = 5_000;
const hintedLaunches: string[] = [];
const derivations: string[] = [];
let scopeWallet: string | null = null;
/* Signature to the signed transaction's base64, for the proof; signature to the address whose list it came from. */
const sentTransactions = new Map<string, string>();
const signatureSources = new Map<string, string>();

function pushBounded(list: string[], value: string, max: number): void {
  const i = list.indexOf(value);
  if (i >= 0) list.splice(i, 1);
  list.push(value);
  if (list.length > max) list.splice(0, list.length - max);
}
export function hintLaunch(id: string | null | undefined): void {
  if (typeof id === "string" && id.length >= 32 && id.length <= 44) pushBounded(hintedLaunches, id, MAX_HINTED_LAUNCHES);
}
/* A launch the browser derives itself (createLaunch): creator and salt, so the server can prove the address before its next scan. */
export function hintLaunchDerivation(creator: string, salt: bigint): void {
  pushBounded(derivations, `${creator}:${salt.toString()}`, MAX_DERIVATIONS);
}
export function setScopeWallet(address: string | null): void {
  scopeWallet = address;
}
/* A transaction this tab sent, signed: its signature's status and read-back are provable on any instance. */
export function rememberSent(signature: string, bytes: Uint8Array): void {
  sentTransactions.delete(signature);
  sentTransactions.set(signature, Buffer.from(bytes).toString("base64"));
  while (sentTransactions.size > MAX_SENT) sentTransactions.delete(sentTransactions.keys().next().value as string);
}

const isSiteRequest = (url: string): boolean => SITE_ROUTES && (url.startsWith("/api/") || url === RPC_URL || url.startsWith(`${RPC_URL}?`) || url.startsWith(`${RPC_URL}/`));

/* The signatures a JSON-RPC body asks about (getTransaction, getSignatureStatuses) and the signature-list calls it makes, read from the body the library built. */
function inspectBody(body: BodyInit | null | undefined): { signatures: string[]; signatureLists: string[]; calls: { id: unknown; method: string; address: string }[] } {
  const out = { signatures: [] as string[], signatureLists: [] as string[], calls: [] as { id: unknown; method: string; address: string }[] };
  if (typeof body !== "string" || body.length > 65_536 || !(body.startsWith("{") || body.startsWith("["))) return out;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return out;
  }
  for (const c of Array.isArray(parsed) ? parsed : [parsed]) {
    const call = c as { id?: unknown; method?: unknown; params?: unknown } | null;
    if (!call || typeof call.method !== "string" || !Array.isArray(call.params)) continue;
    const p = call.params;
    if (call.method === "getTransaction" && typeof p[0] === "string") out.signatures.push(p[0]);
    else if (call.method === "getSignatureStatuses" && Array.isArray(p[0])) {
      for (const s of p[0]) if (typeof s === "string") out.signatures.push(s);
    } else if (call.method === "getSignaturesForAddress" && typeof p[0] === "string") out.calls.push({ id: call.id, method: call.method, address: p[0] });
  }
  return out;
}

/* The site's fetch: the context headers on a request to the site, and the signature lists it answers remembered by address. */
export async function siteFetch(url: string | URL | Request, init?: RequestInit): Promise<Response> {
  const u = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
  if (!isSiteRequest(u)) return fetch(url, init);
  const headers = new Headers(init?.headers ?? (url instanceof Request ? url.headers : undefined));
  const parts: string[] = [];
  if (scopeWallet) parts.push(`w=${scopeWallet}`);
  if (hintedLaunches.length) parts.push(`l=${hintedLaunches.join(",")}`);
  if (derivations.length) parts.push(`m=${derivations.join(",")}`);
  const asked = inspectBody(init?.body);
  const from = asked.signatures.map((s) => signatureSources.get(s)).find((a) => a !== undefined);
  if (from) parts.push(`f=${from}`);
  if (parts.length) headers.set("x-bouncer-scope", parts.join(";"));
  const proofs = asked.signatures.filter((s) => sentTransactions.has(s)).slice(0, 2);
  if (proofs.length) headers.set("x-bouncer-sent", proofs.map((s) => `${s}.${sentTransactions.get(s)}`).join(","));
  const res = await fetch(url, { ...init, headers });
  if (asked.calls.length && res.ok) {
    try {
      const replies = (await res.clone().json()) as unknown;
      for (const r of Array.isArray(replies) ? replies : [replies]) {
        const reply = r as { id?: unknown; result?: unknown } | null;
        const call = asked.calls.find((c) => String(c.id) === String(reply?.id)) ?? (asked.calls.length === 1 ? asked.calls[0] : undefined);
        if (!call || !Array.isArray(reply?.result)) continue;
        for (const item of reply.result) {
          const s = (item as { signature?: unknown } | null)?.signature;
          if (typeof s === "string") signatureSources.set(s, call.address);
        }
      }
      while (signatureSources.size > MAX_SIGNATURE_SOURCES) signatureSources.delete(signatureSources.keys().next().value as string);
    } catch {
      /* not JSON: nothing remembered */
    }
  }
  return res;
}

/*
  24i (Astra R8-M1, Claude M1): a send keeps what every try said. The route marks a refusal it made before forwarding
  with "notForwarded" (server/output.ts). A try of a send here whose answer was not so marked may have reached the node:
  its signed bytes are noted, and the signer reads the chain for them whatever a later try says (chain/signer.ts
  broadcast, mayHaveReached). The answer itself is handed on as it came.
*/
const SEND_CALL = /"method"\s*:\s*"sendTransaction"/;
const MARKED = /"notForwarded"\s*:\s*true/;
const REACHED_MAX = 256;
const reachedSends = new Set<string>();
/* 24j (Astra R9-L1): once a send has been forgotten (past REACHED_MAX), any send not held may be one that was, so every send may have reached. */
let forgotReached = false;
export const mayHaveReached = (bytesBase64: string): boolean => forgotReached || reachedSends.has(bytesBase64);
function sentBytesOf(body: string): string[] {
  try {
    const parsed = JSON.parse(body) as unknown;
    const calls = (Array.isArray(parsed) ? parsed : [parsed]) as { method?: unknown; params?: unknown }[];
    return calls.filter((c) => c?.method === "sendTransaction" && Array.isArray(c.params) && typeof c.params[0] === "string").map((c) => (c.params as string[])[0]);
  } catch {
    return [];
  }
}
/*
  24j (Astra R9-L1, the batch boundary): marked only when the whole answer says so: one marked refusal for the request,
  or, for a batch answer, every entry marked. A mixed, partial or unreadable answer is not marked, so its sends are
  noted as maybe reached.
*/
async function markedRefusal(res: Response): Promise<boolean> {
  try {
    const text = await res.clone().text();
    if (!MARKED.test(text)) return false;
    const parsed = JSON.parse(text) as unknown;
    const entries = Array.isArray(parsed) ? parsed : [parsed];
    return entries.length > 0 && entries.every((e) => (e as { error?: { data?: { notForwarded?: unknown } } } | null)?.error?.data?.notForwarded === true);
  } catch {
    return false;
  }
}

/* fetch for the site's connection: a 429 is retried after a random, growing wait. Anything else is returned as it came. */
export async function fetchWithBackoff(url: string | URL | Request, init?: RequestInit): Promise<Response> {
  const sends = typeof init?.body === "string" && SEND_CALL.test(init.body) ? sentBytesOf(init.body) : [];
  for (let attempt = 0; ; attempt++) {
    const res = await siteFetch(url, init);
    if (sends.length && !(await markedRefusal(res))) {
      for (const b of sends) reachedSends.add(b);
      while (reachedSends.size > REACHED_MAX) {
        reachedSends.delete(reachedSends.values().next().value as string);
        forgotReached = true;
      }
    }
    if (res.status !== 429 || attempt >= RATE_RETRIES) return res;
    const asked = Number(res.headers.get("retry-after"));
    const base = asked > 0 ? Math.min(asked * 1000, RATE_WAIT_MAX_MS) : Math.min(RATE_WAIT_MS * 2 ** attempt, RATE_WAIT_MAX_MS);
    await new Promise((r) => setTimeout(r, base * (1 + Math.random())));
  }
}

const CONFIGURED_RPC: string = configuredRpc(CLUSTER, process.env.NEXT_PUBLIC_RPC_URL);
export const RPC_URL: string = resolveRpc(CONFIGURED_RPC);
/*
  Whether the build reads through the site (the RPC is a path): then the
  browser also reads a launch, its bids, its history and the Config from
  the site's shared endpoints (app/api/launch, app/api/config), one read per
  cache period for everyone, and polls instead of subscribing (2026-10-15).
*/
export const SITE_ROUTES: boolean = CONFIGURED_RPC.startsWith("/");
export const CLUSTER_NAME: string = CLUSTER;

let conn: Connection | null = null;
/* The server's fetch for its own reads, set by the server modules (server/snapshot.ts: the budget's metered fetch); the browser never sets one. */
let serverFetch: typeof fetch | null = null;

export function setServerFetch(f: typeof fetch): void {
  serverFetch = f;
  conn = null;
  historyConn = null;
}

/* The fetch the site's connection reads through (the server's metered one once set), for a raw JSON-RPC read beside the library (rpcFunding.ts). */
export function connectionFetch(): typeof fetch {
  return (serverFetch ?? fetchWithBackoff) as typeof fetch;
}

export function getConnection(): Connection {
  if (!conn) conn = new Connection(RPC_URL, { commitment: "confirmed", fetch: (serverFetch ?? fetchWithBackoff) as typeof fetch, disableRetryOnRateLimit: true });
  return conn;
}

/*
  Whether an RPC endpoint has a websocket beside it (web3.js derives wss from
  https). The site's own route (a path, "/api/rpc") and the local board's
  proxy have none: nothing subscribes through them, every live figure polls
  (2026-10-15: no websockets on mainnet, where every read goes through the
  route).
*/
export function rpcHasWebsocket(endpoint: string = getConnection().rpcEndpoint): boolean {
  try {
    const u = new URL(endpoint);
    return (u.protocol === "http:" || u.protocol === "https:") && !u.pathname.startsWith("/api/rpc");
  } catch {
    return false;
  }
}

export function setConnection(c: Connection): void {
  conn = c;
  historyConn = null;
}

/*
  The same RPC for reading a launch's history, without the library's own
  retry on a refusal. The public devnet endpoint answers about ten
  getTransaction calls in ten seconds (measured 2026-10-02) and counts a
  refused call against the next window, so a retry half a second later only
  extends the refusal. The history reader paces itself instead (history.ts).
*/
let historyConn: Connection | null = null;

export function getHistoryConnection(): Connection {
  if (!historyConn) historyConn = new Connection(getConnection().rpcEndpoint, { commitment: "confirmed", fetch: (serverFetch ?? fetchWithBackoff) as typeof fetch, disableRetryOnRateLimit: true });
  return historyConn;
}

/* Explorer links carry the cluster, so a devnet account never opens a mainnet page. */
export function explorerUrl(kind: "tx" | "account" | "token", id: string): string {
  const c: string = CLUSTER;
  const q = c === "mainnet" || c === "mainnet-beta" ? "" : `?cluster=${c}`;
  return `https://solscan.io/${kind}/${id}${q}`;
}
