/*
  The live SOL price in dollars. the founder, 2026-09-28: every market cap on the
  site is a dollar figure and every amount stays SOL, so this quote prices
  the market caps of launches still open (the starting cap, the bid control).
  It is no longer decoration: a dollar cap typed into the bid control is
  converted into the grid step that is sealed. The seal itself never uses
  this cached answer; it reads both sources fresh through /api/sol-price/check.
  Settled launches never use it either: their caps are frozen at the minute
  they settled (/api/sol-price/at).

  Two free public endpoints, no key, tried in order; the first answer within
  four seconds wins. Cached here for 30 seconds so a busy page does not turn
  into a request per visitor; the browser asks every 30 seconds and treats
  the quote as missing once it is older than the staleness window
  (solPrice.ts). With no quote, market caps read "price unavailable" and
  priced bids wait: nothing falls back to a SOL market cap.
  SOL_PRICE_DISABLED=1 turns the feed off.

  Every answer leaves through the output policy (server/output.ts): a typed
  quote, or a failure by kind.
*/
import { answer, fail, route } from "@/lib/bouncer/server/output";

export const dynamic = "force-dynamic";

const CACHE_MS = 30_000;
const TIMEOUT_MS = 4_000;

interface Quote {
  usdPerSol: number;
  /* Unix milliseconds when this server read the quote. */
  at: number;
  source: "coinbase" | "kraken";
}

const SOURCES: { name: Quote["source"]; url: string; parse: (json: unknown) => number }[] = [
  {
    name: "coinbase",
    url: "https://api.coinbase.com/v2/prices/SOL-USD/spot",
    parse: (j) => Number((j as { data?: { amount?: string } }).data?.amount),
  },
  {
    name: "kraken",
    url: "https://api.kraken.com/0/public/Ticker?pair=SOLUSD",
    parse: (j) => Number((j as { result?: { SOLUSD?: { c?: string[] } } }).result?.SOLUSD?.c?.[0]),
  },
];

let cached: Quote | null = null;
let inflight: Promise<Quote | null> | null = null;
/* After both sources failed, no new read for a few seconds: without it every request would read twice while they are down (2026-10-16, the adversarial review). */
let failedAt = 0;
const FAIL_PAUSE_MS = 5_000;

async function readOne(source: (typeof SOURCES)[number]): Promise<Quote | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(source.url, { signal: ctrl.signal, cache: "no-store", headers: { accept: "application/json" } });
    if (!res.ok) return null;
    const price = source.parse(await res.json());
    if (!Number.isFinite(price) || price <= 0) return null;
    return { usdPerSol: price, at: Date.now(), source: source.name };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function readQuote(): Promise<Quote | null> {
  for (const s of SOURCES) {
    const q = await readOne(s);
    if (q) return q;
  }
  return null;
}

export const GET = route(async (): Promise<Response> => {
  if (process.env.SOL_PRICE_DISABLED === "1") return fail("priceOff");
  if ((!cached || Date.now() - cached.at > CACHE_MS) && Date.now() - failedAt > FAIL_PAUSE_MS) {
    if (!inflight) {
      inflight = readQuote().finally(() => {
        inflight = null;
      });
    }
    const fresh = await inflight;
    if (fresh) cached = fresh;
    else failedAt = Date.now();
  }
  /* A failed refresh keeps the last quote; the browser judges its age against the staleness window, not this server. */
  if (!cached) return fail("priceNone");
  /* 24d (the founder's caching directive): one quote per region per 10 s at the CDN, under this instance's own 30 s. */
  return answer(cached, { cache: "public, max-age=0, s-maxage=10, stale-while-revalidate=20" });
});
