/*
  The FAQ's questions and answers, one source for the page (FaqView, which
  renders the parts with the live config) and its FAQPage JSON-LD (app/faq,
  which joins them as text with the pinned config; lib/seo.ts faqPageLd).
  A part is plain text, a figure (shown in the mono face) or a link.
*/
import { BRAND } from "@/lib/brand";
import { solExact } from "@/lib/bouncer/amountInput";
import { fmtSol } from "@/lib/bouncer/format";
import { bpsPct, burnSplitText, CONFIG_FALLBACK, fmtVolumePct, PRODUCT, tradingFeeSplit } from "@/lib/bouncer/product";
import { V030 } from "@/lib/bouncer/v030";
import { UPGRADE_AUTHORITY_SENTENCE } from "@/lib/bouncer/siteCluster";
import { BEACON, BOUNDS } from "@contract/constants";
import { revealDelayText } from "@/lib/bouncer/beacon";
import { durationText } from "./durations";

/* v0.32: { info: "heldPayouts" } is the "About held payouts" i (HeldPayoutInfo.tsx); it adds nothing to the JSON-LD text. */
export type FaqPart = string | { num: string } | { href: string; text: string } | { info: "heldPayouts" };
export type FaqEntry = { q: string; a: FaqPart[] };
export type FaqInputs = { floor: bigint; minBid: bigint; raiseFeeBps: number; abortAfterSecs: number; attestBids: boolean; revealMarginSecs: number };

/* What the page shows before the live config lands, and what the JSON-LD says: this cluster's pinned terms. */
export function pinnedFaqInputs(): FaqInputs {
  return {
    floor: PRODUCT.floorValue,
    minBid: PRODUCT.minBid,
    raiseFeeBps: Number(PRODUCT.raiseFeeBps),
    abortAfterSecs: Number(PRODUCT.abortAfterSecs),
    attestBids: Number(CONFIG_FALLBACK.attestBids) === 1,
    revealMarginSecs: BEACON.revealMarginSecs,
  };
}

export function faqEntries(i: FaqInputs): FaqEntry[] {
  const revealIn = revealDelayText(i.revealMarginSecs);
  const fee = bpsPct(i.raiseFeeBps);
  /* F-5: the shares of volume (product.ts; 2% and 2,188 bps with the 0.30 contract). */
  const volume = tradingFeeSplit(PRODUCT.creatorLpBps);
  return [
    { q: "Can anyone see my max?", a: [`No. It is encrypted to a drand beacon round published about ${revealIn} after the window ends. Until then nobody can open it, ${BRAND.name} included. Your deposit is public.`] },
    { q: "Can I cancel or change my bid?", a: ["No. One bid per wallet, final for the window. If the launch fails or you are below the cutoff, you get your deposit back."] },
    { q: "What if my bid does not fill?", a: ["You get your whole deposit back. If you fill part of it at the cutoff, the unspent part comes back."] },
    { q: "What if a launch falls short?", a: ["Needs ", { num: fmtSol(i.floor) }, " by close, or all refundable."] },
    /* Content sweep F-1 (the founder, 2026-10-27), with v0.30. */
    { q: "When do I get my tokens?", a: V030 ? ["Before trading opens. Winners' tokens are sent to their wallets, nothing to claim. Trading opens when everyone is paid. ", { info: "heldPayouts" }] : ["A few minutes after the pool opens, delivered to your wallet. You can also claim them yourself on the launch page with one signature, any time."] },
    {
      q: "What does bidding cost?",
      a: [
        "Your deposit (at least ",
        { num: solExact(i.minBid) },
        "), a ",
        { num: fmtSol(BigInt(BOUNDS.processingChargeLamports)) },
        " processing charge and the network fee.",
      ],
    },
    { q: "What does creating cost?", a: ["Rent for the launch's accounts, kept on chain, plus a prepay for the steps after the window. The unused prepay is returned when due; the amount varies. The create page and your wallet show the exact total. See the ", { href: "/guide#cost", text: "guide" }, "."] },
    { q: "Who holds my SOL?", a: [`The program's vault for that launch. No ${BRAND.name} key can move it; only a program upgrade could change the rules (below). It goes to the pool, less the launch fee, or back to you.`] },
    /* F-3: under v0.30 "no freeze authority is ever set" is no longer true. */
    { q: "Can the team mint more tokens?", a: [V030 ? "No. Supply is fixed at one billion. The mint authority is removed after the pool is created. The freeze authority only keeps the pool shut until everyone is paid, and it is revoked forever when trading opens." : "No. Supply is fixed at one billion. The mint authority is removed after the pool opens, and no freeze authority is ever set."] },
    { q: "Why one price for everyone?", a: ["So being first or fast buys nothing. Everyone who gets in pays the same clearing market cap. Higher max bids only decide who gets in first."] },
    { q: "What is the recovery deadline?", a: [`The end of the window plus ${durationText(i.abortAfterSecs)}. If no pool has been created by then, anyone can end the launch and every deposit comes back in full.`] },
    { q: "Can the program be upgraded?", a: [`Yes. ${UPGRADE_AUTHORITY_SENTENCE} An upgrade can change the rules for everything after it.`] },
    {
      q: "What about automated bidding?",
      a: [`Every launch${i.attestBids ? " and bid" : ""} passes a bot check first. It slows scripts, not a determined bot; sealed bids make speed worthless anyway.`],
    },
    /* F-5 (SHIPS WITH v0.30, the burn). */
    { q: "What fees does Bouncer take?", a: [V030 ? `${fee} of a launch's raise, half of it to the creator, and ${fmtVolumePct(volume.bouncerPct)} of trading volume: ${burnSplitText(volume.bouncerPct)}. Nothing from refunds. All of it is on ` : `${fee} of a launch's raise, split with the creator, and a share of trading fees. Nothing from refunds. All of it is on `, { href: "/fees", text: "Fees and terms" }, "."] },
  ];
}

/* An answer as plain text, for the JSON-LD. */
export function faqText(parts: FaqPart[]): string {
  return parts.map((p) => (typeof p === "string" ? p : "num" in p ? p.num : "info" in p ? "" : p.text)).join("").trim();
}
