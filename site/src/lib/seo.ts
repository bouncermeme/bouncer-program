/*
  Search and share metadata (launch candidate, 2026-10-22): one helper for each
  page's title, description, canonical URL and cards, and the JSON-LD the home,
  /faq and /whitepaper carry. Whether any of it is indexed is lib/indexing.ts's
  decision, not this module's.
*/
import type { Metadata } from "next";
import { BRAND } from "@/lib/brand";
import { CONTACT_EMAIL } from "@/lib/site";
import { WP_LEAD } from "@/components/content/whitepaperText";

/* The canonical origin: SITE_ORIGIN when it is a plain origin, else the production domain. */
export function canonicalOrigin(env: { SITE_ORIGIN?: string; [name: string]: string | undefined } = process.env): string {
  const set = env.SITE_ORIGIN?.trim();
  return set && /^https?:\/\/[A-Za-z0-9.-]+(:\d+)?$/.test(set) ? set : `https://${BRAND.domain}`;
}

export const TITLE_TEMPLATE = `%s · ${BRAND.name}`;
export const fullTitle = (title: string) => `${title} · ${BRAND.name}`;

/* The static pages the sitemap lists, and the titles they carry (scripts/check-seo.tsx holds them unique). /trust and /stats since 2026-10-30 (build lane 2, item 8): both carry their canonical metadata already. */
export const SITE_PAGES = ["/", "/how", "/fees", "/guide", "/faq", "/whitepaper", "/create", "/terms", "/privacy", "/cookies", "/risk", "/trust", "/stats"] as const;

/*
  The share cards (23c, the founder 2026-10-24: og:image and twitter:image on every page). A page's openGraph and twitter
  objects replace the layout's whole object in Next, so a page that sets them names its image too: the site's card
  (app/opengraph-image.tsx) everywhere but a launch, whose pages name the launch's own (app/launch/[id]/opengraph-image.tsx).
*/
export const SITE_CARD_ALT = `${BRAND.name}: no line to cut. Fair launches, one price.`;
export const SITE_CARD = { url: "/opengraph-image", width: 1200, height: 630, alt: SITE_CARD_ALT };
/* The whitepaper's own card (31c, 2026-10-31): public/og/whitepaper.png, the coming-soon card's bytes, which the gate opens with the page (lib/comingSoon.ts PUBLIC_CARD); a static file named with no query, so the card fetchers' robots lines match it. */
export const WHITEPAPER_CARD_META = { url: "/og/whitepaper.png", width: 1200, height: 630, alt: `${BRAND.name}. A new launchpad on Solana. Launching soon.` };
export const launchCard = (id: string) => ({ url: `/launch/${encodeURIComponent(id)}/opengraph-image`, width: 1200, height: 630, alt: `A ${BRAND.domain} launch` });

/*
  A page's metadata: the title (the layout's template adds " · Bouncer"; `absolute` skips it), the description, the
  canonical path (resolved against the layout's metadataBase), and the Open Graph and X cards with the site's card.
*/
export function pageMetadata({ title, description, path, absolute = false, card = SITE_CARD }: { title: string; description?: string; path: string; absolute?: boolean; card?: typeof SITE_CARD }): Metadata {
  const shown = absolute ? title : fullTitle(title);
  return {
    title: absolute ? { absolute: title } : title,
    ...(description ? { description } : {}),
    alternates: { canonical: path },
    openGraph: { type: "website", siteName: BRAND.name, url: path, title: shown, ...(description ? { description } : {}), images: [card] },
    twitter: { card: "summary_large_image", site: BRAND.xHandle, title: shown, ...(description ? { description } : {}), images: [card] },
  };
}

/* JSON-LD. */
type Ld = Record<string, unknown>;

export function organizationLd(origin: string = canonicalOrigin()): Ld {
  return {
    "@context": "https://schema.org",
    "@type": "Organization",
    "@id": `${origin}/#organization`,
    name: BRAND.name,
    url: origin,
    email: CONTACT_EMAIL,
    brand: { "@type": "Brand", name: BRAND.name },
    sameAs: ["https://x.com/bouncermeme"],
  };
}

export function websiteLd(origin: string = canonicalOrigin()): Ld {
  return {
    "@context": "https://schema.org",
    "@type": "WebSite",
    "@id": `${origin}/#website`,
    name: BRAND.name,
    url: origin,
    inLanguage: "en",
    publisher: { "@id": `${origin}/#organization` },
  };
}

export function faqPageLd(entries: { q: string; text: string }[], origin: string = canonicalOrigin()): Ld {
  return {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    url: `${origin}/faq`,
    mainEntity: entries.map((e) => ({ "@type": "Question", name: e.q, acceptedAnswer: { "@type": "Answer", text: e.text } })),
  };
}

/* The whitepaper's date: the launch candidate's text (WhitepaperView). Change it with the text. */
export const WHITEPAPER_MODIFIED = "2026-10-22";
/* The share description is the paper's own lead line (whitepaperText.ts WP_LEAD, the founder's text), since 31c (2026-10-31): the old one named an "upgrade freeze" the program does not have. */
export const WHITEPAPER_DESCRIPTION = WP_LEAD;

/*
  Each sitemap page's title and description, the one source for its metadata (pageMetadata) and for /llms.txt
  (lib/llms.ts, public/llms.txt): build lane 2, 2026-10-31 (Dispatch: llms.txt from the pages' existing descriptions,
  no new words). The words are the pages' own, moved here unchanged.
*/
export const PAGE_META: Readonly<Record<(typeof SITE_PAGES)[number], { title: string; description: string; absolute?: boolean }>> = {
  "/": { title: "Bouncer: a Solana launchpad with one price for everyone", absolute: true, description: "A Solana launchpad where everyone who gets in pays the same market cap, set by a sealed-bid auction." },
  "/how": { title: "How it works", description: "How a Bouncer launch runs: one sealed-bid auction, one clearing price for every winner, refunds for the rest." },
  "/fees": { title: "Fees and terms", description: "Every rule and fee a Bouncer launch carries, read from the program's config." },
  "/guide": { title: "Guide", description: "Creating and bidding on Bouncer, step by step: the auction, the price, tokens, refunds, fees and timelines." },
  "/faq": { title: "FAQ", description: "Short answers about bidding and creating on Bouncer." },
  "/whitepaper": { title: "Whitepaper", description: WHITEPAPER_DESCRIPTION },
  "/create": { title: "Create a launch", description: "Start a sealed-bid token launch on Solana: name, ticker, image and window. Everything else is the same on every launch." },
  "/terms": { title: "Terms of Use", description: "The terms for using the Bouncer site." },
  "/privacy": { title: "Privacy Policy", description: "What the Bouncer site collects, and what it does not." },
  "/cookies": { title: "Cookies and storage", description: "Every cookie and browser storage item the Bouncer site uses." },
  "/risk": { title: "Risk Disclosure", description: "Read this before you bid or create a launch on Bouncer." },
  "/trust": { title: "Trust", description: "What runs Bouncer and who can change it: the program, its build, the upgrade authority, the treasury, the keepers and the official accounts." },
  "/stats": { title: "Stats", description: "Bouncer in numbers: launches, SOL raised, liquidity locked forever, refunds and creator earnings, read from the chain." },
};

export function articleLd(origin: string = canonicalOrigin()): Ld {
  const org = { "@type": "Organization", "@id": `${origin}/#organization`, name: BRAND.name };
  return {
    "@context": "https://schema.org",
    "@type": "Article",
    headline: `${BRAND.name} whitepaper`,
    description: WHITEPAPER_DESCRIPTION,
    url: `${origin}/whitepaper`,
    mainEntityOfPage: `${origin}/whitepaper`,
    inLanguage: "en",
    dateModified: WHITEPAPER_MODIFIED,
    author: org,
    publisher: org,
    image: `${origin}/opengraph-image`,
  };
}

/* The script body: JSON with every "<" escaped, so no value can close the script tag (and "&", ">" and the two line separators for good measure). */
export function ldJson(data: Ld | Ld[]): string {
  return JSON.stringify(data).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}
