"use client";

import { useEffect, useState } from "react";
import { PublicKey } from "@solana/web3.js";
import { FailureNote, StageLine, stageLabel, useTx } from "@/components/tx/TxState";
import { useAccount } from "@/components/wallet/AccountProvider";
import { getClient } from "@/lib/bouncer/client";
import { TOKEN_ACCOUNT_BYTES } from "@/lib/bouncer/chain/creatorFees";
import { needsTokenAccount, readTokenTarget } from "@/lib/bouncer/chain/parked";
import { mintPda } from "@/lib/bouncer/chain/pda";
import { explorerUrl, getConnection } from "@/lib/bouncer/chain/rpc";
import { fmtSolPrecise, fmtTokens, shortAddr } from "@/lib/bouncer/format";
import { useNow, useRent } from "@/lib/bouncer/hooks";
import { setParkedReceipt, useParkedReceipt, type ParkedReceipt } from "@/lib/bouncer/parkedReceipt";
import type { BidAccount, Launch } from "@/lib/bouncer/types";

/*
  v0.32: the Collect control for a parked payout, as the founder approved it on 2026-10-29 (review/2026-10-29-v032/mocks: p7
  and p8 the winner, p2 a refund on a launch that sold, p4 a refund on a failed launch). The held line, one button with
  the amount, the fee line, and after the collect the "Collected" line with its signature. The caller shows the lines
  above it (the winner box's own, or the refund's figure).

  the founder's call B: the fee line names a token account's rent only when the wallet needs one, read from the wallet's own
  associated address for the mint (chain/parked.ts); a read that has not answered keeps the mock's "if your wallet
  needs one". One read, for this wallet only, and only while a payout is held for it.
*/
export const NETWORK_FEE = 5_000n;

/*
  the founder's call B (2026-10-29): a winner's line names the token account's rent only when the wallet needs one (target
  read: needs); while the read has not answered (null), the mock's own "if your wallet needs one". A fresh account's
  keypair signs too, so its fee is two signatures'. A refund pays nothing but the fee.
*/
export function parkedFeeLine(winner: boolean, target: { needs: boolean; fresh: boolean } | null, rent: bigint | null): string {
  const fee = fmtSolPrecise(NETWORK_FEE * (target?.fresh ? 2n : 1n));
  if (!winner) return `Paid to this wallet. Network fee ${fee}.`;
  if (target && !target.needs) return `Network fee ${fee}.`;
  if (target && rent !== null) return `Network fee ${fee}, plus ${fmtSolPrecise(rent)} for a token account.`;
  return `Network fee ${fee}, plus ${rent !== null ? fmtSolPrecise(rent) : "the rent"} for a token account if your wallet needs one.`;
}

export function ParkedCollect({ launch, bid, variant }: { launch: Launch; bid: BidAccount; variant: "winner" | "refund" | "failed" }) {
  const account = useAccount();
  const address = account.address;
  const tx = useTx(address);
  const now = useNow(1000);
  const receipt = useParkedReceipt(launch.id, address);
  const held = bid.parked ?? { tokens: 0n, lamports: 0n };
  const sym = launch.token.symbol;
  const d = launch.token.decimals;
  const rent = useRent(TOKEN_ACCOUNT_BYTES);
  /* The wallet's token account for the mint: null until read, then whether the collect makes one (and so signs twice when it makes a fresh one). */
  const [target, setTarget] = useState<{ address: string; needs: boolean; fresh: boolean } | null>(null);
  const mine = !!address && address === bid.bidder;

  useEffect(() => {
    if (!mine || !address || variant !== "winner" || held.tokens === 0n) return;
    let live = true;
    const mint = mintPda(new PublicKey(launch.account.creator), launch.account.mintSalt);
    readTokenTarget(getConnection(), new PublicKey(address), mint, held.tokens)
      .then((t) => live && setTarget({ address, needs: needsTokenAccount(t), fresh: t.kind === "fresh" }))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [mine, address, variant, held.tokens, launch.account.creator, launch.account.mintSalt]);

  if (receipt) return <ParkedCollected launch={launch} receipt={receipt} />;
  if (!mine) return null;

  const collect = async () => {
    const signer = account.signer;
    if (!signer || account.signProblem || !address) return;
    const r = await tx.run((onStage) => getClient().collectParked(launch.id, signer, { onStage }));
    if (!r) return;
    setParkedReceipt(launch.id, address, { signature: r.signature, tokens: r.tokens, lamports: r.lamports });
    void getClient().refreshLaunch(launch.id, { minSlot: r.slot, test: (l) => (l.account.parkedCount ?? 0) < (launch.account.parkedCount ?? 0) });
  };

  const winner = variant === "winner" && held.tokens > 0n;
  const ready = !!target && target.address === address;
  const feeLine = parkedFeeLine(winner, ready ? { needs: target.needs, fresh: target.fresh } : null, rent);
  const idle = winner ? `Collect ${fmtTokens(held.tokens, d)} ${sym}` : `Collect ${fmtSolPrecise(held.lamports)}`;

  return (
    <div data-parked-collect>
      <p className="text-text-2 mt-2 leading-snug">
        {winner
          ? held.lamports > 0n
            ? `Your tokens couldn't be sent to your wallet, so they're held for you, with ${fmtSolPrecise(held.lamports)} back.`
            : "Your tokens couldn't be sent to your wallet, so they're held for you."
          : "It couldn't be delivered, so it's held for you."}
      </p>
      <button type="button" className={`btn btn-primary w-full ${variant === "failed" ? "mt-4 text-[1.125rem]" : "mt-3"}`} disabled={tx.busy || !!account.signProblem || !account.signer} onClick={collect} data-parked-collect-button>
        {tx.stage ? stageLabel(tx.stage, now) : idle}
      </button>
      <StageLine stage={tx.stage} />
      <FailureNote failure={tx.failure} onRetry={collect} />
      {account.signProblem && <p className="text-text-2 mt-2 leading-snug">{account.signProblem}</p>}
      <p className="text-text-3 mt-2 leading-snug" data-parked-fee>
        {feeLine}
      </p>
    </div>
  );
}

/* After a collect this page made (p8): what came out, with its signature. */
export function ParkedCollected({ launch, receipt }: { launch: Launch; receipt: ParkedReceipt }) {
  const sol = fmtSolPrecise(receipt.lamports);
  return (
    <p className="text-text mt-2 leading-snug" data-parked-collected>
      {receipt.tokens > 0n ? `Collected ${fmtTokens(receipt.tokens, launch.token.decimals)} ${launch.token.symbol} and ${sol}.` : `Collected ${sol}.`}{" "}
      {receipt.signature && (
        <>
          <a href={explorerUrl("tx", receipt.signature)} target="_blank" rel="noreferrer" className="link-accent">
            Solscan
          </a>
          <span className="text-text-3"> {shortAddr(receipt.signature, 6, 6)}</span>
        </>
      )}
    </p>
  );
}
