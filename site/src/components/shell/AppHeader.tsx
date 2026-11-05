"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ConnectButton } from "@/components/wallet/ConnectButton";
import { BRAND } from "@/lib/brand";
import { Mark } from "./Mark";

const NAV = [
  { href: "/", label: "Launches" },
  { href: "/create", label: "Create" },
  { href: "/how", label: "How it works" },
];

function isOn(href: string, path: string): boolean {
  return href === "/" ? path === "/" || path.startsWith("/launch") : path.startsWith(href);
}

/* The trading page: /launch/<id>/trade. */
export function isTrade(path: string): boolean {
  return /^\/launch\/[^/]+\/trade\/?$/.test(path);
}

/* The bid page (the founder, 2026-10-23): the quick guide's (i) sits in the header there, so it never covers the bid panel. */
export function isBid(path: string): boolean {
  return /^\/launch\/[^/]+\/bid\/?$/.test(path);
}

export function AppHeader() {
  const path = usePathname();
  return (
    <header className="sticky top-0 z-40 backdrop-blur-md border-b border-line" style={{ background: "var(--bg-glass)" }}>
      <div className="rope" aria-hidden="true" />
      {/* At phone width the wordmark and the button must fit 375 px with the 16 px gutters: the wordmark steps down and the button says Connect (2026-10-01; it overflowed by 29 px and the page scrolled sideways). */}
      {/* The trading page runs to 1360 px from 1024 px and its bar with it, 1424 with the bar's own 32 px gutters, so the logo lines up with the page (the founder, 2026-10-23; TradeView.tsx). */}
      <div className={`w-full ${isTrade(path) ? "max-w-[1120px] lg:max-w-[1424px]" : "max-w-[1120px]"} mx-auto px-4 md:px-8 h-16 flex items-center justify-between gap-3 min-w-0`}>
        <div className="flex items-center gap-6 min-w-0">
          {/* The lockup as concept C sets it: the door, then the name in title case (the domain stays in titles and cards). */}
          <Link href="/" className="flex items-center gap-2.5 min-w-0" aria-label={`${BRAND.name} home`}>
            <Mark />
            <span className="wordmark text-[1.5rem] whitespace-nowrap">{BRAND.name}</span>
          </Link>
          <nav className="hidden lg:flex items-center gap-1">
            {NAV.map((n) => {
              const on = isOn(n.href, path);
              return (
                <Link
                  key={n.href}
                  href={n.href}
                  className={`px-3 py-1.5 rounded-[6px] whitespace-nowrap transition ${on ? "bg-panel-2 text-text" : "text-text-2 hover:text-text"}`}
                >
                  {n.label}
                </Link>
              );
            })}
          </nav>
        </div>
        <div className="flex items-center gap-2">
          {isBid(path) && <button type="button" onClick={() => window.dispatchEvent(new Event("bouncer:quick-guide"))} aria-haspopup="dialog" aria-label="Quick guide: how Bouncer works" title="Quick guide: how Bouncer works" className="h-11 w-11 shrink-0 rounded-full border-2 border-accent bg-accent text-accent-ink grid place-items-center" data-quick-guide-header>
            <span aria-hidden="true" className="font-semibold text-[1.125rem] leading-none" style={{ fontFamily: "Georgia, serif", fontStyle: "italic" }}>i</span>
          </button>}
          <ConnectButton />
        </div>
      </div>
      {/* Phones: the header carries the way to Create and How it works at every width (the home hero of 2026-10-10 holds one line and the door, no links). */}
      {/* 2026-10-07: the four links fit 375 px without a sideways scroll (they ran to 413 px and cut "First hour" off) at the 16 px floor: 6 px side padding under 420 px, the row still scrollable for narrower phones. */}
      <nav className="lg:hidden scroll-x flex items-center gap-1 px-2 min-[420px]:px-3 pb-2 -mt-1" aria-label="Pages">
        {NAV.map((n) => (
          <Link
            key={n.href}
            href={n.href}
            className={`shrink-0 px-1.5 min-[420px]:px-3 py-2 rounded-[6px] transition ${isOn(n.href, path) ? "bg-panel-2 text-text" : "text-text-2"}`}
          >
            {n.label}
          </Link>
        ))}
      </nav>
    </header>
  );
}
