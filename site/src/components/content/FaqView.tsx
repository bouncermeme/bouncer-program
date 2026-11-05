"use client";

/*
  The FAQ (launch candidate, 2026-10-22). Plain question and answer, every
  answer in the page's HTML (no collapsed content: closed <details> hide their
  text from readers and from the page's own checks). Figures come from the
  live config, the pinned config until it lands, and the program's constants.
  The upgrade sentence is siteCluster's, so it follows the pin. The words are
  in faqData.ts, shared with the page's FAQPage JSON-LD.
*/
import Link from "next/link";
import { ContentPage } from "./ContentPage";
import { useConfigLive } from "@/lib/bouncer/hooks";
import { faqEntries, pinnedFaqInputs, type FaqPart } from "./faqData";
import { HeldPayoutInfo } from "@/components/ui/HeldPayoutInfo";

/* One answer's parts: text, a figure in the mono face, a link. */
function Answer({ parts }: { parts: FaqPart[] }) {
  return (
    <>
      {parts.map((p, i) =>
        typeof p === "string" ? (
          p
        ) : "num" in p ? (
          <span key={i} className="num">
            {p.num}
          </span>
        ) : "info" in p ? (
          <HeldPayoutInfo key={i} />
        ) : (
          <Link key={i} href={p.href} className="link">
            {p.text}
          </Link>
        ),
      )}
    </>
  );
}

export function FaqView() {
  const { config } = useConfigLive();
  const pinned = pinnedFaqInputs();
  /* The questions and answers live in faqData.ts (also the page's FAQPage JSON-LD); the live config's terms when it has landed, the pinned ones until then. */
  const qa = faqEntries(
    config
      ? { floor: config.floorValue, minBid: config.minBid, raiseFeeBps: Number(config.raiseFeeBps), abortAfterSecs: Number(config.abortAfterSecs), attestBids: config.attestBids, revealMarginSecs: config.revealMarginSecs }
      : pinned,
  );

  return (
    <ContentPage title="FAQ" lead="Short answers. The guide has the detail.">
      <dl className="mt-8 flex flex-col gap-6">
        {qa.map(({ q, a }) => (
          <div key={q} data-faq-item>
            <dt className="display text-[1.125rem] text-text">{q}</dt>
            <dd className="mt-1.5 text-text-2 leading-relaxed">
              <Answer parts={a} />
            </dd>
          </div>
        ))}
      </dl>
    </ContentPage>
  );
}
