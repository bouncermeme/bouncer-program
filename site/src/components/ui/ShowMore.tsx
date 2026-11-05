"use client";

import type { RefObject } from "react";
import { flushSync } from "react-dom";

/*
  A long list shows SHOW_STEP rows, and this button adds the next SHOW_STEP (the founder, 2026-10-30: "limit to 10 and
  then put a show more button"). The words and the button are the home board's own ("Show 12 more").
  The tap moves focus to the first new row, so the last tap (which removes the button) leaves keyboard and screen
  reader users in the list, not at the top of the page. describedBy names the list's heading for the button.
*/
export const SHOW_STEP = 10;

export function ShowMore({ left, onMore, list, describedBy }: { left: number; onMore: () => void; list?: RefObject<HTMLElement | null>; describedBy?: string }) {
  if (left <= 0) return null;
  const more = () => {
    const before = list?.current?.children.length ?? 0;
    flushSync(onMore);
    const row = list?.current?.children[before];
    if (row instanceof HTMLElement) {
      row.tabIndex = -1;
      row.focus({ preventScroll: true });
    }
  };
  return (
    <div className="mt-3 flex justify-center">
      <button type="button" className="btn btn-secondary" onClick={more} aria-describedby={describedBy} data-show-more>
        Show {Math.min(SHOW_STEP, left)} more
      </button>
    </div>
  );
}
