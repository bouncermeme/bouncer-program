/*
  The two public SOL/USD sources, and the rules for using them, in one place
  for the server routes (/api/sol-price, /check, /at) and the scripts.

  the founder, 2026-09-28: every market cap on the site is a dollar figure; every
  amount stays SOL. That turns the quote from decoration into an input: the
  dollar cap a bidder types is converted into the grid step that gets sealed
  on chain. So a priced bid reads both sources fresh and seals only when they
  agree (QUOTE_AGREEMENT_PCT), and a settled launch's caps are priced once,
  at the minute it settled, from a public price history that answers the
  same way every time it is asked.
*/

const UA = { accept: "application/json", "user-agent": "bouncer-site" };
const TIMEOUT_MS = 4_000;

/*
  The most two fresh quotes may differ before a priced bid is refused, in
  percent. Measured, not judged (scripts/quote-divergence.ts, 2026-09-28):
  Coinbase against Kraken candle closes differed by at most 0.075% minute to
  minute over 12 hours, 0.124% hour to hour over 30 days and 0.184% day to day
  over two years, never once above 0.25%. 0.5% is four times the worst hour
  in a month and half of one grid step, so ordinary volatility never trips it
  and a quote that is wrong by a step or more always does.
*/
export const QUOTE_AGREEMENT_PCT = 0.5;

async function getJson(url: string): Promise<unknown | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal, cache: "no-store", headers: UA });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

const positive = (n: number): number | null => (Number.isFinite(n) && n > 0 ? n : null);
/* A reader's parse never throws: a source's unexpected shape is a missing quote, never an exception out of a route (2026-10-16, the output policy's gate). */
const parsed = (read: () => number | null): number | null => {
  try {
    return read();
  } catch {
    return null;
  }
};

/* Coinbase's spot price, dollars per SOL, or null. */
export async function coinbaseSpot(): Promise<number | null> {
  const j = (await getJson("https://api.coinbase.com/v2/prices/SOL-USD/spot")) as { data?: { amount?: string } } | null;
  return parsed(() => (j ? positive(Number(j.data?.amount)) : null));
}

/* Kraken's last trade, dollars per SOL, or null. */
export async function krakenSpot(): Promise<number | null> {
  const j = (await getJson("https://api.kraken.com/0/public/Ticker?pair=SOLUSD")) as { result?: { SOLUSD?: { c?: string[] } } } | null;
  return parsed(() => (j ? positive(Number(j.result?.SOLUSD?.c?.[0])) : null));
}

/*
  The close of the one-minute candle containing `ts` (unix seconds). Coinbase
  Exchange serves one-minute history at least 200 days back; Kraken serves
  only its last 720 one-minute candles (12 hours) whatever `since` asks for.
*/
export async function coinbaseMinute(ts: number): Promise<number | null> {
  const minute = ts - (ts % 60);
  const iso = (s: number) => new Date(s * 1000).toISOString();
  const rows = (await getJson(`https://api.exchange.coinbase.com/products/SOL-USD/candles?granularity=60&start=${iso(minute)}&end=${iso(minute + 60)}`)) as number[][] | null;
  return parsed(() => {
    const row = Array.isArray(rows) ? rows.find((r) => Array.isArray(r) && r[0] === minute) : undefined;
    return row ? positive(Number(row[4])) : null;
  });
}

export async function krakenMinute(ts: number): Promise<number | null> {
  const minute = ts - (ts % 60);
  const j = (await getJson(`https://api.kraken.com/0/public/OHLC?pair=SOLUSD&interval=1&since=${minute - 60}`)) as { result?: Record<string, unknown> } | null;
  return parsed(() => {
    const result = j && typeof j.result === "object" && j.result !== null ? j.result : {};
    const series = Object.entries(result).find(([k]) => k !== "last")?.[1];
    const row = Array.isArray(series) ? (series as unknown[]).find((r) => Array.isArray(r) && Number(r[0]) === minute) : undefined;
    return Array.isArray(row) ? positive(Number(row[4])) : null;
  });
}

/* How far apart two quotes are, in percent of the lower. */
export function gapPct(a: number, b: number): number {
  return (Math.abs(a - b) / Math.min(a, b)) * 100;
}
