"use client";

import { useEffect, useRef, useState } from "react";

/*
  Whether an element scrolls (22e2 review's layout nit; 23c for the trading page's "Launch details"): a box that fits
  is no tab stop, one that overflows is a named, focusable region a keyboard can scroll. Checked when the box or any
  child changes size and when children come or go (the figures and the creator's history arrive after the first
  paint), so content that grows inside a fixed box is caught too. Off (false) on the server and until measured.
*/
export function useOverflows<T extends HTMLElement>(on: boolean) {
  const ref = useRef<T>(null);
  const [overflows, setOverflows] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!on || !el || typeof ResizeObserver === "undefined") return;
    const check = () => setOverflows(el.scrollHeight > el.clientHeight + 1);
    const ro = new ResizeObserver(check);
    const watch = () => {
      ro.disconnect();
      ro.observe(el);
      for (const c of Array.from(el.children)) ro.observe(c);
      check();
    };
    const mo = typeof MutationObserver === "undefined" ? null : new MutationObserver(watch);
    mo?.observe(el, { childList: true, subtree: true, characterData: true });
    watch();
    return () => {
      ro.disconnect();
      mo?.disconnect();
    };
  }, [on]);
  return [ref, on && overflows] as const;
}
