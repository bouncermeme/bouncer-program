import type { Metadata } from "next";
import { launchCard } from "@/lib/seo";
import { readShare } from "@/lib/bouncer/share/facts";
import { BidFlow } from "@/components/bid/BidFlow";

type Props = { params: Promise<{ id: string }> };

/* The token's name and ticker, read from the chain, never the launch's account address (someone would paste it into a screener as if it were a mint). */
export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id } = await params;
  const read = await readShare(id);
  const f = read === "missing" ? null : read;
  if (!f) return { title: "Bid", alternates: { canonical: `/launch/${id}/bid` }, openGraph: { images: [launchCard(id)] }, twitter: { card: "summary_large_image", images: [launchCard(id)] } };
  return { title: `Bid on ${f.name} (${f.symbol})`, description: `${f.status}. Deposited ${f.deposited}.`, alternates: { canonical: `/launch/${id}/bid` }, openGraph: { title: `Bid on ${f.name} (${f.symbol})`, description: `${f.status}. Deposited ${f.deposited}.`, url: `/launch/${id}/bid`, images: [launchCard(id)] }, twitter: { card: "summary_large_image", title: `Bid on ${f.name} (${f.symbol})`, description: `${f.status}. Deposited ${f.deposited}.`, images: [launchCard(id)] } };
}

export default async function BidPage({ params }: Props) {
  const { id } = await params;
  return <BidFlow id={id} />;
}
