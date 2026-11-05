import type { Metadata } from "next";
import { TickerAdmin } from "@/components/admin/TickerAdmin";

/* The admin ticker release (components/admin/TickerAdmin.tsx). Linked from nowhere, never indexed, behind the coming-soon gate like every page. */
export const metadata: Metadata = { title: "Ticker release", robots: { index: false, follow: false } };

export default function Page() {
  return <TickerAdmin />;
}
