import type { Metadata } from "next";
import { PAGE_META, pageMetadata } from "@/lib/seo";
import { TrustView } from "@/components/trust/TrustView";

export const metadata: Metadata = pageMetadata({ ...PAGE_META["/trust"], path: "/trust" });

export default function TrustPage() {
  return <TrustView />;
}
