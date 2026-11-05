"use client";

import type { ReactNode } from "react";
import { Info } from "@/components/ui/Info";
import { solExact } from "@/lib/bouncer/amountInput";
import { commitFee } from "@/lib/bouncer/terms";
import type { Launch } from "@/lib/bouncer/types";

/*
  What leaves the wallet when the bid is signed, and what comes back in
  each outcome (the founder, 2026-10-07: "Cost summary before signing a bid:
  build it ... Keep it tight; this is the one with money in it"). the founder,
  2026-10-08: the amount typed is the whole of what is sent, and the costs
  come out of it ("if someone bids 2 sol, they should have any fees taken
  out of that 2 sol"), so the box reads from the top: you send this; of it,
  this much is the deposit, this the processing charge, this the bid
  account's rent (back when it closes), this the network fee. Every figure
  is exact lamports as SOL: the amount as typed; the processing charge from
  the launch (0.29, the ceiling the commit carries, terms.ts); the bid account's rent
  read from the cluster (never typed in; the win line names no token
  account figure since the founder's row 9, 2026-10-23); the one signature's fee, fixed by the explicit compute budget.
  What comes back follows INTERFACE 0.27: a claim or a refund returns the
  whole bid account; a pushed delivery on a launch created by 0.26 is repaid
  the token account rent it fronted plus the launch's reward out of the bid
  account, and on an older launch takes its fee in tokens; the charge goes
  to whoever processes the bid and comes back only if nobody did.
*/


/* 24g (the founder's pick, 2026-10-25; review/2026-10-25-priority-fee-mock, files 4 to 6): one network fee line, the (i) only while it includes the final 90 seconds' priority fee. */
export const PRIORITY_FEE_TIP = "Includes a priority fee in the final 90 seconds, so your bid reaches the chain before the close.";

export function CostSummary({ launch, sent, deposit, bidRent, priority = 0n }: { launch: Launch; sent: bigint; deposit: bigint; bidRent: bigint; priority?: bigint }) {
  const a = launch.account;
  const sym = launch.token.symbol;
  /* A lost, invalid or refunded bid: the deposit and the rent; the charge too when nobody processed it. */
  const back = deposit + bidRent;
  return (
    <div className="mb-3 rounded-[10px] border border-line p-3" data-cost-summary>
      <dl className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-1">
        <Row label="You send" value={solExact(sent)} strong />
        <Row label="Deposit" value={solExact(deposit)} />
      </dl>
      <details className="mt-2" data-fees-details>
        <summary className="cursor-pointer min-h-11 py-2 font-medium">Fees &amp; details</summary>
        <dl className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-1">
        <Row label="Processing charge" value={solExact(a.processingCharge)} />
        <Row label="Account setup" value={solExact(bidRent)} />
        {/* 0.29: a gated launch's bot check rides in the transaction as a second signature, charged like the first; 24g: one line for the whole fee, the priority fee included in the last 90 seconds. */}
        <Row
          label={
            priority > 0n ? (
              <>
                Network fee <Info text={PRIORITY_FEE_TIP} label="About the network fee" />
              </>
            ) : (
              "Network fee"
            )
          }
          value={solExact(commitFee(a) + priority)}
        />
      </dl>
      <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 leading-snug" data-cost-outcomes>
        <dt className="text-text-3">Win</dt>
        <dd>
          {sym}, plus unspent SOL back.
        </dd>
        <dt className="text-text-3">Lose</dt>
        <dd>
          <span className="num">{solExact(back)}</span> back.
        </dd>
        <dt className="text-text-3">No pool</dt>
        <dd>
          <span className="num">{solExact(back)}</span> back.
        </dd>
      </dl>
      </details>
    </div>
  );
}

function Row({ label, value, strong = false }: { label: ReactNode; value: string; strong?: boolean }) {
  return (
    <>
      <dt className={strong ? "font-semibold pb-1 border-b border-line" : "text-text-3"}>{label}</dt>
      <dd className={`num text-right ${strong ? "font-semibold pb-1 border-b border-line" : ""}`}>{value}</dd>
    </>
  );
}
