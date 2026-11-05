/*
  Admin releases of a funded ticker hold (23c; review/2026-10-24-23c-morning/DESIGN.md section 7, decision D4).
  Committed, so every release is reviewed in git with who, when and why.

  Each entry frees ONE launch's funded hold (a dead pool, a rug) and nothing else:
  - it names the launch address (the generation) and the key it holds (tickerKey.ts, e.g. "t2:PEPE");
  - a launch that is not funded is ignored and logged (TICKER_RELEASE_IGNORED): a live auction or a pending
    reservation is never released, so no issued permit is revoked;
  - it never touches the token;
  - it is never ticker-wide: any other launch with the key, earlier or later, holds as usual.
  Official-brand reservations (creationPolicy.ts) are a separate list and are not released here.

  2026-10-24: the everyday path is the admin release (server/tickerAdmin.ts, scripts/ticker-release.ts), a mark in
  the store. This file stays as the fallback: reviewed in git, and it survives a loss of the store (where a lost mark
  would only hold the ticker again). The gate reads both.
*/
export interface TickerRelease {
  launch: string;
  key: string;
  by: string;
  /* ISO date. */
  at: string;
  why: string;
}

export const TICKER_RELEASES: readonly TickerRelease[] = [];
