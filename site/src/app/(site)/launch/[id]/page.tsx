import type { Metadata } from "next";
import { launchCard } from "@/lib/seo";
import { redirect } from "next/navigation";
import { readShare } from "@/lib/bouncer/share/facts";
import { LaunchView } from "@/components/launch/LaunchView";
import { REVIEW_PARAM, withReview } from "@/lib/review";

/*
  the founder, 2026-10-08: "people want to get to trading instantly, not show the
  working." Once the pool is live, the coin's URL is the trading page: a
  fresh visit (a card tap, a share link, the Telegram feed, an address bar)
  is redirected here on the server, before anything renders, and a page
  already open moves itself the moment the pool opens (LaunchView). Before
  the pool (open, revealing, settling) this stays the auction page. The
  auction's working lives on at /launch/<id>/auction, behind "How it
  cleared" on the trading page. A read that fails or is late falls through
  to the auction page, which then redirects on the client once it has read
  the launch itself.
*/

type Props = { params: Promise<{ id: string }> };

/* The token's name and ticker, read from the chain, never the launch's account address (someone would paste it into a screener as if it were a mint). */
export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id } = await params;
  const read = await readShare(id);
  const f = read === "missing" ? null : read;
  if (!f) return { title: "Launch", alternates: { canonical: `/launch/${id}` }, openGraph: { images: [launchCard(id)] }, twitter: { card: "summary_large_image", images: [launchCard(id)] } };
  return { title: `${f.name} (${f.symbol})`, description: `${f.status}. Deposited ${f.deposited}.`, alternates: { canonical: `/launch/${id}` }, openGraph: { title: `${f.name} (${f.symbol})`, description: `${f.status}. Deposited ${f.deposited}.`, url: `/launch/${id}`, images: [launchCard(id)] }, twitter: { card: "summary_large_image", title: `${f.name} (${f.symbol})`, description: `${f.status}. Deposited ${f.deposited}.`, images: [launchCard(id)] } };
}

export default async function LaunchPage({ params, searchParams }: Props & { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { id } = await params;
  const read = await readShare(id);
  /* A reviewer's key (lib/review.ts; the proxy has checked it) goes with the redirect, or the trading page would be the coming-soon page. */
  const review = (await searchParams)[REVIEW_PARAM];
  if (read && read !== "missing" && read.tradable) redirect(withReview(`/launch/${id}/trade`, typeof review === "string" ? review : null));
  return <LaunchView id={id} />;
}
