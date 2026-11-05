"use client";

import { BOARD_SORTS, isBoardSort, type BoardSort } from "@/lib/bouncer/boardSort";

/*
  The Recently cleared board's order. 24n (the founder, 2026-10-26, the approved mock review/2026-10-26-24n-sort-mock): a
  compact "Sort:" dropdown on the heading's line in place of the three chips, the same chip box with the site's stroke
  chevron. A native select: one Tab stop, the keys a select takes, and the phone's own picker on a tap. Choosing one
  reorders what the board has read; nothing is fetched.
  The right padding is inline: .chip's own padding is unlayered CSS and beats Tailwind's pr-* utilities.
  24o (the founder's approved mock): a little tighter under 420 px (the gap and the chevron's room, through --sort-pr), so the
  longest choice, "Highest raise", keeps the control on the heading's line.
*/
export function SortControl({ sort, onChoose }: { sort: BoardSort; onChoose: (s: BoardSort) => void }) {
  return (
    <label className="relative shrink-0 flex items-center gap-1 min-[420px]:gap-2 text-text-2">
      <span>Sort:</span>
      <span className="relative inline-flex">
        <select
          className="chip appearance-none cursor-pointer [--sort-pr:2rem] min-[420px]:[--sort-pr:2.5rem]"
          style={{ paddingRight: "var(--sort-pr)" }}
          value={sort}
          data-board-sort={sort}
          onChange={(e) => {
            if (isBoardSort(e.target.value)) onChoose(e.target.value);
          }}
        >
          {BOARD_SORTS.map((s) => (
            <option key={s.id} value={s.id}>
              {s.label}
            </option>
          ))}
        </select>
        <svg className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-text-2" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M6 9l6 6 6-6" />
        </svg>
      </span>
    </label>
  );
}
