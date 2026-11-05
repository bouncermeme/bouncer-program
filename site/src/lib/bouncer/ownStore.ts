/*
  Pictures and metadata from the site's own token store only (2026-10-20,
  the adversarial pass's S3, docs/ADVERSARIAL-GRIEFING-2026-10-20.md 8b). A
  launch created directly on chain may name any https URI; the site used to
  fetch it from every visitor's browser (and from the server, for the share
  card) and show whatever image its JSON named, from any origin: tracking,
  an offensive picture, a very large file, all for 0.07 SOL.

  Now a launch's URI is read only when it is the site's own metadata file,
  https://<one of our hosts>/api/token/<32 hex>.json, and it is read from
  this site's own store whatever host it names, so no request ever goes to
  a host the creator chose. The image the file names is shown only when it
  is the same store's picture, /api/token/<32 hex>. Anything else: no
  picture (the lettered tile), no description, nothing fetched.

  Our hosts: bouncer.meme (and www), the devnet project's own vercel.app
  names, the site's configured origin (siteOrigin, SITE_ORIGIN on the local
  board), this page's own host, and this machine.
*/
import { BRAND } from "../brand";
import { siteOrigin } from "./siteCluster";

const META = /^\/api\/token\/([0-9a-f]{32})\.json$/;
const PICTURE = /^\/api\/token\/([0-9a-f]{32})$/;
const DEVNET_HOSTS = /^bouncer-devnet(-[a-z0-9]+)?(-bouncer-meme)?\.vercel\.app$/;

export function isOwnHost(host: string, here: string | null = typeof window !== "undefined" ? window.location.host : null): boolean {
  const h = host.toLowerCase();
  if (h === BRAND.domain || h === `www.${BRAND.domain}`) return true;
  if (DEVNET_HOSTS.test(h)) return true;
  if (/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(h)) return true;
  if (here && h === here.toLowerCase()) return true;
  try {
    return h === new URL(siteOrigin()).host.toLowerCase();
  } catch {
    return false;
  }
}

function ownPath(uri: string, re: RegExp, here?: string | null): string | null {
  if (typeof uri !== "string" || uri.length > 300) return null;
  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && !(u.protocol === "http:" && /^(localhost|127\.0\.0\.1)$/.test(u.hostname))) return null;
  if (u.username || u.password || u.search || u.hash) return null;
  if (!isOwnHost(u.host, here)) return null;
  const m = re.exec(u.pathname);
  return m ? u.pathname : null;
}

/* The site's own metadata file a launch's URI names, as a path on this site; null for any other URI. */
export function ownMetadataPath(uri: string, here?: string | null): string | null {
  return ownPath(uri, META, here);
}

/* The site's own picture a metadata file names, as a path on this site; null for any other image. */
export function ownPicturePath(image: string, here?: string | null): string | null {
  return ownPath(image, PICTURE, here);
}

/* Where to read one of our paths from: the page's own origin in a browser, the site's origin on the server. */
export function ownUrl(path: string): string {
  return typeof window !== "undefined" ? path : `${siteOrigin()}${path}`;
}
