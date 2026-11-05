import type { MetadataRoute } from "next";
import { canonicalOrigin, SITE_PAGES } from "@/lib/seo";

/*
  The sitemap (launch candidate, 2026-10-22): the site's own pages, never the
  API or the reviewer packet. Launches are not listed (each is a chain read);
  they are linked from the home page. robots.txt names this file only when the
  build is indexed (lib/indexing.ts).
*/
export default function sitemap(): MetadataRoute.Sitemap {
  const origin = canonicalOrigin();
  return SITE_PAGES.map((path) => ({ url: `${origin}${path === "/" ? "" : path}`, changeFrequency: path === "/" ? "daily" : "monthly", priority: path === "/" ? 1 : 0.6 }));
}
