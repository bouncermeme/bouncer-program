/*
  The public whitepaper (round 3b's frame, built for tag 31c on 2026-10-31: while the coming-soon gate is on and the
  switch is 1, /whitepaper alone opens to everyone, linked from the coming-soon page). src/proxy.ts serves an anonymous /whitepaper from the route /whitepaper/public;
  the address stays /whitepaper. On that route the shell shows nothing that leads into a gated page: the wordmark goes
  to the coming-soon page, the footer carries only the official accounts and the contact address, and the app's
  header, banners, wallet button, guide button and storage notice are not drawn (none of them reads anything then).
  Since tag 31d the route has its own layout, app/(public)/layout.tsx, and this module is a server component that
  imports nothing of the site's frame (the 31c pre-check's G1: the old swap carried the frame in the page data).
*/
import { BRAND } from "@/lib/brand";
import { LINE as COMING_SOON_LINE, TELEGRAM_URL, X_URL } from "@/lib/comingSoon";
import { CONTACT_EMAIL } from "@/lib/site";
import { Mark } from "./Mark";

/* Plain anchors, not Link: a client navigation to a gated address would get the coming-soon page back instead of the
   app's data, so each one loads the page whole. */
export function PublicHeader() {
  return (
    <header className="border-b border-line" data-public-header>
      <div className="rope" aria-hidden="true" />
      <div className="w-full max-w-[1120px] mx-auto px-4 md:px-8 h-16 flex items-center min-w-0">
        <a href="/" className="flex items-center gap-2.5 min-w-0 min-h-11" aria-label={`${BRAND.name} home`}>
          <Mark />
          <span className="wordmark text-[1.5rem] whitespace-nowrap">{BRAND.name}</span>
        </a>
      </div>
    </header>
  );
}

export function PublicFooter() {
  const year = new Date().getUTCFullYear();
  return (
    <div className="hairline pt-5 flex flex-col gap-3 text-base" data-public-footer>
      <p className="text-text-2">{COMING_SOON_LINE}</p>
      <nav aria-label="Official accounts" className="flex flex-wrap gap-x-5 gap-y-0">
        <a href={X_URL} target="_blank" rel="noreferrer" className="link inline-flex items-center min-h-11">
          X
        </a>
        <a href={TELEGRAM_URL} target="_blank" rel="noreferrer" className="link inline-flex items-center min-h-11">
          Telegram community
        </a>
      </nav>
      <p>
        <a href={`mailto:${CONTACT_EMAIL}`} className="link inline-flex items-center min-h-11">
          {CONTACT_EMAIL}
        </a>
      </p>
      <p>
        © {year} {BRAND.name}.
      </p>
    </div>
  );
}
