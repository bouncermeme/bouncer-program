import { NextResponse, type NextRequest } from "next/server";
import { ACCESS_COOKIE, ACCESS_MAX_AGE, accessToken, apiOpenWhileGated, comingSoonHtml, gateOn, isApiPath, isOpenPath, KEY_PARAM, OPEN_FILES, PUBLIC_ROUTE, publicCardBytes, publicCardWhileGated, publicWhileGated, robotsWhileGated, SIGN_OUT } from "@/lib/comingSoon";
import { OPEN_FILE_BYTES } from "@/lib/openFiles";
import { WHITEPAPER_CARD } from "@/lib/whitepaperCard";
import { burst, classify, clientOf, queryVerdict, rpcTotals, totalsConfig } from "@/lib/rateLimit";
import { REVIEW_PARAM, reviewFromReferer, reviewKeyValid } from "@/lib/review";
import { reviewPacketLocked } from "@/lib/reviewLock";
import { clusterFromEnv, indexingOn } from "@/lib/indexing";

/* lib/bouncer/siteCluster.ts X_ROBOTS_TAG_NOINDEX's words; that module reads the contract pin, which the proxy does not load. */
const X_ROBOTS_TAG_NOINDEX = "noindex, nofollow, noarchive";

/*
  The local test board's gate (2026-09-29). When the board is exposed through
  a tunnel, BOARD_PASSWORD is set and every path but robots.txt needs the
  cookie this sets; without it the answer is a sign-in page. Unset (the
  Vercel deploy, next dev) it passes everything through untouched.

  Failed tries are counted per address and in total: 8 per address in 15
  minutes, 200 in total per hour, then the gate refuses everyone until the
  window passes. The cookie holds a hash of the password, never the password.

  Without BOARD_PASSWORD, the coming-soon gate (lib/comingSoon.ts;
  2026-10-19): off unless COMING_SOON_KEY is set on a deployment that is not
  a preview.

  Before either gate, every /api request passes the per-client limits and
  the query check (lib/rateLimit.ts, the adversarial pass's S1, 2026-10-20).
  Before those, while the coming-soon gate is on, the API lock (apiLock,
  launch candidate 2026-10-22): an /api request without the access cookie
  or the reviewer key gets the coming-soon page as a 404, so a refusal says
  nothing about the route; a reviewer's ?review= is checked here and taken
  off the address before the limits and the route see it.
*/
const COOKIE = "board_pass";
const LOGIN = "/__board/sign-in";
const PER_IP = 8;
const PER_IP_MS = 15 * 60_000;
const TOTAL = 200;
const TOTAL_MS = 60 * 60_000;
const fails = new Map<string, number[]>();
let allFails: number[] = [];

async function token(password: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`bouncer-local-board:${password}`));
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, "0")).join("");
}

function page(message: string, status: number): Response {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>Local test board</title>
<style>body{margin:0;background:#0b0d11;color:#e8e6e1;font:18px/1.45 system-ui,sans-serif}main{max-width:26rem;margin:0 auto;padding:2.5rem 1rem}h1{font-size:1.5rem;margin:0 0 .75rem}p{margin:0 0 1rem;color:#b9b5ad}label{display:block;margin:0 0 .4rem}input,button{box-sizing:border-box;width:100%;font:inherit;font-size:18px;padding:.8rem;border-radius:.6rem;border:1px solid #3a3d44;background:#15181e;color:inherit}button{margin-top:.75rem;background:#e8e6e1;color:#0b0d11;font-weight:600}.note{color:#e8e6e1}</style></head>
<body><main><h1>Local test board</h1><p>A test chain on the founder&#39;s PC, shown through a private tunnel. Nothing here is on devnet or mainnet, and the wallet button does not work.</p>${message ? `<p class="note">${message}</p>` : ""}
<form method="post" action="${LOGIN}"><label for="p">Password</label><input id="p" name="password" type="password" autocomplete="current-password" autocapitalize="none" autocorrect="off" required><button type="submit">Open the board</button></form></main></body></html>`;
  return new Response(html, { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex, nofollow, noarchive" } });
}

function recent(list: number[], ms: number, now: number): number[] {
  return list.filter((t) => now - t < ms);
}

/* The limits' refusals: the RPC route's as a JSON-RPC envelope (the browser's web3.js reads it, and backs off by retry-after), the others as the routes' own JSON. */
const TOO_MANY = "Too many requests from this network. Try again in a minute.";
const UNKNOWN_QUERY = { error: "Unknown query parameter." };
function limited(rpc: boolean, retryAfter: number): Response {
  const headers = { "content-type": "application/json", "cache-control": "no-store", "retry-after": String(retryAfter) };
  const body = rpc ? { jsonrpc: "2.0", id: null, error: { code: -32005, message: TOO_MANY } } : { error: TOO_MANY };
  return new Response(JSON.stringify(body), { status: 429, headers });
}

/*
  The API lock while the coming-soon gate is on. Null: not gated here (the gate
  is off, the board gate runs instead, the path is not /api, or it is one of
  the two open paths). "pass": the access cookie or a valid reviewer key came
  with it (from ?review=, or from a reviewed page in the Referer); url is the
  address to serve, without the review parameter. A Response: the refusal,
  the coming-soon page with status 404.
*/
type ApiLock = null | { pass: true; url: URL; reviewed: boolean } | Response;
async function apiLock(req: NextRequest): Promise<ApiLock> {
  if (process.env.BOARD_PASSWORD) return null;
  const key = process.env.COMING_SOON_KEY;
  if (!key || !gateOn({ COMING_SOON_KEY: key, VERCEL_ENV: process.env.VERCEL_ENV })) return null;
  const url = req.nextUrl;
  if (!isApiPath(url.pathname) || apiOpenWhileGated(req.method, url.pathname)) return null;
  const clean = new URL(url.toString());
  clean.searchParams.delete(REVIEW_PARAM);
  if (req.cookies.get(ACCESS_COOKIE)?.value === (await accessToken(key))) return { pass: true, url: clean, reviewed: false };
  const review = url.searchParams.get(REVIEW_PARAM) ?? reviewFromReferer(req.headers.get("referer"), url.origin);
  if (review !== null && (await reviewKeyValid(review, reviewerKeyEnv(), Date.now()))) return { pass: true, url: clean, reviewed: true };
  return new Response(comingSoonHtml(url.origin), { status: 404, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex, nofollow, noarchive", vary: "cookie, referer" } });
}

/* The /api guard: a parameter the route does not read is refused (a token file's is dropped by a redirect), then the client's limits. Null passes the request on. */
async function apiGuard(req: NextRequest, url: URL = req.nextUrl): Promise<Response | null> {
  const cls = classify(req.method, url.pathname, url.searchParams);
  if (!cls) return null;
  const q = queryVerdict(req.method, url.pathname, url.searchParams);
  if (q === "refuse") return new Response(JSON.stringify(UNKNOWN_QUERY), { status: 400, headers: { "content-type": "application/json", "cache-control": "no-store" } });
  if (q === "strip") {
    const bare = new URL(url.toString());
    bare.search = "";
    return NextResponse.redirect(bare, 308);
  }
  const client = clientOf(req.headers);
  const first = burst(cls, client);
  if (!first.ok) return limited(cls === "rpc", first.retryAfter);
  if (cls === "rpc") {
    const total = rpcTotals(client, totalsConfig());
    if (!total.ok) return limited(true, total.retryAfter);
  }
  return null;
}

/*
  Search indexing (launch candidate, 2026-10-22; lib/indexing.ts): while the build is not indexed (the switch off, the
  gate on, a preview, a devnet pin), every response this proxy answers or passes carries X-Robots-Tag; the reviewer
  packet carries it always. A response that already says it keeps its own.
*/
function robotsTagged(req: NextRequest, res: Response): Response {
  const always = req.nextUrl.pathname === "/review" || req.nextUrl.pathname.startsWith("/review/");
  if (res.headers.has("x-robots-tag") || (!always && indexingOn(clusterFromEnv(process.env), process.env))) return res;
  try {
    res.headers.set("x-robots-tag", X_ROBOTS_TAG_NOINDEX);
    return res;
  } catch {
    /* An immutable response (Response.redirect): the same answer, its headers copied. */
    const copy = new Response(res.body, { status: res.status, headers: new Headers(res.headers) });
    copy.headers.set("x-robots-tag", X_ROBOTS_TAG_NOINDEX);
    return copy;
  }
}

/* The reviewer key as configured, or nothing on a mainnet pin: there the key opens no page at all (lib/reviewLock.ts, B20). */
function reviewerKeyEnv(): { REVIEW_KEY?: string; REVIEW_KEY_EXPIRES?: string } {
  return reviewPacketLocked(clusterFromEnv(process.env)) ? {} : { REVIEW_KEY: process.env.REVIEW_KEY, REVIEW_KEY_EXPIRES: process.env.REVIEW_KEY_EXPIRES };
}

export async function proxy(req: NextRequest): Promise<Response> {
  return robotsTagged(req, await route(req));
}

async function route(req: NextRequest): Promise<Response> {
  const lock = await apiLock(req);
  if (lock instanceof Response) return lock;
  const guarded = await apiGuard(req, lock ? lock.url : req.nextUrl);
  if (guarded) return guarded;
  if (lock) {
    /* Let through: served at the address without the review parameter (a route that refuses unknown parameters never sees it), never cached. */
    const res = lock.url.search !== req.nextUrl.search ? NextResponse.rewrite(lock.url) : NextResponse.next();
    res.headers.set("cache-control", "private, no-store");
    res.headers.set("x-robots-tag", "noindex, nofollow, noarchive");
    return res;
  }
  const password = process.env.BOARD_PASSWORD;
  if (!password) return comingSoon(req);
  const path = req.nextUrl.pathname;
  if (path === "/robots.txt") return NextResponse.next();
  const want = await token(password);

  if (path === LOGIN && req.method === "POST") {
    const now = Date.now();
    const ip = req.headers.get("cf-connecting-ip") ?? req.headers.get("x-forwarded-for") ?? "local";
    const mine = recent(fails.get(ip) ?? [], PER_IP_MS, now);
    allFails = recent(allFails, TOTAL_MS, now);
    if (mine.length >= PER_IP || allFails.length >= TOTAL) return page("Too many wrong tries. Try again later.", 429);
    let given = "";
    try {
      given = String((await req.formData()).get("password") ?? "");
    } catch {}
    if (given && (await token(given)) === want) {
      const res = NextResponse.redirect(new URL("/", req.url), 303);
      res.cookies.set(COOKIE, want, { httpOnly: true, secure: req.nextUrl.protocol === "https:" || req.headers.get("x-forwarded-proto") === "https", sameSite: "lax", path: "/", maxAge: 7 * 24 * 3600 });
      return res;
    }
    mine.push(now);
    allFails.push(now);
    fails.set(ip, mine);
    return page("That is not the password.", 401);
  }

  if (req.cookies.get(COOKIE)?.value === want) return NextResponse.next();
  if (path.startsWith("/api/")) return Response.json({ error: "sign in to the board first" }, { status: 401 });
  return page("", 401);
}

/* The coming-soon gate: open paths pass untouched, ?key= sets or clears the access cookie, the cookie opens the app (noindex), ?review= with the unexpired reviewer key opens the one request (lib/review.ts), anything else is the coming-soon page. */
async function comingSoon(req: NextRequest): Promise<Response> {
  const key = process.env.COMING_SOON_KEY;
  if (!key || !gateOn({ COMING_SOON_KEY: key, VERCEL_ENV: process.env.VERCEL_ENV })) return NextResponse.next();
  const url = req.nextUrl;
  const path = url.pathname;
  /* The exact open files (lib/comingSoon.ts OPEN_FILES): their bytes, answered here (lib/openFiles.ts) and never handed to Next, so no spelling Next maps onto these names before the proxy (a trailing .rsc, which Next takes off first; an RSC header) reaches Next's not-found page in the site's frame (tag 31e, the 31d pre-check's D-GATE-1). Any method but GET or HEAD, or a name the module does not hold: the coming-soon page. */
  if (OPEN_FILES.includes(path)) return openFile(req.method, path) ?? new Response(comingSoonHtml(url.origin), { status: 200, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", vary: "cookie" } });
  if (isOpenPath(path) || isApiPath(path)) return NextResponse.next();
  /* robots.txt follows the whitepaper switch (lib/comingSoon.ts robotsWhileGated): unset, everything refused to every crawler; "1", the card fetchers may read the open page and its card, nothing else. */
  if (path === "/robots.txt") return new Response(robotsWhileGated(), { status: 200, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
  const want = await accessToken(key);
  const secure = url.protocol === "https:" || req.headers.get("x-forwarded-proto") === "https";
  const given = url.searchParams.get(KEY_PARAM);
  if (given !== null) {
    const back = url.clone();
    back.searchParams.delete(KEY_PARAM);
    if (given === SIGN_OUT || (await accessToken(given)) === want) {
      const res = NextResponse.redirect(back, 303);
      res.cookies.set(ACCESS_COOKIE, given === SIGN_OUT ? "" : want, { httpOnly: true, secure, sameSite: "lax", path: "/", maxAge: given === SIGN_OUT ? 0 : ACCESS_MAX_AGE });
      res.headers.set("cache-control", "no-store");
      return res;
    }
  }
  if (req.cookies.get(ACCESS_COOKIE)?.value === want) {
    const res = NextResponse.next();
    res.headers.set("x-robots-tag", "noindex, nofollow, noarchive");
    return res;
  }
  /* Reviewer access (2026-10-21): per request, no redirect, no cookie. The page keeps the key in its address, so it is never cached or sent to another site. */
  const review = url.searchParams.get(REVIEW_PARAM) ?? reviewFromReferer(req.headers.get("referer"), url.origin);
  if (review !== null && (await reviewKeyValid(review, reviewerKeyEnv(), Date.now()))) {
    const res = NextResponse.next();
    res.headers.set("x-robots-tag", "noindex, nofollow, noarchive");
    res.headers.set("referrer-policy", "strict-origin-when-cross-origin");
    res.headers.set("cache-control", "private, no-store");
    return res;
  }
  /* The one page open to everyone while the gate is on (lib/comingSoon.ts publicWhileGated): never indexed, never in a shared cache. Not a data route (Next marks /_next/data/<any build id>/whitepaper.json with x-nextjs-data and hands the proxy /whitepaper; passed on, any build id but the live one is Next's not-found page in the app frame). */
  if (publicWhileGated(req.method, path) && !req.headers.has("x-nextjs-data")) {
    /* Served from the twin route (lib/comingSoon.ts PUBLIC_ROUTE), whose frame reads nothing from the gated API; the address stays /whitepaper. */
    const res = NextResponse.rewrite(new URL(PUBLIC_ROUTE, url));
    res.headers.set("x-robots-tag", "noindex, nofollow, noarchive");
    res.headers.set("cache-control", "private, no-store");
    res.headers.set("vary", "cookie");
    return res;
  }
  /* The open page's share card, on the same switch (lib/comingSoon.ts publicCardWhileGated): the card's own bytes, answered here and never handed to Next, so every spelling Next maps onto this address before the proxy (a data route with any build id, the .rsc form) gets these bytes, never Next's not-found page; never indexed, never in a shared cache. No card in the build: the coming-soon page. */
  const card = publicCardWhileGated(req.method, path) ? whitepaperCard() : null;
  if (card) return new Response(req.method === "HEAD" ? null : card, { status: 200, headers: { "content-type": "image/png", "x-robots-tag": "noindex, nofollow, noarchive", "cache-control": "private, no-store" } });
  return new Response(comingSoonHtml(url.origin), { status: 200, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", vary: "cookie" } });
}

/* The card's bytes (lib/whitepaperCard.ts through lib/comingSoon.ts publicCardBytes: a PNG under X's limit, or none), decoded once per value. */
let cardMemo: { from: string; bytes: Uint8Array<ArrayBuffer> | null } | null = null;
function whitepaperCard(): Uint8Array<ArrayBuffer> | null {
  const from = WHITEPAPER_CARD.png;
  if (cardMemo === null || cardMemo.from !== from) cardMemo = { from, bytes: publicCardBytes(from) };
  return cardMemo.bytes;
}

/* An open file's answer (lib/openFiles.ts), as Next serves the file: its type, the same cache rule; GET or HEAD only. Decoded once per value. */
const openFileMemo = new Map<string, { from: string; bytes: Uint8Array<ArrayBuffer> }>();
function openFile(method: string, path: string): Response | null {
  if (method !== "GET" && method !== "HEAD") return null;
  const file = Object.prototype.hasOwnProperty.call(OPEN_FILE_BYTES, path) ? OPEN_FILE_BYTES[path] : null;
  if (!file) return null;
  let memo = openFileMemo.get(path);
  if (!memo || memo.from !== file.base64) {
    const raw = atob(file.base64);
    const bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
    memo = { from: file.base64, bytes };
    openFileMemo.set(path, memo);
  }
  return new Response(method === "HEAD" ? null : memo.bytes, { status: 200, headers: { "content-type": file.type, "content-length": String(memo.bytes.length), "cache-control": "public, max-age=0, must-revalidate" } });
}
