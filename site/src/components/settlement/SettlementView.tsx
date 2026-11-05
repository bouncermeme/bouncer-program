"use client";

import Link from "next/link";
import { useState } from "react";
import { POOL_RESERVE } from "@contract/constants";
import { OnChain } from "@/components/chain/OnChain";
import { MyBid } from "@/components/launch/MyBid";
import { TokenIdentity } from "@/components/launch/TokenIdentity";
import { Cap, noRateText, RateNote } from "@/components/ui/Cap";
import { Stat } from "@/components/ui/Stat";
import { useCapRate } from "@/lib/bouncer/solPrice";
import { fmtCap, fmtRate, fmtUsd } from "@/lib/bouncer/usdCap";
import { ceilDiv } from "@/lib/bouncer/clearing";
import { explorerUrl } from "@/lib/bouncer/chain/rpc";
import { fmtAtoms, fmtBids, fmtDateTime, fmtDuration, fmtPct, fmtSol, fmtTokens, shortAddr } from "@/lib/bouncer/format";
import { MAX_TICK } from "@/lib/bouncer/grid";
import { useLaunch, useLaunchMissing, useRent, useSettlement } from "@/lib/bouncer/hooks";
import { ReadFailed } from "@/components/ui/ReadFailed";
import { MissingLaunch } from "@/components/launch/MissingLaunch";
import { anyMayStay, endedWithoutSale, launchFeeMayStay, mcapAtTick, mcapForValue, openingMcap, openingPricePerToken, poolPremium, priceForValue, raiseFeeOf, ratio, totalSupply, underClearingText } from "@/lib/bouncer/view";
import { solExact } from "@/lib/bouncer/amountInput";
import { RefundView } from "@/components/launch/RefundView";
import { BidTable } from "./BidTable";
import { useSettlementBook } from "./useSettlementBook";
import { burnSplitText, fmtVolumePct, onV030Pool, poolSwapFeeBps, tradingFeeSplit } from "@/lib/bouncer/product";

export function SettlementView({ id }: { id: string }) {
  const [working, setWorking] = useState(false);
  const launch = useLaunch(id);
  const missingAt = useLaunchMissing(id);
  const state = launch?.account.state;
  const { record, loading, failed: recordFailed, retry: retryRecord } = useSettlement(id, `${state}:${launch?.account.distributedCount ?? 0}`);
  /* One rate for every market cap on this page: the SOL price in the minute the launch settled (SettlementRecord.settled_ts), frozen. Never today's price, never a SOL cap. */
  const { rate, status: rateStatus } = useCapRate(record ? record.settledTs : null);
  /* The rent of an empty account: whether a raise fee part is sure to be paid when the pool opens (view.ts, raiseFeeMayStay). */
  const rentEmpty = useRent(0);
  /* The book, its tally and the funding trace (useSettlementBook.ts; the trading page shows the funding links from the same reads). */
  const { bids, bidsFailed, retryBids, view, closed, deliveries, amountsMissing, gapWhy, tally, linked } = useSettlementBook(id, launch, record);

  if (launch === null && missingAt !== null) return <MissingLaunch id={id} checkedAt={missingAt} />;
  /* A read that failed says so, never "Not settled yet." and never a skeleton that does not end (F14). */
  const readFailed = (what: string, retry: () => void) => (
    <div className="pt-8 max-w-[34rem]">
      {launch && <TokenIdentity launch={launch} compact />}
      <div className="panel p-4 md:p-5 mt-4">
        <ReadFailed what={what} onRetry={retry} />
      </div>
    </div>
  );
  if (launch !== null && loading && recordFailed) return readFailed("The settlement record", retryRecord);
  if (launch === null || loading) return <div className="pt-8 animate-pulse h-96 rounded-[14px] bg-panel-2" />;

  /* A launch that ended without a sale has no record. The page shows the refund instead of a placeholder. */
  if (endedWithoutSale(launch)) {
    return (
      <div className="pt-5 md:pt-8">
        <Link href={`/launch/${id}/auction`} className="text-text-2 inline-flex items-center gap-1 mb-3 hover:text-text max-w-full wrap-any">
          <svg className="shrink-0" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M15 5l-7 7 7 7" />
          </svg>
          {launch.token.name} auction
        </Link>
        <TokenIdentity launch={launch} compact />
        <p className="text-text-3 mt-2">No settlement record. A launch that does not clear writes none; every deposit is refunded instead.</p>
        <section className="panel door p-5 md:p-7 mt-5 max-w-[40rem]">
          <RefundView launch={launch} />
        </section>
      </div>
    );
  }

  /* The record is read and the bids are not yet: a wait, or a failed read, never "Not settled yet." (F14). */
  if (record && bids === null) return bidsFailed ? readFailed("The bids", retryBids) : <div className="pt-8 animate-pulse h-96 rounded-[14px] bg-panel-2" />;
  if (!record || !view || !tally) {
    return (
      <div className="pt-8 max-w-[34rem]">
        <TokenIdentity launch={launch} compact />
        <div className="panel p-4 md:p-5 mt-4">
          <p className="display text-[1.5rem]">Not settled yet.</p>
          <p className="text-text-2 mt-2">The record appears here the moment the bids open and the auction clears.</p>
          <Link href={`/launch/${id}/auction`} className="btn btn-secondary w-full mt-4">
            Back to the auction
          </Link>
        </div>
      </div>
    );
  }

  const a = launch.account;
  /* R-2: this launch's shares of volume (its pool's fee, product.ts). */
  const volume = tradingFeeSplit(a.creatorLpBps, poolSwapFeeBps(launch));
  const d = launch.token.decimals;
  const c = view.clearing;
  const clearingMcap = mcapForValue(a, c.floatValue);
  /* The pool that opened (N-14, C-24): the program wrapped the proceeds less the raise fee paid (pool_sol_in, 0.28; all of float_value before); the pool opened holding pool_sol_at_open on the SOL side, that less the dust (Meteora counts no stray SOL). Zero until create_pool has run. */
  const poolOpen = record.poolSolAtOpen > 0n;
  /* 0.28: the raise fee, agreed at settle, paid when the pool opens (view.ts). Null on a launch that pays none: every sentence below is then as before. */
  const fee = raiseFeeOf(a, record);
  /* Before the open, a part under the rent of an empty account stays in the pool if its wallet is empty then (view.ts, raiseFeeMayStay): the figures below are then the least, and the pool panel's fee rows say whose part. */
  const mayStay = launchFeeMayStay(a, record, rentEmpty);
  const risk = !!fee && !fee.open && anyMayStay(mayStay);
  const toPool = fee ? fee.toPool : c.floatValue;
  const openMcap = poolOpen ? openingMcap(record) : mcapForValue(a, toPool);
  const premium = poolPremium(record);
  const under = fee ? `${risk ? "up to " : ""}${underClearingText(fee, c.floatValue)}` : null;
  const intoPool = fee ? `${risk ? "at least " : ""}${fmtSol(toPool)} into the pool` : "all of it into the pool";
  /* Largest bidder share = tokens / total supply: a fixed denominator, so it cannot drift while payouts run. */
  const largestShare = tally.largest ? tally.largest.shareOfSupply : 0;
  const paying = a.state !== "finalized";
  const windowMin = Math.round(a.windowSecs / 60);
  /* The margin, the way deliver computes it: full fills above it round up as a group, the margin shares what is left. */
  const marginMcap = mcapAtTick(a, c.marginalTick);
  /* Ruling 2.8: the top of the grid is the "no limit" bid, never a market cap a bidder chose. */
  const cap = (lamports: bigint) => (rate ? fmtCap(lamports, rate.usdPerSol) : noRateText(rateStatus));
  const marginRef = c.marginalTick === MAX_TICK ? "the no limit step" : `the cutoff (${cap(marginMcap)})`;
  const MarginRef = marginRef.charAt(0).toUpperCase() + marginRef.slice(1);
  const takenTokens = c.aboveDeposits === 0n ? 0n : ceilDiv(c.aboveDeposits * a.float, c.floatValue);
  const remainingTokens = a.float - takenTokens;
  const spentAtMargin = c.floatValue - c.aboveDeposits;
  /* Both figures count the bids already paid as well: their accounts are closed, so they are in the history and not in the open rows. Counted from the open rows alone, a launch paid out in full read "The 0 bids there" (seen on launch E, 2026-10-02). */
  const outbidDeposits =
    view.rows.filter((r) => r.status === "outbid").reduce((s, r) => s + r.bid.deposit, 0n) +
    closed.filter((x) => !x.invalid && x.tick != null && x.tick < c.marginalTick && x.tick >= c.tick).reduce((s, x) => s + x.deposit, 0n);
  const marginBidders = view.margin.bidders + closed.filter((x) => !x.invalid && x.tick === c.marginalTick).length;
  /* The rounding remainder burns at finalize (C-27). Until then it is a prediction from the fills. */
  /* Only when every bid is accounted for: a paid bid whose history this RPC does not serve would otherwise count as unsold, and the whole float would read as burning. */
  const rowsComplete = view.rows.length >= a.bidCount;
  const burnPredicted = rowsComplete ? a.float - view.tokensSold : null;
  const burned: bigint | null = a.state === "finalized" ? record.burnedTokens : burnPredicted;

  return (
    <div className="pt-5 md:pt-8">
      <div className="reveal" style={{ "--i": 0 } as React.CSSProperties}>
        <Link href={`/launch/${id}/auction`} className="text-text-2 inline-flex items-center gap-1 mb-3 hover:text-text max-w-full wrap-any">
          <svg className="shrink-0" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M15 5l-7 7 7 7" />
          </svg>
          {launch.token.name} auction
        </Link>
        <TokenIdentity launch={launch} compact />
        <p className="text-text-3 mt-2">
          Settlement record. Settled {fmtDateTime(record.settledTs)}.
          {c.tick === MAX_TICK && <> The book cleared at the top of the grid.</>}
          {paying && <span className="text-accent"> Payouts are running. Amounts below are what the program delivers.</span>}
        </p>
        {view.selfCheckFailures.length > 0 && (
          <div className="inset p-3 mt-3 border-bad">
            <p className="font-semibold text-bad">The site&apos;s prediction does not match the record.</p>
            <ul className="text-text-2 mt-1 list-disc pl-5">
              {view.selfCheckFailures.map((f) => (
                <li key={f}>{f}</li>
              ))}
            </ul>
            <p className="text-text-3 mt-1">The record on chain is what the program pays. Treat the amounts below as unverified.</p>
          </div>
        )}
        <MyBid launch={launch} record={record} />
      </div>

      {/* The headline. First class, not a footnote. The figure is the record's largest fill, what that wallet received at settlement; this page reads no live balance, so it never says "holds" (Astra's review of 2026-10-17c, B3). */}
      <section className="panel door p-5 md:p-7 mt-5 reveal" style={{ "--i": 1 } as React.CSSProperties}>
        <p className="display text-[1.5rem] text-text-2">Largest allocation won at the auction</p>
        <p className="figure text-[4.5rem] md:text-[6rem] mt-2">
          {fmtPct(largestShare)}
          <span className="display text-[1.5rem] text-text-2 ml-2">of supply</span>
        </p>
        {tally.largest && tally.largest.bidder === null && (
          <p className="text-[1.0625rem] text-text-2 mt-4 max-w-[62ch] leading-relaxed">
            The record&apos;s largest fill is{" "}
            <span className="num font-medium text-text">
              {fmtTokens(tally.largest.tokens, d)} {launch.token.symbol}
            </span>
            . Its bid account has closed, so the wallet comes from the payment&apos;s history, and {gapWhy(true)}.
          </p>
        )}
        {tally.largest && tally.largest.bidder !== null && (
          <p className="text-[1.0625rem] text-text-2 mt-4 max-w-[62ch] leading-relaxed">
            <span className="mono">{shortAddr(tally.largest.bidder, 5, 4)}</span>{" "}
            {tally.largest.cost !== null ? (
              <>
                paid <span className="num font-medium text-text">{fmtSol(tally.largest.cost)}</span> for{" "}
              </>
            ) : (
              <>got </>
            )}
            <span className="num font-medium text-text">
              {fmtTokens(tally.largest.tokens, d)} {launch.token.symbol}
            </span>
            , at the same market cap as everyone who got in.
          </p>
        )}
        <dl className="mt-6 grid grid-cols-2 gap-x-4 gap-y-5 md:grid-cols-4">
          <Stat label="Cleared at" value={<Cap lamports={clearingMcap} rate={rate} status={rateStatus} />} sub={rate ? `SOL at ${fmtRate(rate.usdPerSol)} when it settled` : "market cap"} />
          <Stat label="Deposited" value={fmtSol(a.totalDeposits)} sub={`${fmtBids(a.bidCount)}, max market caps sealed until close`} />
          <Stat label="Raised" value={fmtSol(c.floatValue)} sub={tally.complete ? `${intoPool}: ${tally.winners} of ${fmtBids(tally.bids)} got in` : record.distributedBids >= tally.bids ? `${intoPool}; ${tally.bids === 1 ? "its one bid" : `all ${fmtBids(tally.bids)}`} paid out` : `${intoPool}: ${record.distributedBids} of ${fmtBids(tally.bids)} paid out so far`} />
          <Stat label={tally.complete ? "Refunded" : "Refunded so far"} value={amountsMissing ? "not returned" : fmtSol(tally.refunded)} sub={tally.complete ? `after a ${windowMin} min window` : "deposits less the proceeds, within a lamport per marginal bid"} />
        </dl>
        <RateNote rate={rate} status={rateStatus} className="mt-4" />
      </section>

      {/* Ruling D7 (the founder: C): the stats, one sentence, then the working, closed by default. 2B (the founder, 2026-10-27): only that sentence between the stats and every bid; the floor line and the fee paragraph went (the fee stays in the pool panel's rows). */}
      <p className="text-[1.125rem] text-text mt-5 leading-snug max-w-[62ch]">Everyone who got in paid the same market cap.</p>
      {/* 2B (the founder, 2026-10-27, revised shot approved): every bid shows without a click, under the kept line, the creator's first (BidTable). */}
      <section className="panel p-4 md:p-5 mt-5">
        <div className="flex items-baseline justify-between gap-3 mb-1">
          <h2 id="every-bid-heading" className="display text-[1.25rem]">Every bid</h2>
          <p className="text-text-3 num">{fmtBids(tally.bids)}, highest max bid first</p>
        </div>
        {/* Copy pass, 2026-10-02: the table needs a sentence only when rows are missing from it. */}
        {tally.complete ? (
          <div className="mb-3" />
        ) : (
          <p className="text-text-2 mb-3">
            {tally.bids - view.rows.length - closed.length} of the {fmtBids(tally.bids)} that settled are not shown: {gapWhy(tally.bids - view.rows.length - closed.length === 1)}.
          </p>
        )}
        <BidTable rateStatus={rateStatus} launch={launch} rows={view.rows} closed={closed} deliveries={deliveries} largest={tally.largest?.bidder ?? null} linked={linked} rate={rate} />
      </section>
      <details className="mt-5 group" open={working} onToggle={(e) => setWorking((e.currentTarget as HTMLDetailsElement).open)}>
        <summary className="btn btn-secondary w-full md:w-auto list-none cursor-pointer select-none">{working ? "Hide the working" : "Show the working"}</summary>
      <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-12 md:gap-5">
        <div className="md:col-span-7 flex flex-col gap-4">
          <section className="panel p-4 md:p-5">
            {/* 3A (the founder, 2026-10-27, FOUNDER-UI-DECISIONS.md): the "How the market cap was found" heading and paragraph went; the kept line above the working says it ("Everyone who got in paid the same market cap."). */}
            <div className="flex flex-col gap-3 text-text-2 leading-relaxed">
              <div className="inset p-4">
                <p className="font-semibold text-text mb-2">Who got in</p>
                <ol className="flex flex-col gap-2 list-decimal pl-5">
                  <li>
                    Highest max bids first.{" "}
                    {c.aboveDeposits > 0n ? (
                      <>
                        Every bid with a max above {marginRef} got its full amount: <span className="num font-medium text-text">{fmtSol(c.aboveDeposits)}</span> bought{" "}
                        <span className="num font-medium text-text">
                          {fmtTokens(takenTokens, d)} {launch.token.symbol}
                        </span>{" "}
                        at the same market cap.
                      </>
                    ) : (
                      <>No bid had a max above {marginRef}, so nothing filled ahead of it.</>
                    )}
                  </li>
                  <li>
                    {MarginRef}{c.marginalTick === MAX_TICK ? ", the top of the grid," : ""} was the lowest max still needed. {tally.complete ? `The ${marginBidders} ${marginBidders === 1 ? "bid" : "bids"} there` : "The bids there"} shared the remaining{" "}
                    <span className="num font-medium text-text">
                      {fmtTokens(remainingTokens, d)} {launch.token.symbol}
                    </span>{" "}
                    in proportion to their deposits, at the same market cap: <span className="num font-medium text-text">{fmtSol(c.atDeposits)}</span> deposited, <span className="num font-medium text-text">{fmtSol(spentAtMargin)}</span> spent,{" "}
                    {fmtSol(c.atDeposits - spentAtMargin)} refunded.
                  </li>
                  <li>
                    Everything below {marginRef} was refunded in full
                    {outbidDeposits > 0n && <>, including {fmtSol(outbidDeposits)} with a max at or above where it cleared, outbid by the max market caps above it</>}.
                  </li>
                </ol>
              </div>
            </div>
            <div className="hairline mt-4 pt-3 flex flex-col gap-1 text-text-2">
              <Row k="Bids opened" v={`${record.revealedBids} of ${record.revealedBids + record.invalidBids}`} />
              <Row k="Unsealing round" v={<span className="mono">{a.revealRound.toString()}</span>} />
              {record.invalidBids > 0 && <Row k="Could not open" v={`${record.invalidBids}, refunded in full`} />}
              {/* The whole float sells on every launch that clears, except the division's remainder (C-27). */}
              <Row k="Rounding remainder" v={burned === null ? "not known yet: some paid bids' history could not be read from this RPC; the record states it at finalize" : burned > 0n ? `${fmtAtoms(burned)} of ${launch.token.symbol}, at most one per filled bidder, ${a.state === "finalized" ? "burned at finalize" : "burn at finalize"}` : "none, every fill divided exactly"} />
            </div>
          </section>

          {/* The funding links moved to the trading page (the founder, 2026-10-27, 3A follow-up; TradeFunding.tsx), beside its holder map. */}

        </div>

        <aside className="md:col-span-5 flex flex-col gap-4">
          <section className="panel p-4 md:p-5">
            <h2 className="display text-[1.25rem] mb-4">{poolOpen ? "The pool that opened" : "The pool that will open"}</h2>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-5">
              <Stat label={poolOpen ? "Pool opened at" : "Pool opens at"} value={<Cap lamports={openMcap} rate={rate} status={rateStatus} />} sub={fee && premium === 0n ? `${risk ? "or more, " : ""}${under} under cleared at: the fee` : premium === 0n ? "the same as cleared at" : "market cap"} />
              <Stat
                label="Per token"
                value={<span className="text-[1.125rem] break-all">{rate ? fmtUsd((poolOpen ? openingPricePerToken(record) : priceForValue(launch, toPool)) * rate.usdPerSol) : noRateText(rateStatus)}</span>}
                sub={risk ? "at least" : undefined}
              />
              <Stat label={poolOpen ? "SOL in the pool at open" : "SOL into the pool"} value={fmtSol(poolOpen ? record.poolSolAtOpen : toPool)} sub={`${risk ? "at least, " : ""}with ${fmtTokens(POOL_RESERVE, d)} ${launch.token.symbol}${fee ? ", after the fee" : ""}`} tone="good" />
              <Stat label="Supply" value={fmtTokens(totalSupply(a), d)} sub={`${fmtTokens(a.float, d)} sold, ${fmtTokens(POOL_RESERVE, d)} in the pool, ${burned === null ? "the remainder known at finalize" : burned > 0n ? `${fmtAtoms(burned)} burned` : "nothing burned"}`} />
            </dl>
            {poolOpen && premium > 0n && (
              <p className="text-text-2 mt-4 leading-snug">
                The pool received {fee ? <>{fmtSol(toPool)} after the fee</> : <>the proceeds, {fmtSol(c.floatValue)},</>} and opened with {fmtSol(record.poolSolAtOpen)}. Strangers added the other {fmtSol(premium)} to the pool&apos;s vault before it opened{record.poolSolAtOpen > c.floatValue ? ", so the pool opened at a higher market cap than where it cleared" : ""}.
              </p>
            )}
            <div className="hairline mt-5 pt-4 flex flex-col gap-2 text-text-2">
              <Row k="SOL in pool" v={`${fmtPct(ratio(poolOpen ? record.poolSolAtOpen : toPool, openMcap), 0)} of market cap`} />
              {/* 0.28: the fee's two parts, exact, from the record: paid once the pool is open, agreed before. */}
              {fee && (
                <>
                  <Row k="Fee to the creator" v={fee.creatorStayed > 0n ? `${solExact(fee.creatorStayed)}, stayed in the pool` : `${solExact(fee.creator)}${fee.open ? "" : mayStay.creator ? " when the pool is created, unless the wallet is empty then" : " when the pool is created"}`} />
                  <Row k="Fee to Bouncer" v={fee.platformStayed > 0n ? `${solExact(fee.platformStayed)}, stayed in the pool` : `${solExact(fee.platform)}${fee.open ? "" : mayStay.platform ? " when the pool is created, unless the wallet is empty then" : " when the pool is created"}`} />
                </>
              )}
              <Row k="Meteora pool" v={record.pool ? <Ext href={`${explorerUrl("account", record.pool)}`}>{shortAddr(record.pool, 5, 5)}</Ext> : "opening"} />
              <Row k="LP positions" v={record.lpLockState === 3 ? "two, both locked" : record.lpLockState === 0 ? "locking" : "one locked, one to go"} />
              {record.creatorLockNft && <Row k="Creator's position" v={<Ext href={`${explorerUrl("token", record.creatorLockNft)}`}>{shortAddr(record.creatorLockNft, 5, 5)}</Ext>} />}
              {record.protocolLockNft && <Row k="Protocol's position" v={<Ext href={`${explorerUrl("token", record.protocolLockNft)}`}>{shortAddr(record.protocolLockNft, 5, 5)}</Ext>} />}
              <Row k="Book closed" v={`${fmtDuration(a.windowSecs)} after open`} />
            </div>
            <OnChain id={id} version={`${a.state}:${a.distributedCount}`} className="hairline mt-4 pt-3" />
            <p className="text-text-3 mt-4 leading-snug">
              {/* R-2 (the founder, 2026-10-27): the per-trade wording with the burn, on the 0.30 pool terms. */}
              {onV030Pool(launch) ? (
                <>
                  The creator&apos;s position earns {fmtVolumePct(volume.creatorPct)} of every trade, Bouncer&apos;s {fmtVolumePct(volume.bouncerPct)} ({burnSplitText(volume.bouncerPct)}). The program can move neither.
                </>
              ) : (
                <>
                  {fmtPct(a.creatorLpBps / 10_000, 0)} of the liquidity is the creator&apos;s position, {fmtPct((10_000 - a.creatorLpBps) / 10_000, 0)} Bouncer&apos;s. Each earns its own trading fees; the program can move neither.
                </>
              )}
            </p>
          </section>

        </aside>
      </div>
      </details>
    </div>
  );
}

function Row({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="text-text-3">{k}</span>
      <span className="num text-right">{v}</span>
    </div>
  );
}

function Ext({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noreferrer" className="mono link">
      {children}
    </a>
  );
}
