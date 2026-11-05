"use client";

import { explorerUrl } from "@/lib/bouncer/chain/rpc";
import type { DecodedEvent } from "@/lib/bouncer/chain/events";
import { fmtDateTime, shortAddr } from "@/lib/bouncer/format";
import { useLaunchEventsRead } from "@/lib/bouncer/hooks";

/*
  What happened on a launch, from every transaction that touched it, back to
  the one that created it. One row per lifecycle event with its signature;
  the per bid steps (commits, reveals, deliveries, refunds) are counted.
  Nothing here is inferred: a lifecycle row and a reveal exist because the
  program wrote the line, and a commit, delivery or refund because its
  instruction landed (chain/history.ts), whether or not the node kept the
  log line for it.
*/
const LABEL: Record<string, string> = {
  LaunchCreated: "Genesis",
  /* 0.29: the second step of genesis; until it lands the launch takes no bid. */
  HistogramGrown: "Setup finished",
  AttestationWaived: "Bot check waived",
  LaunchClosed: "Book closed",
  BeaconPosted: "Unsealing key posted",
  Settled: "Settled",
  LaunchFailed: "Failed",
  Aborted: "Aborted",
  PoolCreated: "Pool created",
  /* v0.30: open_trading thawed the pool once everyone was paid. */
  TradingOpened: "Trading opened",
  /* 0.29, the ninth candidate: finish_mint, the token's metadata written and its mint authority revoked. */
  MintFinished: "Token named",
  /* The twelfth candidate: release_pool_cash, three days on with the creator's split not landed. */
  PoolCashReleased: "Pool cash released",
  Finalized: "Finalized",
  EmergencyUpdatePauseSet: "Pause set",
  CreatorFeeSwept: "Creator fee swept",
};
const COUNTED: Record<string, string> = { BidCommitted: "bids", BidRevealed: "bids opened", BidInvalid: "bids invalid", Delivered: "deliveries", Refunded: "refunds" };

export function OnChain({ id, version, className = "" }: { id: string; version: string; className?: string }) {
  const { events, read, progress } = useLaunchEventsRead(id, version);
  if (events === null) return <div className={`h-12 rounded-[6px] bg-panel-2 animate-pulse ${className}`} />;
  const rows = events.filter((e) => LABEL[e.name]);
  const counts = new Map<string, number>();
  for (const e of events) if (COUNTED[e.name]) counts.set(e.name, (counts.get(e.name) ?? 0) + 1);
  const seen = events.length;
  /* The counts below are of what has been read; while a read runs, or after the node withheld some, the line says how much that is. */
  const partial = progress && progress.total > 0 && progress.read < progress.total;
  return (
    <div className={className}>
      <p className="text-text-3">On chain</p>
      {partial && (
        <p className="text-text-2 mt-1 num" data-history-progress>
          {read === "loading" ? "Reading" : "Read"} {progress.read.toLocaleString("en-US")} of {progress.total.toLocaleString("en-US")} transactions{read === "limited" ? ", rate limited" : ""}.
        </p>
      )}
      {!partial && progress && progress.missing > 0 && (
        <p className="text-text-2 mt-1 num">
          {progress.missing.toLocaleString("en-US")} of {progress.total.toLocaleString("en-US")} transactions not returned by this RPC.
        </p>
      )}
      {!partial && progress && progress.complete === false && (
        <p className="text-text-2 mt-1" data-history-incomplete>
          This RPC&apos;s history ends before this launch&apos;s creation; what is older is not shown.
        </p>
      )}
      {seen === 0 ? (
        partial ? null : <p className="text-text-2 mt-1">No events found for this launch in the transactions the RPC returned.</p>
      ) : (
        <ul className="mt-1 flex flex-col gap-1.5">
          {rows.map((e) => (
            <li key={`${e.signature}:${e.name}`} className="flex items-baseline justify-between gap-3">
              <span className="text-text-2">
                {LABEL[e.name]}
                {e.blockTime != null && <span className="text-text-3 num"> {fmtDateTime(e.blockTime)}</span>}
              </span>
              <a href={explorerUrl("tx", e.signature)} target="_blank" rel="noreferrer" className="mono link shrink-0">
                {shortAddr(e.signature, 5, 5)}
              </a>
            </li>
          ))}
          {[...counts.entries()].map(([name, n]) => (
            <li key={name} className="flex items-baseline justify-between gap-3">
              <span className="text-text-2">{COUNTED[name]}</span>
              <span className="num text-text-2">{n}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function eventsVersion(events: readonly DecodedEvent[] | null): string {
  return events ? String(events.length) : "0";
}
