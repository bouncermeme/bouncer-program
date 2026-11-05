/*
  Approved words for the v0.30 site (the founder, 2026-10-27,
  review/2026-10-27-v030/FOUNDER-UI-DECISIONS.md), one source for the
  components that show them and for scripts/check-v030-site.tsx. Changing a
  string here is a copy change and needs the founder's approval, like any other.
*/

/* 4B: the bid receipt's rent-and-fee clause, behind an (i) after "is your deposit." */
export const BID_REST_INFO = {
  label: "About what else was sent",
  text: "The rest was the processing charge, the bid account's rent (back when it closes) and the network fee.",
} as const;

/* 6A: the recovery deadline behind an (i) after a forward step's note; the sentence itself is unchanged (DrivePanel.tsx builds it with the launch's own time). */
export const DEADLINE_INFO_LABEL = "About the recovery deadline";

/*
  Rehearsal item 7 (the founder, 2026-10-28, mocks-v031 7a/7b/7c): the "Finish the auction" step's note, short, while the
  bids are sealed (after "Sealed until <time>.") and once they can open; the press detail and the deadline sentence
  move behind one (i), "About this step".
*/
export const FINISH_SEALED_NOTE = "Then the bids open and settle, the pool is created, every winner is paid, and trading opens.";
export const FINISH_READY_NOTE = "Opens and settles the bids and creates the pool. Then every winner is paid and trading opens.";
export const STEP_INFO_LABEL = "About this step";

/* 2A: the link under the launch page's deposits from settlement on, to the Results table. */
export function allDepositsLink(n: number): string {
  return `All ${n.toLocaleString("en-US")} deposits`;
}
