import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import localFont from "next/font/local";
import "./globals.css";
import { ReviewCarry } from "@/components/ReviewCarry";
import { BRAND } from "@/lib/brand";
import { NIGHT } from "@/lib/brandMark";
import { robotsMetadata } from "@/lib/bouncer/siteCluster";
import { CLUSTER } from "@contract/active";
import { canonicalOrigin, SITE_CARD, TITLE_TEMPLATE } from "@/lib/seo";

/*
  Two faces, decided by the founder on 2026-09-24 as three and cut to two by them
  on 2026-10-07 (the serif display face is gone), and a display face again
  in the new look proposed on 2026-10-10 (Red Hat Display, the closest
  licensed match to concept C's lettering, through the --font-display token
  in globals.css), all self-hosted from src/app/fonts as woff2 so nothing
  is fetched from a CDN at runtime.

  There is no quiet fallback on purpose. Each family falls back to the
  generic cursive face, so if a file ever fails to load the page looks
  visibly wrong instead of quietly turning into Segoe or Roboto.
*/

/* Display, body, labels, buttons. Variable: wght 100..900. */
const switzer = localFont({
  src: [
    { path: "./fonts/Switzer-VF.woff2", style: "normal" },
    { path: "./fonts/Switzer-Italic-VF.woff2", style: "italic" },
  ],
  weight: "100 900",
  variable: "--font-switzer",
  display: "block",
  fallback: ["cursive"],
  adjustFontFallback: false,
  preload: true,
});

/*
  Headings, names and the wordmark (the --font-display token). Variable: wght
  300..900, OFL (licence beside the files). Fontsource cuts it in two: Latin,
  preloaded, and Latin Extended, which the browser fetches only when a name
  holds a letter the first half lacks. Neither has a fallback of its own, so
  the token can list both and then Switzer, which ends in cursive. The cost:
  if both Red Hat files failed to load, headings would quietly show Switzer;
  the files are served from the same place as Switzer's.
*/
const redhat = localFont({
  src: [{ path: "./fonts/RedHatDisplay-latin-VF.woff2", style: "normal" }],
  weight: "300 900",
  variable: "--font-redhat",
  display: "block",
  fallback: [],
  adjustFontFallback: false,
  preload: true,
});
const redhatExt = localFont({
  src: [{ path: "./fonts/RedHatDisplay-latin-ext-VF.woff2", style: "normal" }],
  weight: "300 900",
  variable: "--font-redhat-ext",
  display: "block",
  fallback: [],
  adjustFontFallback: false,
  preload: false,
});

/* Addresses, hashes, tickers and the big figures. Static 400 and 700. */
const commit = localFont({
  src: [
    { path: "./fonts/CommitMono-Regular.woff2", weight: "400", style: "normal" },
    { path: "./fonts/CommitMono-Bold.woff2", weight: "700", style: "normal" },
  ],
  variable: "--font-commit",
  display: "block",
  fallback: ["cursive"],
  adjustFontFallback: false,
  preload: true,
});

export const metadata: Metadata = {
  /* Canonical URLs and card images resolve against the site's origin (lib/seo.ts canonicalOrigin: SITE_ORIGIN, else bouncer.meme). */
  metadataBase: new URL(canonicalOrigin()),
  title: {
    default: BRAND.name,
    template: TITLE_TEMPLATE,
  },
  applicationName: BRAND.name,
  openGraph: { siteName: BRAND.name, type: "website", images: [SITE_CARD] },
  twitter: { card: "summary_large_image", site: BRAND.xHandle, images: [SITE_CARD] },
  /* Out of search unless the build is indexed (lib/indexing.ts: SITE_INDEXING=on, the gate off, a mainnet pin; launch candidate 2026-10-22). Also app/robots.ts, the X-Robots-Tag header in next.config.ts and src/proxy.ts. */
  robots: robotsMetadata(CLUSTER),
  description:
    "A Solana launchpad where everyone who gets in pays the same market cap, set by a sealed-bid auction. Nothing to snipe.",
};

export const viewport: Viewport = {
  themeColor: NIGHT,
  viewportFit: "cover",
  width: "device-width",
  initialScale: 1,
};

/*
  The html both root layouts share (tag 31d): the fonts, the metadata above and the reviewer's link carry. The site's
  root, app/(site)/layout.tsx, draws its frame inside (the banners, the wallet providers, the header, the footer, the
  storage notice, the guide; components/shell/SiteFrame.tsx), and its 404 is app/(site)/not-found.tsx (an address no
  route matches: app/global-not-found.tsx). The public
  whitepaper's root, app/(public)/layout.tsx, draws its own header and footer and imports nothing of the site's frame,
  so the anonymous /whitepaper carries neither the frame's elements in its page data nor the wallet code (the 31c
  pre-check's G1). Two roots, not one with two frames under it: a root's not-found page rides in every page's data
  below it, and the 404's has the site's frame.
*/
export function RootHtml({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${switzer.variable} ${redhat.variable} ${redhatExt.variable} ${commit.variable} h-full`}>
      <body className="min-h-full flex flex-col">
        {/* Reviewer access (lib/review.ts): a page opened with ?review= keeps it on every internal link. */}
        <ReviewCarry />
        {children}
      </body>
    </html>
  );
}
