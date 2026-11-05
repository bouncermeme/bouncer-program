"use client";

/*
  The How it works page, the founder's text of 2026-10-16 (approved with his two
  accuracy edits applied; the draft was HOW-IT-WORKS-DRAFT-2026-10-16.md).
  The words are his and are not reflowed here. Every figure in them is read
  live from the program's config (useConfigLive, every 30 s): the floor, the
  launch fee and its split, the creator's share of the locked liquidity and
  the trading fee shares it gives (product.ts, tradingFeeSplit), and what
  creating costs. Until the first read lands the page shows the pinned
  config for this cluster (PRODUCT), so a mainnet build reads 5 SOL and a
  devnet build its own floor. The window bounds and the supply halves are
  the program's constants.
*/
import Link from "next/link";
import type { ReactNode } from "react";
import { MeteoraSplitInfo } from "@/components/ui/MeteoraSplitInfo";
import { HeldPayoutInfo } from "@/components/ui/HeldPayoutInfo";
import { fmtSol } from "@/lib/bouncer/format";
import { useConfigLive } from "@/lib/bouncer/hooks";
import { bpsPct, fmtVolumePct, PRODUCT, tradingFeeSplit } from "@/lib/bouncer/product";
import { WINDOW_MAX_SECS, WINDOW_MIN_SECS } from "@/lib/bouncer/view";
import { V030 } from "@/lib/bouncer/v030";
import { FLOAT, TOKEN_DECIMALS } from "@contract/constants";

const HALF_SUPPLY_MILLIONS = Number(FLOAT / 10n ** BigInt(TOKEN_DECIMALS)) / 1e6;

export function HowView() {
  const { config } = useConfigLive();
  const floor = config?.floorValue ?? PRODUCT.floorValue;
  const raiseFeeBps = config?.raiseFeeBps ?? PRODUCT.raiseFeeBps;
  const creatorShareBps = config?.raiseFeeCreatorShareBps ?? PRODUCT.raiseFeeCreatorShareBps;
  const creatorLpBps = config?.creatorLpBps ?? PRODUCT.creatorLpBps;
  const split = tradingFeeSplit(creatorLpBps);
  const creatorVolume = fmtVolumePct(split.creatorPct);
  const half = `${HALF_SUPPLY_MILLIONS} million`;
  const minutes = `${Math.round(WINDOW_MIN_SECS / 60)} and ${Math.round(WINDOW_MAX_SECS / 60)} minutes`;

  const steps: ReactNode[] = [
    <>A creator starts an auction: name, ticker, image and a window between {minutes}. Same rules for every launch.</>,
    <>
      You bid: SOL plus your max market cap. <strong className="text-text">One bid per wallet.</strong> Your max is sealed until close, from us too. Your SOL waits in the program&apos;s vault.
    </>,
    <>At close every bid opens at once.</>,
    <>One price for everyone: the highest market cap that sells all {half} tokens. Highest max bids fill first; the rest are refunded.</>,
    <>The token is born: the pool {V030 ? "is created" : "opens"} on Meteora with the other {half} tokens and the raise. Liquidity is locked forever.{" "}
      <MeteoraSplitInfo voice="reader" /> No pre-sale, no team tokens.</>,
    /* v0.30 (the founder, 2026-10-27, the approved step 6): every winner is pushed; trading waits for the last one. */
    V030 ? (
      <>Winners&apos; tokens are sent to their wallets, nothing to claim. Trading opens when everyone is paid. <HeldPayoutInfo /></>
    ) : (
      <>
        Winners get tokens, delivered or claimed free.
      </>
    ),
  ];

  const whyBid: [string, ReactNode][] = [
    ["No sniper advantage.", <>Everyone gets the same entry price.</>],
    ["Your max is sealed.", <>Nobody can see it or copy it.</>],
    ["No bundles or insiders getting in cheaper than you.", null],
    ["Bid too low?", <>Your SOL comes back.</>],
    ["Liquidity locked forever at launch.", <><MeteoraSplitInfo voice="reader" /></>],
  ];

  const whyLaunch: [string, ReactNode][] = [
    ["A fair launch for your community.", <>No snipers, no bundles, one price for everyone.</>],
    ["Seconds to start.", null],
    [`You earn ${bpsPct((raiseFeeBps * creatorShareBps) / 10_000)} of the raise, then ${creatorVolume} of all trading volume.`, null],
    ["No free dev tokens.", <>You can bid like anyone, and your bid is labeled creator.</>],
  ];

  return (
    <div className="pt-8 md:pt-14 max-w-[46rem]" data-how-view>
      <h1 className="display text-[1.75rem] md:text-[2rem] leading-tight">How it works</h1>

      <h2 className="display text-[1.25rem] mt-10 mb-3">What happens</h2>
      <ol className="flex flex-col gap-4">
        {steps.map((s, i) => (
          <li key={i} className="grid grid-cols-[2.5rem_1fr] gap-3 items-start">
            <span className="display text-[1.75rem] leading-none text-brand-text" aria-hidden="true">
              {i + 1}
            </span>
            <p className="text-text-2 leading-snug pt-1">{s}</p>
          </li>
        ))}
      </ol>
      <p className="text-text-2 leading-snug mt-4" data-how-floor-line>
        Needs <span className="num" data-how-floor>{fmtSol(floor)}</span> by close, or all refundable.
      </p>
      {/* v0.30, 1B (the founder, 2026-10-27): the freeze authority scanners flag, said where a holder looks for it. */}
      {V030 && (
        <p className="text-text-2 leading-snug mt-3" data-how-freeze-line>
          <span className="text-text font-semibold">Freeze authority.</span> Scanners flag it on new tokens. Here it only keeps the pool shut until everyone is paid, and it is revoked forever when trading opens.
        </p>
      )}

      <Section title="Why bid here" items={whyBid} />
      <Section title="Why launch here" items={whyLaunch} />

      <p className="hairline mt-10 pt-5">
        <Link href="/fees" className="link-accent inline-flex items-center min-h-11">
          Fees and terms
        </Link>
      </p>
      <span className="sr-only" data-how-window={`${WINDOW_MIN_SECS}-${WINDOW_MAX_SECS}`} data-how-fee={`${raiseFeeBps}:${creatorShareBps}:${creatorLpBps}`} />
    </div>
  );
}

function Section({ title, items }: { title: string; items: [string, ReactNode][] }) {
  return (
    <>
      <h2 className="display text-[1.25rem] mt-10 mb-3">{title}</h2>
      <ul className="flex flex-col gap-3">
        {items.map(([lead, rest]) => (
          <li key={lead} className="text-text-2 leading-snug pl-4 relative before:content-['•'] before:absolute before:left-0 before:text-text-3">
            <span className="text-text font-semibold">{lead}</span> {rest}
          </li>
        ))}
      </ul>
    </>
  );
}
