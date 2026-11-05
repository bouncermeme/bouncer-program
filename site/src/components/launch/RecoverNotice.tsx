"use client";

import { useAccount } from "@/components/wallet/AccountProvider";
import { ConnectButton } from "@/components/wallet/ConnectButton";
import { FailureNote, StageLine, stageLabel, useTx } from "@/components/tx/TxState";
import { ReadFailed } from "@/components/ui/ReadFailed";
import { ACCOUNTS } from "@contract/constants";
import { solExact } from "@/lib/bouncer/amountInput";
import { getClient } from "@/lib/bouncer/client";
import { fmtDateTime } from "@/lib/bouncer/format";
import { useBidsRead, useNow, useNowSec, useRent } from "@/lib/bouncer/hooks";
import { recoverBack, useRecoveryReceipt } from "@/lib/bouncer/recovery";
import type { Launch } from "@/lib/bouncer/types";
import { recoverable, recoveryDeadline } from "@/lib/bouncer/view";

/*
  Recover deposit (INTERFACE 0.22). A launch that has not reached its pool by
  its recovery deadline (the scheduled close plus the valve, fixed at
  creation) cannot go further, and each bidder's own refund cancels it and
  pays that bidder in one transaction: no abort first, nobody else needed.
  Replaces the two-step "Abort and refund everyone" of 0.21. Anyone else's
  deposit can still be pushed back from the drive panel. What was recovered
  belongs to the wallet that signed, and a failed read of the bids says so
  (the 0.28 triage's F14).
*/
export function RecoverNotice({ launch }: { launch: Launch }) {
  const a = launch.account;
  const nowSec = useNowSec(1000);
  const now = useNow(1000);
  const account = useAccount();
  const tx = useTx(account.address);
  const { bids, failed: bidsFailed, retry } = useBidsRead(launch.id, `${a.state}:${a.distributedCount}`);
  const bidRent = useRent(ACCOUNTS.Bid.len);
  /* 9D: the receipt is the wallet's for this launch, shared with RefundView, which takes over once the recovery cancels the launch. */
  const [done, setDone] = useRecoveryReceipt(launch.id, account.address);

  if (nowSec == null || !recoverable(a, nowSec)) return null;
  const mine = account.address && bids ? (bids.find((b) => b.bidder === account.address && b.state !== "done" && b.state !== "parked") ?? null) : null;
  /* 9A: the deposit, the charge (it comes back when nobody opened the bid; a reveal that pays it zeroes it) and the bid's rent. */
  const back = mine && bidRent !== null ? recoverBack(mine, bidRent) : null;

  const recover = async () => {
    const signer = account.signer;
    if (!mine || !signer || account.signProblem) return;
    const deposit = mine.deposit;
    const before = a.distributedCount;
    const r = await tx.run((onStage) => getClient().refund(launch.id, signer, { onStage }));
    if (r) {
      setDone({ via: "recover", signature: r.signature, slot: r.slot ?? null, deposit, net: null });
      /* 24n (Astra's 24m E2E, L1): the page's counts catch up with this refund now. */
      void getClient().refreshLaunch(launch.id, { minSlot: r.slot, test: (l) => l.account.distributedCount > before });
    }
  };

  return (
    <div className="mt-5 inset p-4">
      <p className="font-semibold text-text">This launch missed its deadline ({fmtDateTime(recoveryDeadline(a))}).</p>
      <p className="text-text-2 mt-1 leading-snug">
        No pool in time, so it won&apos;t go ahead. Take your whole deposit back: one signature.
      </p>
      {done ? (
        /* 9C: the net, read from the landed transaction; "your deposit" until the read answers. */
        <p className="mt-3 text-text">Recovered: {done.net !== null ? solExact(done.net) : "your deposit"} is back in your wallet.</p>
      ) : !account.address ? (
        <div className="mt-3">
          <ConnectButton size="full" tone="primary" />
        </div>
      ) : mine && back !== null ? (
        <>
          <button type="button" onClick={recover} disabled={tx.busy || !!account.signProblem} className="btn btn-primary w-full mt-3 text-[1.125rem]">
            {tx.busy && tx.stage ? stageLabel(tx.stage, now) : `Recover deposit: ${solExact(back)}`}
          </button>
          <StageLine stage={tx.stage} />
          {account.signProblem && <p className="mt-2 text-text-2 leading-snug">{account.signProblem}</p>}
          <FailureNote failure={tx.failure} onRetry={recover} />
        </>
      ) : bids === null && bidsFailed ? (
        <ReadFailed what="Your bid" onRetry={retry} className="mt-3" />
      ) : bids === null || mine ? (
        /* A bid found waits here for the rent read (9A) before the button shows a figure. */
        <p className="mt-3 text-text-3">Looking for your bid…</p>
      ) : (
        <p className="mt-3 text-text-2">This wallet has no bid here to recover.</p>
      )}
    </div>
  );
}
