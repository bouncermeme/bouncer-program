import type { Metadata } from "next";
import { FaqView } from "@/components/content/FaqView";
import { faqEntries, faqText, pinnedFaqInputs } from "@/components/content/faqData";
import { JsonLd } from "@/components/seo/JsonLd";
import { faqPageLd, PAGE_META, pageMetadata } from "@/lib/seo";

export const metadata: Metadata = pageMetadata({ ...PAGE_META["/faq"], path: "/faq" });

/* The FAQPage JSON-LD is the page's own questions (faqData.ts), with this cluster's pinned terms. */
export default function FaqPage() {
  const ld = faqPageLd(faqEntries(pinnedFaqInputs()).map((e) => ({ q: e.q, text: faqText(e.a) })));
  return (
    <>
      <JsonLd data={ld} />
      <FaqView />
    </>
  );
}
