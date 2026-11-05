import { BRAND } from "./brand";
import { doorSvg } from "./brandMark";
import { THEME } from "./theme";

/*
  The coming-soon gate (2026-10-19: we post on X, and the public must not
  see the devnet app; the team and the lanes keep full access). This module
  holds the gate's facts and the page as a string; src/proxy.ts answers with
  it.

  On when COMING_SOON_KEY is set and the deployment is not a Vercel preview
  (VERCEL_ENV "preview"), so previews and next dev keep the app. A visitor
  without the access cookie gets the coming-soon page on every page route;
  ?key=<COMING_SOON_KEY> on any page sets the cookie (a hash of the key,
  never the key, 400 days) and reloads the same address without the key;
  ?key=out clears it. With the cookie the app answers as before, marked
  for search engines to skip (the X-Robots-Tag header src/proxy.ts sets).

  The API is gated too (launch candidate, 2026-10-22: "coming soon no matter
  where they look... close it for everyone else besides our reviewer
  agents"): while the gate is on, an /api/* request needs the access cookie or
  the reviewer key (?review= or a reviewed page as its Referer) and is
  otherwise answered with the coming-soon page as a 404 (apiOpenWhileGated,
  src/proxy.ts apiLock). Two stay open: GET and HEAD of /api/token/<file>
  (the metadata and picture every launch's on-chain URI names, read by
  wallets and explorers) and /api/volume/refresh (the Vercel cron; its
  CRON_SECRET is its gate).

  Never gated (isOpenPath): /_next/static/* (the app's built files), the
  files of public/coming-soon (this page's fonts, their licences and its X
  card image) and the three icons, each by its exact name (2026-10-31,
  GATE-ALLOWLIST.md parked item 7: any other path under /_next/ or
  /coming-soon/, or any icon-like name, used to skip the gate, and Next
  answered it with its not-found page in the full app frame). robots.txt is answered by the proxy while the gate
  is on (launch candidate, 2026-10-22: while the gate is on, robots
  disallows everything): with the switch below unset, every crawler, X's
  card fetcher included, is refused everything, so a shared link shows no
  card. The page itself says noindex, nofollow, and the proxy adds the
  X-Robots-Tag header (lib/indexing.ts).

  The one page the gate may open (2026-10-31): /whitepaper, while
  COMING_SOON_OPEN_WHITEPAPER is exactly "1" after trim (a server variable,
  read on every call; unset, the default, keeps it gated). Decided last in
  src/proxy.ts comingSoon(), after the key, the cookie and the reviewer key,
  so those work on /whitepaper as on every page (publicWhileGated): GET or
  HEAD of exactly /whitepaper, a query allowed. Served as the existing page
  until the frontend lane's public twin route replaces the pass-through with
  its rewrite. The noindex and the /api lock are unchanged.
  review/2026-10-31-whitepaper/GATE-ALLOWLIST.md has the scope.

  The page's share card, on the same switch (2026-10-31, so a shared
  /whitepaper link can show a card on X and Telegram): GET or HEAD of
  exactly PUBLIC_CARD (publicCardWhileGated, decided beside the page rule),
  answered by the proxy itself with the card's bytes built into it
  (lib/whitepaperCard.ts, publicCardBytes), never handed to Next; with no
  card in the build, the coming-soon page. robots.txt lets X's,
  Telegram's and Discord's card fetchers read exactly the page and the card,
  each with or without a query; every other path, and every other crawler,
  stays refused (robotsWhileGated). Switch unset: both exactly as before.
  review/2026-10-31-whitepaper/XCARD-SCOPE.md has the scope.

  Tag 31c (2026-10-31): the proxy sees the address as asked (next.config.ts
  skipProxyUrlNormalize), so a data route such as
  /_next/data/<any build id>/whitepaper.json is never /whitepaper to these
  rules. On Vercel Next's adapter used to rewrite it to /whitepaper with no
  x-nextjs-data mark, and the 31b switch let Next's not-found page through
  (review/2026-10-31-whitepaper-public/LIVE.md).
*/

export const ACCESS_COOKIE = "bouncer_access";
export const ACCESS_MAX_AGE = 400 * 24 * 3600;
export const KEY_PARAM = "key";
export const SIGN_OUT = "out";
export const OG_IMAGE_PATH = "/coming-soon/og.png";

/* The handles, confirmed on 2026-10-19. Since 2026-10-21: t.me/bouncermeme becomes the community chat (the announcements channel moves to a new username, not yet chosen), so the site links it as the community. */
export const X_URL = "https://x.com/bouncermeme";
export const TELEGRAM_URL = "https://t.me/bouncermeme";

export const LINE = "A new launchpad on Solana. Launching soon.";

export function gateOn(env: { COMING_SOON_KEY?: string; VERCEL_ENV?: string }): boolean {
  return !!env.COMING_SOON_KEY && env.COMING_SOON_KEY.trim().length > 0 && env.VERCEL_ENV !== "preview";
}

/* The switch for the one open page (above). Exactly "1" opens it; anything else, unset included, keeps it gated. */
export const WHITEPAPER_OPEN_NAME = "COMING_SOON_OPEN_WHITEPAPER";
export function whitepaperOpen(env: Record<string, string | undefined> = process.env): boolean {
  return (env[WHITEPAPER_OPEN_NAME] ?? "").trim() === "1";
}

/* The one page open to everyone while the gate is on (above): only to read, only this exact address, only with the switch. */
export const PUBLIC_PAGE = "/whitepaper";
/* The route that serves it to an anonymous visitor (src/proxy.ts rewrites to it; the address stays PUBLIC_PAGE). Its
   frame reads nothing from the gated API (components/shell/PublicShell.tsx). Asked for by its own address, it is gated
   like any other page. */
export const PUBLIC_ROUTE = "/whitepaper/public";
export function publicWhileGated(method: string, path: string, env: Record<string, string | undefined> = process.env): boolean {
  return whitepaperOpen(env) && (method === "GET" || method === "HEAD") && path === PUBLIC_PAGE;
}

/*
  The open page's share card (above; XCARD-SCOPE.md): one image, the frontend lane's (by approved mock), which the
  public page's og:image and twitter:image name with no query. Only to read, only this exact address, only with the
  switch, like the page. Never in OPEN_FILES: those are open whatever the switch.
*/
export const PUBLIC_CARD = "/og/whitepaper.png";
export function publicCardWhileGated(method: string, path: string, env: Record<string, string | undefined> = process.env): boolean {
  return whitepaperOpen(env) && (method === "GET" || method === "HEAD") && path === PUBLIC_CARD;
}

/*
  The card's bytes from lib/whitepaperCard.ts's base64 (the same bytes as public/og/whitepaper.png): strict base64, a
  PNG's eight first bytes, under X's 5,000,000-byte limit. Anything else, empty included, is no card (null), and the
  proxy then answers the coming-soon page: only a PNG can open.
*/
export const PUBLIC_CARD_MAX_BYTES = 5_000_000;
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
export function publicCardBytes(base64: string): Uint8Array<ArrayBuffer> | null {
  if (typeof base64 !== "string" || base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) return null;
  let raw: string;
  try {
    raw = atob(base64);
  } catch {
    return null;
  }
  if (raw.length >= PUBLIC_CARD_MAX_BYTES) return null;
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return PNG_SIGNATURE.every((b, i) => bytes[i] === b) ? bytes : null;
}

/* Every file of public/coming-soon and the app's three icons (src/app): check-coming-soon holds this list to both folders. */
export const OPEN_FILES: readonly string[] = [
  "/coming-soon/FFL-Switzer.txt",
  "/coming-soon/OFL-RedHatDisplay.txt",
  "/coming-soon/RedHatDisplay-latin-VF.woff2",
  "/coming-soon/Switzer-VF.woff2",
  OG_IMAGE_PATH,
  "/favicon.ico",
  "/icon.svg",
  "/apple-icon.png",
];

export function isOpenPath(path: string): boolean {
  return path.startsWith("/_next/static/") || OPEN_FILES.includes(path);
}

export const isApiPath = (path: string): boolean => path === "/api" || path.startsWith("/api/");

/* The two /api paths the gate leaves open: a token file read (GET or HEAD only; the upload, POST /api/token, is gated) and the Vercel cron. */
export function apiOpenWhileGated(method: string, path: string): boolean {
  if (path === "/api/volume/refresh") return true;
  return (method === "GET" || method === "HEAD") && /^\/api\/token\/[^/]+$/.test(path);
}

/* What the cookie holds: a hash of the key, so the key itself never sits in a browser. */
export async function accessToken(key: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`bouncer-coming-soon:${key.trim()}`));
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, "0")).join("");
}

export const ROBOTS_WHILE_GATED = "User-agent: *\nDisallow: /\n";

/*
  robots.txt while gated with the switch (above): X's card fetcher (Twitterbot) and Telegram's (TelegramBot) may read
  exactly the open page and its card, each bare ("$" ends the path) or with a query ("?" is a plain character, so the
  line is a prefix of every query); "/" stays refused to them, and the "*" group refuses everything to every other
  crawler. A named group replaces the "*" group for its crawler (RFC 9309 2.2.1), so each repeats Disallow: /; the
  longest match wins (2.2.2), so the exact lines beat it. Advice only: the proxy's exact-path rules are the gate.
*/
/* Discord's (Discordbot) since 31c (2026-10-31: the founder shares the link on X, Telegram and Discord). */
export const CARD_FETCHERS: readonly string[] = ["Twitterbot", "TelegramBot", "Discordbot"];
const cardGroup = (agent: string) => `User-agent: ${agent}\nAllow: ${PUBLIC_PAGE}$\nAllow: ${PUBLIC_PAGE}?\nAllow: ${PUBLIC_CARD}$\nAllow: ${PUBLIC_CARD}?\nDisallow: /\n`;
export const ROBOTS_WHILE_GATED_WHITEPAPER = `${CARD_FETCHERS.map(cardGroup).join("\n")}\n${ROBOTS_WHILE_GATED}`;
export function robotsWhileGated(env: Record<string, string | undefined> = process.env): string {
  return whitepaperOpen(env) ? ROBOTS_WHILE_GATED_WHITEPAPER : ROBOTS_WHILE_GATED;
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/*
  The page: the door and the wordmark, one line, X and the Telegram community. The site's own tones (lib/theme.ts) and fonts.
  While the switch opens /whitepaper, a text line under the sentence links to it (the founder's option B, 2026-10-31,
  review/2026-10-31-whitepaper-public/round2 shot 2-coming-soon-b), so the link and the page move together; switch unset,
  the page is byte for byte as before.
*/
export const WHITEPAPER_LINK = "Read the whitepaper";
export function comingSoonHtml(origin: string, env: Record<string, string | undefined> = process.env): string {
  const link = whitepaperOpen(env);
  const title = `${BRAND.name}: launching soon`;
  const image = `${origin}${OG_IMAGE_PATH}`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(LINE)}">
<meta name="robots" content="noindex,nofollow">
<link rel="icon" href="/icon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="/apple-icon.png">
<meta property="og:type" content="website"><meta property="og:site_name" content="${esc(BRAND.name)}"><meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(LINE)}"><meta property="og:url" content="${esc(origin)}/"><meta property="og:image" content="${esc(image)}"><meta property="og:image:width" content="1200"><meta property="og:image:height" content="630"><meta property="og:image:alt" content="${esc(`${BRAND.name}. ${LINE}`)}">
<meta name="twitter:card" content="summary_large_image"><meta name="twitter:site" content="${esc(BRAND.xHandle)}"><meta name="twitter:title" content="${esc(title)}"><meta name="twitter:description" content="${esc(LINE)}"><meta name="twitter:image" content="${esc(image)}">
<meta name="theme-color" content="${THEME.bg}">
<style>
@font-face{font-family:"Red Hat Display";src:url("/coming-soon/RedHatDisplay-latin-VF.woff2") format("woff2");font-weight:300 900;font-display:swap}
@font-face{font-family:"Switzer";src:url("/coming-soon/Switzer-VF.woff2") format("woff2");font-weight:100 900;font-display:swap}
*{box-sizing:border-box}html,body{height:100%}body{margin:0;background:${THEME.bg};color:${THEME.text};font:18px/1.5 "Switzer",system-ui,sans-serif;-webkit-font-smoothing:antialiased}
main{min-height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:1.5rem;padding:2.5rem 1rem;text-align:center}
.mark{display:flex;align-items:center;gap:.85rem}.mark svg{width:2.6rem;height:auto}
.word{font-family:"Red Hat Display","Switzer",system-ui,sans-serif;font-weight:800;font-size:2.75rem;letter-spacing:-.02em;line-height:1}
p{margin:0;color:${THEME["text-2"]};font-size:1.125rem;max-width:26rem;text-wrap:balance}
nav{display:flex;gap:.75rem;flex-wrap:wrap;justify-content:center}
a{display:inline-flex;align-items:center;justify-content:center;min-height:44px;min-width:8.5rem;padding:0 1.1rem;border-radius:10px;border:1px solid ${THEME["line-2"]};background:${THEME.panel};color:${THEME.text};text-decoration:none;font-weight:600}
a:hover,a:focus-visible{border-color:${THEME.brand};outline:none}
${link ? `a.text{min-width:0;padding:0;border:0;background:none;color:${THEME.brand};text-decoration:underline;text-underline-offset:.2em;font-weight:600}\n` : ""}</style></head>
<body><main data-coming-soon>
<div class="mark" aria-label="${esc(BRAND.name)}">${doorSvg(THEME.brand)}<span class="word">${esc(BRAND.name)}</span></div>
<p>${esc(LINE)}</p>
${link ? `<a class="text" href="${PUBLIC_PAGE}" data-whitepaper-link>${esc(WHITEPAPER_LINK)}</a>\n` : ""}<nav><a href="${esc(X_URL)}" rel="noopener" target="_blank">X</a><a href="${esc(TELEGRAM_URL)}" rel="noopener" target="_blank">Telegram community</a></nav>
</main></body></html>`;
}
