import type { Metadata } from "next";
import { PAGE_META, pageMetadata } from "@/lib/seo";
import { HowView } from "@/components/how/HowView";

export const metadata: Metadata = pageMetadata({ ...PAGE_META["/how"], path: "/how" });

/* the founder's text of 2026-10-16, word for word, with the figures read live from the program's config (components/how/HowView.tsx). */
export default function HowPage() {
  return <HowView />;
}
