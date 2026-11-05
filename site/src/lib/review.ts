/*
  Reviewer access (the founder, 2026-10-21, for the v1 sign-off panel). AI browsers
  drop the coming-soon cookie on its 303, so a second key opens the gate per
  request instead: ?review=<REVIEW_KEY> on any gated route passes it, with no
  redirect and no cookie. The key works only while REVIEW_KEY_EXPIRES (an ISO
  8601 time, or unix seconds) is in the future; unset either and nothing
  passes. An env change reaches the site at its next deployment, so revoking
  is: unset REVIEW_KEY and redeploy, or let the expiry pass.

  A request without the parameter also passes when its Referer is a page of
  this same site that carried a valid key: the app's prefetches and data
  requests for the next page are sent before the address changes. The key
  never leaves the site in a Referer: reviewed pages answer with
  Referrer-Policy strict-origin-when-cross-origin (other sites get the origin
  only). Pages keep the key in their address as a reviewer clicks around
  (components/ReviewCarry.tsx, and the /review pages' own links).

  Nothing here logs. The key is compared by its SHA-256, byte by byte to the
  end.
*/

export const REVIEW_PARAM = "review";
const MAX_KEY = 200;

/* The expiry as epoch milliseconds, or null when unset or unreadable (then the key opens nothing). */
export function reviewExpiry(raw: string | undefined): number | null {
  const s = (raw ?? "").trim();
  if (!s) return null;
  const ms = /^\d{9,11}$/.test(s) ? Number(s) * 1000 : Date.parse(s);
  return Number.isFinite(ms) ? ms : null;
}

async function digest(s: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
}

/* True when `given` is the configured key and the key has not expired. */
export async function reviewKeyValid(given: string | null | undefined, env: { REVIEW_KEY?: string; REVIEW_KEY_EXPIRES?: string }, nowMs: number): Promise<boolean> {
  const key = (env.REVIEW_KEY ?? "").trim();
  if (!key || key.length < 24 || !given || given.length > MAX_KEY) return false;
  const until = reviewExpiry(env.REVIEW_KEY_EXPIRES);
  if (until === null || nowMs >= until) return false;
  const [a, b] = await Promise.all([digest(given), digest(key)]);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/* The review parameter of a same-origin Referer, or null. */
export function reviewFromReferer(referer: string | null, origin: string): string | null {
  if (!referer) return null;
  try {
    const u = new URL(referer);
    return u.origin === origin ? u.searchParams.get(REVIEW_PARAM) : null;
  } catch {
    return null;
  }
}

/* An internal href with the review parameter added (kept as given when it already has one, or is external, or there is no key). */
export function withReview(href: string, key: string | null, base = "https://bouncer.invalid"): string {
  if (!key) return href;
  let u: URL;
  try {
    u = new URL(href, base);
  } catch {
    return href;
  }
  if (u.origin !== new URL(base).origin || u.searchParams.has(REVIEW_PARAM)) return href;
  u.searchParams.set(REVIEW_PARAM, key);
  return /^https?:\/\//i.test(href) ? u.toString() : `${u.pathname}${u.search}${u.hash}`;
}

/* The key this page was opened with, in the browser; null on the server or without one. */
export function currentReviewKey(): string | null {
  if (typeof window === "undefined") return null;
  return new URLSearchParams(window.location.search).get(REVIEW_PARAM);
}

/* An app route for router.push and router.replace that keeps the reviewer's key. */
export function reviewHref(href: string): string {
  return typeof window === "undefined" ? href : withReview(href, currentReviewKey(), window.location.origin);
}
