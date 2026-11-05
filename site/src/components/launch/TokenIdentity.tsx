"use client";

import { useNowSec } from "@/lib/bouncer/hooks";
import { hue } from "@/lib/bouncer/hue";
import { ShareSlot } from "./ShareSlot";
import type { Launch } from "@/lib/bouncer/types";
import { closeAtTs, recoverable } from "@/lib/bouncer/view";
import { phaseOf, stageOf } from "./phase";


export function TokenAvatar({ launch, size = 56 }: { launch: Launch; size?: number }) {
  const h = hue(launch.token.mint);
  /* The site's own store's picture only (ownStore.ts, S3); metadata.ts keeps no other, and this holds if something else ever sets one. */
  if (launch.token.image && /^\/api\/token\/[0-9a-f]{32}$/.test(launch.token.image)) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={launch.token.image}
        alt=""
        width={size}
        height={size}
        className="shrink-0 rounded-[8px] object-cover"
        style={{ width: size, height: size, boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.08)" }}
      />
    );
  }
  return (
    <div
      className="shrink-0 rounded-[8px] flex items-center justify-center font-semibold text-text"
      style={{
        width: size,
        height: size,
        /* Never under the 16px floor, whatever the box size. */
        fontSize: Math.max(16, size * 0.36),
        background: `linear-gradient(160deg, hsl(${h} 26% 22%), hsl(${(h + 30) % 360} 30% 12%))`,
        boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.08)",
      }}
      aria-hidden="true"
    >
      {launch.token.symbol.slice(0, 2)}
    </div>
  );
}

/*
  One pill per on-chain state, one word where one will do. Finalized reads
  two ways: settled with a record, or ended without one. After the window
  the pill is the stage (decision 6; the manager, 2026-10-01: one word
  everywhere, the same on the card, the header and the clock), so a launch
  being processed never wears the same word as a dead one.
*/
export function StatusPill({ launch }: { launch: Launch }) {
  const state = launch.account.state;
  /* 24o (Astra's 24n F5): the page's one-second clock, as the body and the countdown use, so the header never reads Open after the window. */
  const nowSec = useNowSec(1000);
  if (state === "finalized" && !launch.recordExists) return <span className="pill pill-muted">Ended</span>;
  /* The state byte says open until someone sends close or a late commit; the clock says the window ended. The clock wins. */
  /* 0.22: past the recovery deadline an unfinished launch will not go ahead, whatever its state byte still says. */
  if (nowSec != null && recoverable(launch.account, nowSec)) return <span className="pill pill-muted">Missed its deadline</span>;
  const stage = stageOf(phaseOf(launch, nowSec ?? undefined));
  if (stage) return <span className="pill pill-muted">{stage}</span>;
  switch (state) {
    case "initializing":
      /* 0.29: the second step of genesis has not landed; no bid until it does, and after the window it never will. */
      return nowSec != null && nowSec >= closeAtTs(launch.account) ? (
        <span className="pill pill-muted" data-pill-setup>
          Did not open
        </span>
      ) : (
        <span className="pill pill-muted" data-pill-setup>
          Finishing setup
        </span>
      );
    case "open":
      return (
        <span className="pill pill-live">
          <span className="live-dot" /> Open
        </span>
      );
    case "closed":
    case "settled":
    case "poolLive":
      /* Covered by the stage above; the switch stays exhaustive for the type. */
      return <span className="pill pill-muted">{state === "closed" ? "Closed" : state === "settled" ? "Cleared" : "Pool live"}</span>;
    case "finalized":
      /* The e2e test of 2026-10-22: "Settled" here named an earlier program state (the record written, no pool yet) on a launch whose every step is done; after "Claims available" the last stage reads "Complete". */
      return (
        <span className="pill pill-good" data-pill-complete>
          Complete
        </span>
      );
    case "aborted":
      return <span className="pill pill-muted">Ended, refunding</span>;
    case "failed":
      return <span className="pill pill-muted">Refunding</span>;
  }
}

/*
  the founder, 2026-10-07 (review hold 4): the ticker leads and the name sits under
  it, as on the board's cards and the trading page; the pill stays beside the
  lead line. The share slot no longer repeats the ticker, since it is the
  heading now.
*/
export function TokenIdentity({ launch, compact = false }: { launch: Launch; compact?: boolean }) {
  return (
    <div className="flex items-center gap-3 min-w-0">
      <TokenAvatar launch={launch} size={compact ? 44 : 56} />
      <div className="min-w-0">
        <div className="flex items-center gap-2.5 flex-wrap">
          <h1 className={`display ${compact ? "text-[1.25rem] font-bold" : "text-[1.75rem] md:text-[2rem]"} leading-tight wrap-any max-w-full`}>{launch.token.symbol}</h1>
          <StatusPill launch={launch} />
        </div>
        <p className={`text-text-2 leading-tight wrap-any ${compact ? "mt-0.5" : "mt-1"}`}>{launch.token.name}</p>
        {!compact && (
          <div className="mt-2">
            <ShareSlot launch={launch} ticker={false} solscan />
          </div>
        )}
        {/* "Creator allocation 0" went in the sweep of 2026-10-07: the terms list beside says it. */}
        {!compact && <p className="text-text-2 mt-1.5">Launched by {launch.token.creator}.</p>}
      </div>
    </div>
  );
}
