"use client";

import { ACCOUNTS, INTERFACE_VERSION } from "@contract/constants";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { ConnectButton } from "@/components/wallet/ConnectButton";
import { useAccount } from "@/components/wallet/AccountProvider";
import { Countdown } from "@/components/launch/Countdown";
import { TokenIdentity } from "@/components/launch/TokenIdentity";
import { FailureNote, StageLine, stageLabel, useTx } from "@/components/tx/TxState";
import { ReadFailed } from "@/components/ui/ReadFailed";
import { bidsOpenAt } from "@/lib/bouncer/beacon";
import { networkNowSec } from "@/lib/bouncer/netClock";
import { getClient } from "@/lib/bouncer/client";
import { readSolInput, solExact, solUsd } from "@/lib/bouncer/amountInput";
import { fmtDateTime, fmtSol, fmtTime, shortAddr } from "@/lib/bouncer/format";
import { useConfig, useFinalPrice, useLaunch, useLaunchMissing, useNow, useNowSec, useRent, useWalletScoped } from "@/lib/bouncer/hooks";
import { AttestRefused, attestReasonText, requestPermit, TURNSTILE_SITE_KEY, type Permit } from "@/lib/bouncer/attest";
import { TxFailure } from "@/lib/bouncer/chain/signer";
import { MissingLaunch } from "@/components/launch/MissingLaunch";
import type { BidAccount, CommitResult } from "@/lib/bouncer/types";
import { MAX_TICK } from "@/lib/bouncer/grid";
import { roundPointMatches } from "@/lib/bouncer/seal";
import { leastSent, pushCostText, sentExceedsBalance } from "@/lib/bouncer/product";
import { PublicKey } from "@solana/web3.js";
import { bidBumpMisses } from "@/lib/bouncer/chain/pda";
import { bidCosts, bidPriority, commitComputeUnits, commitFee, COMMIT_COMPUTE_UNITS } from "@/lib/bouncer/terms";
import { checkQuote, quoteProblem, useCapRate, type QuoteCheck } from "@/lib/bouncer/solPrice";
import { fmtCap, fmtRate, fmtUsd } from "@/lib/bouncer/usdCap";
import { bookOpen, closeAtTs, mcapAtTick, recoveryDeadline, setupFinishable } from "@/lib/bouncer/view";
import { MaxCapPicker, resolveCap, sealedTick, type CapChoice } from "./MaxCapPicker";
import { defaultQuick, LOCKED, QuickAmounts } from "./QuickAmounts";
import { Refused } from "./Refused";
import { VerifyCommitment } from "./VerifyCommitment";
import { CostSummary } from "./CostSummary";
import { BotCheck } from "./BotCheck";
import { Info } from "@/components/ui/Info";
import { BID_REST_INFO } from "@/lib/bouncer/approvedCopy";

/*
  The sentence above the bid button. The manager's words, "The token is
  minted at close", describe the mint deferral (INTERFACE 0.19 on): there
  the mint is created when the pool opens. The build this site is pinned
  to (v0.18) mints the whole supply into the program's vault when the
  launch is created, so under it the second clause says what that build
  does. The pinned version decides which, so the words move with the pin.
*/
function custodySentence(): string {
  const [major, minor] = INTERFACE_VERSION.split(".").map(Number);
  const mintDeferred = major > 0 || minor >= 19;
  return mintDeferred
    ? "Your SOL waits in the program's vault, not with us."
    : "Your SOL stays in the auction vault. The token is paid out at close, or the SOL is returned.";
}

/* "done" is not a phase: the result belongs to the wallet that signed (F14), so another wallet gets the form. */
type Phase = "edit" | "signing";

/* What was sealed, and at which checked price: the receipt names the rate. No limit needs no price and carries no check. */
interface Sealing {
  tick: number;
  check: Extract<QuoteCheck, { ok: true }> | null;
}

export function BidFlow({ id }: { id: string }) {
  const launch = useLaunch(id);
  const missingAt = useLaunchMissing(id);
  const account = useAccount();
  const nowSec = useNowSec(1000);
  const now = useNow(1000);
  const tx = useTx(account.address);
  /* Null until the bidder types or picks: the page then shows the launch's own first quick amount, never one under its minimum. */
  const [typed, setDepositText] = useState<string | null>(null);
  /* No default max: the bidder types or picks one. A default dollar figure would be a figure nobody chose. */
  const [choice, setChoice] = useState<CapChoice>({ kind: "none" });
  const { rate, status: rateStatus } = useCapRate(null);
  const [checking, setChecking] = useState(false);
  const [quoteMsg, setQuoteMsg] = useState<string | null>(null);
  /* The step moved between what the page showed and the fresh two-source check: asked before the wallet opens. */
  const [moved, setMoved] = useState<Sealing | null>(null);
  const [sealed, setSealed] = useState<Sealing | null>(null);
  const [phase, setPhase] = useState<Phase>("edit");
  /*
    24i (Astra R8-M2): the deposit, priority fee and price of the attempt in progress, fixed at the tap. The page shows
    these and the commit carries these until the attempt ends; the two-second price read changes only an idle form.
    24j (Astra R9-M2, Claude L-A; the founder approved the lock as mocked, 2026-10-25): what is sent is fixed at the tap too,
    and every control that changes the bid is locked until the attempt ends, so the page always shows the bid it sends.
  */
  const [active, setActive] = useState<{ deposit: bigint; priority: bigint; price: number; sent: bigint } | null>(null);
  /* v0.30 (SPEC 3.3): self-claim is gone; commit refuses bit 0 (ClaimRemoved), so there is no choice and every bid is pushed. */
  /* The receipt, for the wallet that signed only (the 0.28 triage's F14): after a switch the other wallet gets the form, and the receipt comes back with its wallet. */
  const [done, setDone] = useWalletScoped<{ result: CommitResult; sealed: Sealing | null }>(account.address);
  const result = done?.result ?? null;
  /* Keyed by wallet so a wallet change never shows the previous wallet's bid. A failed read says so (F14) rather than reading as no bid. */
  const [existingFor, setExistingFor] = useState<{ address: string; bid: BidAccount | null; failed: boolean } | null>(null);
  const [existingRetry, setExistingRetry] = useState(0);
  const existingOwn = existingFor && existingFor.address === account.address ? existingFor : null;
  const existing = existingOwn ? existingOwn.bid : null;
  const existingFailed = !!existingOwn && existingOwn.failed;
  /*
    0.29, the bot check on a gated launch (lib/bouncer/attest.ts): the
    widget's token, used once; the attestation it bought, held for its wallet
    while it lasts, so a declined wallet prompt is retried without a second
    check; the config's attestor keys, which the answer must be signed by.
  */
  const config = useConfig();
  const [botToken, setBotToken] = useState<string | null>(null);
  const [botReset, setBotReset] = useState(0);
  const [heldPermit, setHeldPermit] = useWalletScoped<Permit>(account.address);

  const a = launch?.account ?? null;
  /*
    the founder, 2026-10-08: "if someone bids 2 sol, they should have any fees
    taken out of that 2 sol, not 2.001 sol or whatever it is." The amount
    typed is the whole of what leaves the wallet. The deposit the commit
    carries is that less the costs: the processing charge (the pin's), the
    Bid account's rent (read from the cluster; back when the bid closes) and
    the one signature's fee (exact, with the compute budget set explicitly in
    chainClient.ts). The minimum is enforced on the deposit, so the least the
    field takes is the minimum bid plus the costs: a flat 0.02 SOL since 22e3
    (Config min_bid 17,683,840; product.ts leastSent, the founder, 2026-10-23). No program change: the
    deposit is an argument of commit (INTERFACE 0.27), and the program moves
    deposit plus charge from the bidder and has the bidder pay the account.
  */
  const bidRent = useRent(ACCOUNTS.Bid.len);
  const costs = bidRent === null || a === null ? null : bidCosts(bidRent, a);
  const minSent = a && costs !== null ? leastSent(a.minBid, costs) : null;
  /* Whether the round figure is the one in force; the message then needs no arithmetic. */
  const roundFloor = a !== null && costs !== null && minSent !== null && minSent > a.minBid + costs;
  /* The quick amounts start at the least the field takes, and a bidder can replace the rest with their own (QuickAmounts.tsx; the founder, 2026-10-07). Until the bidder types or picks, the field shows that least. */
  const quickDefault = useMemo(() => (a && bidRent !== null ? defaultQuick(leastSent(a.minBid, bidCosts(bidRent, a))) : null), [a, bidRent]);
  const depositText = typed ?? quickDefault?.[0] ?? "";
  /* Read strictly: digits and one point, straight to lamports, or refused with the reason (amountInput.ts). Nothing typed is reinterpreted; "1,5" was once read as 15 SOL here. */
  const read = useMemo(() => readSolInput(depositText), [depositText]);
  /* What leaves the wallet, and the deposit inside it. */
  const sent = read.ok ? read.atoms : 0n;
  /*
    24g (the founder's cost line, 2026-10-25): in the last 90 seconds the site adds a priority fee, and it comes out of what is
    sent like every other cost. It is the limit this wallet's bid needs (terms.ts commitComputeUnits) times the price the
    shared send context gives now, and that same price goes to the commit. A fee that would take the deposit under the
    minimum is not added: that bid goes without it, and the least the field takes stays as it is.
  */
  const finalPrice = useFinalPrice(id, a ? closeAtTs(a) : null, nowSec);
  const units = useMemo(() => {
    try {
      return account.address ? commitComputeUnits(bidBumpMisses(new PublicKey(id), new PublicKey(account.address))) : COMMIT_COMPUTE_UNITS;
    } catch {
      return COMMIT_COMPUTE_UNITS;
    }
  }, [id, account.address]);
  const base = costs !== null && sent > costs ? sent - costs : 0n;
  const livePriority = a ? bidPriority(base, a.minBid, finalPrice, units) : { priority: 0n, price: 0 };
  const { deposit, priority, price } = active ?? { deposit: base - livePriority.priority, priority: livePriority.priority, price: livePriority.price };
  /* What the summary and the restated line show as sent: the tap's while an attempt runs. */
  const shownSent = active?.sent ?? sent;
  /* The lock: from the tap (the price check included) until the attempt ends. */
  const locked = active !== null || phase === "signing";

  /* The step the choice seals at, at the live price. Null without a choice, outside the grid, or with no price. */
  const tick = a ? sealedTick(resolveCap(a, choice, rate?.usdPerSol ?? null)) : null;

  /* The site's own check of the launch's stored point against its reveal round. The program derives it on chain since v0.14; this guards launches from older builds and costs nothing. */
  const roundOk = useMemo(() => (a ? roundPointMatches(a.roundPoint, a.revealRound) : true), [a]);

  useEffect(() => {
    const address = account.address;
    if (!address) return;
    let live = true;
    getClient()
      .getMyBid(id, address)
      .then((bid) => live && setExistingFor({ address, bid, failed: false }))
      .catch(() => live && setExistingFor({ address, bid: null, failed: true }));
    return () => {
      live = false;
    };
  }, [id, account.address, phase, existingRetry, done]);

  /* B2 (the e2e test of 2026-10-22): the wallet's balance, read on connect and every 30 seconds, as the create page does; a bid over it is said under the field and the button waits. */
  const balanceTick = now ? Math.floor(now / 30_000) : 0;
  const [held, setHeld] = useState<{ address: string; lamports: bigint } | null>(null);
  useEffect(() => {
    const address = account.address;
    if (!address) return;
    let live = true;
    getClient()
      .getBalanceLamports(address)
      .then((lamports) => live && setHeld({ address, lamports }))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [account.address, balanceTick, done]);

  if (launch === null && missingAt !== null) return <MissingLaunch id={id} checkedAt={missingAt} />;
  if (launch === null || a === null) return <div className="pt-8 animate-pulse h-96 rounded-[14px] bg-panel-2" />;

  /* By the clock, not the state byte: once the window ends a commit closes the book instead of landing (S-02, S-03). */
  const open = nowSec != null ? bookOpen(a, nowSec) : a.state === "open";
  const tooSmall = sent > 0n && minSent !== null && sent < minSent;
  const enough = minSent !== null && sent >= minSent;
  const balance = held && held.address === account.address ? held.lamports : null;
  const overBalance = read.ok && enough && sentExceedsBalance(sent, balance);
  /* Any deposit at or above the minimum lands. Nothing here refuses a size; there is no cap of any kind. */
  /* 0.29: a gated launch needs the bot check passed, or an attestation still held from the last attempt (a minute's life left at least). */
  const gated = a.attestRequired;
  const permitLive = heldPermit !== null && nowSec !== null && heldPermit.expiry - nowSec > 60;
  const botReady = !gated || permitLive || (botToken !== null && config !== null);
  /* A priced max needs a live price on screen; with none, bidding waits, No limit included (nothing falls back to a SOL cap). */
  const canSubmit = open && a.histogramGrown && roundOk && !!account.address && !account.signProblem && enough && !overBalance && !existing && phase === "edit" && tick != null && rate != null && !checking && !moved && botReady;
  /* The top of the grid: no maximum (the interface's "no limit" bid). */
  const anyPrice = tick === MAX_TICK;
  const opensAt = fmtTime(bidsOpenAt(a.revealRound));
  /* The deposit in dollars at the live price, shown inside the field beside the unit (the founder, 2026-10-07: in the field, not under the buttons). Nothing unreadable or under the minimum is priced. */
  const depositUsd = read.ok && enough && rate ? fmtUsd(solUsd(sent, rate.usdPerSol)) : null;

  /*
    Sealing a priced max: the dollar figure on screen was converted at the
    cached live price. Before anything is signed, both sources are read fresh;
    they must agree within the limit, the step is converted again at the
    higher of the two, and if that is a different step than the one on screen
    the bidder chooses before the wallet opens.
  */
  async function submit(confirmed?: Sealing) {
    const signer = account.signer;
    if (!signer || account.signProblem || !a || tick == null) return;
    setQuoteMsg(null);
    setActive({ deposit, priority, price, sent });
    let seal: Sealing | null = confirmed ?? null;
    if (!seal) {
      if (choice.kind === "nolimit") {
        seal = { tick: MAX_TICK, check: null };
      } else {
        setChecking(true);
        const c = await checkQuote();
        setChecking(false);
        if (!c.ok) {
          setQuoteMsg(quoteProblem(c));
          setActive(null);
          return;
        }
        const t = sealedTick(resolveCap(a, choice, c.usdPerSol));
        if (t == null) {
          setQuoteMsg(`At ${fmtRate(c.usdPerSol)} per SOL, checked just now, the market cap you typed is outside the grid. Nothing was sealed.`);
          setActive(null);
          return;
        }
        seal = { tick: t, check: c };
        if (t !== tick) {
          setMoved(seal);
          setActive(null);
          return;
        }
      }
    }
    setMoved(null);
    setSealed(seal);
    setPhase("signing");
    const sealTick = seal.tick;
    /* Every outcome, including a wallet that answered after the window closed, lands in tx.failure and is shown by whichever panel is on screen then. */
    /* 0.25: the ceiling sent is the charge the cost summary is printed from. 0.29: the launch's own (Launch.processing_charge), fixed at genesis, so nothing read later can raise it. */
    const token = botToken;
    const r = await tx.run(async (onStage) => {
      /* 0.29: the bot check's attestation first, checked byte for byte against this launch and wallet (attest.ts); a refusal is said before anything is built. */
      let permit: Permit | null = null;
      if (a.attestRequired) {
        const nowS = networkNowSec();
        if (heldPermit && heldPermit.expiry - nowS > 60) permit = heldPermit;
        else {
          if (!TURNSTILE_SITE_KEY) throw new TxFailure("nothingSent", "botCheck", attestReasonText("not-set-up"), {});
          if (!token || !config) throw new TxFailure("nothingSent", "botCheck", attestReasonText("turnstile"), {});
          try {
            permit = await requestPermit({ launch: id, bidder: signer.address, token, attestors: config.attestors });
            setHeldPermit(permit);
          } catch (e) {
            throw new TxFailure("nothingSent", "botCheck", e instanceof AttestRefused ? e.message : attestReasonText("unreachable"), { cause: e });
          } finally {
            /* A token verifies once: the widget is asked for a fresh one either way. */
            setBotToken(null);
            setBotReset((n) => n + 1);
          }
        }
      }
      return getClient().commit({ launchId: id, deposit, tick: sealTick, maxProcessingCharge: a.processingCharge, permit, priceMicroLamports: price }, signer, { onStage });
    });
    if (r) setDone({ result: r, sealed: seal });
    setPhase("edit");
    setActive(null);
  }

  if (result?.kind === "closedInstead") {
    /* The launch account is live through the subscription: the late commit left it closed (bids to open) or failed (under the floor, refunds). */
    const failed = a.state === "failed";
    const closed = a.state === "closed";
    return (
      <div className="pt-8 max-w-[34rem]">
        <div className="panel p-4 md:p-5 reveal">
          <p className="display text-[1.5rem] leading-tight">Closed before your bid landed.</p>
          <p className="text-text-2 mt-2">
            {/* 24e, bug B (the founder chose B, 2026-10-25): network fees apply to a late close; the fee is the exact one the site built. */}
            The window had already ended, so your transaction closed the book instead, which anyone may do. No deposit or charge was taken; only the network fee ({fmtSol(result.networkFee)}) was paid.
            {failed
              ? ` Bids came to under ${fmtSol(a.floorValue)}, so nobody bought: every deposit is refunded in full.`
              : closed
                ? ` The ${a.bidCount} ${a.bidCount === 1 ? "bid" : "bids"} that got in open at ${opensAt}.`
                : ""}
          </p>
          {result.signature && <p className="text-text-3 mt-3 mono break-all">Signature {shortAddr(result.signature, 8, 8)}</p>}
          <Link href={`/launch/${id}/auction`} className="btn btn-primary w-full mt-4">
            {failed ? "See refunds" : closed ? "Watch bids open" : "Back to the auction"}
          </Link>
        </div>
      </div>
    );
  }

  if (!open && !result) {
    return (
      <div className="pt-8 max-w-[34rem]">
        <TokenIdentity launch={launch} compact />
        <div className="panel p-4 md:p-5 mt-4">
          <p className="display text-[1.5rem]">Bidding is closed.</p>
          {/* A bid pressed before the close that failed after it (a wallet that signed too late, an expired transaction) must still be answered here, not hidden by the close. */}
          <FailureNote failure={tx.failure} />
          {phase === "signing" && (
            <>
              <p className="text-text-2 mt-2">Your bid is still with your wallet. If it lands now it closes the book instead of bidding, and this page will say so.</p>
              <StageLine stage={tx.stage} />
            </>
          )}
          {a.bidCount === 0 ? (
            <>
              <p className="text-text-2 mt-2">No more bids, and none came in. The launch fails when its close lands, with nothing to refund and nothing sold.</p>
              <Link href={`/launch/${id}/auction`} className="btn btn-secondary w-full mt-4">
                Back to the auction
              </Link>
            </>
          ) : (
            <>
              <p className="text-text-2 mt-2">No more bids. Every bid opens at {opensAt}, all at once, and the record shows each one and how it filled.</p>
              <Link href={`/launch/${id}/settlement`} className="btn btn-secondary w-full mt-4">
                Open settlement
              </Link>
            </>
          )}
        </div>
      </div>
    );
  }

  /* 0.29: the create landed without its second step (Initializing); commit refuses HistogramNotReady (6071) until it does. */
  if (setupFinishable(a, nowSec) && !result) {
    return (
      <div className="pt-8 max-w-[34rem]">
        <TokenIdentity launch={launch} compact />
        <div className="panel p-4 md:p-5 mt-4" data-setup-pending>
          <p className="display text-[1.5rem]">Finishing setup.</p>
          <p className="text-text-2 mt-2 leading-snug">This launch takes no bids until its creator&apos;s second setup step lands. The window is already running.</p>
          <Link href={`/launch/${id}/auction`} className="btn btn-secondary w-full mt-4">
            Back to the auction
          </Link>
        </div>
      </div>
    );
  }

  if (result?.kind === "placed") {
    const bid = result.bid;
    /* What left the wallet: the chain's deposit and charge on the bid account, the account's rent on this cluster, the signature's fee. */
    const doneSent = bid.deposit + bid.processingCharge + (bidRent ?? 0n) + commitFee(a);
    const doneTick = done?.sealed?.tick ?? null;
    const doneNoLimit = doneTick === MAX_TICK;
    const doneCheck = done?.sealed?.check ?? null;
    const doneCap = doneTick != null && doneCheck ? fmtCap(mcapAtTick(a, doneTick), doneCheck.usdPerSol) : "sealed";
    return (
      <div className="pt-8 max-w-[34rem]">
        <div className="panel p-4 md:p-5 reveal">
          <div className="w-11 h-11 rounded-full bg-good-soft text-good flex items-center justify-center mb-3">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M5 12.5l4.5 4.5L19 7.5" />
            </svg>
          </div>
          <p className="display text-[1.5rem] leading-tight">Bid placed.</p>
          <p className="text-text-2 mt-2" data-receipt>
            You sent <span className="num font-medium text-text">{solExact(doneSent)}</span> from <span className="mono">{shortAddr(bid.bidder)}</span>: <span className="num font-medium text-text">{solExact(bid.deposit)}</span> is your deposit.{" "}
            {/* 4B (the founder, 2026-10-27): the rest of what was sent behind an (i); CostSummary itemised it before signing. */}
            <Info text={BID_REST_INFO.text} label={BID_REST_INFO.label} />{" "}
            {doneNoLimit ? (
              <>Your bid has no limit on the market cap.</>
            ) : (
              <>
                Your max is a <span className="num font-medium text-text">{doneCap}</span> market cap, at {doneCheck ? fmtRate(doneCheck.usdPerSol) : "?"} per SOL
                {doneCheck && <> (Coinbase {fmtRate(doneCheck.coinbase)}, Kraken {fmtRate(doneCheck.kraken)})</>}.
              </>
            )}{" "}
            Sealed until close, from us too. Only the deposit is public.{!doneNoLimit && " If SOL moves before close, your max moves with it in dollars."}
          </p>
          <dl className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3">
            <div className="inset p-3">
              <dt className="text-text-3">Sent</dt>
              <dd className="figure text-[1.5rem] mt-1.5">{fmtSol(doneSent)}</dd>
            </div>
            <div className="inset p-3">
              <dt className="text-text-3">Deposit</dt>
              <dd className="figure text-[1.5rem] mt-1.5">{fmtSol(bid.deposit)}</dd>
            </div>
            <div className="inset p-3">
              <dt className="text-text-3">Max market cap</dt>
              <dd className="figure text-[1.5rem] mt-1.5">{doneNoLimit ? "No limit" : doneCap}</dd>
            </div>
          </dl>
          <p className="text-text-2 mt-4 leading-snug">
            Every bid opens at {opensAt}. Nobody reveals anything.{" "}
            Then the program pushes {launch.token.symbol} or your SOL straight back to this wallet; the push costs you {pushCostText(a)}.
          </p>
          {/* 24l: a proven bid may come with no signature (""): the line shows only when there is one. */}
          {result.signature && <p className="text-text-3 mt-2 mono break-all">Signature {shortAddr(result.signature, 8, 8)}</p>}
          <div className="flex flex-col gap-2 mt-4 sm:flex-row">
            <Link href={`/launch/${id}/auction`} className="btn btn-primary flex-1">
              Back to the auction
            </Link>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="pt-5 md:pt-8 md:grid md:grid-cols-12 md:gap-8">
      <div className="md:col-span-7 lg:col-span-6">
        <Link href={`/launch/${id}/auction`} className="text-text-2 inline-flex items-center gap-1 mb-3 hover:text-text max-w-full wrap-any">
          <svg className="shrink-0" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M15 5l-7 7 7 7" />
          </svg>
          {launch.token.name} auction
        </Link>

        <div className="flex items-center justify-between gap-4 reveal" style={{ "--i": 0 } as React.CSSProperties}>
          <TokenIdentity launch={launch} compact />
          <div className="shrink-0 text-right whitespace-nowrap">
            <Countdown launch={launch} size="sm" />
          </div>
        </div>

        {/* Step 1: wallet */}
        <section className="panel p-4 md:p-5 mt-4 reveal" style={{ "--i": 1 } as React.CSSProperties}>
          {account.address ? (
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-text-3">Bidding from</p>
                <p className="mono">{shortAddr(account.address, 6, 6)}</p>
              </div>
              <ConnectButton />
            </div>
          ) : (
            <div>
              <p className="display text-[1.25rem] mb-3">Connect to bid</p>
              <ConnectButton size="full" tone="primary" />
            </div>
          )}
        </section>

        {!existing && existingFailed && <ReadFailed what="Whether this wallet has a bid here" onRetry={() => setExistingRetry((n) => n + 1)} className="inset p-4 mt-4" />}
        {existing && (
          <section className="inset p-4 mt-4 border-accent-line">
            <p className="font-semibold">This wallet already has a bid in.</p>
            {/* The one-bid rule is stated once, in the deposit panel below (sweep of 2026-10-07). */}
            <p className="text-text-2 mt-1">{fmtSol(existing.deposit)} deposited; it is refunded at settlement if it loses.</p>
          </section>
        )}

        {/* Step 2: deposit */}
        <section className="panel p-4 md:p-5 mt-4 reveal" style={{ "--i": 2 } as React.CSSProperties}>
          <label htmlFor="deposit" className="display text-[1.25rem]">
            Your bid
          </label>
          <div className={`relative mt-2 ${locked ? LOCKED : ""}`}>
            <input
              id="deposit"
              disabled={locked}
              inputMode="decimal"
              className="field figure text-[2rem] pr-20 py-3"
              /* .field is unlayered CSS, so a padding utility never reaches it (MaxCapPicker sets its "$" room the same way): room under the number for the dollar figure. */
              style={depositUsd ? { paddingBottom: "2.75rem" } : undefined}
              value={depositText}
              onChange={(e) => {
                if (!locked) setDepositText(e.target.value);
              }}
              placeholder="0.00"
              autoComplete="off"
              /* Astra's frontend review of 2026-10-21, F6: the line under the field is its description, and a refused or too small figure marks it invalid. */
              aria-invalid={(!read.ok && !read.empty) || (read.ok && tooSmall)}
              aria-describedby="deposit-note"
            />
            <span className={`absolute right-4 text-text-3 text-[1.125rem] leading-none pointer-events-none ${depositUsd ? "top-5" : "top-1/2 -translate-y-1/2"}`}>SOL</span>
            {depositUsd && (
              <span className="absolute left-4 bottom-3 num text-text-2 text-[1.125rem] leading-none pointer-events-none" data-deposit-usd={depositUsd}>
                {depositUsd}
              </span>
            )}
          </div>
          {minSent !== null && <QuickAmounts min={minSent} wallet={account.address} selected={depositText} onPick={(t) => !locked && setDepositText(t)} locked={locked} />}
          {/* The reason the field was not read, or the minimum it is under. Never blank while the bid button is dead (a finding of the misuse pass); nothing while the figure is fine (the founder's item 21, 2026-10-16: the words line went, the dollars sit in the field). */}
          <p id="deposit-note" className={`mt-2 leading-snug ${!read.ok ? "text-text-3" : tooSmall || overBalance ? "text-bad" : "hidden"}`} data-over-balance={overBalance ? "1" : undefined} role="status" data-deposit-read={read.ok ? deposit.toString() : "refused"} data-sent={read.ok ? sent.toString() : "refused"}>
            {!read.ok ? (
              read.empty ? (
                read.why
              ) : (
                <Refused why={read.why} />
              )
            ) : tooSmall ? (
              roundFloor ? (
                `Minimum ${minSent !== null ? solExact(minSent) : "…"}.`
              ) : (
                `Minimum ${minSent !== null ? solExact(minSent) : "…"}: the ${solExact(a.minBid)} minimum bid plus ${costs !== null ? solExact(costs) : "…"} of costs.`
              )
            ) : overBalance && balance !== null ? (
              `This wallet holds ${fmtSol(balance)}. This bid sends ${solExact(sent)}, costs included.`
            ) : null}
          </p>
          {/* "You only pay if you win, and the rest comes back" went in the sweep of 2026-10-07: the sentence above the bid button says what happens to the SOL, and the delivery panel says a refund takes nothing. */}
          {/* the founder, 2026-10-07: the processing-charge sentence is gone (the ceiling is still sent with the commit, the launch's charge above). The one-bid rule stated on its own instead: the program keeps one bid account per wallet per launch (seeds "bid", launch, bidder) and has no instruction that changes one. */}
          <p className="text-text mt-2 leading-snug" data-one-bid>
            <span className="font-semibold">One bid per wallet.</span> Final once sent.
          </p>
          {/* 0.22: the recovery deadline, fixed at creation, stated before the bidder signs. */}
          <p className="text-text-2 mt-2 leading-snug">
            Refundable if no pool by <span className="font-semibold text-text">{fmtDateTime(recoveryDeadline(a))}</span>.
          </p>
        </section>

        {/* Step 3: max market cap */}
        <section className="panel p-4 md:p-5 mt-4 reveal" style={{ "--i": 3 } as React.CSSProperties}>
          <MaxCapPicker
            launch={launch}
            deposit={deposit}
            choice={choice}
            onChange={(c) => {
              if (locked) return;
              setChoice(c);
              setMoved(null);
              setQuoteMsg(null);
            }}
            rate={rate}
            status={rateStatus}
            wallet={account.address}
            locked={locked}
          />
        </section>

        {!roundOk && (
          <section className="inset p-4 mt-4 border-bad">
            <p className="font-semibold text-bad">This launch cannot be bid on.</p>
            <p className="text-text-2 mt-1">
              It was set up wrong, so a sealed bid on it could never be opened. Nothing was sent; choose another launch.
            </p>
          </section>
        )}

        <FailureNote failure={tx.failure} onRetry={() => submit(sealed ?? undefined)} />
        {quoteMsg && (
          <section className="inset p-4 mt-4" role="status">
            <p className="font-semibold">Not sealed.</p>
            <p className="text-text-2 mt-1 leading-snug">{quoteMsg}</p>
          </section>
        )}
        {moved && moved.check && (
          <section className="inset p-4 mt-4 border-accent-line" role="status">
            <p className="font-semibold">SOL moved since this page priced your max.</p>
            <p className="text-text-2 mt-1 leading-snug">
              At {fmtRate(moved.check.usdPerSol)} per SOL (Coinbase {fmtRate(moved.check.coinbase)}, Kraken {fmtRate(moved.check.kraken)}, just now), what you typed seals as a{" "}
              <span className="num font-medium text-text">{fmtCap(mcapAtTick(a, moved.tick), moved.check.usdPerSol)}</span> market cap, not the {tick != null && rate ? fmtCap(mcapAtTick(a, tick), rate.usdPerSol) : "figure"} shown. Nothing has been signed.
            </p>
            <div className="flex flex-col gap-2 mt-3 sm:flex-row">
              <button type="button" className="btn btn-primary flex-1" onClick={() => submit(moved)}>
                Seal at {fmtCap(mcapAtTick(a, moved.tick), moved.check.usdPerSol)}
              </button>
              <button type="button" className="btn btn-secondary flex-1" onClick={() => setMoved(null)}>
                Keep editing
              </button>
            </div>
          </section>
        )}
        {account.address && account.signProblem && <p className="mt-3 text-text-2 leading-snug">{account.signProblem}</p>}

        <div className="mt-4 pb-4 reveal" style={{ "--i": 5 } as React.CSSProperties}>
          {/* Directly above the bid control, the manager's sentence (2026-09-27), with the check beside it. */}
          <div className="mb-3 flex items-start justify-between gap-3">
            <p className="text-text leading-snug">{custodySentence()}</p>
            <VerifyCommitment launch={launch} />
          </div>
          {/* The amount restated beside the button, exact, in figures and dollars (the manager, 2026-10-01; the founder's item 21, 2026-10-16: not spelled out in words). */}
          {phase === "edit" && enough && tick != null && rate && (
            <p className="mb-3 leading-snug text-text" data-restated={deposit.toString()} data-restated-sent={shownSent.toString()}>
              You send <span className="num font-semibold">{solExact(shownSent)}</span>, about {fmtUsd(solUsd(shownSent, rate.usdPerSol))}. Your deposit is <span className="num font-semibold">{solExact(deposit)}</span>
              {anyPrice ? ", with no limit on the market cap." : `, at up to a ${fmtCap(mcapAtTick(a, tick), rate.usdPerSol)} market cap.`}
            </p>
          )}
          {/* 0.29: the bot check on a gated launch, and the waiver when the operator switched it off (Launch.attest_waived_ts; the griefing doc's 14.6: post every waiver). */}
          {gated && (
            <div className="mb-3" data-bot-check>
              {permitLive ? null : <BotCheck onToken={setBotToken} resetKey={botReset} />}
            </div>
          )}
          {!gated && a.attestWaivedTs !== 0 && (
            <p className="mb-3 text-text-2 leading-snug" data-bot-check-waived>
              Bot check switched off for this launch by the operator at {fmtDateTime(a.attestWaivedTs)}.
            </p>
          )}
          {/* the founder, 2026-10-07 (review hold 1): the money, exactly, before the signature: what leaves the wallet and what comes back in each outcome (CostSummary.tsx). */}
          {!result && read.ok && enough && <CostSummary launch={launch} sent={shownSent} deposit={deposit} bidRent={bidRent ?? 0n} priority={priority} />}
          <button type="button" className="btn btn-primary w-full text-[1.125rem]" disabled={!canSubmit} onClick={() => submit()}>
            {phase === "signing"
              ? tx.stage
                ? stageLabel(tx.stage, now)
                : "Waiting for your wallet"
              : !account.address
                ? "Connect a wallet to bid"
                : costs === null
                  ? "Reading costs"
                  : !rate
                  ? "Bidding waits for the SOL price"
                  : checking
                    ? "Checking the SOL price"
                    : deposit === 0n
                      ? "Type an amount to bid"
                      : tooSmall
                        ? `Minimum ${minSent !== null ? solExact(minSent) : "…"}`
                        : overBalance
                          ? "More than this wallet holds"
                        : tick == null
                          ? "Choose a max market cap"
                          : !botReady
                            ? "Running the bot check"
                            : anyPrice
                            ? `Bid ${solExact(sent)} with no limit`
                            : `Bid ${solExact(sent)} at up to ${fmtCap(mcapAtTick(a, tick), rate.usdPerSol)} market cap`}
          </button>
          <StageLine stage={tx.stage} />
          <p className="text-text-3 text-center mt-3 leading-snug">
            Your max stays sealed until close, from us too.
          </p>
        </div>
      </div>
    </div>
  );
}
