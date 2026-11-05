"use client";

import { useSearchParams } from "next/navigation";
import { CLUSTER } from "@contract/active";

const ON_MAINNET = (CLUSTER as string) === "mainnet-beta" || (CLUSTER as string) === "mainnet";

/*
  The holder map, as a link (B7, the approved mock 1d98d36, option B; plan F13, F41): the Bubblemaps embed is gone, so
  the trading page frames no holder map and needs no partner id. Bubblemaps' own public page for the token opens in a
  new tab, from the funding panel's heading row (TradeFunding.tsx), and the funding panel takes the map's cell
  (TradeView.tsx). Bubblemaps maps mainnet tokens only (a devnet mint answers "No holders found for this token
  address", read 2026-10-07), so off mainnet there is no link. app.bubblemaps.io/sol/token/<mint> answers 301 to the
  current map, v2.bubblemaps.io/map?address=<mint>&chain=solana (read 2026-10-30).
*/
export function bubblemapsUrl(mint: string): string {
  return `https://app.bubblemaps.io/sol/token/${encodeURIComponent(mint)}`;
}

/* The same dev-only override TokenMarket takes, ?market=<mainnet pool>:<mainnet mint>: the link goes to that mint's map. Dead code in a production build. */
function usePreviewMint(): string | null {
  const params = useSearchParams();
  return process.env.NODE_ENV === "development" ? (params.get("market") ?? "").split(":")[1] || null : null;
}

export function BubblemapsLink({ mint }: { mint: string }) {
  const preview = usePreviewMint();
  if (!ON_MAINNET && preview === null) return null;
  return (
    <a href={bubblemapsUrl(preview ?? mint)} target="_blank" rel="noreferrer" className="link-accent inline-flex items-center gap-1 min-h-[2.75rem] px-1 whitespace-nowrap" data-bubblemaps-link>
      View on Bubblemaps
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M7 17L17 7M9 7h8v8" />
      </svg>
    </a>
  );
}
