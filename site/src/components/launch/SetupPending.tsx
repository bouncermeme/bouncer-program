"use client";

import { ACCOUNTS, HISTOGRAM_INIT_LEN } from "@contract/constants";
import { useAccount } from "@/components/wallet/AccountProvider";
import { FailureNote, StageLine, stageLabel, useTx } from "@/components/tx/TxState";
import { getClient } from "@/lib/bouncer/client";
import { fmtSol } from "@/lib/bouncer/format";
import { useNow, useRent } from "@/lib/bouncer/hooks";
import type { Launch } from "@/lib/bouncer/types";

/*
  0.29: a launch whose create landed without its second step
  (grow_histogram; docs/V029-DESIGN-2026-10-20.md section 11), state
  Initializing (7) since the seventh candidate. The create page sends both
  in one transaction, so this comes only from a create sent some other way
  (with its own creation permit). Commit refuses HistogramNotReady (6071)
  until the step lands, so the page offers no bid; the creator can finish it
  here while the window runs, paying the rest of the histogram's rent.
  Everyone else is told what it waits for. LaunchView shows this only inside
  the window (view.ts, setupFinishable).
*/
export function SetupPending({ launch }: { launch: Launch }) {
  const account = useAccount();
  const now = useNow(1000);
  const tx = useTx(account.address);
  const full = useRent(ACCOUNTS.Histogram.len);
  const first = useRent(HISTOGRAM_INIT_LEN);
  const rest = full !== null && first !== null ? full - first : null;
  const isCreator = account.address === launch.account.creator;

  async function finish() {
    const signer = account.signer;
    if (!signer) return;
    await tx.run((onStage) => getClient().finishSetup(launch.id, signer, { onStage }));
  }

  return (
    <div className="inset p-4 mt-4" data-setup-pending>
      <p className="font-semibold text-text">Finishing setup.</p>
      <p className="text-text-2 mt-1 leading-snug">No bids until the creator&apos;s second setup step lands. The window is already running.</p>
      {isCreator && (
        <>
          <p className="text-text-2 mt-2 leading-snug" data-setup-rest={rest?.toString() ?? ""}>
            Your launch was created without its second step. Finish it to open bidding: {rest !== null ? <span className="num text-text">{fmtSol(rest)}</span> : "the rest of the launch cost"} more, kept on chain for good, not refunded.
          </p>
          <button type="button" className="btn btn-primary w-full mt-3" disabled={tx.busy || !account.signer || !!account.signProblem} onClick={finish}>
            {tx.busy && tx.stage ? stageLabel(tx.stage, now) : "Finish setup"}
          </button>
          <StageLine stage={tx.stage} />
          {account.signProblem && <p className="mt-2 text-text-2 leading-snug">{account.signProblem}</p>}
          <FailureNote failure={tx.failure} onRetry={finish} />
        </>
      )}
    </div>
  );
}
