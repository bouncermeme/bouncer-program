import type { MetadataRoute } from "next";
import { robotsRules } from "@/lib/bouncer/siteCluster";
import { canonicalOrigin } from "@/lib/seo";
import { CLUSTER } from "@contract/active";

/* Follows the pin and the switch (lib/indexing.ts; launch candidate 2026-10-22): disallows everything unless the build is indexed, then everything but the API and the reviewer packet, with the sitemap. Replaces the static app/robots.txt. While the gate is on the proxy answers robots.txt itself (lib/comingSoon.ts). */
export default function robots(): MetadataRoute.Robots {
  return robotsRules(CLUSTER, process.env, canonicalOrigin());
}
