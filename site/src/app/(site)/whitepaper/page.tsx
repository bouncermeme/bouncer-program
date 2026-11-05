import type { Metadata } from "next";
import { WhitepaperView } from "@/components/content/WhitepaperView";
import { JsonLd } from "@/components/seo/JsonLd";
import { articleLd, PAGE_META, pageMetadata, WHITEPAPER_CARD_META } from "@/lib/seo";

/* The page's own card (31c): the one image the gate opens with it, so a shared link shows a picture while the rest is gated. */
export const metadata: Metadata = pageMetadata({ ...PAGE_META["/whitepaper"], path: "/whitepaper", card: WHITEPAPER_CARD_META });

export default function WhitepaperPage() {
  return (
    <>
      <JsonLd data={articleLd()} />
      <WhitepaperView />
    </>
  );
}
