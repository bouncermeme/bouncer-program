"use client";

import { useEffect, useId, useRef, useState, type FocusEvent, type ReactNode } from "react";

/*
  The sentence behind a figure, behind an "i" (the founder, 2026-10-07: the
  explanatory sentences on the trading page go into info tooltips). A
  disclosure: a click, a tap, Enter or Space opens it and the same again
  closes it. Nothing opens it on hover or on focus: the click that focused
  the button used to close what the hover or the focus had just opened
  (found 2026-10-11, live Edge, "About the swap"; fixed 2026-10-13).
  Closes on Escape (focus back on the button), a press outside, focus moving
  out, or the window losing focus (a press inside a chart or swap frame
  never reaches this document). The glyph is 18 px inside a 32 px button;
  the text is the body size, never under 16 px; the box opens under the
  button, toward the side with room, and stays 16 px inside the viewport.
*/
const GUTTER = 16;
const MAX_WIDTH = 320;

/* Where the box goes, relative to the button: under its left edge, or under its right edge in the right half, then moved just enough to stay 16 px inside the viewport. */
function placeBox(el: HTMLElement): { x: number; w: number } {
  const vw = document.documentElement.clientWidth;
  const w = Math.min(MAX_WIDTH, vw - 2 * GUTTER);
  const r = el.getBoundingClientRect();
  const want = r.left > vw / 2 ? r.right - w : r.left;
  const x = Math.max(GUTTER, Math.min(want, vw - GUTTER - w));
  return { x: x - r.left, w };
}

export function Info({ text, label }: { text: ReactNode; label: string }) {
  const [open, setOpen] = useState(false);
  const [box, setBox] = useState({ x: 0, w: MAX_WIDTH });
  const id = useId();
  const wrap = useRef<HTMLSpanElement | null>(null);
  const button = useRef<HTMLButtonElement | null>(null);

  const toggle = () => {
    if (open) {
      setOpen(false);
    } else {
      if (wrap.current) setBox(placeBox(wrap.current));
      setOpen(true);
    }
  };

  /* Focus moving to something outside closes it. Focus moving to nothing (a press on plain text, another window) is left to the press and window handlers below. Focus moving to an element around this one is not leaving: Safari moves focus from a pressed button to its nearest focusable ancestor (the #swap column, tabIndex -1), and closing here would let the click reopen it. */
  const onBlur = (e: FocusEvent<HTMLSpanElement>) => {
    const next = e.relatedTarget as Node | null;
    if (next && !e.currentTarget.contains(next) && !next.contains(e.currentTarget)) setOpen(false);
  };

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setOpen(false);
      const active = document.activeElement;
      if (!active || active === document.body || wrap.current?.contains(active) || (wrap.current && active.contains(wrap.current))) button.current?.focus({ preventScroll: true });
    };
    const onWindowBlur = () => setOpen(false);
    const onResize = () => {
      if (wrap.current) setBox(placeBox(wrap.current));
    };
    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("keydown", onKey);
    window.addEventListener("blur", onWindowBlur);
    window.addEventListener("resize", onResize);
    return () => {
      document.removeEventListener("pointerdown", onDown, true);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("blur", onWindowBlur);
      window.removeEventListener("resize", onResize);
    };
  }, [open]);

  return (
    <span ref={wrap} className="relative inline-flex align-middle" onBlur={onBlur}>
      <button
        ref={button}
        type="button"
        className="inline-flex items-center justify-center w-8 h-8 rounded-full text-text-3 hover:text-text focus-visible:text-text outline-none focus-visible:ring-2 focus-visible:ring-accent-line"
        aria-label={label}
        aria-expanded={open}
        aria-controls={id}
        onClick={toggle}
        data-info
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
          <circle cx="12" cy="12" r="9" />
          <path d="M12 11v5.5" />
          <circle cx="12" cy="7.6" r="0.9" fill="currentColor" stroke="none" />
        </svg>
      </button>
      {/* tabIndex -1: a press on the text focuses the box, so focus stays inside and the box stays open (the #swap column around it is itself focusable). */}
      <span
        id={id}
        hidden={!open}
        tabIndex={-1}
        className="absolute z-30 top-full mt-1 panel-2 p-3 text-[1rem] text-text-2 text-left leading-snug font-normal outline-none"
        style={{ left: box.x, width: box.w }}
        data-info-text
      >
        {text}
      </span>
    </span>
  );
}
