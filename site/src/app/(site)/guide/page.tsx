import type { Metadata } from "next";
import { PAGE_META, pageMetadata } from "@/lib/seo";
import { GuideView } from "@/components/content/GuideView";

export const metadata: Metadata = pageMetadata({ ...PAGE_META["/guide"], path: "/guide" });

export default function GuidePage() {
  return <GuideView />;
}
