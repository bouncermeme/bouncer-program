"use client";

import { Info } from "./Info";

/*
  v0.32 (the founder approved the mocks on 2026-10-29, review/2026-10-29-v032/mocks round 2): the main lines stay ("Winners'
  tokens are sent to their wallets, nothing to claim. Trading opens when everyone is paid."), and this one "i" after
  them carries the rare case, a payout park_bid held for its winner. One source for How it works, the Guide, the FAQ and
  a launch's page while it pays out.
*/
export const HELD_PAYOUT_LABEL = "About held payouts";
export const HELD_PAYOUT_TEXT = "Rarely, a winner's tokens can't be sent, for example when their token account was handed to another owner. Then they're held for that winner in the program, safe, and trading doesn't wait. The winner collects them on the launch's page with one signature.";

export function HeldPayoutInfo() {
  return <Info text={HELD_PAYOUT_TEXT} label={HELD_PAYOUT_LABEL} />;
}
