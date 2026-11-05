"use client";

import { useNow } from "@/lib/bouncer/hooks";
import { fmtCountdown, fmtTime } from "@/lib/bouncer/format";
import type { Launch } from "@/lib/bouncer/types";
import { recoverable } from "@/lib/bouncer/view";
import { phaseOf, STAGES, stageOf, type Phase } from "./phase";
import { V030 } from "@/lib/bouncer/v030";
import { HeldPayoutInfo } from "@/components/ui/HeldPayoutInfo";

/* v0.30, 2B: the paid share of every bid, and how many are left. */
export function PayoutBar({ paid, total }: { paid: number; total: number }) {
  const done = Math.min(paid, total);
  const pct = total > 0 ? (done / total) * 100 : 0;
  return (
    <>
      <div className="mt-4" role="progressbar" aria-label="Bids paid" aria-valuemin={0} aria-valuemax={total} aria-valuenow={done} style={{ height: 8, borderRadius: 999, background: "var(--bg-2)", border: "1px solid var(--line)", overflow: "hidden" }}>
        <div style={{ height: "100%", width: `${pct.toFixed(1)}%`, background: "var(--brand)", borderRadius: 999 }} />
      </div>
      <div className="mt-2 flex items-baseline justify-between gap-4">
        <p className="num text-text">
          {done} of {total} paid
        </p>
        <p className="text-text-3 num">{total - done} to go</p>
      </div>
    </>
  );
}

/*
  The window clock's colour: red (the danger token, --bad) in the last 60 seconds (the founder, 2026-10-28), the live blue
  from two minutes, else the figure's own. One rule for every place the window counts down.
*/
export const LAST_MINUTE_MS = 60 * 1000;
export function windowClockTone(leftMs: number | null): string {
  if (leftMs == null) return "";
  if (leftMs < LAST_MINUTE_MS) return "text-bad";
  return leftMs < 2 * 60 * 1000 ? "text-brand-text" : "";
}

/*
  One honest clock. The window is fixed, so "Closes in" means exactly that.
  Three sizes: lg on the launch page, md on a home card (the card's big
  figure, where other launchpads put a market cap; decision 1 of 2026-09-30),
  sm beside a heading. lg and md carry the line under the figure; sm does not.
*/
export function Countdown({ launch, size = "lg" }: { launch: Launch; size?: "lg" | "md" | "sm" }) {
  const now = useNow(1000);
  const phase = phaseOf(launch, now ? Math.floor(now / 1000) : undefined);
  const big = size === "lg" ? "text-[3.5rem] md:text-[4.5rem]" : size === "md" ? "text-[2.75rem] leading-none" : "text-[1.625rem]";
  /* Word states need less room than a clock. */
  const word = size === "lg" ? "text-[2rem] md:text-[2.75rem]" : size === "md" ? "text-[1.75rem] leading-tight" : "text-[1.375rem]";
  const sub = size !== "sm";
  const blank = "––:––";

  /* 0.22: from the recovery deadline on, nothing moves the launch forward; the clock says so instead of the phase it stopped in. */
  if (now && recoverable(launch.account, Math.floor(now / 1000)))
    return (
      <div>
        <p className="text-text-3">Missed its deadline</p>
        <p className={`display ${word} mt-1.5`}>Refunds open</p>
      </div>
    );

  switch (phase.kind) {
    /* 0.29: no bid until the creator's grow lands; inside the window it still can, after it the launch waits for its deadline. */
    case "setup": {
      const left = now ? phase.closeTs * 1000 - now : null;
      if (left != null && left <= 0)
        return (
          <div>
            <p className="text-text-3">Did not open</p>
            <p className={`display ${word} mt-1.5`}>No bids taken</p>
            {sub && <p className="text-text-2 mt-2">its setup never finished; the prepay returns after the deadline</p>}
          </div>
        );
      return (
        <div>
          <p className="text-text-3">Finishing setup</p>
          <p className={`figure ${big} mt-1.5 ${windowClockTone(left)}`} aria-live="off" data-window-clock>
            {left == null ? blank : fmtCountdown(Math.max(0, left))}
          </p>
          {sub && <p className="text-text-2 mt-2">left in the window; no bids until the creator finishes setup</p>}
        </div>
      );
    }
    case "open": {
      const left = now ? phase.closeTs * 1000 - now : null;
      return (
        <div>
          <p className="text-text-3">Closes in</p>
          <p className={`figure ${big} mt-1.5 ${windowClockTone(left)}`} aria-live="off" data-window-clock>
            {left == null ? blank : fmtCountdown(Math.max(0, left))}
          </p>
          {sub &&<p className="text-text-2 mt-2">at {fmtTime(phase.closeTs)}, fixed</p>}
        </div>
      );
    }
    /* After close the clock names the stage (decision 6, 2026-09-30), never a finished state while anyone cannot claim. */
    case "closed":
      if (stageOf(phase) === "Opening bids")
        return (
          <div>
            <p className="text-text-3">Opening bids</p>
            <p className={`figure ${big} mt-1.5`}>
              {phase.opened}/{phase.total}
            </p>
            {sub &&<p className="text-text-2 mt-2">opened so far; closed {fmtTime(phase.closeTs)}</p>}
          </div>
        );
      return (
        <div>
          <p className="text-text-3">Calculating</p>
          <p className={`display ${word} mt-1.5`}>The clearing market cap</p>
          {sub &&<p className="text-text-2 mt-2">every bid is open; the settlement is next</p>}
        </div>
      );
    case "settled":
      return (
        <div>
          <p className="text-text-3">Cleared</p>
          <p className={`display ${word} mt-1.5`}>Preparing liquidity</p>
          {sub &&<p className="text-text-2 mt-2">bids that did not get in can refund now</p>}
        </div>
      );
    case "poolLive":
      /* v0.30, 2B (the founder, 2026-10-27): the pool is created frozen and opens when every bid is delivered or refunded; the bar counts both (distributed_count of bid_count, the gate's own P1). */
      if (V030)
        return (
          <div data-paying-out>
            <p className="text-text-3">Pool created</p>
            <p className={`display ${word} mt-1.5`}>Paying out winners</p>
            {sub && (
              <p className="text-text-2 mt-2">
                Trading opens when everyone is paid.{size === "lg" && <> <HeldPayoutInfo /></>}
              </p>
            )}
            {size === "lg" && <PayoutBar paid={launch.account.distributedCount} total={launch.account.bidCount} />}
          </div>
        );
      return (
        <div>
          <p className="text-text-3">Pool live</p>
          <p className={`display ${word} mt-1.5`}>Claims available</p>
          {sub &&<p className="text-text-2 mt-2">tokens and refunds are going out</p>}
        </div>
      );
    case "finalized":
      if (!launch.recordExists)
        return (
          <div>
            <p className="text-text-3">Ended</p>
            <p className={`display ${word} mt-1.5`}>Everyone refunded</p>
          </div>
        );
      return (
        <div>
          <p className="text-text-3">Closed</p>
          <p className={`figure ${big} mt-1.5`}>{fmtTime(launch.account.closeTs)}</p>
        </div>
      );
    case "failed":
      return (
        <div>
          <p className="text-text-3">Closed</p>
          <p className={`display ${word} mt-1.5`}>Refunds open</p>
        </div>
      );
    case "aborted":
      return (
        <div>
          <p className="text-text-3">Ended early</p>
          <p className={`display ${word} mt-1.5`}>Refunds open</p>
        </div>
      );
  }
}

/* The four stages in a row, the current one bright, the done ones ticked. Nothing while bidding is open or once the launch is over. */
export function StageLine({ launch }: { launch: Launch }) {
  const now = useNow(1000);
  const phase: Phase = phaseOf(launch, now ? Math.floor(now / 1000) : undefined);
  const stage = stageOf(phase);
  if (!stage) return null;
  const at = STAGES.indexOf(stage);
  return (
    <ol className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-text-3" aria-label="Progress after close">
      {STAGES.map((s, i) => (
        /* Pass 2 (2026-10-10): the stage under way is in the live blue (8.15:1 on the panel), the done ones in the second tone. */
        <li key={s} className={i === at ? "text-brand-text font-medium" : i < at ? "text-text-2" : ""} aria-current={i === at ? "step" : undefined}>
          {i < at ? "\u2713 " : `${i + 1}. `}
          {s}
        </li>
      ))}
    </ol>
  );
}
