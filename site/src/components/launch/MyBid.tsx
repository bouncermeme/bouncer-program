"use client";

import { useEffect, useState } from "react";
import { useAccount } from "@/components/wallet/AccountProvider";
import { bidsOpenAt } from "@/lib/bouncer/beacon";
import { explorerUrl } from "@/lib/bouncer/chain/rpc";
import { fill } from "@/lib/bouncer/clearing";
import { getClient } from "@/lib/bouncer/client";
import { fmtPct, fmtSol, fmtTime, fmtTokens, shortAddr } from "@/lib/bouncer/format";
import { MAX_TICK } from "@/lib/bouncer/grid";
import { useBidEventsRead, useNow, useNowSec, useWalletScoped } from "@/lib/bouncer/hooks";
import { FailureNote, StageLine, stageLabel, useTx } from "@/components/tx/TxState";
import { ReadFailed } from "@/components/ui/ReadFailed";
import { ParkedCollect, ParkedCollected } from "@/components/launch/ParkedCollect";
import { useParkedReceipt } from "@/lib/bouncer/parkedReceipt";
import type { BidAccount, Launch, SettlementRecord } from "@/lib/bouncer/types";
import { useCapRate, useFrozenRate } from "@/lib/bouncer/solPrice";
import { noRateText } from "@/components/ui/Cap";
import { fmtCap } from "@/lib/bouncer/usdCap";
import { bookOpen, clearingFromRecord, mcapAtTick, mcapForValue, shareOfSupply } from "@/lib/bouncer/view";

/*
  The connected wallet's own bid, on the launch and settlement pages. Every
  sentence is read from the wallet's Bid account, the record, or the
  transactions that touched that account; nothing is inferred from the state
  byte alone. A loser or an invalid bid gets the refund button from Settled
  onward; a winner is told the tokens arrive before trading opens (v0.30: every
  winner is pushed, no claim). When the account is gone, the transaction
  that paid it says what left, and when: the instruction names this bid, the
  token transfers and balances give the amounts (chain/history.ts). It does
  not depend on the node having kept the program's log line (2026-10-02: a
  node that cuts logs lost the fifth winner onward of a batch, and this box
  came up empty for them).

  F14 (2026-10-09): everything here is this wallet's. The bid read is kept
  with the address it was read for, so another wallet's bid never shows
  under this address, not even before this one's read lands; a failed read
  says so with Try again (and reads again by itself every 20 s) instead of
  reading as "no bid"; the "Done." signature belongs to the wallet that
  signed.
*/
export function MyBid({ launch, record }: { launch: Launch; record: SettlementRecord | null }) {
  const account = useAccount();
  const nowSec = useNowSec(1000);
  const a = launch.account;
  /*
    24d (the founder's caching directive): what can change this wallet's bid account: the state, a reveal, a payout. Not
    the bid count: another wallet's bid never changes this one, and this wallet's own bid is placed on /bid, which
    mounts this view again when it comes back. (With it, every bid anyone placed made every viewer read the RPC.)
  */
  const version = `${a.state}:${a.revealedCount}:${a.distributedCount}:${a.parkedCount ?? 0}`;
  const [bump, setBump] = useState(0);
  const [retry, setRetry] = useState(0);
  /* bid undefined with failed: the read failed and nothing is known for this wallet. */
  const [state, setState] = useState<{ key: string; address: string; bid: BidAccount | null | undefined; failed: boolean } | null>(null);
  const tx = useTx(account.address);
  const now = useNow(1000);
  const [acting, setActing] = useState<"refund" | null>(null);
  const [signature, setSignature] = useWalletScoped<string>(account.address);
  const address = account.address;
  /* v0.32: a collect made on this page, kept after the bid account closes. */
  const collected = useParkedReceipt(launch.id, account.address);
  /* This wallet's bid only: the transactions that touched its bid account (commit, reveal, payout). A handful of reads on a launch of any size. */
  const { events, failed: eventsFailed } = useBidEventsRead(launch.id, address ?? null, `${version}:${bump}:${retry}`);
  const key = `${address ?? ""}:${version}:${bump}`;
  /* This wallet's read only: the last one for another address is never shown under this one. */
  const own = address && state && state.address === address ? state : null;
  /* Market caps in dollars: live until the launch settles, then frozen at the minute it settled. Beside a settled max, what it was worth in the minute the bid was placed. */
  const { rate, status: rateStatus } = useCapRate(record ? record.settledTs : null);
  const placed = useFrozenRate(record && own?.bid ? own.bid.placedTs : null);

  useEffect(() => {
    if (!address) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    getClient()
      .getMyBid(launch.id, address)
      .then((bid) => live && setState({ key, address, bid, failed: false }))
      .catch(() => {
        if (!live) return;
        setState({ key, address, bid: undefined, failed: true });
        timer = setTimeout(() => live && setRetry((n) => n + 1), 20_000);
      });
    return () => {
      live = false;
      if (timer) clearTimeout(timer);
    };
  }, [launch.id, address, key, retry]);

  if (!address) return null;
  const bid = own ? own.bid : undefined;
  const readFailed = !!own && own.failed;
  const mine = (events ?? []).filter((e) => String(e.data.bidder) === address);
  /* A loser's claim read from a node that left the tokens out is a Delivered marked loser (history.ts): the deposit came back. */
  const delivered = mine.find((e) => e.name === "Delivered" && e.data.loser !== true) ?? null;
  const refunded = mine.find((e) => e.name === "Refunded" || (e.name === "Delivered" && e.data.loser === true)) ?? null;
  /* v0.32: a parked payout that left: collected by this wallet, or pushed to it by anyone. */
  const parkedOut = mine.find((e) => e.name === "ParkedCollected" || e.name === "ParkedPushed") ?? null;
  const open = nowSec != null ? bookOpen(a, nowSec) : a.state === "open";
  const opensAtTs = bidsOpenAt(a.revealRound);
  const opensAt = fmtTime(opensAtTs);
  const d = launch.token.decimals;
  const sym = launch.token.symbol;

  const act = async (kind: "refund") => {
    const signer = account.signer;
    if (!signer || account.signProblem) return;
    setActing(kind);
    const before = a.distributedCount;
    const r = await tx.run((onStage) => getClient().refund(launch.id, signer, { onStage }));
    if (r) {
      setSignature(r.signature);
      setBump((n) => n + 1);
      /* 24n (Astra's 24m E2E, L1): the page's counts catch up with this payout now, not at the next poll. */
      void getClient().refreshLaunch(launch.id, { minSlot: r.slot, test: (l) => l.account.distributedCount > before });
    }
    setActing(null);
  };
  const gate = account.signProblem ? <p className="text-text-2 mt-2 leading-snug">{account.signProblem}</p> : null;
  const label = (kind: "refund", idle: string) => (acting === kind && tx.stage ? stageLabel(tx.stage, now) : idle);
  const off = tx.busy || !!account.signProblem;

  const box = (children: React.ReactNode) => (
    <section className="inset p-4 mt-5 border-accent-line">
      <p className="text-text-3">
        Your bid, <span className="mono">{shortAddr(address, 5, 4)}</span>
      </p>
      {children}
      <StageLine stage={tx.stage} />
      <FailureNote failure={tx.failure} />
    </section>
  );

  if (bid === undefined) return readFailed ? box(<ReadFailed what="Your bid" onRetry={() => setRetry((n) => n + 1)} className="mt-2" />) : <div className="mt-5 h-16 rounded-[6px] bg-panel-2 animate-pulse" />;

  /* The account is gone: what the program said left. */
  if (bid === null) {
    if (collected) return box(<><p className="display text-[1.5rem] mt-1 leading-tight">Paid out.</p><ParkedCollected launch={launch} receipt={collected} /></>);
    if (parkedOut) {
      const tokens = BigInt(parkedOut.data.tokens);
      const lamports = BigInt(parkedOut.data.lamports);
      return box(
        <>
          <p className="display text-[1.5rem] mt-1 leading-tight">Paid out.</p>
          <p className="text-text-2 mt-1 leading-snug">
            {parkedOut.name === "ParkedCollected" ? (
              <>{tokens > 0n ? `Collected ${fmtTokens(tokens, d)} ${sym} and ${fmtSol(lamports)}.` : `Collected ${fmtSol(lamports)}.`}</>
            ) : (
              <>
                {tokens > 0n && <>{fmtTokens(tokens, d)} {sym} arrived.</>}
                {lamports > 0n && <> {fmtSol(lamports)} refunded.</>}
              </>
            )}{" "}
            Signature <Sig s={parkedOut.signature} />.
          </p>
        </>,
      );
    }
    if (delivered) {
      const tokens = BigInt(delivered.data.tokens) - BigInt(delivered.data.fee_tokens);
      const refund = BigInt(delivered.data.refund);
      /* The payout is read from its instruction; a node that returned neither inner instructions nor token balances leaves the amounts unknown. 7 (the founder, 2026-10-27, revised shot approved): "arrived" and "refunded" only; the fee words went (push only: nothing to claim). */
      const settled = delivered.data.settled !== false;
      return box(
        <>
          <p className="display text-[1.5rem] mt-1 leading-tight">Paid out.</p>
          <p className="text-text-2 mt-1 leading-snug">
            {!settled && <>The amounts were not returned by this RPC. </>}
            {settled && tokens > 0n && (
              <>
                {fmtTokens(tokens, d)} {sym} arrived.
              </>
            )}
            {settled && refund > 0n && <> {fmtSol(refund)} refunded.</>} Signature <Sig s={delivered.signature} />.
          </p>
        </>,
      );
    }
    if (refunded) {
      const settled = refunded.data.settled !== false;
      return box(
        <>
          <p className="display text-[1.5rem] mt-1 leading-tight">Your deposit is back.</p>
          <p className="text-text-2 mt-1 leading-snug">
            {/* 7: "refunded" and the amount only. */}
            {settled ? <>{fmtSol(BigInt(refunded.data.amount ?? refunded.data.refund))} refunded.</> : <>Refunded; the amount was not returned by this RPC.</>} Signature <Sig s={refunded.signature} />.
          </p>
        </>,
      );
    }
    /* 24l: a proven outcome may come with no signature (""): still done, the signature shown only when there is one. */
    if (signature !== null) {
      return box(
        <>
          <p className="display text-[1.5rem] mt-1 leading-tight">Done.</p>
          <p className="text-text-2 mt-1 leading-snug">
            Your transaction landed and the bid account closed.{signature && (
              <>
                {" "}
                Signature <Sig s={signature} />.
              </>
            )}
          </p>
        </>,
      );
    }
    /* The account is gone and the transactions that closed it could not be read: say so, never nothing (a pushed payout would read as no bid). */
    if (events === null && eventsFailed) return box(<ReadFailed what="What happened to your bid" onRetry={() => setRetry((n) => n + 1)} className="mt-2" />);
    return null;
  }

  /* A max market cap in dollars at the page's rate; never a SOL figure. */
  const capText = (lamports: bigint) => (rate ? fmtCap(lamports, rate.usdPerSol) : noRateText(rateStatus));
  const maxText = bid.tick == null ? "sealed" : bid.tick === MAX_TICK ? "no limit" : `a ${rate?.kind === "live" ? "about " : ""}${capText(mcapAtTick(a, bid.tick))} market cap`;
  const placedText = bid.tick != null && bid.tick !== MAX_TICK && placed?.state === "ok" ? fmtCap(mcapAtTick(a, bid.tick), placed.usdPerSol) : null;
  const clearedText = record ? capText(mcapForValue(a, record.floatValue)) : null;

  /*
    v0.32 (Dispatch, 2026-10-29): a parked bid, its payout held for the bidder until collect_parked or push_parked. The
    winner box's own sentences, then the Collect control the founder approved on 2026-10-29 (review/2026-10-29-v032/mocks,
    ParkedCollect.tsx); deliver and refund do nothing on it.
  */
  if (bid.state === "parked") {
    const held = bid.parked ?? { tokens: 0n, lamports: 0n };
    if (held.tokens > 0n) {
      return box(
        <>
          {clearedText && <p className="display text-[1.5rem] mt-1 leading-tight">You&apos;re in at a {clearedText} market cap.</p>}
          <p className="text-text-2 mt-1 leading-snug">
            You won {fmtTokens(held.tokens, d)} {sym}, {fmtPct(shareOfSupply(a, held.tokens), 2)} of supply.
          </p>
          <ParkedCollect launch={launch} bid={bid} variant="winner" />
        </>,
      );
    }
    return box(
      <>
        <p className="display text-[1.5rem] mt-1 leading-tight">Not this time.</p>
        <p className="figure text-[1.75rem] mt-1">{fmtSol(held.lamports)}</p>
        <ParkedCollect launch={launch} bid={bid} variant="refund" />
      </>,
    );
  }

  if (bid.state === "sealed") {
    return box(
      <>
        <p className="figure text-[1.75rem] mt-1">{fmtSol(bid.deposit)}</p>
        <p className="text-text-2 mt-1 leading-snug">
          {open
            ? `Deposited, max market cap sealed. One bid per wallet; it cannot be changed, topped up or withdrawn. It opens at ${opensAt} with everyone else's.`
            : record
              ? "Still sealed on chain after settlement. The program has not opened this bid; what happens to it is on the record, not here."
              : /* 24o (Astra's 24n R1): past the scheduled time a sealed bid is not promised that time again (the founder's W2 B, 2026-10-26). */
                nowSec != null && nowSec >= opensAtTs
                ? `Bidding is closed. Your bid is still sealed; it was due to open at ${opensAt}.`
                : `Bidding is closed. Your bid opens at ${opensAt} with everyone else's, and the record then shows how it did.`}
        </p>
      </>,
    );
  }

  if (bid.state === "invalid") {
    return box(
      <>
        <p className="figure text-[1.75rem] mt-1">{fmtSol(bid.deposit)}</p>
        <p className="text-text-2 mt-1 leading-snug">This bid could not be opened, so it bought nothing and the deposit is refunded in full.</p>
        {record && (
          <>
            <button type="button" onClick={() => act("refund")} disabled={off} className="btn btn-primary w-full mt-3">
              {label("refund", "Refund")}
            </button>
            {gate}
          </>
        )}
      </>,
    );
  }

  if (bid.state === "revealed") {
    if (!record) {
      return box(
        <>
          <p className="figure text-[1.75rem] mt-1">{fmtSol(bid.deposit)}</p>
          <p className="text-text-2 mt-1 leading-snug">Opened: {maxText === "no limit" ? "no limit" : `a max of ${maxText}`}. Waiting for the launch to settle.</p>
        </>,
      );
    }
    const f = fill(bid.deposit, bid.tick ?? 0, clearingFromRecord(a, record));
    /* F9 (the 0.28 triage): while the pool's lock is due, the deployed keeper holds every push behind it, so no push is promised until the lock lands; claiming or taking the refund never waits for it. The push line can return for this state once the keeper's own F9 change is live. */
    /* The record read with the launch (every poll) before the page's copy, which is read again only when the state byte changes; a lock landing leaves the launch pool live (as DrivePanel). */
    const lockDue = a.state === "poolLive" && (launch.record ?? record).lpLockState !== 3;
    if (f.tokens > 0n) {
      return box(
        <>
          <p className="display text-[1.5rem] mt-1 leading-tight">You&apos;re in at a {clearedText} market cap.</p>
          <p className="text-text-2 mt-1 leading-snug">
            You won {fmtTokens(f.tokens, d)} {sym}, {fmtPct(shareOfSupply(a, f.tokens), 2)} of supply, for {fmtSol(f.cost)}
            {f.refund > 0n ? `, with ${fmtSol(f.refund)} back` : ""}.{" "}
            {bid.tick === MAX_TICK ? "You bid with no limit." : <>Your max was {maxText.replace(/^a /, "")} at settlement{placedText && <>; you set about {placedText} when you bid</>}.</>}{" "}
            {/* v0.30, 3C (the founder, 2026-10-27): no button; this sentence only (every winner is pushed). */}
            Your tokens arrive before trading opens.
          </p>
        </>,
      );
    }
    /* 0.29, the ninth candidate (Astra's F9): a bid at the margin whose share rounds to no tokens still paid a cost (one lamport at most values). It waits for the pool while Settled (the program refuses its refund, IsAWinner 6024), then refunds its deposit less that cost. */
    if (f.cost > 0n) {
      return box(
        <>
          <p className="display text-[1.5rem] mt-1 leading-tight">Not this time.</p>
          <p className="text-text-2 mt-1 leading-snug">
            Your bid was at the margin, and its share rounded to no tokens. {a.state === "settled" ? <>Your refund of {fmtSol(f.refund)} is awaiting the pool: it can be taken once the pool is created.</> : <>Your {fmtSol(f.refund)} is refunded ({fmtSol(f.cost)} kept as the margin&apos;s cost). {lockDue ? "Take it now with one signature." : "Take it now with one signature, or leave it: anyone may push it to you, free."}</>}
          </p>
          {a.state !== "settled" && (
            <>
              <button type="button" onClick={() => act("refund")} disabled={off} className="btn btn-primary w-full mt-3">
                {label("refund", `Refund ${fmtSol(f.refund)}`)}
              </button>
              {gate}
            </>
          )}
        </>,
      );
    }
    return box(
      <>
        <p className="display text-[1.5rem] mt-1 leading-tight">Not this time.</p>
        <p className="text-text-2 mt-1 leading-snug">
          Your max ({maxText.replace(/^a /, "").replace(/ market cap$/, "")} at settlement{placedText && <>, about {placedText} when you bid</>}){" "}
          {bid.tick != null && record && bid.tick >= record.clearingTick ? (
            <>was at or above where it cleared ({clearedText}), but the max bids above yours bought everything, so you didn&apos;t get in. Everyone who got in paid that same market cap.</>
          ) : (
            <>was under where it cleared ({clearedText}), so you didn&apos;t get in.</>
          )}{" "}
          Your {fmtSol(bid.deposit)} is refunded in full. {lockDue ? "Take it now with one signature." : "Take it now with one signature, or leave it: anyone may push it to you, free."}
        </p>
        <button type="button" onClick={() => act("refund")} disabled={off} className="btn btn-primary w-full mt-3">
          {label("refund", `Refund ${fmtSol(bid.deposit)}`)}
        </button>
        {gate}
      </>,
    );
  }

  return box(<p className="text-text-2 mt-1">Settled. Nothing left to do for this bid.</p>);
}

function Sig({ s }: { s: string }) {
  return (
    <a href={explorerUrl("tx", s)} target="_blank" rel="noreferrer" className="mono link">
      {shortAddr(s, 6, 6)}
    </a>
  );
}
