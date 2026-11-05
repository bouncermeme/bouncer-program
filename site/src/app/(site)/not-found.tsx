import type { Metadata } from "next";
import { NotFoundBody } from "@/components/shell/NotFoundBody";

export const metadata: Metadata = { title: "Not found" };

/* The 404 (launch candidate, 2026-10-22) of a site page that calls notFound() (the reviewer packet), the site root's own (tag 31d), inside the site's frame (app/(site)/layout.tsx). An address no route matches gets app/global-not-found.tsx. */
export default function NotFound() {
  return <NotFoundBody />;
}
