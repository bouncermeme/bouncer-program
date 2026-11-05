"use client";

import { BOARD_LOCAL } from "@/lib/board";
import { useState } from "react";
import { useAccount } from "@/components/wallet/AccountProvider";
import { ConnectButton } from "@/components/wallet/ConnectButton";
import { FailureNote, StageLine, stageLabel, useTx } from "@/components/tx/TxState";
import { bidsOpenAt } from "@/lib/bouncer/beacon";
import { fill } from "@/lib/bouncer/clearing";
import { getClient } from "@/lib/bouncer/client";
import { fmtFee } from "@/lib/bouncer/product";
import { fmtCountdown, fmtSol, fmtTime, shortAddr } from "@/lib/bouncer/format";
import { useBidsRead, useMintAuthorityHeld, useNow, useNowSec, useWalletScoped } from "@/lib/bouncer/hooks";
import { ReadFailed } from "@/components/ui/ReadFailed";
import { Info } from "@/components/ui/Info";
import { DEADLINE_INFO_LABEL, FINISH_READY_NOTE, FINISH_SEALED_NOTE, STEP_INFO_LABEL } from "@/lib/bouncer/approvedCopy";
import type { BidAccount, DrivePlan, DriveResult, Launch, PushStep, SettlementRecord } from "@/lib/bouncer/types";
import { tradingFrozen } from "@/lib/bouncer/v030";
import type { TxSigner } from "@/lib/bouncer/chain/signer";
import { clearingFromRecord, closeAtTs, recoverable, recoveryDeadline } from "@/lib/bouncer/view";
import { BOUNDS } from "@contract/constants";

/* 0.22: what each operating step's signer is paid on top of its costs, from the creator's operating prepay. */
const ALLOWANCE = BigInt(BOUNDS.stepAllowanceLamports);
const lamports = (n: bigint | number) => `${Number(n).toLocaleString("en-US")} lamports`;
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/*
  Drive this launch by hand. Bouncer's keeper runs every step (since
  2026-10-06), and each is also offered here as a button any connected wallet
  may press, from the window's end to finalize (none of them needs the
  creator's key). From the
  window's end to a live pool it is one button (the founder, 2026-10-07): once the
  drand round is out, a press posts the beacon (which closes the book), opens
  every sealed bid and settles in one transaction, then opens the pool and
  locks the creator's liquidity in one transaction each, all signed in one
  wallet prompt where the wallet allows. Before the round the button counts down and is
  off. The per-bid pushes and finalize stay one each. Every button is
  simulated before the wallet opens, so a step the chain would refuse shows
  its refusal instead of a prompt. Plain on purpose.
*/

interface Step {
  step: PushStep | "drive";
  label: string;
  note: string;
  bidder?: string;
  /* Unix seconds before which the button is off (the drand round is not out yet). */
  notBefore?: number;
  plan?: DrivePlan;
  /* 6A (the founder, 2026-10-27): the recovery deadline sentence, shown behind an (i) after the note, not inside it. */
  deadline?: string;
  /* Item 7 (the founder, 2026-10-28): the finish step's short note while sealed (after "Sealed until <time>."), and its one (i), "About this step": the press detail, then the deadline. */
  sealedNote?: string;
  stepInfo?: string;
}

/* The sentence under the one button: what the press does, the count, the money, then the lock and mint steps' own short note (the deadline is the step's (i), 6A). */
export function driveNote(p: DrivePlan, tail: string): string {
  const does: string[] = [];
  if (p.beaconDue) does.push("posts the key that unseals the bids");
  if (p.sealed > 0) does.push(`opens ${plural(p.sealed, "bid", "bids")}`);
  if (p.settles) does.push("settles");
  if (p.opensPool) does.push("creates the pool");
  if (p.finishesMint) does.push("writes the token's name on chain");
  if (p.locks) does.push(p.opensPool ? "locks the creator's liquidity" : "creates the creator's LP position and locks it");
  const list = does.length > 1 ? `${does.slice(0, -1).join(", ")} and ${does[does.length - 1]}` : (does[0] ?? "");
  const what = list.charAt(0).toUpperCase() + list.slice(1);
  const count = `${plural(p.transactions, "transaction", "transactions")}, ${plural(p.prompts, "wallet approval", "wallet approvals")}`;
  const money = p.front > 0n ? ` You front ${fmtSol(p.front)} of rents, repaid plus ${lamports(ALLOWANCE)} a step by the creator's operating prepay in the same transactions.` : "";
  return `${what}. ${count}.${money}${tail ? ` ${tail}` : ""}`;
}

function plan(launch: Launch, record: SettlementRecord | null, bids: BidAccount[] | null, nowSec: number, me: string | null, signer: TxSigner | null, genesis: string | null, mintHeld = false): { steps: Step[]; waiting: string | null } {
  const a = launch.account;
  const closeAt = closeAtTs(a);
  /* 0.22: from the recovery deadline on, nothing moves the launch forward; any refund cancels it and pays that bid back. */
  if (recoverable(a, nowSec)) {
    if (bids === null) return { steps: [], waiting: "Reading the bids…" };
    return {
      steps: bids
        .filter((b) => b.state !== "done")
        .map((b) => ({ step: "refundFor" as const, bidder: b.bidder, label: `Refund ${shortAddr(b.bidder)} (${fmtSol(b.deposit + b.processingCharge)})`, note: "The deadline has passed. Sends this bid's deposit back to its bidder; the first refund also cancels the launch. Free apart from the fee." })),
      waiting: null,
    };
  }
  const deadline = `Before ${fmtTime(recoveryDeadline(a))}: from then on it is refused and every deposit can be recovered instead.`;
  if (a.state === "open" && nowSec < closeAt) return { steps: [], waiting: null };
  if (a.state === "open" && a.totalDeposits < a.floorValue) {
    return { steps: [{ step: "close", label: "End bidding", note: `Bids total under ${fmtSol(a.floorValue)}, so this ends the launch as failed and every deposit becomes refundable.` }], waiting: null };
  }
  /* The plan is sized for this wallet (one prompt, version 0) when one is connected; for nobody yet, as a wallet that signs one at a time would see it. */
  const drivePlan = (bidList: BidAccount[]) => getClient().drivePlan(launch, bidList, record, me ?? a.creator, signer, genesis, mintHeld);
  const driveStep = (p: DrivePlan): Step => {
    const label = p.kind === "finish" ? "Finish the auction" : p.kind === "pool" ? "Create the pool" : p.kind === "lock" ? "Split and lock the creator's liquidity" : "Write the token's name";
    const tail = p.kind === "lock" ? "Needed before finalize." : p.kind === "mint" ? (a.state === "finalized" ? "Nothing waits for it." : "Payouts and finalize do not wait for it.") : "";
    /* Item 7: the finish press that runs through the pool (the usual one) says what follows it; the detail moves behind the (i). */
    if (p.kind === "finish" && p.opensPool) return { step: "drive", label, note: FINISH_READY_NOTE, sealedNote: FINISH_SEALED_NOTE, stepInfo: `${driveNote(p, tail)} ${deadline}`, notBefore: p.notBefore || undefined, plan: p };
    return { step: "drive", label, note: driveNote(p, tail), notBefore: p.notBefore || undefined, plan: p, deadline: p.kind === "lock" || p.kind === "mint" ? undefined : deadline };
  };
  if (a.state === "open" || a.state === "closed" || a.state === "settled") {
    if (bids === null) return { steps: [], waiting: "Reading the bids…" };
    const p = drivePlan(bids);
    if (!p) return { steps: [], waiting: a.state === "closed" ? "Some bids are not readable yet; try again in a moment." : null };
    return { steps: [driveStep(p)], waiting: null };
  }
  if (a.state === "poolLive" || a.state === "failed" || a.state === "aborted") {
    const steps: Step[] = [];
    if (bids === null) return { steps, waiting: "Reading the open bids…" };
    /* F9 (the 0.28 triage; the founder, 2026-10-13: "we can't have anything holding up pushing"): deliver and refund read no lock bit (lib.rs deliver, refund, payout_for); only burn_unsold, behind Finalize, needs lp_lock_state 3. While the lock is due it comes first and the deliveries and refunds follow it; Finalize waits for it (lockDone below). */
    /* The ninth 0.29 candidate: finish_mint (the token's metadata) rides with the lock while both are due, and goes alone once the lock is done; nothing else waits for it. */
    if (a.state === "poolLive" && record && (record.lpLockState !== 3 || mintHeld)) {
      const p = drivePlan(bids);
      if (p) steps.push(driveStep(p));
    }
    const clearing = a.state === "poolLive" && record ? clearingFromRecord(a, record) : null;
    for (const b of bids) {
      const f = clearing && b.state === "revealed" && b.tick != null ? fill(b.deposit, b.tick, clearing) : null;
      const won = !!f && f.tokens > 0n;
      /* A bid at the margin whose share rounded to no tokens is refunded its deposit less the margin's cost (the ninth 0.29 candidate holds it until the pool). */
      const back = f && f.cost > 0n ? f.refund : b.deposit;
      steps.push(
        won
          ? { step: "deliver", bidder: b.bidder, label: `Deliver to ${shortAddr(b.bidder)}`, note: a.deliveryTerms === 1 ? `Sends this winner's tokens and any unspent SOL. The bid repays any rent you front, plus up to ${lamports(a.deliveryReward)}.` : `Sends this winner's tokens and any unspent SOL. You earn ${fmtFee(a.deliveryFeeBps)} of the tokens.` }
          : { step: "refundFor", bidder: b.bidder, label: `Refund ${shortAddr(b.bidder)} (${fmtSol(back)})`, note: back === b.deposit ? "Sends this bid's full deposit back to its bidder. Free apart from the fee." : "Sends this bid's deposit, less the margin's cost, back to its bidder. Free apart from the fee." },
      );
    }
    const lockDone = a.state !== "poolLive" || record?.lpLockState === 3;
    /* L-8 (v0.30, SPEC 3.4): every bid paid out (distributed_count = bid_count), the pool still frozen: anyone may open trading. The keeper sends it too. */
    if (bids.length === 0 && tradingFrozen(launch) && a.distributedCount === a.bidCount) {
      steps.push({ step: "openTrading", label: "Open trading", note: "Every bid is paid out, so this opens the pool for trading. Anyone can send it." });
    }
    /* v0.30 (SPEC 3.6): finalize is refused on a frozen pool (TradingNotOpen); open_trading comes first. */
    if (bids.length === 0 && lockDone && !tradingFrozen(launch)) {
      /* bond_state 1: the pool was opened under 0.21 or earlier and its opener took the whole bond; nothing is left to return. bond_state 3 (0.23): the split step already returned the remainder, and only the held allowance is left. */
      const rest = a.bondState === 1 ? null : a.bondState === 3 ? 0n : a.crankBond - a.opsPaid;
      const end = a.state === "poolLive" ? "Burns the unsold rounding remainder and ends the launch." : "Ends the launch.";
      const left = rest === null ? 0n : rest - ALLOWANCE > 0n ? rest - ALLOWANCE : 0n;
      steps.push({ step: "finalize", label: "Finalize", note: rest === null ? end : left === 0n ? `${end} Pays you ${lamports(ALLOWANCE)} from the operating prepay.` : `${end} Pays you ${lamports(ALLOWANCE)} and returns what is left of the operating prepay, about ${fmtSol(left)}, to the creator.` });
    }
    return { steps, waiting: null };
  }
  /* The eleventh 0.29 candidate: a launch finalized before finish_mint landed can still be named, paid from its metadata reserve. */
  if (a.state === "finalized" && mintHeld) {
    const p = drivePlan([]);
    return { steps: p ? [driveStep(p)] : [], waiting: null };
  }
  return { steps: [], waiting: null };
}

/* The line after a press of the one button: what landed, in how many transactions and prompts. v0.30: the pool is created frozen, so the timing is the open's (openedLine, L-11). The round number is only on the settlement page's working. */
export function doneLine(r: DriveResult, p: DrivePlan | undefined): string {
  const did: string[] = [];
  if (p?.beaconDue) did.push("unsealing key posted");
  if (p && p.sealed > 0) did.push(`${plural(p.sealed, "bid", "bids")} opened`);
  if (p?.settles) did.push("settled");
  if (r.poolAt) did.push("pool created");
  if (p?.finishesMint && r.transactions.some((t) => t.label.includes("finish_mint"))) did.push("token named");
  if (p?.locks && (r.bundledPool || p.kind === "lock" || r.transactions.some((t) => t.label.includes("lock_liquidity")))) did.push("liquidity locked");
  const count = `${plural(r.transactions.length, "transaction", "transactions")}, ${plural(r.prompts, "approval", "approvals")}`;
  /* 24m (Claude L-1): a step proven with no signature lists none. */
  const sigs = r.transactions.filter((t) => t.signature).map((t) => shortAddr(t.signature, 6, 6)).join(", ");
  return `${did.length ? did.join(", ") + ": " : ""}${count}.${sigs ? ` ${sigs}.` : ""}`;
}

/* L-11 (v0.30): after Open trading lands, how long after the bids could be unsealed the pool traded, from SettlementRecord.opened_ts (the thaw), not from the pool. Empty until the record shows the open. */
export function openedLine(openedTs: number | undefined, revealRound: bigint): string {
  return openedTs ? ` Tradable ${Math.max(0, openedTs - bidsOpenAt(revealRound))} s after the bids could be unsealed.` : "";
}

export function DrivePanel({ launch, record: recordProp }: { launch: Launch; record: SettlementRecord | null }) {
  /* The record as the client last read it with the launch (fresh after every step this panel sends), before the page's own copy, which refetches only when the state byte changes and so lagged behind a lock that landed in the same press (seen 2026-10-07). */
  const record = launch.record ?? recordProp;
  const account = useAccount();
  const nowSec = useNowSec(1000);
  const now = useNow(1000);
  const tx = useTx(account.address);
  const a = launch.account;
  const [bump, setBump] = useState(0);
  /* The line for a step this wallet ran, shown to that wallet only (F14). */
  const [done, setDone] = useWalletScoped<string>(account.address);
  const [acting, setActing] = useState<string | null>(null);
  const { bids, failed: bidsFailed, retry: retryBids } = useBidsRead(launch.id, `${a.state}:${a.revealedCount}:${a.distributedCount}:${record?.lpLockState ?? ""}:${bump}`);
  const mintHeld = useMintAuthorityHeld(launch.id, (a.state === "poolLive" || a.state === "finalized") && !a.mintFinished, `${a.state}:${record?.lpLockState ?? ""}:${bump}`);
  if (nowSec == null) return null;
  const { steps, waiting } = plan(launch, record, bids, nowSec, account.address, account.signer, account.cluster?.genesis ?? null, mintHeld === true);
  if (steps.length === 0 && !waiting) return null;

  const run = async (s: Step) => {
    const signer = account.signer;
    if (!signer || account.signProblem) return;
    const key = `${s.step}:${s.bidder ?? ""}`;
    setActing(key);
    setDone(null);
    if (s.step === "drive") {
      const r = await tx.run((onStage) => getClient().drive(launch.id, signer, { onStage }));
      if (r) {
        setDone(doneLine(r, s.plan));
        setBump((n) => n + 1);
      }
    } else {
      const r = await tx.run((onStage) => getClient().push(launch.id, s.step as PushStep, signer, { onStage }, s.bidder));
      if (r) {
        const opened = s.step === "openTrading" ? openedLine((await getClient().getSettlement(launch.id).catch(() => null))?.openedTs, a.revealRound) : "";
        setDone(`${r.signature ? `${s.label}: landed, ${shortAddr(r.signature, 6, 6)}.` : `${s.label}: landed.`}${opened}`);
        setBump((n) => n + 1);
      }
    }
    setActing(null);
  };

  return (
    <section className="panel p-4 md:p-5 mt-4" aria-label="Drive this launch">
      <h2 className="display text-[1.25rem]">Next step</h2>
      <p className="text-text-2 mt-1 leading-snug">{BOARD_LOCAL ? "No crank runs on this test chain: any wallet can run the next step." : "Bouncer's keeper runs these steps. Any wallet can run one sooner."}</p>
      {!account.address && (
        <div className="mt-3">
          <ConnectButton size="full" />
        </div>
      )}
      <ul className="mt-3 flex flex-col gap-3">
        {steps.map((s) => {
          const key = `${s.step}:${s.bidder ?? ""}`;
          const early = s.notBefore != null && nowSec < s.notBefore;
          return (
            <li key={key}>
              <button type="button" className="btn btn-primary w-full" disabled={!account.address || !!account.signProblem || tx.busy || early} onClick={() => run(s)} data-drive={s.step === "drive" ? (early ? "waiting" : "ready") : undefined}>
                {acting === key && tx.stage ? stageLabel(tx.stage, now) : early ? `Bids open in ${fmtCountdown((s.notBefore! - nowSec) * 1000)}` : s.label}
              </button>
              <p className="text-text-3 mt-1 leading-snug">
                {early ? (s.sealedNote ? `Sealed until ${fmtTime(bidsOpenAt(a.revealRound))}. ${s.sealedNote}` : `Sealed until ${fmtTime(bidsOpenAt(a.revealRound))}. One press then ${s.note.charAt(0).toLowerCase()}${s.note.slice(1)}`) : s.note}
                {s.stepInfo && (
                  <>
                    {" "}
                    <Info text={s.stepInfo} label={STEP_INFO_LABEL} />
                  </>
                )}
                {s.deadline && (
                  <>
                    {" "}
                    <Info text={s.deadline} label={DEADLINE_INFO_LABEL} />
                  </>
                )}
              </p>
            </li>
          );
        })}
      </ul>
      {/* A failed read of the bids says so, never a wait that does not end (F14). */}
      {waiting && bids === null && bidsFailed ? <ReadFailed what="The bids" onRetry={retryBids} className="mt-3" /> : waiting && <p className="text-text-2 mt-3 leading-snug">{waiting}</p>}
      <StageLine stage={tx.stage} />
      <FailureNote failure={tx.failure} />
      {done && (
        <p className="text-text mt-3 leading-snug" data-drive-done>
          {done}
        </p>
      )}
      {account.signProblem && <p className="text-text-2 mt-2 leading-snug">{account.signProblem}</p>}
    </section>
  );
}
