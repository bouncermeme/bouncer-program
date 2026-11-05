"use client";

import { useState } from "react";
import { EXTERNAL, INTERFACE_VERSION, POOL_RESERVE, TOKEN_DECIMALS } from "@contract/constants";
import { Sheet } from "@/components/ui/Sheet";
import { useAccount } from "@/components/wallet/AccountProvider";
import { bidsOpenAt } from "@/lib/bouncer/beacon";
import { explorerUrl } from "@/lib/bouncer/chain/rpc";
import { solExact } from "@/lib/bouncer/amountInput";
import { fmtDuration, fmtPct, fmtSol, fmtTime, fmtTokens, shortAddr } from "@/lib/bouncer/format";
import { useLeastSent, useRent } from "@/lib/bouncer/hooks";
import { bpsPct, burnSplitText, fmtVolumePct, onV030Pool, POOL_SWAP_FEE_BPS, pushCostText, raiseFeeTermsRow, tradingFeeSplit } from "@/lib/bouncer/product";
import { V030 } from "@/lib/bouncer/v030";
import { Info } from "@/components/ui/Info";
import type { Launch } from "@/lib/bouncer/types";
import { useCapRate } from "@/lib/bouncer/solPrice";
import { fmtCap } from "@/lib/bouncer/usdCap";
import { anyMayStay, launchFeeMayStay, mcapAtTick, totalSupply } from "@/lib/bouncer/view";
import { PROGRAM_ID, DEPLOYMENT as deployment } from "@contract/active";

/*
  What a bidder can check before signing, beside the sentence above the bid
  button (the manager's brief, 2026-09-27): supply, allocation, decimals,
  the metadata commitment, the auction's parameters, the pool's config,
  fees and what happened to each authority. Every value is this launch's
  account or the pinned generated contract (site/contract/, the 0.28
  pin); where the pinned build has no such thing, the row says so rather
  than borrowing it from a later interface. No claims, only values and
  where to check them.
*/
export function VerifyCommitment({ launch }: { launch: Launch }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className="link shrink-0" onClick={() => setOpen(true)}>
        Verify commitment
      </button>
      <Sheet open={open} onClose={() => setOpen(false)} title="Verify commitment">
        <Body launch={launch} />
      </Sheet>
    </>
  );
}

function Body({ launch }: { launch: Launch }) {
  const capRate = useCapRate(null);
  const { cluster } = useAccount();
  const a = launch.account;
  /* The amount to send, beside the chain's own figure, since this sheet names what is on chain (the founder, 2026-10-08). */
  const least = useLeastSent(a.minBid, a);
  /* The rent of an empty account: whether a raise fee part is sure to be paid (view.ts, raiseFeeMayStay). */
  const rentEmpty = useRent(0);
  const d = launch.token.decimals;
  const sym = launch.token.symbol;
  const supply = totalSupply(a);
  const creator = supply - a.float - POOL_RESERVE;
  const creatorLp = a.creatorLpBps / 10_000;
  const split = tradingFeeSplit(a.creatorLpBps);
  return (
    <div className="flex flex-col gap-5 text-text-2">
      <p className="leading-snug">
        Read from this launch&apos;s account and the program interface this site is pinned to (v{INTERFACE_VERSION}). Each can be checked on an explorer.
      </p>

      <Group title="Token">
        <Row k="Supply" v={`${fmtTokens(supply, d)} ${sym}`} />
        <Row k="Decimals" v={`${d}${d === TOKEN_DECIMALS ? "" : `, the pin says ${TOKEN_DECIMALS}`}`} />
        <Row k="For sale" v={`${fmtTokens(a.float, d)} (${fmtPct(Number(a.float) / Number(supply), 0)} of supply)`} />
        <Row k="Pool reserve" v={`${fmtTokens(POOL_RESERVE, d)} (${fmtPct(Number(POOL_RESERVE) / Number(supply), 0)})`} />
        <Row k="Creator allocation" v={fmtTokens(creator, d)} />
        <Row k="Name, ticker" v={`${launch.token.name}, ${sym}`} />
        <Row
          k="Metadata commitment"
          v={a.meta ? `fixed in the launch account at creation: "${a.meta.name}", ${a.meta.symbol}${a.meta.uri ? `, ${a.meta.uri}` : ", no image link"}. Written to Metaplex metadata when the pool opens.` : "this launch predates v0.19: its name and ticker were written to Metaplex metadata at creation"}
        />
      </Group>

      <Group title="Auction">
        <Row k="Needs to launch" v={`${fmtSol(a.floorValue)} in deposits by close (floor_value, on chain)`} />
        <Row k="Minimum market cap" v={capRate.rate ? `about ${fmtCap(mcapAtTick(a, 0), capRate.rate.usdPerSol)} at today's SOL price` : "price unavailable"} />
        <Row k="Minimum bid" v={`${least !== null ? solExact(least) : "…"} to send (min_bid ${solExact(a.minBid)} on chain)`} />
        <Row k="Window" v={fmtDuration(a.windowSecs)} />
        <Row k="Sealed until" v={fmtTime(bidsOpenAt(a.revealRound))} />
        <Row k="Abort after" v={fmtDuration(a.abortAfterSecs)} />
      </Group>

      <Group title="Pool">
        <Row k="Meteora config" v={<Ext id={EXTERNAL.meteoraConfig} kind="account">{shortAddr(EXTERNAL.meteoraConfig, 4, 4)}, public, {bpsPct(POOL_SWAP_FEE_BPS)} flat fee in SOL, full range</Ext>} />
        <Row k="Pool program" v={<Ext id={EXTERNAL.meteoraCpAmm} kind="account">Meteora DAMM v2 {shortAddr(EXTERNAL.meteoraCpAmm, 4, 4)}</Ext>} />
        {/* B-5 (the founder, 2026-10-27): per-trade shares with the burn, on the 0.30 pool terms. */}
        <Row k="Liquidity" v={onV030Pool(launch) ? `Locked; the creator's position earns ${fmtVolumePct(split.creatorPct)} of every trade, the platform's ${fmtVolumePct(split.bouncerPct)} (${burnSplitText(split.bouncerPct)}).` : `locked, ${fmtPct(creatorLp, 0)} to the creator's position, ${fmtPct(1 - creatorLp, 0)} to the platform's`} />
      </Group>

      <Group title="Fees">
        {/* B-6 (the founder, 2026-10-27): the first sentence shown, the rent sentence behind an (i). */}
        <Row
          k="Delivery"
          v={
            V030 ? (
              <>
                every winner&apos;s tokens are sent automatically. <Info label="About delivery" text={`The sender is repaid ${fmtSol(a.deliveryReward)} from your bid's rent; no tokens are taken.`} />
              </>
            ) : (
              `pushed: ${pushCostText(a)}; claiming is free`
            )
          }
        />
        <Row k="Operating prepay" v={`${fmtSol(a.crankBond)}, posted by the creator; ${fmtSol(a.opsPaid)} paid out so far, the rest returns to the creator`} />
        {/* 0.28: the launch's own raise fee terms (Launch 8832, 8834), out of the proceeds; the bid cost is unchanged. */}
        {a.raiseFeeBps > 0 && <Row k="Raise fee" v={raiseFeeTermsRow(a.raiseFeeBps, a.raiseFeeCreatorShareBps, false, anyMayStay(launchFeeMayStay(a, null, rentEmpty)))} />}
      </Group>

      <Group title="Authorities">
        {/* Copy fix row 1 (2026-10-31): since v0.30 the freeze authority holds until trading opens, as /how, /faq and the whitepaper say. The old words stay for a pre-0.30 build. */}
        <Row k="Mint" v={V030 ? "mint authority revoked once the pool is created; freeze authority revoked forever when trading opens (the pinned interface)" : "mint authority revoked when the mint is created, no freeze authority (the pinned interface)"} />
        <Row k="Program" v={<Ext id={PROGRAM_ID} kind="account">{shortAddr(PROGRAM_ID, 4, 4)}</Ext>} />
        <Row k="Upgrade authority" v={<Ext id={deployment.upgrade_authority} kind="account">{shortAddr(deployment.upgrade_authority, 4, 4)}</Ext>} />
        <Row
          k="Deployed bytes"
          v={`sha256 ${deployment.on_chain.sha256.slice(0, 12)}, ${cluster === null ? "being checked on this RPC" : cluster.bytes === "match" ? `matched on this RPC at ${new Date(cluster.checkedAt).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}, its deploy slot read again before each send` : cluster.bytes === "mismatch" ? "NOT matched on this RPC" : "not checked on this RPC"}`}
        />
      </Group>
    </div>
  );
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h3 className="font-semibold text-text mb-2">{title}</h3>
      <dl className="flex flex-col gap-1.5">{children}</dl>
    </section>
  );
}

function Row({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[9.5rem_1fr] gap-3 items-baseline">
      <dt className="text-text-3">{k}</dt>
      <dd className="num leading-snug wrap-any">{v}</dd>
    </div>
  );
}

function Ext({ id, kind, children }: { id: string; kind: "account" | "token"; children: React.ReactNode }) {
  return (
    <a href={explorerUrl(kind, id)} target="_blank" rel="noreferrer" className="mono link">
      {children}
    </a>
  );
}
