import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { PACKET_DOCS } from "@/content/reviewPacket";
import { markdownToHtml } from "@/lib/reviewMarkdown";
import { REVIEW_PARAM, withReview } from "@/lib/review";
import { reviewPacketLocked } from "@/lib/reviewLock";
import { CLUSTER } from "@contract/active";

/* One document of the reviewer packet (app/review/page.tsx), with its source and the links back and on. A 404 on a mainnet pin, always (lib/reviewLock.ts, B20). */
type Props = { params: Promise<{ slug: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const doc = reviewPacketLocked(CLUSTER) ? undefined : PACKET_DOCS.find((d) => d.slug === slug);
  return { title: doc ? doc.title : "Reviewer packet", robots: { index: false, follow: false } };
}

export default async function ReviewDocPage({ params, searchParams }: Props) {
  if (reviewPacketLocked(CLUSTER)) notFound();
  const { slug } = await params;
  const sp = await searchParams;
  const key = typeof sp[REVIEW_PARAM] === "string" ? (sp[REVIEW_PARAM] as string) : null;
  const at = PACKET_DOCS.findIndex((d) => d.slug === slug);
  if (at < 0) notFound();
  const doc = PACKET_DOCS[at];
  const prev = PACKET_DOCS[at - 1];
  const next = PACKET_DOCS[at + 1];
  const nav = (
    <nav className="flex flex-wrap gap-x-4 gap-y-1">
      <Link href={withReview("/review", key)}>Packet contents</Link>
      {prev && <Link href={withReview(`/review/${prev.slug}`, key)}>Previous: {prev.title}</Link>}
      {next && <Link href={withReview(`/review/${next.slug}`, key)}>Next: {next.title}</Link>}
    </nav>
  );
  return (
    <article className="packet pt-6 md:pt-8">
      {nav}
      <h1>{doc.title}</h1>
      <p>
        Source: <code>{doc.source}</code>. sha256 of the source file (first 16 hex digits): <code>{doc.sha256}</code>. Reproduced from the repository; the text is the source&apos;s own.
      </p>
      <hr />
      <div dangerouslySetInnerHTML={{ __html: markdownToHtml(doc.body, 1) }} />
      <hr />
      {nav}
    </article>
  );
}
