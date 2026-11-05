/*
  The quick guide's words (the founder, 2026-10-22): the three steps that used to sit at
  the top of the home page, now a popup on the first visit and behind the (i)
  button in the bottom corner of every page (components/shell/QuickGuide.tsx).
  Every word the guide shows is here, so it can be edited in this one file. No
  figures: the full guide (/guide) and How it works carry them, so nothing here
  can drift from the program.
*/
export const QUICK_GUIDE = {
  title: "How Bouncer works",
  steps: [
    ["Bid sealed", "Deposit SOL and set your max market cap. Nobody sees it until close."],
    ["One price", "At close every bid opens. Everyone who gets in pays the same price."],
    ["Tokens or refund", "Winners get tokens. Everyone else gets their SOL back."],
  ] as readonly (readonly [string, string])[],
  guideLink: "Read the full guide",
  close: "Got it",
  /* The (i) button's accessible name and its tooltip. */
  open: "Quick guide: how Bouncer works",
} as const;
