"use client";

import { useRef, useState, type ReactNode } from "react";
import { Stat } from "@/components/ui/Stat";
import { SHOW_STEP, ShowMore } from "@/components/ui/ShowMore";
import { solExact } from "@/lib/bouncer/amountInput";
import type { FundingWinner } from "@/lib/bouncer/book";
import { fmtDateTime, fmtPct, fmtSol, fmtTokens, shortAddr } from "@/lib/bouncer/format";
import { describeLink, hopWords, type FundingHop, type FundingReport, type FundingTrace } from "@/lib/bouncer/funding";
import type { Launch, SettlementRecord } from "@/lib/bouncer/types";
import { explorerUrl } from "@/lib/bouncer/chain/rpc";
import { ratio, totalSupply } from "@/lib/bouncer/view";

/*
  The creator's wallet on the settlement record. Two facts with their
  denominators: the creator's own bid, labelled by the program, and the
  winners whose SOL funding history shares a source with the creator's, each
  with the hops expandable to signatures. Evidence a reader judges for
  themselves. No score, no verdict, no colour that implies guilt. Paths
  through known exchanges are dropped, not shown.

  The 0.28 triage's F6 (2026-10-09): the creator's bid is the record's
  (creator_bid_state and its figures, written at settle, kept after every bid
  closes), and the winners are the open fills plus the closed deliveries
  (book.ts, fundingWinners), so a paid-out launch no longer reads "0 of 0"
  or "did not bid".

  Partial traces (the founder's pick, 2026-11-04): a walk stopped at its limits still shows what it read, an exchange
  it met or the wallet's first funder, marked Partial and counted apart from the traced. The limits are unchanged.
*/
export function FundingLinks({ launch, winners, record, report, loading, failed = false, waiting = false, complete = true, gapWhy = "this RPC no longer serves the transactions that paid them", headEnd }: { launch: Launch; winners: FundingWinner[]; record: SettlementRecord; report: FundingReport | null; loading: boolean; failed?: boolean; waiting?: boolean; complete?: boolean; gapWhy?: string; headEnd?: ReactNode }) {
  const a = launch.account;
  const d = launch.token.decimals;
  const sym = launch.token.symbol;
  const [shownLinks, setShownLinks] = useState(SHOW_STEP);
  const linkList = useRef<HTMLUListElement>(null);
  const [shownPartial, setShownPartial] = useState(SHOW_STEP);
  const partialList = useRef<HTMLUListElement>(null);

  const M = winners.length;
  const byBidder = new Map(winners.map((w) => [w.bidder, w] as const));
  const winningDeposits = record.winningDeposits;
  /* Every share on the site divides by the whole supply, a fixed number. */
  const tokenDenom = totalSupply(a);
  const tokenDenomLabel = "of supply";

  /* Only the traces of the winners named here: the client's walk can cover a winner this page has not read yet. */
  const traces = (report?.traces ?? []).filter((t) => byBidder.has(t.bidder));
  const linkedTraces = traces.filter((t) => t.status === "linked");
  const linkedRows = linkedTraces.map((t) => byBidder.get(t.bidder)!);
  const linkedDeposits = linkedRows.reduce((s, w) => s + w.deposit, 0n);
  const linkedTokens = linkedRows.reduce((s, w) => s + (w.tokens ?? 0n), 0n);
  /* A delivery this RPC returned without its amounts: counted, its figures not summed, so the sums are a floor. */
  const atLeast = linkedRows.some((w) => w.tokens === null || w.deposit === 0n) ? "At least " : "";
  const count = (s: FundingTrace["status"]) => traces.filter((t) => t.status === s).length;
  const unresolved = count("unresolved");
  /* A winner the report carries no trace for was not walked (the server walks at most 200 per launch): counted apart, never as traced (2026-10-16, GPT-6's N3). */
  const notWalked = Math.max(0, M - traces.length);
  const traced = traces.length - unresolved;
  /* Every winner unresolved reads as "Not traced", never as "0 of M", which would say none were linked. */
  const allUnresolved = M > 0 && !!report && unresolved === M;
  const exchange = count("exchange");
  /* Stopped at a limit, with something read: an exchange met on the way back, or the first funder. */
  const partialTraces = traces.filter((t) => t.status === "unresolved" && (t.stoppedAt || t.firstFunder));
  const partial = partialTraces.length;
  const REASONS: Record<string, string> = { history: "history too long for a plain RPC", error: "the RPC refused the request", lookups: "lookup budget spent", fanout: "too many funders to follow" };
  const unresolvedWhy = Object.entries(REASONS)
    .map(([k, why]) => [traces.filter((t) => t.status === "unresolved" && t.limit === k).length, why] as const)
    .filter(([n]) => n > 0)
    .map(([n, why]) => `${n}, ${why}`)
    .join("; ");
  const maxHops = report?.limits.maxHops ?? 3;
  /* The reach of the history behind every number here. A trace can only find transfers this RPC still serves. */
  const reach = report?.historyFrom ?? null;
  const reachText = reach ? (reach.firstBlockTime != null ? fmtDateTime(reach.firstBlockTime) : `slot ${reach.firstSlot.toLocaleString("en-US")}`) : null;

  return (
    <section className="panel p-4 md:p-5 reveal" style={{ "--i": 3 } as React.CSSProperties}>
      <div className="flex flex-wrap items-center justify-between gap-x-3 mb-1">
        <h2 id="creator-wallet-heading" className="display text-[1.25rem]">The creator&apos;s wallet</h2>
        {headEnd && <div className="-my-2">{headEnd}</div>}
      </div>
      <p className="text-text-2 mb-4">
        Winners are traced back up to {maxHops} hops for a funding source shared with the creator. Evidence, not a verdict.
      </p>

      <dl className="grid grid-cols-1 gap-5 sm:grid-cols-2">
        <Stat label="Creator's own bid" value={record.creatorBidState === 0 ? "None" : fmtSol(record.creatorDeposit)} sub={creatorSub(record, winningDeposits, tokenDenom, tokenDenomLabel, d, sym)} />
        <Stat
          label="Winners sharing a funding source"
          value={waiting ? "…" : M === 0 ? (complete ? "None" : "Not traced") : !report ? (failed ? "Not read" : loading ? "…" : "Not traced") : allUnresolved ? (partial > 0 ? "None found" : "Not traced") : `${linkedRows.length} of ${complete ? "" : "at least "}${M}`}
          sub={
            waiting
              ? `Waiting for the winners: ${gapWhy}.`
              : M === 0
                ? complete
                  ? "No winner but the creator."
                  : `The winners' bid accounts have closed and ${gapWhy}, so there is nobody left to trace.`
                : !report
                  ? failed
                    ? "Funding history could not be read just now. The page tries again every 20 seconds."
                    : loading
                      ? "Reading funding history."
                      : "Funding history is not available for this launch yet."
                  : allUnresolved
                    ? partial > 0
                      ? `Traced ${traced} of ${M} in full, ${partial} partial. Nothing read shares a source with the creator. Stopped at the limits: ${unresolvedWhy}.`
                      : `None could be traced: ${unresolvedWhy || "the RPC did not answer"}.`
                    : linkedRows.length > 0
                      ? `${atLeast}${fmtSol(linkedDeposits)} of ${fmtSol(winningDeposits)} winning deposits (${fmtPct(ratio(linkedDeposits, winningDeposits))}). ${fmtTokens(linkedTokens, d)} ${sym}, ${fmtPct(ratio(linkedTokens, tokenDenom))} ${tokenDenomLabel}.`
                      : `None of the ${M} other winners${complete ? "" : " this RPC can name"} shares a funding source with the creator within ${maxHops} hops of what could be traced${reachText ? `, in the history this RPC serves (from ${reachText})` : ""}.`
          }
        />
      </dl>

      {(waiting || (loading && !report && !failed && M > 0)) && <div className="mt-5 h-24 rounded-[10px] bg-panel-2 animate-pulse" />}

      {report && linkedTraces.length > 0 && (
        <ul ref={linkList} className="mt-5">
          {linkedTraces.slice(0, shownLinks).map((t) => (
            <LinkItem key={t.bidder} trace={t} winner={byBidder.get(t.bidder)!} creator={report.creator} />
          ))}
        </ul>
      )}
      {report && <ShowMore left={linkedTraces.length - shownLinks} onMore={() => setShownLinks((n) => n + SHOW_STEP)} list={linkList} describedBy="creator-wallet-heading" />}

      {report && partial > 0 && (
        <div className="mt-5" data-funding-partial>
          <p className="text-text-3 mb-1">Found before the limits</p>
          <ul ref={partialList}>
            {partialTraces.slice(0, shownPartial).map((t) => (
              <PartialItem key={t.bidder} trace={t} winner={byBidder.get(t.bidder)!} />
            ))}
          </ul>
          <ShowMore left={partial - shownPartial} onMore={() => setShownPartial((n) => n + SHOW_STEP)} list={partialList} describedBy="creator-wallet-heading" />
        </div>
      )}

      {report && M > 0 && (
        <div className="hairline mt-5 pt-4 flex flex-col gap-1 text-text-2">
          <Row k="History this RPC serves" v={reachText ? `from ${reachText}; nothing older is visible to the trace` : "not stated by this RPC"} />
          <Row k="Traced" v={`${traced} of ${M} winners${complete ? "" : " this RPC can name"}${partial > 0 ? ` in full, ${partial} partial` : ""}, up to ${maxHops} hops back within that history`} />
          {exchange > 0 && <Row k="Stop at an exchange or faucet" v={`${exchange}${report.exclusionsMet.length ? ` (${report.exclusionsMet.join(", ")})` : ""}, not reported`} />}
          {unresolved > 0 && <Row k="Could not be traced that far" v={unresolvedWhy || `${unresolved}`} />}
          {notWalked > 0 && <Row k="Not walked" v={`${notWalked} of ${M}, outside the server's walk of ${traces.length}`} />}
          <Row k="Creator's own history" v={`${report.creatorTrace.resolvedHops} of ${maxHops} hops read${report.creatorTrace.stoppedAt ? `, stops at ${report.creatorTrace.stoppedAt.label}` : ""}`} />
          <Row k="Lookups used" v={`${report.lookups} of ${report.limits.maxLookups}`} />
        </div>
      )}

      <p className="text-text-3 mt-4 leading-snug">
        A shared source is common and usually innocent. Exchange and faucet wallets are left out.
        {reachText ? ` Nothing before ${reachText} is visible to this RPC.` : ""}
      </p>
    </section>
  );
}

/* From the record (lib.rs:1512-1534: settle cannot leave the creator's bid out): state 0 no bid, 2 did not open, 1 opened, with its tokens, cost and step. */
function creatorSub(record: SettlementRecord, winningDeposits: bigint, tokenDenom: bigint, tokenDenomLabel: string, d: number, sym: string): string {
  if (record.creatorBidState === 0) return "The creator did not bid in this auction. The program would have labelled it if they had.";
  if (record.creatorBidState === 2) return "Could not open, refunded in full. Labelled by the program.";
  if (record.creatorTokens === 0n) {
    if (record.creatorCost > 0n) return `No tokens at the cutoff, ${solExact(record.creatorDeposit - record.creatorCost)} back. Labelled by the program.`;
    return record.creatorTick < record.clearingTick ? "Max under where it cleared, refunded in full. Labelled by the program." : "Outbid, refunded in full. Labelled by the program.";
  }
  return `${fmtPct(ratio(record.creatorDeposit, winningDeposits))} of ${fmtSol(winningDeposits)} winning deposits. ${fmtTokens(record.creatorTokens, d)} ${sym}, ${fmtPct(ratio(record.creatorTokens, tokenDenom))} ${tokenDenomLabel}. Labelled by the program.`;
}

function LinkItem({ trace, winner, creator }: { trace: FundingTrace; winner: FundingWinner; creator: string }) {
  const link = trace.link!;
  return (
    <li className="border-t border-line py-3">
      <details className="group">
        <summary className="list-none cursor-pointer flex flex-wrap items-baseline gap-x-3 gap-y-1 [&::-webkit-details-marker]:hidden">
          <span className="mono">{shortAddr(trace.bidder, 5, 4)}</span>
          {winner.deposit > 0n && <span className="tab">{fmtSol(winner.deposit)}</span>}
          <span className="text-text-2">{describeLink(link, trace.bidder, creator)}</span>
          <span className="link ml-auto whitespace-nowrap group-open:hidden">Show the hops</span>
          <span className="link ml-auto whitespace-nowrap hidden group-open:inline">Hide the hops</span>
        </summary>
        <div className="inset p-4 mt-3 flex flex-col gap-3">
          <p className="text-text-2">
            Source <span className="mono text-text">{shortAddr(link.source, 6, 6)}</span>
            {link.source === creator ? ", the creator's wallet." : link.source === trace.bidder ? ", this bidder's wallet." : " funded both wallets."}
          </p>
          {link.toBidder.length > 0 && <Hops title="To this bidder" hops={link.toBidder} />}
          {link.toCreator.length > 0 && <Hops title="To the creator" hops={link.toCreator} />}
        </div>
      </details>
    </li>
  );
}

/* One partial trace: the exchange it met, the first funder, or both. A fact about transfers, marked Partial. */
function PartialItem({ trace, winner }: { trace: FundingTrace; winner: FundingWinner }) {
  const f = trace.firstFunder ?? null;
  const s = trace.stoppedAt;
  const first = f && (!s || f.from !== s.address) ? (
    <>
      First funder{" "}
      <a href={explorerUrl("tx", f.signature)} target="_blank" rel="noreferrer" className="mono link">
        {shortAddr(f.from, 4, 4)}
      </a>
      , <span className="num text-text">{fmtSol(f.lamports)}</span>
    </>
  ) : null;
  const via = s ? (s.hops === 1 ? `funded via ${s.label}` : `via ${s.label}, ${hopWords(s.hops)} back`) : null;
  return (
    <li className="border-t border-line py-3 flex flex-wrap items-baseline gap-x-3 gap-y-1">
      <span className="mono">{shortAddr(trace.bidder, 5, 4)}</span>
      {winner.deposit > 0n && <span className="tab">{fmtSol(winner.deposit)}</span>}
      {/* On a phone the finding takes its own line, the marker stays beside the wallet. */}
      <span className="text-text-2 order-last basis-full sm:order-none sm:basis-auto">
        {first}
        {first && via ? `; ${via}` : via ? via.charAt(0).toUpperCase() + via.slice(1) : null}
      </span>
      <span className="pill pill-muted ml-auto">Partial</span>
    </li>
  );
}

function Hops({ title, hops }: { title: string; hops: FundingHop[] }) {
  return (
    <div>
      <p className="text-text-3 mb-1">{title}</p>
      <ol className="flex flex-col gap-1.5 text-text-2">
        {hops.map((h) => (
          <li key={h.signature} className="leading-snug">
            <span className="mono">{shortAddr(h.from, 4, 4)}</span> sent <span className="num text-text">{fmtSol(h.lamports)}</span> to <span className="mono">{shortAddr(h.to, 4, 4)}</span>
            {h.blockTime ? ` on ${fmtDateTime(h.blockTime)}` : ""},{" "}
            <a href={`${explorerUrl("tx", h.signature)}`} target="_blank" rel="noreferrer" className="mono link">
              {shortAddr(h.signature, 6, 6)}
            </a>
          </li>
        ))}
      </ol>
    </div>
  );
}

/* Label over value on a phone, side by side once there is room, so neither wraps into a ragged column. */
function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex flex-col gap-0.5 py-0.5 sm:flex-row sm:items-baseline sm:justify-between sm:gap-3">
      <span className="text-text-3">{k}</span>
      <span className="num sm:text-right">{v}</span>
    </div>
  );
}
