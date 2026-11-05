import type { Metadata } from "next";
import { NamesAdmin } from "@/components/admin/NamesAdmin";

/* The admin's same-name notices (components/admin/NamesAdmin.tsx; v0.30 item 8). Linked from nowhere, never indexed, behind the coming-soon gate like every page. */
export const metadata: Metadata = { title: "Same-name notices", robots: { index: false, follow: false } };

export default function Page() {
  return <NamesAdmin />;
}
