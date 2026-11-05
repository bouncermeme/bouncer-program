import type { Metadata } from "next";
import { PAGE_META, pageMetadata } from "@/lib/seo";
import { StatsView } from "@/components/stats/StatsView";

export const metadata: Metadata = pageMetadata({ ...PAGE_META["/stats"], path: "/stats" });

export default function StatsPage() {
  return <StatsView />;
}
