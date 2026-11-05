import type { Metadata } from "next";
import { launchCard } from "@/lib/seo";
import { readShare } from "@/lib/bouncer/share/facts";
import { SettlementView } from "@/components/settlement/SettlementView";

type Props = { params: Promise<{ id: string }> };

/* The token's name and ticker, read from the chain, never the launch's account address (someone would paste it into a screener as if it were a mint). */
export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id } = await params;
  const read = await readShare(id);
  const f = read === "missing" ? null : read;
  if (!f) return { title: "Settlement", alternates: { canonical: `/launch/${id}/settlement` }, openGraph: { images: [launchCard(id)] }, twitter: { card: "summary_large_image", images: [launchCard(id)] } };
  return { title: `${f.name} (${f.symbol}) settlement`, description: `${f.status}. Deposited ${f.deposited}.`, alternates: { canonical: `/launch/${id}/settlement` }, openGraph: { title: `${f.name} (${f.symbol}) settlement`, description: `${f.status}. Deposited ${f.deposited}.`, url: `/launch/${id}/settlement`, images: [launchCard(id)] }, twitter: { card: "summary_large_image", title: `${f.name} (${f.symbol}) settlement`, description: `${f.status}. Deposited ${f.deposited}.`, images: [launchCard(id)] } };
}

export default async function SettlementPage({ params }: Props) {
  const { id } = await params;
  return <SettlementView id={id} />;
}
