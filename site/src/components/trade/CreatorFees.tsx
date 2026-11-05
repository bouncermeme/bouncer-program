"use client";

import { useCallback, useEffect, useState } from "react";
import { PublicKey } from "@solana/web3.js";
import { FailureNote, StageLine, stageLabel, useTx } from "@/components/tx/TxState";
import { ReadFailed } from "@/components/ui/ReadFailed";
import { useAccount } from "@/components/wallet/AccountProvider";
import { CLAIM_NETWORK_FEE, claimCreatorFees, readCreatorFees, type CreatorFees as Fees } from "@/lib/bouncer/chain/creatorFees";
import { explorerUrl, getConnection } from "@/lib/bouncer/chain/rpc";
import { fmtSolPrecise, shortAddr } from "@/lib/bouncer/format";
import { useNow, useWalletScoped } from "@/lib/bouncer/hooks";
import type { Launch, SettlementRecord } from "@/lib/bouncer/types";

/*
  The creator's trading fees on the trade page (the founder, 2026-10-14). Shown only
  when the connected wallet is the launch's creator (Launch.creator) and holds
  the creator's position NFT, once lock_liquidity has split the creator's
  position off (lp_lock_state bit 0). Anyone else gets nothing, and no read is
  made for them. One click claims the position's fees from Meteora and
  unwraps them to SOL in the same transaction (chain/creatorFees.ts). The
  record is the launch's own, read with the launch on every poll, so the
  card appears once the lock lands without a reload (useSettlement's copy is
  keyed by state, which the lock does not change).
*/
const READ_EVERY_MS = 20_000;
/* Lock state bit 0: the creator's position exists (lib.rs LOCK_BIT_CREATOR). */
const LOCK_BIT_CREATOR = 1;

export function CreatorFees({ launch, record }: { launch: Launch; record: SettlementRecord }) {
  const account = useAccount();
  const address = account.address;
  const tx = useTx(address);
  const now = useNow(1000);
  const rec = launch.record ?? record;
  const nft = rec.creatorLockNft;
  const pool = rec.pool;
  const eligible = !!address && address === launch.account.creator && (rec.lpLockState & LOCK_BIT_CREATOR) !== 0 && nft !== null && pool !== null;
  /* The last good read and whether the latest failed, both kept per wallet (F14): another wallet's never shows. */
  const [fees, setFees] = useWalletScoped<Fees>(address);
  const [failed, setFailed] = useWalletScoped<true>(address);
  const [done, setDone] = useWalletScoped<{ text: string; signature: string }>(address);
  /* After a claim lands the figure on screen is the old one: the button waits for a read made after it. */
  const [claimedAt, setClaimedAt] = useWalletScoped<number>(address);
  const [bump, setBump] = useState(0);

  const read = useCallback(async (): Promise<Fees | null> => {
    if (!eligible || !address || !nft || !pool) return null;
    return readCreatorFees(getConnection(), { owner: new PublicKey(address), pool: new PublicKey(pool), nftMint: new PublicKey(nft), tokenMint: new PublicKey(launch.token.mint) });
  }, [eligible, address, nft, pool, launch.token.mint]);

  useEffect(() => {
    if (!eligible) return;
    let live = true;
    const once = () =>
      read()
        .then((f) => {
          if (!live) return;
          setFees(f);
          setFailed(null);
        })
        .catch(() => live && setFailed(true));
    once();
    const t = setInterval(once, READ_EVERY_MS);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [eligible, read, bump, setFees, setFailed]);

  if (!eligible) return null;
  /* Until the first read answers, nothing: a creator who no longer holds the NFT never sees a card appear and vanish. */
  if (!fees)
    return failed ? (
      <section className="panel p-4 md:p-5 mt-4" data-creator-fees-failed>
        <ReadFailed what="Your trading fees" onRetry={() => setBump((n) => n + 1)} />
      </section>
    ) : null;
  if (!fees.holds) return null;

  const worth = fees.unclaimed > CLAIM_NETWORK_FEE;
  const fresh = claimedAt === null || fees.readAt > claimedAt;
  const can = worth && fresh && !!account.signer && !account.signProblem && !tx.busy;
  const claim = async () => {
    const signer = account.signer;
    if (!signer || account.signProblem) return;
    setDone(null);
    const r = await tx.run((onStage) => claimCreatorFees(getConnection(), fees, signer, { onStage }));
    if (!r) return;
    setClaimedAt(Date.now());
    const text = r.claimed !== null ? `Collected ${fmtSolPrecise(r.claimed)}.` : "Collected.";
    setDone({ text: r.unwrapped > 0n ? `${text} Also unwrapped ${fmtSolPrecise(r.unwrapped)} that was already wrapped.` : text, signature: r.signature });
    setBump((n) => n + 1);
  };

  return (
    <section className="panel p-4 md:p-5 mt-4" aria-label="Your trading fees" data-creator-fees>
      <p className="text-text-3">Your trading fees</p>
      <p className="figure text-[1.75rem] leading-tight mt-1 wrap-any" data-creator-fees-unclaimed={fees.unclaimed.toString()}>
        {fmtSolPrecise(fees.unclaimed)} <span className="text-text-2 font-sans text-[1rem]">to collect</span>
      </p>
      {fees.wrapped > 0n && (
        <p className="text-text-2 mt-1 leading-snug" data-creator-fees-wrapped={fees.wrapped.toString()}>
          Also unwraps {fmtSolPrecise(fees.wrapped)} already in this wallet as wrapped SOL.
        </p>
      )}
      <button type="button" className="btn btn-primary w-full mt-3" disabled={!can} onClick={claim} data-claim-fees>
        {tx.stage ? stageLabel(tx.stage, now) : !fresh ? "Reading the position" : worth ? `Collect ${fmtSolPrecise(fees.unclaimed)}` : "Nothing to collect yet"}
      </button>
      <StageLine stage={tx.stage} />
      <FailureNote failure={tx.failure} onRetry={() => tx.reset()} />
      {done && (
        <p className="text-text mt-3 leading-snug" data-creator-fees-done>
          {done.text}{" "}
          {/* 24m (Claude L-1): a result proven with no signature has no link to give. */}
          {done.signature && (
            <>
              <a href={explorerUrl("tx", done.signature)} target="_blank" rel="noreferrer" className="link-accent">
                Solscan
              </a>
              <span className="text-text-3"> {shortAddr(done.signature, 6, 6)}</span>
            </>
          )}
        </p>
      )}
      {account.signProblem && <p className="text-text-2 mt-2 leading-snug">{account.signProblem}</p>}
      <p className="text-text-3 mt-2 leading-snug">Paid to this wallet as SOL. Network fee {fmtSolPrecise(CLAIM_NETWORK_FEE)}.</p>
    </section>
  );
}
