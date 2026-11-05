import { coinbaseSpot, gapPct, krakenSpot, QUOTE_AGREEMENT_PCT } from "@/lib/bouncer/priceSources";
import { answer, route } from "@/lib/bouncer/server/output";
import { chargePrice } from "@/lib/bouncer/server/budget";

/*
  The check before a priced bid is sealed. Both sources are read fresh, in
  parallel, never from a cache: this quote decides which grid step goes on
  chain. The answer carries both prices, the gap between them and, when they
  agree within QUOTE_AGREEMENT_PCT, the rate to seal at: the higher of the
  two, so the sealed market cap is at or below what the bidder typed at
  either source's price.

  Every answer is a typed body through the output policy (server/output.ts):
  numbers, and `reason` from a closed set (off, budget, missing, disagree).
  The two reads are charged to the day's price meter first
  (server/budget.ts): past it the check answers budget and nothing is read.
*/

export const dynamic = "force-dynamic";

export const GET = route(async (): Promise<Response> => {
  if (process.env.SOL_PRICE_DISABLED === "1") return answer({ ok: false, reason: "off", coinbase: null, kraken: null, at: Date.now() }, { status: 503 });
  /* Urgent: the check goes to the price meter's hard line, so a flood of old minutes on /sol-price/at (which stops at the soft line) cannot stop bidding. */
  if (chargePrice(2, true) === "refused") return answer({ ok: false, reason: "budget", coinbase: null, kraken: null, at: Date.now() }, { status: 503 });
  const [coinbase, kraken] = await Promise.all([coinbaseSpot().catch(() => null), krakenSpot().catch(() => null)]);
  const at = Date.now();
  if (coinbase === null || kraken === null) return answer({ ok: false, reason: "missing", coinbase, kraken, at }, { status: 503 });
  const gap = gapPct(coinbase, kraken);
  if (gap > QUOTE_AGREEMENT_PCT) return answer({ ok: false, reason: "disagree", coinbase, kraken, gapPct: gap, limitPct: QUOTE_AGREEMENT_PCT, at }, { status: 409 });
  return answer({ ok: true, coinbase, kraken, gapPct: gap, limitPct: QUOTE_AGREEMENT_PCT, usdPerSol: Math.max(coinbase, kraken), at });
});
