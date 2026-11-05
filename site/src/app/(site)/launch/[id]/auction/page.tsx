import type { Metadata } from "next";
import { launchCard } from "@/lib/seo";
import { readShare } from "@/lib/bouncer/share/facts";
import { LaunchView } from "@/components/launch/LaunchView";

/*
  The auction page, whatever the launch's state: the deposits, the bids,
  the terms, the settled summary. the founder, 2026-10-08: once the pool is live
  the coin's own URL (/launch/<id>) lands on trading, and this is where the
  working went, behind "How it cleared" on the trading page. Nothing here
  redirects.
*/
type Props = { params: Promise<{ id: string }> };

/* The token's name and ticker, read from the chain, never the launch's account address (someone would paste it into a screener as if it were a mint). */
export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id } = await params;
  const read = await readShare(id);
  const f = read === "missing" ? null : read;
  if (!f) return { title: "Auction", alternates: { canonical: `/launch/${id}/auction` }, openGraph: { images: [launchCard(id)] }, twitter: { card: "summary_large_image", images: [launchCard(id)] } };
  return { title: `${f.name} (${f.symbol}) auction`, description: `${f.status}. Deposited ${f.deposited}.`, alternates: { canonical: `/launch/${id}/auction` }, openGraph: { title: `${f.name} (${f.symbol}) auction`, description: `${f.status}. Deposited ${f.deposited}.`, url: `/launch/${id}/auction`, images: [launchCard(id)] }, twitter: { card: "summary_large_image", title: `${f.name} (${f.symbol}) auction`, description: `${f.status}. Deposited ${f.deposited}.`, images: [launchCard(id)] } };
}

export default async function AuctionPage({ params }: Props) {
  const { id } = await params;
  return <LaunchView id={id} />;
}
