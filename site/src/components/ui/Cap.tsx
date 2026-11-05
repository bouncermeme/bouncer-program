"use client";

import { BOARD_LOCAL } from "@/lib/board";
import { SOL_PRICE_STALE_MS, useSolPrice, useSolPriceAttempted, type CapRate, type RateStatus } from "@/lib/bouncer/solPrice";
import { fmtCap, fmtRate } from "@/lib/bouncer/usdCap";
import { CLUSTER } from "@contract/active";

/*
  A market cap, in dollars, at the page's one rate (useCapRate). the founder,
  2026-09-28: every market cap is a dollar figure and none is ever shown in
  SOL, so with no rate this prints "price unavailable", never a SOL figure.
  A live rate is marked "about" (it moves with SOL until the launch settles);
  a settled rate is exact, frozen at the minute the launch settled.
*/
export function Cap({ lamports, rate, status, compact, about = true }: { lamports: bigint; rate: CapRate | null; status: RateStatus; compact?: boolean; about?: boolean }) {
  if (!rate) return <span className="text-text-3">{noRateText(status)}</span>;
  const s = fmtCap(lamports, rate.usdPerSol, { compact });
  return <span className="num">{rate.kind === "live" && about ? `about ${s}` : s}</span>;
}

/* What a market cap reads with no rate: "…" while the first read is out, "Please wait" while a settled launch's minute is not priced yet (item 6, the founder 2026-10-28), else "price unavailable". */
export function noRateText(status: RateStatus): string {
  return status === "loading" ? "…" : status === "pending" ? "Please wait" : "price unavailable";
}

/* The line under a settled launch's caps: which price they are frozen at. */
export function RateNote({ rate, status, className = "" }: { rate: CapRate | null; status: RateStatus; className?: string }) {
  if (!rate) {
    return status === "unavailable" ? <p className={`text-text-3 leading-snug ${className}`}>No SOL price for the minute this launch settled yet, so no dollar figures. Trying again.</p> : null;
  }
  if (rate.kind === "settled") {
    return (
      <p className={`text-text-3 leading-snug ${className}`}>
        Market caps at {fmtRate(rate.usdPerSol)} per SOL, the price in the minute this launch settled ({rate.source === "kraken" ? "Kraken" : "Coinbase"}).
      </p>
    );
  }
  return <p className={`text-text-3 leading-snug ${className}`}>Market caps at about {fmtRate(rate.usdPerSol)} per SOL, moving with SOL until the launch settles.</p>;
}

/* Pick 5 (the founder, 2026-09-28): on devnet, dollar caps show, priced at mainnet SOL, and say so. Once per page, in the footer (copy pass, 2026-10-02): the banner above every page already says devnet SOL has no value, and the line under each page's rate repeated both. */
const DEVNET_NOTE = BOARD_LOCAL || String(CLUSTER) !== "mainnet-beta" ? " Priced at mainnet SOL." : "";

/* The footer disclosure on every page: where the live price comes from and when it goes missing. */
export function PriceNote() {
  const quote = useSolPrice();
  const attempted = useSolPriceAttempted();
  const minutes = Math.round(SOL_PRICE_STALE_MS / 60_000);
  if (quote) {
    return (
      <p>
        Market caps in dollars at SOL about {fmtRate(quote.usdPerSol)} ({quote.source === "kraken" ? "Kraken" : "Coinbase"}); settled launches at the price of the minute they settled.{DEVNET_NOTE}
      </p>
    );
  }
  if (attempted) return <p>No SOL price for {minutes} minutes: market caps read &ldquo;price unavailable&rdquo; and priced bids wait.</p>;
  return null;
}
