"use client";

import { OnChain } from "@/components/chain/OnChain";
import { ReadFailed } from "@/components/ui/ReadFailed";
import { ParkedCollect, ParkedCollected } from "@/components/launch/ParkedCollect";
import { useParkedReceipt } from "@/lib/bouncer/parkedReceipt";
import { Stat } from "@/components/ui/Stat";
import { useAccount } from "@/components/wallet/AccountProvider";
import { ConnectButton } from "@/components/wallet/ConnectButton";
import { FailureNote, StageLine, stageLabel, useTx } from "@/components/tx/TxState";
import { solExact } from "@/lib/bouncer/amountInput";
import { getClient } from "@/lib/bouncer/client";
import { fmtBids, fmtDateTime, fmtDuration, fmtSol, fmtTokens, shortAddr } from "@/lib/bouncer/format";
import { explorerUrl } from "@/lib/bouncer/chain/rpc";
import { useBidEventsRead, useBidsRead, useNow } from "@/lib/bouncer/hooks";
import { useRecoveryReceipt } from "@/lib/bouncer/recovery";
import type { Launch } from "@/lib/bouncer/types";
import { closeAtTs, totalSupply } from "@/lib/bouncer/view";

/*
  A launch that ended without a sale. Failed: deposits never reached the
  floor, judged against total deposits at close or against revealed deposits
  at settle (N-13). Aborted: no pool had opened by the valve and someone
  ended it for everyone (T-06). Both are normal outcomes, so this reads like
  a refund at a shop: what happened, that the deposit is yours in full, a
  button to take it, and the plain fact that nobody holds this token. No
  apology, no alarm, nothing red. Wording per checklist C-19 and C-20.
  F14 (2026-10-09): a refund taken here belongs to the wallet that signed;
  a read that failed says so with Try again, never "did not bid".
*/
export function RefundView({ launch }: { launch: Launch }) {
  const a = launch.account;
  /* A launch created under 0.18 minted its whole supply at genesis. Whether finalize under 0.21 burns it is being re-derived by the program lane (2026-09-28), so the page states neither. Since 0.19 the mint is created only with the pool, so a launch that never opened one never had a token. The launch account's own name field marks the newer kind. */
  const minted = a.meta === null;
  const failed = a.state === "failed";
  const aborted = a.state === "aborted";
  /* Finalized with no record: every refund is out and the supply is burned. Nothing left to do. */
  const complete = a.state === "finalized";
  const account = useAccount();
  const { bids, failed: bidsFailed, retry: retryBids } = useBidsRead(launch.id, `${a.state}:${a.distributedCount}:${a.parkedCount ?? 0}`);
  /* v0.32: refunds park_bid holds for their owners (Launch.parked_count), and a collect this page made. */
  const parked = a.parkedCount ?? 0;
  const collected = useParkedReceipt(launch.id, account.address);
  const mine = account.address && bids ? (bids.find((b) => b.bidder === account.address) ?? null) : null;
  /* The account closes with the refund; the refund transaction that names this wallet's bid is the proof it went back. Read from the bid account's own few transactions, not the launch's whole history. */
  /* 9D: the wallet's receipt for this launch, shared with RecoverNotice: a recovery that cancelled the launch arrives here with it. */
  const [done, setDone] = useRecoveryReceipt(launch.id, account.address);
  const signature = done?.signature ?? null;
  /* The bid's own history is read again once this page holds a receipt, so the payout it names is looked for past the refund's slot. */
  const { events, failed: eventsFailed, retry: retryEvents } = useBidEventsRead(launch.id, account.address ?? null, `${a.state}:${a.distributedCount}:${signature ?? ""}`);
  const pushed = account.address ? (events ?? []).find((e) => e.name === "Refunded" && String(e.data.bidder) === account.address) ?? null : null;
  /* v0.32: a parked refund that left, collected or pushed: its lamports are the deposit, in full. */
  const parkedOut = account.address ? (events ?? []).find((e) => (e.name === "ParkedCollected" || e.name === "ParkedPushed") && String(e.data.bidder) === account.address) ?? null : null;
  const tx = useTx(account.address);
  const now = useNow(1000);
  const busy = tx.busy;

  const takeBack = async () => {
    const signer = account.signer;
    if (!mine || !signer || account.signProblem) return;
    const deposit = mine.deposit;
    const before = a.distributedCount;
    const r = await tx.run((onStage) => getClient().refund(launch.id, signer, { onStage }));
    if (r) {
      setDone({ via: "refund", signature: r.signature, slot: r.slot ?? null, deposit, net: null });
      /* 24n (Astra's 24m E2E, L1): the counts and the lists catch up with this refund now, not at the next poll. */
      void getClient().refreshLaunch(launch.id, { minSlot: r.slot, test: (l) => l.account.distributedCount > before });
    }
  };

  /* The bid account closes with the refund, so once this page has a signature the sentence stands even after the account is gone. 24l: a proven refund may come with no signature (""): it is still this page's result, never "did not bid". */
  const refunded = signature !== null || (mine ? mine.state === "done" : false);
  const closedAt = a.closeTs || closeAtTs(a);

  return (
    <div>
      <p className="text-text-3">{failed ? "Closed" : complete ? "Ended" : "Aborted"}</p>
      <p className="display text-[1.5rem] mt-1.5 leading-tight">
        {failed ? <>Needed {fmtSol(a.floorValue)} by close.<br />All refundable.</> : complete ? "This launch ended without a sale. Every deposit was refunded in full." : "No pool opened in time, so this launch was aborted. Every deposit is refundable in full."}
      </p>
      <p className="text-text-2 mt-3 leading-relaxed max-w-[62ch]">
        {complete || failed ? (
          <>Nothing was sold{minted ? "" : " and no token was minted"}.</>
        ) : (
          <>
            No pool had opened {fmtDuration(a.abortAfterSecs)} after close, so anyone could end it, and someone did. Nothing was sold{minted ? "" : " and no token was minted"}.
          </>
        )}
      </p>

      <div className="mt-5 pt-4 hairline">
        {!account.address ? (
          <>
            {/* Once every refund is pushed there is nothing to take (GPT-6's E, 2026-10-16): connecting only shows the refund. */}
            <p className="text-text-2">{complete ? "Connect the wallet you bid with to see its refund." : "Connect the wallet you bid with to take your deposit back."}</p>
            <div className="mt-3">
              <ConnectButton size="full" tone="primary" />
            </div>
          </>
        ) : bids === null && bidsFailed ? (
          <ReadFailed what="Your bid" onRetry={retryBids} />
        ) : bids === null ? (
          <div className="h-16 rounded-[6px] bg-panel-2 animate-pulse" />
        ) : !mine && collected ? (
          <>
            <p className="text-text-3">Your deposit</p>
            <p className="figure text-[2.25rem] md:text-[2.75rem] mt-1.5">{fmtSol(collected.lamports)}</p>
            <ParkedCollected launch={launch} receipt={collected} />
          </>
        ) : !mine && signature === null && parkedOut ? (
          <>
            <p className="text-text-3">Your deposit</p>
            <p className="figure text-[2.25rem] md:text-[2.75rem] mt-1.5">{fmtSol(BigInt(parkedOut.data.lamports))}</p>
            <p className="text-text-2 mt-2">
              Already back in your wallet in full, with the bid&apos;s rent{parkedOut.blockTime != null ? `, ${fmtDateTime(parkedOut.blockTime)}` : ""}. Signature{" "}
              <a href={explorerUrl("tx", parkedOut.signature)} target="_blank" rel="noreferrer" className="mono link">
                {shortAddr(parkedOut.signature, 6, 6)}
              </a>
              .
            </p>
          </>
        ) : !mine && signature === null && pushed ? (
          <>
            <p className="text-text-3">Your deposit</p>
            <p className="figure text-[2.25rem] md:text-[2.75rem] mt-1.5">{pushed.data.settled === false ? "Back" : fmtSol(BigInt(pushed.data.amount))}</p>
            <p className="text-text-2 mt-2">
              Already back in your wallet in full, with the bid&apos;s rent{pushed.blockTime != null ? `, ${fmtDateTime(pushed.blockTime)}` : ""}. Signature{" "}
              <a href={explorerUrl("tx", pushed.signature)} target="_blank" rel="noreferrer" className="mono link">
                {shortAddr(pushed.signature, 6, 6)}
              </a>
              .
            </p>
          </>
        ) : !mine && signature === null && events === null ? (
          /* The account may be closed by a pushed refund: until its transactions are read, never "did not bid". */
          eventsFailed ? <ReadFailed what="This wallet's bid" onRetry={retryEvents} /> : <div className="h-16 rounded-[6px] bg-panel-2 animate-pulse" />
        ) : !mine && signature === null ? (
          /* 9D: reached only with no receipt here and the bid's history read through: a wallet that recovered or refunded on this page never sees it. */
          <p className="text-text-2">
            <span className="mono">{shortAddr(account.address, 5, 4)}</span> did not bid on this launch, as far as the accounts and the transactions this RPC serves show. Nothing to take back.
          </p>
        ) : (
          <>
            <p className="text-text-3">Your deposit</p>
            <p className="figure text-[2.25rem] md:text-[2.75rem] mt-1.5">{done?.via === "recover" && !mine ? solExact(done.deposit) : fmtSol(mine?.deposit ?? done?.deposit ?? 0n)}</p>
            {done?.via === "recover" && !mine ? (
              /* 9D: the recovery's own line (9C), carried over from the recover notice, with its signature. */
              <p className="text-text-2 mt-2">
                Recovered: {done.net !== null ? solExact(done.net) : "your deposit"} is back in your wallet. Signature{" "}
                <a href={explorerUrl("tx", done.signature)} target="_blank" rel="noreferrer" className="mono link">
                  {shortAddr(done.signature, 6, 6)}
                </a>
                .
              </p>
            ) : refunded ? (
              <p className="text-text-2 mt-2">
                Back in your wallet in full, with the bid&apos;s rent.
                {signature && (
                  <>
                    {" "}
                    Signature <span className="mono">{shortAddr(signature, 6, 6)}</span>.
                  </>
                )}
              </p>
            ) : mine?.state === "parked" || collected ? (
              /* v0.32 (the founder approved p4 on 2026-10-29): a parked refund is held for the bidder; refund does nothing on it, so Collect takes the button's place. */
              mine ? <ParkedCollect launch={launch} bid={mine} variant="failed" /> : collected && <ParkedCollected launch={launch} receipt={collected} />
            ) : (
              <>
                <p className="text-text-2 mt-2">Yours to take back in full now.</p>
                <button type="button" onClick={takeBack} disabled={busy || !!account.signProblem} className="btn btn-primary w-full mt-4 text-[1.125rem]">
                  {busy && tx.stage ? stageLabel(tx.stage, now) : "Refund"}
                </button>
                <StageLine stage={tx.stage} />
                {account.signProblem && <p className="mt-2 text-text-2 leading-snug">{account.signProblem}</p>}
                <FailureNote failure={tx.failure} onRetry={takeBack} />
              </>
            )}
          </>
        )}
        <p className="text-text-3 mt-3 leading-snug">
          {/* v0.32 (the founder's call A, 2026-10-29): with refunds held for their owners, the second sentence says how many instead. */}
          {refundsLine(complete, parked)}
        </p>
      </div>

      <dl className="mt-6 grid grid-cols-2 gap-x-4 gap-y-5">
        <Stat label="Bid" value={fmtSol(a.totalDeposits)} sub={`${fmtBids(a.bidCount)} in a ${fmtDuration(a.windowSecs)} window`} />
        <Stat label="Needed to launch" value={fmtSol(a.floorValue)} sub="in deposits by close" />
        <Stat label={complete ? "Refunded" : "Refunded so far"} value={`${a.distributedCount} of ${a.bidCount}`} sub={complete ? "every deposit, in full" : "pushed out or taken back"} />
        {minted ? (
          <Stat label="Supply minted" value={fmtTokens(totalSupply(a), launch.token.decimals)} sub={a.state === "finalized" ? `at creation, under v0.18; finalized` : "at creation, under v0.18"} />
        ) : (
          /* 24n (the founder, 2026-10-26): "None" alone; its whole sub-line went. */
          <Stat label="Supply minted" value="None" />
        )}
      </dl>
      <div className="hairline mt-5 pt-4 flex flex-col gap-2 text-text-2">
        <Row k={aborted && !a.closeTs ? "Window ended" : "Closed"} v={fmtDateTime(closedAt)} />
        {/* G (22e3): the program counts the recovery deadline from the window's end (open_ts + window_secs + abort_after_secs, lib.rs recovery_deadline), never from settlement. */}
        {aborted && <Row k="Abort after" v={`${fmtDuration(a.abortAfterSecs)} after close`} />}
        <Row k="Pool" v="none" />
      </div>
      <OnChain id={launch.id} version={`${a.state}:${a.distributedCount}`} className="hairline mt-5 pt-4" />
    </div>
  );
}

/* The line under the wallet's part. v0.32 (the founder's call A, 2026-10-29): with refunds held for their owners, it says how many instead of "Nothing is left to take." */
export function refundsLine(complete: boolean, parked: number): string {
  if (!complete) return "Refunds are normally pushed automatically.";
  if (parked === 0) return "Every refund has been pushed out. Nothing is left to take.";
  return parked === 1 ? "1 refund is held for its owner to collect." : `${parked} refunds are held for their owners to collect.`;
}

function Row({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="text-text-3">{k}</span>
      <span className="num text-right">{v}</span>
    </div>
  );
}
