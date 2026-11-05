"use client";

import { ParkedCollect, ParkedCollected } from "@/components/launch/ParkedCollect";
import { noRateText } from "@/components/ui/Cap";
import { useAccount } from "@/components/wallet/AccountProvider";
import { fmtPct, fmtSolPrecise, fmtTokens, shortAddr } from "@/lib/bouncer/format";
import { useBidsRead } from "@/lib/bouncer/hooks";
import { useParkedReceipt } from "@/lib/bouncer/parkedReceipt";
import { useCapRate } from "@/lib/bouncer/solPrice";
import type { Launch, SettlementRecord } from "@/lib/bouncer/types";
import { fmtCap } from "@/lib/bouncer/usdCap";
import { mcapForValue, shareOfSupply } from "@/lib/bouncer/view";

/*
  v0.32: a parked payout on the trade page, above the market (the founder approved the mocks on 2026-10-29,
  review/2026-10-29-v032/mocks: p7 and p8 a winner in the winner box's own markup, p2 a refund). A launch that sold
  opens here, and the launch page that carries the winner box redirects here once trading is open, so without this a
  parked bidder would see nothing to do.

  the founder's caching rule: nothing is read unless the launch's shared snapshot says a bid is parked (Launch.parked_count)
  and a wallet is connected; then the launch's shared bid list (the CDN's, app/api/launch/[id]/bids) says whether one is
  this wallet's. No per-visitor RPC on any other launch or for any other visitor.
*/
export function ParkedBid({ launch, record }: { launch: Launch; record: SettlementRecord }) {
  const account = useAccount();
  const address = account.address;
  const a = launch.account;
  const parked = a.parkedCount ?? 0;
  const receipt = useParkedReceipt(launch.id, address);
  const { bids } = useBidsRead(address && parked > 0 ? launch.id : "", `${a.state}:${a.distributedCount}:${parked}`);
  const { rate, status } = useCapRate(record.settledTs);
  const mine = address && bids ? (bids.find((b) => b.bidder === address && b.state === "parked") ?? null) : null;
  if (!address || (!mine && !receipt)) return null;

  const tokens = mine?.parked?.tokens ?? receipt?.tokens ?? 0n;
  const d = launch.token.decimals;
  const sym = launch.token.symbol;
  const cleared = rate ? fmtCap(mcapForValue(a, record.floatValue), rate.usdPerSol) : noRateText(status);

  if (tokens > 0n) {
    return (
      <section className="panel p-4 md:p-5 mt-4" aria-label="Your bid" data-parked-bid>
        <section className="inset p-4 border-accent-line">
          <p className="text-text-3">
            Your bid, <span className="mono">{shortAddr(address, 5, 4)}</span>
          </p>
          <p className="display text-[1.5rem] mt-1 leading-tight">You&apos;re in at a {cleared} market cap.</p>
          <p className="text-text-2 mt-1 leading-snug">
            You won {fmtTokens(tokens, d)} {sym}, {fmtPct(shareOfSupply(a, tokens), 2)} of supply.
          </p>
          {mine ? <ParkedCollect launch={launch} bid={mine} variant="winner" /> : receipt && <ParkedCollected launch={launch} receipt={receipt} />}
        </section>
      </section>
    );
  }
  const lamports = mine?.parked?.lamports ?? receipt?.lamports ?? 0n;
  return (
    <section className="panel p-4 md:p-5 mt-4" aria-label="Your refund" data-parked-bid>
      <p className="text-text-3">Your refund</p>
      {mine && (
        <p className="figure text-[1.75rem] leading-tight mt-1 wrap-any">
          {fmtSolPrecise(lamports)} <span className="text-text-2 font-sans text-[1rem]">to collect</span>
        </p>
      )}
      {mine ? <ParkedCollect launch={launch} bid={mine} variant="refund" /> : receipt && <ParkedCollected launch={launch} receipt={receipt} />}
    </section>
  );
}
