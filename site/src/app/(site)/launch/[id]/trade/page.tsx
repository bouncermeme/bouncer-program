import type { Metadata } from "next";
import { launchCard } from "@/lib/seo";
import { readShare } from "@/lib/bouncer/share/facts";
import { TradeView } from "@/components/trade/TradeView";

type Props = { params: Promise<{ id: string }> };

/* The token's name and ticker, read from the chain, never the launch's account address (someone would paste it into a screener as if it were a mint). */
export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id } = await params;
  const read = await readShare(id);
  const f = read === "missing" ? null : read;
  if (!f) return { title: "Trading", alternates: { canonical: `/launch/${id}/trade` }, openGraph: { images: [launchCard(id)] }, twitter: { card: "summary_large_image", images: [launchCard(id)] } };
  return { title: `${f.name} (${f.symbol}) trading`, description: `${f.status}. Deposited ${f.deposited}.`, alternates: { canonical: `/launch/${id}/trade` }, openGraph: { title: `${f.name} (${f.symbol}) trading`, description: `${f.status}. Deposited ${f.deposited}.`, url: `/launch/${id}/trade`, images: [launchCard(id)] }, twitter: { card: "summary_large_image", title: `${f.name} (${f.symbol}) trading`, description: `${f.status}. Deposited ${f.deposited}.`, images: [launchCard(id)] } };
}

export default async function TradePage({ params }: Props) {
  const { id } = await params;
  return <TradeView id={id} />;
}
