import { coinbaseMinute, krakenMinute } from "@/lib/bouncer/priceSources";
import { answer, fail, route } from "@/lib/bouncer/server/output";
import { chargePrice } from "@/lib/bouncer/server/budget";

/*
  The SOL price at one moment, frozen: the one-minute candle containing
  ?ts= (unix seconds). A settled launch's market caps are all priced at the
  candle of its SettlementRecord.settled_ts, and a bid's "when you bid" figure
  at the candle of Bid.placed_ts. Coinbase Exchange first (history reaches
  months back, and the same minute always answers the same). Kraken only as
  a fallback inside its 12 hours, and never cached here for long, so the
  Coinbase figure replaces it once Coinbase answers.

  A minute that has not closed yet has no candle to freeze: the answer is
  "not yet" and the page asks again.

  Every answer leaves through the output policy (server/output.ts): the
  numbers beside a failure are the minute and the wait, nothing else. A
  minute not frozen here costs up to two external reads, each charged to
  the day's price meter first (server/budget.ts, PRICE_DAILY_BUDGET; GPT-6's
  final report: distinct old minutes had no cost limit), and the frozen
  map is capped so a scan of distinct minutes cannot grow it without bound.
*/

export const dynamic = "force-dynamic";

const NOT_BEFORE_SECS = 70;
const frozen = new Map<number, number>();
const MAX_FROZEN = 20_000;
/* 2026-01-01T00:00:00Z: before the first launch. A minute before it has no market cap to price, and a scan of the past stops here. */
const EARLIEST_TS = 1_767_225_600;
function freeze(minute: number, usdPerSol: number): void {
  if (frozen.size >= MAX_FROZEN) {
    const oldest = frozen.keys().next().value;
    if (oldest !== undefined) frozen.delete(oldest);
  }
  frozen.set(minute, usdPerSol);
}

export const GET = route(async (req: Request): Promise<Response> => {
  const ts = Number(new URL(req.url).searchParams.get("ts"));
  if (!Number.isInteger(ts) || ts <= 0) return fail("priceBadTs");
  if (ts < EARLIEST_TS) return fail("priceTooOld");
  const minute = ts - (ts % 60);
  const nowSec = Math.floor(Date.now() / 1000);
  /* Item 6 (2026-10-28): 70 s, not 90: the minute has closed at 60, and the page asks again every few seconds until Coinbase has the candle. */
  if (nowSec < minute + NOT_BEFORE_SECS) return fail("priceNotYet", { numbers: { minute, retryAfterSecs: minute + NOT_BEFORE_SECS - nowSec } });
  const known = frozen.get(minute);
  if (known !== undefined) return frozenAnswer(known, minute);
  try {
    if (chargePrice() === "refused") return fail("priceBudgetSpent");
    const cb = await coinbaseMinute(ts);
    if (cb !== null) {
      freeze(minute, cb);
      return frozenAnswer(cb, minute);
    }
    if (chargePrice() === "refused") return fail("priceBudgetSpent");
    const kr = await krakenMinute(ts);
    if (kr !== null) return answer({ usdPerSol: kr, minute, source: "kraken" }, { cache: "public, max-age=300" });
  } catch {
    /* a reader that threw is a source that did not answer */
  }
  return fail("priceNoHistory", { numbers: { minute } });
});

function frozenAnswer(usdPerSol: number, minute: number): Response {
  return answer({ usdPerSol, minute, source: "coinbase" }, { cache: "public, max-age=31536000, immutable" });
}
