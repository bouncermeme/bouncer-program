import type { Metadata } from "next";
import { PAGE_META, pageMetadata } from "@/lib/seo";
import { FeesAndTerms } from "@/components/create/FeesAndTerms";

export const metadata: Metadata = pageMetadata({ ...PAGE_META["/fees"], path: "/fees" });

export default function FeesPage() {
  return <FeesAndTerms />;
}
