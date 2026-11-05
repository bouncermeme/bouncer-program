/*
  The CDN time for a signature status (app/api/tx/[signature]). 24g (Astra 24f R7-M3): only a finalized status is
  kept the minute, an error included; anything still moving (processed, confirmed, an error not yet finalized, no
  status yet) is kept 1 s, so the signer's confirmation loop sees the next state within a second.
*/
export const CACHE_MOVING = "public, max-age=0, s-maxage=1";
export const CACHE_DONE = "public, max-age=0, s-maxage=60";

export function statusCache(status: { confirmationStatus?: string | null; err?: unknown } | null): string {
  return status !== null && status.confirmationStatus === "finalized" ? CACHE_DONE : CACHE_MOVING;
}
