import type { Metadata } from "next";
import { WhitepaperView } from "@/components/content/WhitepaperView";
import { JsonLd } from "@/components/seo/JsonLd";
import { articleLd, PAGE_META, pageMetadata, WHITEPAPER_CARD_META } from "@/lib/seo";

/*
  The whitepaper an anonymous visitor gets while the coming-soon gate is on and the switch (COMING_SOON_OPEN_WHITEPAPER)
  is 1 (round 3b's frame, tag 31c). src/proxy.ts serves an anonymous GET of /whitepaper from here, so the address stays
  /whitepaper and the canonical is that address; its own layout, app/(public)/layout.tsx, draws the public shell
  (components/shell/PublicShell.tsx) and nothing of the site's frame. Asked for directly without the access cookie, this address is gated like any other.
*/
export const metadata: Metadata = pageMetadata({ ...PAGE_META["/whitepaper"], path: "/whitepaper", card: WHITEPAPER_CARD_META });

export default function PublicWhitepaperPage() {
  return (
    <>
      <JsonLd data={articleLd()} />
      <WhitepaperView />
    </>
  );
}
