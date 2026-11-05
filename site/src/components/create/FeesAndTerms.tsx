"use client";

import { Cap } from "@/components/ui/Cap";
import { useCapRate } from "@/lib/bouncer/solPrice";
import { fmtSol, shortAddr, solApprox } from "@/lib/bouncer/format";
import { explorerUrl } from "@/lib/bouncer/chain/rpc";
import { useConfigLive, useLeastSent, useRent, useSetupCost } from "@/lib/bouncer/hooks";
import { bpsPct, burnSplitText, floorMcap, fmtVolumePct, NEW_LAUNCH_PUSH, PRODUCT, raiseFeeOpensText, tradingFeeSplit } from "@/lib/bouncer/product";
import { V030 } from "@/lib/bouncer/v030";
import { anyMayStay, raiseFeeMayStayAtFloor } from "@/lib/bouncer/view";
import { CREATE_FEE } from "@/lib/bouncer/terms";
import { INTERFACE_VERSION } from "@contract/constants";
import { PIN } from "@/lib/bouncer/chain/cluster";
import { PROGRAM_ID, DEPLOYMENT as deployment } from "@contract/active";

/*
  Every rule and fee a launch carries, read from the program's config. This
  was the side panel of the create page ("What every launch gets") until the
  copy pass of 2026-10-02 (the founder: "way too much text"); it moved here word for
  word, and the create page keeps three figures and a link. Nothing here is a
  number the site made up.
*/
export function FeesAndTerms() {
  const capRate = useCapRate(null);
  const { config, failed: configFailed } = useConfigLive();
  /* "Minimum bid" is the amount a bidder sends, the costs inside it (the founder, 2026-10-08; hooks.useLeastSent). */
  const least = useLeastSent(config?.minBid ?? null, config ? { processingCharge: config.processingCharge, attestRequired: config.attestBids } : null);
  /* Whether a raise fee part could stay in the pool, judged at the config's floor (view.ts, raiseFeeMayStayAtFloor). */
  const rentEmpty = useRent(0);
  const feeMayStay = config ? anyMayStay(raiseFeeMayStayAtFloor(config.floorValue, config.raiseFeeBps, config.raiseFeeCreatorShareBps, rentEmpty)) : true;
  /* The trading fee shares in percent of volume (product.ts, tradingFeeSplit; the founder's items 10 and 16, 2026-10-16). */
  const split = config ? tradingFeeSplit(config.creatorLpBps) : null;
  /* 0.29: the launch cost, rent kept on chain for good (product.ts, setupCost). */
  const setup = useSetupCost();
  return (
    <div className="pt-8 md:pt-14 max-w-[72ch]">
      <h1 className="display text-[1.75rem] md:text-[2rem] leading-tight mb-4">Fees and terms</h1>
      <div className="panel-2 p-4 md:p-5">
      <ul className="mt-4 flex flex-col gap-3">
        <Guarantee>
          {config && config.raiseFeeBps > 0 ? (
            <>1B tokens: half sold in the auction, half into the pool with {feeMayStay ? "at least " : ""}{bpsPct(10_000 - config.raiseFeeBps)} of the raise. You get {bpsPct((config.raiseFeeBps * config.raiseFeeCreatorShareBps) / 10_000)} of the raise in SOL when the pool is created; Bouncer {bpsPct((config.raiseFeeBps * (10_000 - config.raiseFeeCreatorShareBps)) / 10_000)}. {raiseFeeOpensText(config.raiseFeeBps, feeMayStay)}</>
          ) : (
            <>1B tokens: half sold in the auction, half into the pool.</>
          )}
        </Guarantee>
        <Guarantee>One price for everyone. Highest max bids fill first; the rest get their SOL back.</Guarantee>
        <Guarantee>
          {/* P-2 (the founder, 2026-10-27; SHIPS WITH v0.30, the burn). Before it, "collected" (D1). */}
          {split ? (
            V030 ? (
              <>Every swap pays the pool&apos;s {fmtVolumePct(split.creatorPct + split.bouncerPct + split.meteoraPct)} fee; Meteora keeps {fmtVolumePct(split.meteoraPct)} of volume, you earn {fmtVolumePct(split.creatorPct)} of all trading volume and Bouncer {fmtVolumePct(split.bouncerPct)} ({burnSplitText(split.bouncerPct)}). You collect yours any time on your launch&apos;s trade page.</>
            ) : (
              <>Every swap pays the pool&apos;s {fmtVolumePct(split.creatorPct + split.bouncerPct + split.meteoraPct)} fee; Meteora keeps {fmtVolumePct(split.meteoraPct)} of volume, you earn {fmtVolumePct(split.creatorPct)} of all trading volume and Bouncer {fmtVolumePct(split.bouncerPct)}, collected any time on your launch&apos;s trade page.</>
            )
          ) : null}
        </Guarantee>
        <li className="leading-snug text-text" data-fees-floor>Needs {config ? fmtSol(config.floorValue) : "its floor"} by close, or all refundable.</li>
        {/* 24j (the founder, 2026-10-25, on the front-end audit): "You hold nothing: no allocation, no mint authority." cut. 24k (the founder): "labeled creator". */}
        <Guarantee>Your own bid is labeled creator.</Guarantee>
        {/* P-3, with v0.30. */}
        <Guarantee>{V030 ? "Refunds are free" : "Claims and refunds are free"}; delivery costs {fmtSol(NEW_LAUNCH_PUSH.deliveryReward)}.</Guarantee>
      </ul>
      <dl className="hairline mt-5 pt-4 flex flex-col gap-3">
        <Fixed
          k="Minimum market cap"
          v={
            config ? (
              <>
                <Cap lamports={floorMcap(config.floorValue)} rate={capRate.rate} status={capRate.status} /> at today&apos;s SOL price.
              </>
            ) : (
              <Reading failed={configFailed} />
            )
          }
        />
        <Fixed k="Minimum bid" v={least !== null ? `${solApprox(least)} SOL` : <Reading failed={configFailed} />} />
        <Fixed
          k="Launch cost"
          v={
            setup ? (
              <>
                {fmtSol(setup.total)}, one time, not refunded
              </>
            ) : (
              <span className="text-text-3">Reading the rent</span>
            )
          }
        />
        <Fixed
          k="Cost to you"
          v={
            config ? (
              <>
                About {setup ? (Number(setup.total + config.crankBond + CREATE_FEE) / 1e9).toFixed(2) : "…"} SOL to launch, some comes back. You earn {bpsPct((config.raiseFeeBps * config.raiseFeeCreatorShareBps) / 10_000)} of the raise + {fmtVolumePct(tradingFeeSplit(config.creatorLpBps).creatorPct)} of all trading volume</>
            ) : (
              <Reading failed={configFailed} />
            )
          }
        />
        <Fixed
          k="Limits"
          v={
            config ? (
              <>
                No limits.</>
            ) : (
              <Reading failed={configFailed} />
            )
          }
        />
        {/* Copy fix C1 (2026-10-31): no figure. Measured: 37 s with 25 bids (FIN1), 154 s with 1,000 bids. */}
        <Fixed k="Settlement" v="Usually within minutes of close" />
        <Fixed
          k="Program"
          v={
            <>
              {PRODUCT.cluster}, <a href={explorerUrl("account", PROGRAM_ID)} target="_blank" rel="noreferrer" className="mono link">{shortAddr(PROGRAM_ID, 4, 4)}</a>, build {INTERFACE_VERSION} (sha256 <span className="mono">{deployment.on_chain.sha256.slice(0, 8)}</span>),{" "}
              {PIN.pending ? (
                <>not deployed yet; nothing is signed until it is</>
              ) : (
                <>
                  deployed in slot <span className="num">{Number(deployment.deployed_in_slot).toLocaleString("en-US")}</span>
                </>
              )}
            </>
          }
        />
      </dl>
      </div>
    </div>
  );
}

/* While the config is read; after a failed read, says so (F14: never a wait that does not end). useConfigLive reads again every 30 s. */
export function Reading({ failed = false }: { failed?: boolean }) {
  return <span className="text-text-3">{failed ? "Not read just now; trying again" : "Reading the program's config"}</span>;
}

export function Guarantee({ children }: { children: React.ReactNode }) {
  return (
    <li className="grid grid-cols-[1.5rem_1fr] gap-2 items-start">
      <span className="mt-[3px] w-5 h-5 rounded-full bg-good-soft text-good flex items-center justify-center" aria-hidden="true">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
          <path d="M5 12.5l4.5 4.5L19 7.5" />
        </svg>
      </span>
      <span className="leading-snug">{children}</span>
    </li>
  );
}

export function Fixed({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[7.5rem_1fr] gap-3 items-baseline">
      <dt className="text-text-3">{k}</dt>
      <dd className="text-text-2 leading-snug">{v}</dd>
    </div>
  );
}
