/* JSON-LD for a page (lib/seo.ts builds it and escapes it). A server component: nothing ships to the browser but the script tag. */
import { ldJson } from "@/lib/seo";

export function JsonLd({ data }: { data: Record<string, unknown> | Record<string, unknown>[] }) {
  return <script type="application/ld+json" data-jsonld dangerouslySetInnerHTML={{ __html: ldJson(data) }} />;
}
