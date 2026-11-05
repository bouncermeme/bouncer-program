"use client";

import Link from "next/link";
import { copycatsOf, otherLaunchesBy, outcomeOf, type LaunchOutcome } from "@/lib/bouncer/boardSort";
import { explorerUrl } from "@/lib/bouncer/chain/rpc";
import { fmtAgo, fmtDateTime, shortAddr } from "@/lib/bouncer/format";
import { useCreatorAge, useNow, useNowSec } from "@/lib/bouncer/hooks";
import { useHiddenPairs } from "@/lib/bouncer/hiddenPairs";
import type { Launch } from "@/lib/bouncer/types";
import { useOverflows } from "@/lib/useOverflows";

/*
  Who launched this (the founder, 2026-10-20): the creator's wallet, how old it is
  (its first transaction, server/walletAge.ts, read once per creator and
  kept at the CDN) and its other launches on the board with how each ended,
  each a link. The launches come from the list the board reads
  (useLaunchList, read once by the page and handed to both parts here),
  filed by the board's own sections (boardSort.ts outcomeOf), so the page
  reads nothing the board does not.
*/
const SHOWN = 6;

const OUTCOME: Record<LaunchOutcome, { label: string; pill: string }> = {
  live: { label: "Live", pill: "pill-live" },
  processing: { label: "Processing", pill: "pill-muted" },
  cleared: { label: "Cleared", pill: "pill-good" },
  failed: { label: "Did not clear", pill: "pill-muted" },
  aborted: { label: "Aborted", pill: "pill-muted" },
};

/* fill: the trading grid's right column from 1024 px (MarketGrid.tsx): the card takes the height left under the figures, tighter, and its launch list scrolls inside it (a named, focusable region) when it does not fit. */
export function CreatorPanel({ launch, list, listFailed, fill = false }: { launch: Launch; list: Launch[] | null; listFailed: boolean; fill?: boolean }) {
  const creator = launch.account.creator;
  const { age, failed: ageFailed } = useCreatorAge(launch.id, creator);
  const now = useNow(60_000);
  const nowSec = useNowSec(30_000);
  const others = list ? otherLaunchesBy(list, launch) : null;
  const [listRef, scrolls] = useOverflows<HTMLUListElement>(fill && !!others && others.length > 0);
  return (
    <section className={`panel p-4 md:p-5 ${fill ? "lg:p-4 lg:flex lg:flex-col lg:flex-1 lg:min-h-0" : ""}`} data-creator-panel>
      <h2 className={`display text-[1.25rem] mb-3 ${fill ? "lg:mb-2" : ""}`}>The creator</h2>
      <div className={`flex flex-col gap-2 text-text-2 ${fill ? "lg:gap-1.5 lg:shrink-0" : ""}`}>
        <Row k="Wallet" v={<a href={explorerUrl("account", creator)} target="_blank" rel="noreferrer" className="mono link">{shortAddr(creator, 5, 4)}</a>} />
        <Row
          k="First transaction"
          v={
            age === null ? (
              <span className="text-text-3">{ageFailed ? "Could not be read" : "Reading"}</span>
            ) : age.firstTs === null ? (
              <span data-creator-age="none">None found</span>
            ) : age.complete ? (
              <span data-creator-age="complete">
                {now ? fmtAgo(age.firstTs, now) : ""} <span className="text-text-3">({fmtDateTime(age.firstTs)})</span>
              </span>
            ) : (
              <span data-creator-age="partial">
                before {fmtDateTime(age.firstTs)} <span className="text-text-3">(over {age.transactions.toLocaleString("en-US")} transactions)</span>
              </span>
            )
          }
        />
        <Row k="Other launches" v={others === null ? <span className="text-text-3">{listFailed ? "Could not be read" : "Reading"}</span> : <span data-creator-launches={others.length}>{others.length === 0 ? "None" : others.length}</span>} />
      </div>
      {others && others.length > 0 && (
        <ul className={`mt-3 ${fill ? "lg:mt-2 lg:min-h-0 lg:flex-1 lg:overflow-y-auto" : ""}`} ref={listRef} {...(scrolls ? { tabIndex: 0, role: "region", "aria-label": "Other launches by this creator" } : {})} data-creator-list>
          {others.slice(0, SHOWN).map((l) => (
            <LaunchLine key={l.id} launch={l} outcome={outcomeOf(l, nowSec)} now={now} />
          ))}
        </ul>
      )}
      {others && others.length > SHOWN && <p className={`text-text-3 mt-2 ${fill ? "lg:shrink-0" : ""}`}>and {others.length - SHOWN} more</p>}
    </section>
  );
}

/*
  the founder, 2026-10-20: the board card's rule on the launch page itself. Other
  launches with this ticker (matching tickers only, the founder 2026-10-27), each a
  link, newest first.
*/
export function CopycatNotice({ launch, list }: { launch: Launch; list: Launch[] | null }) {
  const now = useNow(60_000);
  const nowSec = useNowSec(30_000);
  /* v0.30 item 8 (the founder, 2026-10-27): only a ticker reused after a failure, and never a direction the admin hid (8C: hidden entirely). */
  const hidden = useHiddenPairs();
  if (!list) return null;
  const c = copycatsOf(list, launch, { nowSec, hidden });
  if (c.by === null) return null;
  const n = c.launches.length;
  return (
    <div className="mt-3 rounded-[8px] px-3 py-2.5 max-w-[62ch]" style={{ background: "var(--bad-soft)" }} role="note" data-copycat={c.by}>
      <p className="leading-snug">
        <span className="font-medium" style={{ color: "var(--bad)" }}>
          {/* P-T1 (the founder, 2026-10-27): only a reuse after a failure shows this. */}
          {n} other {n === 1 ? "launch" : "launches"} used this ticker and failed.
        </span>{" "}
        <span className="text-text-2">Check the creator before you bid.</span>
      </p>
      <ul className="mt-1.5">
        {c.launches.slice(0, SHOWN).map((l) => (
          <LaunchLine key={l.id} launch={l} outcome={outcomeOf(l, nowSec)} now={now} creator />
        ))}
      </ul>
      {n > SHOWN && <p className="text-text-3 mt-1">and {n - SHOWN} more</p>}
    </div>
  );
}

function LaunchLine({ launch, outcome, now, creator = false }: { launch: Launch; outcome: LaunchOutcome; now: number; creator?: boolean }) {
  const o = OUTCOME[outcome];
  return (
    <li className="flex items-center justify-between gap-3 py-1.5 border-t border-line min-w-0">
      <Link href={`/launch/${launch.id}`} className="link min-w-0 truncate">
        <span className="font-medium">{launch.token.symbol}</span> <span className="text-text-2">{launch.token.name}</span>
        {creator && <span className="text-text-3"> · by <span className="mono">{shortAddr(launch.account.creator, 4, 4)}</span></span>}
      </Link>
      <span className="flex items-center gap-2 shrink-0">
        <span className={`pill ${o.pill}`} data-outcome={outcome}>
          {o.label}
        </span>
        <span className="text-text-3 tab hidden sm:inline">{now ? fmtAgo(launch.account.openTs, now) : ""}</span>
      </span>
    </li>
  );
}

function Row({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="text-text-3 shrink-0">{k}</span>
      <span className="num text-right min-w-0">{v}</span>
    </div>
  );
}
