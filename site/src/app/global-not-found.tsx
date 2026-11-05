import type { Metadata, Viewport } from "next";
import { NotFoundBody } from "@/components/shell/NotFoundBody";
import { SiteFrameLazy } from "@/components/shell/SiteFrameLazy";
import { fullTitle } from "@/lib/seo";
import { RootHtml, metadata as rootMetadata, viewport as rootViewport } from "./rootShell";

/* The site root's metadata with the 404's title, as the layout's template made it ("Not found · Bouncer"). */
export const metadata: Metadata = { ...rootMetadata, title: fullTitle("Not found") };
export const viewport: Viewport = rootViewport;

/*
  The 404 for an address no route matches (tag 31d; next.config.ts experimental.globalNotFound): with two root layouts
  there is no app/not-found.tsx. Next renders this page outside every layout, so it draws the root's html and the
  site's frame itself, the frame through components/shell/SiteFrameLazy.tsx. A site page that calls notFound() gets
  app/(site)/not-found.tsx inside the site's own layout.
*/
export default function GlobalNotFound() {
  return (
    <RootHtml>
      <SiteFrameLazy>
        <NotFoundBody />
      </SiteFrameLazy>
    </RootHtml>
  );
}
