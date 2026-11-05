/*
  drand quicknet round arithmetic. The chain hash, the public key, genesis,
  the period, the reveal margin and the slack come from the pinned contract
  (BEACON in contract/constants.ts, INTERFACE v0.18); nothing is retyped.
  The two functions the program also has (round_at, reveal_round_for in
  crates/auction-core/src/beacon.rs) are copied in shape so the site and the
  program agree on the same close time. No crypto here, so any page can
  import it without pulling in the curves.
*/

import { BEACON, BOUNDS, INSTRUCTIONS } from "@contract/constants";

export { BEACON };

/* Facts about the beacon the contract does not carry: where a round's signature is served. Not protocol. */
export const DRAND = {
  scheme: "bls-unchained-g1-rfc9380",
  /* Any of these serve GET /v2/beacons/quicknet/rounds/<r>. */
  apis: ["https://api.drand.sh", "https://api2.drand.sh", "https://api3.drand.sh", "https://drand.cloudflare.com"],
} as const;

/* Round r is published at genesis + (r - 1) * period. Round 1 is genesis. */
export function roundTime(round: number | bigint): number {
  return BEACON.genesis + (Number(round) - 1) * BEACON.period;
}

/* The latest round published at or before a unix time (the crate's round_at). */
export function roundAt(ts: number): number {
  if (ts < BEACON.genesis) return 1;
  return Math.floor((ts - BEACON.genesis) / BEACON.period) + 1;
}

/*
  v0.30 (the founder, 2026-10-27): the reveal margin is the live Config's
  (Config.reveal_margin_secs, the value create_launch checks), adjustable
  within the program's hard bounds (RevealMarginOutOfRange 6091; the pin's
  bounds.reveal_margin_min_secs and _max_secs). BEACON.revealMarginSecs is
  only the pin's starting value: the content pages fall back to it until the
  Config lands, and a create never aims with it. 2026-10-28: devnet runs 60,
  the site aimed with 120, and every create_launch was refused
  RevealRoundOutOfRange (the founder's fix A: the margin is read from the Config).
  The bounds are the pin's (v0.30: 60 to 300; v0.31: 5 to 300).
*/
export const REVEAL_MARGIN_MIN_SECS: number = BOUNDS.revealMarginMinSecs;
export const REVEAL_MARGIN_MAX_SECS: number = BOUNDS.revealMarginMaxSecs;

/*
  v0.31 (idl/INTERFACE-v0.31-NOTE.md, the founder's GO 2026-10-28): create_launch's second argument is the absolute close_ts
  in place of window_secs, so the reveal round is a pure function of the creator's own close and a slow wallet
  approval cannot move it. Read from the pin, so the site builds for the program it is pinned to.
*/
export const CREATE_TAKES_CLOSE_TS: boolean = (INSTRUCTIONS.create_launch.args[1].name as string) === "close_ts";

export function validRevealMargin(secs: number): boolean {
  return Number.isInteger(secs) && secs >= REVEAL_MARGIN_MIN_SECS && secs <= REVEAL_MARGIN_MAX_SECS;
}

/*
  The reveal delay as the content pages say it after "about" (the founder, 2026-10-28, mocks-v031 option A): the margin plus
  about 5 s (the round boundary, 0 to 3 s, and the keeper's post, about 3 s; INTERFACE-v0.31-NOTE.md section 2), to
  the nearest 5 s under a minute: "20 seconds" at 15; from a minute on, the minutes.
*/
export function revealDelayText(marginSecs: number): string {
  const secs = marginSecs + 5;
  return secs < 60 ? `${Math.round(secs / 5) * 5} seconds` : revealMinutesText(marginSecs);
}

/* The reveal delay in minutes: "1 minute", "2 minutes", "5 minutes". */
export function revealMinutesText(marginSecs: number): string {
  const m = Math.max(1, Math.round(marginSecs / 60));
  return `${m} minute${m === 1 ? "" : "s"}`;
}

/*
  The earliest round the program accepts for a book closing at closeTs
  (checklist T-02). This is the crate's reveal_round_for_margin, copied in
  shape: round_at(closeTs + marginSecs) + 1, the first round published
  strictly after the close plus the margin. When close plus margin falls
  exactly on a publish time, that round is already public and is refused;
  the next one is the earliest. The program computes this from the block
  time at genesis and the Config's margin; a round below it is refused
  RevealRoundOutOfRange (6037), and so is one more than revealRoundSlack
  rounds past it.
*/
export function earliestRevealRound(closeTs: number, marginSecs: number): bigint {
  return BigInt(roundAt(closeTs + marginSecs) + 1);
}

/*
  Rounds the client aims above the earliest. Before v0.31 the program counted
  the close from its own landing clock, which this device's clock and the
  time the transaction took to land put seconds (or, with a slow wallet
  approval, minutes) past the build: five rounds was 15 seconds of tolerance.
  Since v0.31 the close is the creator's own number and the program computes
  the earliest round from it, so the client aims at the earliest exactly
  (the note's "aim 0"), and the bidders wait no longer than the margin.
*/
export const REVEAL_AIM_ROUNDS: number = CREATE_TAKES_CLOSE_TS ? 0 : 5;

/* The round every bid on a new launch is sealed to, given the moment the book will close. */
export function revealRoundFor(closeTs: number, marginSecs: number): bigint {
  return earliestRevealRound(closeTs, marginSecs) + BigInt(REVEAL_AIM_ROUNDS);
}

/* Whether the program would accept `round` for a book closing at closeTs under this margin: at least the earliest, at most the slack past it. */
export function revealRoundInRange(round: bigint, closeTs: number, marginSecs: number): boolean {
  const earliest = earliestRevealRound(closeTs, marginSecs);
  return round >= earliest && round <= earliest + BigInt(BEACON.revealRoundSlack);
}

/* When the bids open: the moment the reveal round is published. Everything downstream (the beacon post, the reveals, the settlement) can only follow it. */
export function bidsOpenAt(revealRound: bigint): number {
  return roundTime(revealRound);
}

export function roundSignatureUrl(round: number | bigint, api: string = DRAND.apis[0]): string {
  return `${api}/v2/beacons/quicknet/rounds/${round}`;
}
