"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { currentReviewKey, REVIEW_PARAM, withReview } from "@/lib/review";

/*
  Reviewer access (lib/review.ts): a page opened with ?review= keeps the key
  as the reviewer clicks around. Every link to this site gets the parameter
  in its href (an AI browser that reads a link and opens it gets the key
  too), and a click on one goes through the router with the key in the
  address (next/link would push its own href, without it). Without the
  parameter in the address this does nothing.
*/
export function ReviewCarry() {
  const router = useRouter();
  useEffect(() => {
    const key = currentReviewKey();
    if (!key) return;
    const origin = window.location.origin;
    const internal = (a: HTMLAnchorElement) => {
      const raw = a.getAttribute("href");
      if (!raw || raw.startsWith("#") || /^(mailto|tel|javascript):/i.test(raw)) return null;
      try {
        const u = new URL(raw, window.location.href);
        return u.origin === origin ? u : null;
      } catch {
        return null;
      }
    };
    const mark = (root: ParentNode) => {
      root.querySelectorAll<HTMLAnchorElement>("a[href]").forEach((a) => {
        const u = internal(a);
        if (u && !u.searchParams.has(REVIEW_PARAM)) a.setAttribute("href", withReview(`${u.pathname}${u.search}${u.hash}`, key, origin));
      });
    };
    mark(document);
    const seen = new MutationObserver((changes) => {
      for (const c of changes) {
        if (c.type === "attributes" && c.target instanceof HTMLAnchorElement) mark(c.target.parentNode ?? document);
        else c.addedNodes.forEach((n) => n instanceof Element && (n instanceof HTMLAnchorElement ? mark(n.parentNode ?? document) : mark(n)));
      }
    });
    seen.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["href"] });
    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = e.target instanceof Element ? e.target.closest("a[href]") : null;
      if (!(a instanceof HTMLAnchorElement) || (a.target && a.target !== "_self") || a.hasAttribute("download")) return;
      const u = internal(a);
      if (!u) return;
      const here = new URL(window.location.href);
      /* A link to a place on this same page scrolls as before. */
      if (u.pathname === here.pathname && u.hash && u.search === here.search) return;
      e.preventDefault();
      router.push(withReview(`${u.pathname}${u.search}${u.hash}`, key, origin));
    };
    document.addEventListener("click", onClick, true);
    return () => {
      seen.disconnect();
      document.removeEventListener("click", onClick, true);
    };
  }, [router]);
  return null;
}
