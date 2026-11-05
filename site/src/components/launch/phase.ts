import { closeAtTs } from "@/lib/bouncer/view";
import type { Launch } from "@/lib/bouncer/types";
import { V030 } from "@/lib/bouncer/v030";

/*
  What the launch is doing right now, from the INTERFACE.md state machine:
  Open, Closed, Settled, PoolLive, Finalized, with Failed and Aborted off the
  side (refunds only). Open has one countdown. The window is fixed; nothing
  ends it sooner, and nothing extends it: once the clock passes close_at the
  book is closed whatever the state byte still reads (the close instruction
  is cosmetic; a commit after close_at closes the book instead of landing),
  so the page treats it as closed from that instant (checklist S-02).
*/
export type Phase =
  /* 0.29: Initializing, created without its grow; no bid until the creator's grow lands inside the window. */
  | { kind: "setup"; closeTs: number }
  | { kind: "open"; closeTs: number }
  | { kind: "closed"; closeTs: number; revealed: number; opened: number; total: number }
  | { kind: "settled" }
  | { kind: "poolLive" }
  | { kind: "finalized" }
  | { kind: "aborted" }
  | { kind: "failed" };

/* nowSec is the clock; without it (a server render) the phase follows the state byte alone. */
export function phaseOf(launch: Launch, nowSec?: number): Phase {
  const a = launch.account;
  switch (a.state) {
    case "initializing":
      return { kind: "setup", closeTs: closeAtTs(a) };
    case "open": {
      const closeTs = closeAtTs(a);
      if (nowSec != null && nowSec >= closeTs) return { kind: "closed", closeTs, revealed: a.revealedCount, opened: a.revealedCount + a.invalidCount, total: a.bidCount };
      return { kind: "open", closeTs };
    }
    case "closed":
      return { kind: "closed", closeTs: a.closeTs || closeAtTs(a), revealed: a.revealedCount, opened: a.revealedCount + a.invalidCount, total: a.bidCount };
    case "settled":
      return { kind: "settled" };
    case "poolLive":
      return { kind: "poolLive" };
    case "finalized":
      return { kind: "finalized" };
    case "aborted":
      return { kind: "aborted" };
    case "failed":
      return { kind: "failed" };
  }
}

/*
  The four stages after close (the founder, decision 6 of 2026-09-30): Opening bids,
  Calculating, Preparing liquidity, Claims available. Null while bidding is
  open and once the launch is over. Never "complete" while anyone cannot
  claim: a launch reads Settled only when finalized, which the program allows
  only after every bid is paid out. "Opened" counts invalid bids too; they
  were opened and set aside.
*/
/* v0.30 (the founder, 2026-10-27): the fourth stage is "Paying out" (self-claim is gone; trading opens when everyone is paid). */
export const STAGES = ["Opening bids", "Calculating", "Preparing liquidity", V030 ? "Paying out" : "Claims available"] as const;
export type Stage = (typeof STAGES)[number];
export function stageOf(phase: Phase): Stage | null {
  switch (phase.kind) {
    case "closed":
      return phase.opened < phase.total ? "Opening bids" : "Calculating";
    case "settled":
      return "Preparing liquidity";
    case "poolLive":
      return STAGES[3];
    default:
      return null;
  }
}
