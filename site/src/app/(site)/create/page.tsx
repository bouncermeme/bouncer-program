import type { Metadata } from "next";
import { PAGE_META, pageMetadata } from "@/lib/seo";
import { CreateLaunchView } from "@/components/create/CreateLaunchView";

export const metadata: Metadata = pageMetadata({ ...PAGE_META["/create"], path: "/create" });

export default function CreatePage() {
  return <CreateLaunchView />;
}
