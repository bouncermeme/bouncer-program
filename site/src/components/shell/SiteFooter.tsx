/*
  The footer on every page (the founder, 2026-10-23): three lines, the reading pages; trust, stats and the legal pages; then
  the official accounts (the handles are on /trust). Under them the contact address and the operator line. The
  program-source note left the footer for /risk (row 20). Links wrap on a phone and keep 44 px tap targets; under
  640 px the text is 15 px so each line holds one row at 360.
*/
import Link from "next/link";
import { BRAND } from "@/lib/brand";
import { CONTACT_EMAIL, FOOTER_OFFICIAL, FOOTER_READING, FOOTER_TRUST_LEGAL } from "@/lib/site";

const LINE = "flex flex-wrap gap-x-3.5 sm:gap-x-5 gap-y-0 text-[0.9375rem] sm:text-base";

export function SiteFooter() {
  const year = new Date().getUTCFullYear();
  return (
    <div className="hairline pt-5 flex flex-col gap-3 text-base" data-site-footer>
      <div className="flex flex-col">
        <nav aria-label="Site" className={LINE} data-footer-line="1">
          {FOOTER_READING.map((l) => (
            <Link key={l.href} href={l.href} className="link inline-flex items-center min-h-11">
              {l.label}
            </Link>
          ))}
        </nav>
        <nav aria-label="Trust and legal" className={LINE} data-footer-line="2">
          {FOOTER_TRUST_LEGAL.map((l) => (
            <Link key={l.href} href={l.href} className="link inline-flex items-center min-h-11">
              {l.label}
            </Link>
          ))}
        </nav>
        <nav aria-label="Official accounts" className={LINE} data-footer-line="3">
          {FOOTER_OFFICIAL.map((l) => (
            <a key={l.href} href={l.href} target="_blank" rel="noreferrer" className="link inline-flex items-center min-h-11">
              {l.label}
            </a>
          ))}
        </nav>
      </div>
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
