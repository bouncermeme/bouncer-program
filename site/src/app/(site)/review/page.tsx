import type { Metadata } from "next";
import Link from "next/link";
import { PACKET_DOCS } from "@/content/reviewPacket";
import { REVIEW_OVERVIEW } from "@/content/reviewIndex";
import { markdownToHtml } from "@/lib/reviewMarkdown";
import { REVIEW_PARAM, withReview } from "@/lib/review";
import { reviewPacketLocked } from "@/lib/reviewLock";
import { notFound } from "next/navigation";
import { CLUSTER } from "@contract/active";

/*
  The reviewer packet (the founder, 2026-10-21, for the v1 sign-off panel): plain HTML an AI reviewer without file access
  can read. Behind the same gate as the app (src/proxy.ts): the access cookie, or ?review= with the reviewer key.
  Every link carries the key it was opened with. On a mainnet pin it is a 404, always (lib/reviewLock.ts, B20).
*/
export const metadata: Metadata = { title: "Reviewer packet", robots: { index: false, follow: false } };

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

function packetKey(sp: Record<string, string | string[] | undefined>): string | null {
  const k = sp[REVIEW_PARAM];
  return typeof k === "string" ? k : null;
}

export default async function ReviewPage({ searchParams }: Props) {
  if (reviewPacketLocked(CLUSTER)) notFound();
  const key = packetKey(await searchParams);
  const groups = Array.from(new Set(PACKET_DOCS.map((d) => d.group)));
  return (
    <article className="packet pt-6 md:pt-8">
      <div dangerouslySetInnerHTML={{ __html: markdownToHtml(REVIEW_OVERVIEW, 0) }} />
      <h2 id="contents">8. Contents</h2>
      <p>Each document is one page. The source path and the sha256 prefix of the file it was taken from are at the top of each page.</p>
      {groups.map((g) => (
        <section key={g}>
          <h3>{g}</h3>
          <ul>
            {PACKET_DOCS.filter((d) => d.group === g).map((d) => (
              <li key={d.slug}>
                <Link href={withReview(`/review/${d.slug}`, key)}>{d.title}</Link> <span>({Math.round(d.body.length / 1000)}k characters)</span>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </article>
  );
}
