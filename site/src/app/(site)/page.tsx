import type { Metadata } from "next";
import { HomeView } from "@/components/home/HomeView";
import { JsonLd } from "@/components/seo/JsonLd";
import { organizationLd, PAGE_META, pageMetadata, websiteLd } from "@/lib/seo";

export const metadata: Metadata = pageMetadata({ ...PAGE_META["/"], path: "/" });

export default function Home() {
  return (
    <>
      <JsonLd data={[organizationLd(), websiteLd()]} />
      <HomeView />
    </>
  );
}
