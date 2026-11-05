/*
  The site's own facts that are not the program's (launch candidate, 2026-10-22):
  who runs it, how to reach it, and the pages the footer links. One place, so the
  legal pages, the footer and the guide never disagree.

  The operator is named as Bouncer only (the founder, 2026-11-04, tag 04g): no company
  name, state or address anywhere the site serves. Change it here only.
*/
export const OPERATOR_ENTITY = "the Bouncer team";
/* The sentence the Terms and the Privacy Policy carry. */
export const OPERATED_BY = `Bouncer is operated by ${OPERATOR_ENTITY}`;
export const CONTACT_EMAIL = "hello@bouncer.meme";

/*
  The footer's three lines (the founder, 2026-10-23): the reading pages; trust, stats and the legal pages; then the official
  accounts. Each line is one row from 360 px (measured 2026-10-23 at 390: 325 and 315 of 358 px at 15 px text).
  FOOTER_LINKS is every page the footer links, in order.
*/
export const FOOTER_READING: readonly { href: string; label: string }[] = [
  { href: "/how", label: "How it works" },
  { href: "/guide", label: "Guide" },
  { href: "/faq", label: "FAQ" },
  { href: "/whitepaper", label: "Whitepaper" },
  { href: "/fees", label: "Fees" },
];
export const FOOTER_TRUST_LEGAL: readonly { href: string; label: string }[] = [
  { href: "/trust", label: "Trust" },
  { href: "/stats", label: "Stats" },
  { href: "/terms", label: "Terms" },
  { href: "/privacy", label: "Privacy" },
  { href: "/cookies", label: "Cookies" },
  { href: "/risk", label: "Risk" },
];
export const FOOTER_LINKS: readonly { href: string; label: string }[] = [...FOOTER_READING, ...FOOTER_TRUST_LEGAL];

/* The official accounts (the founder, 2026-10-21: @bouncermeme is the chat group, @bouncermeme_launches the launch feed). */
export const OFFICIAL = {
  site: { href: "https://bouncer.meme", label: "bouncer.meme" },
  x: { href: "https://x.com/bouncermeme", label: "@bouncermeme" },
  telegramChat: { href: "https://t.me/bouncermeme", label: "@bouncermeme" },
  telegramFeed: { href: "https://t.me/bouncermeme_launches", label: "@bouncermeme_launches" },
} as const;
export const FOOTER_OFFICIAL: readonly { href: string; label: string }[] = [
  { href: OFFICIAL.x.href, label: "X" },
  { href: OFFICIAL.telegramChat.href, label: "Telegram" },
  { href: OFFICIAL.site.href, label: OFFICIAL.site.label },
];
