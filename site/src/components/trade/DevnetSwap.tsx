"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PublicKey } from "@solana/web3.js";
import { FailureNote, StageLine, stageLabel, useTx } from "@/components/tx/TxState";
import { useAccount } from "@/components/wallet/AccountProvider";
import { ConnectButton } from "@/components/wallet/ConnectButton";
import { NETWORK_FEE_LAMPORTS, quoteSwap, readBalances, readPool, swapInPool, TOKEN_ACCOUNT_BYTES, type Balances, type PoolInfo, type SwapQuote } from "@/lib/bouncer/chain/dammSwap";
import { solUsd } from "@/lib/bouncer/amountInput";
import { setupCase, swapCostLine } from "@/lib/bouncer/swapCosts";
import { useCapRate } from "@/lib/bouncer/solPrice";
import { fmtUsd } from "@/lib/bouncer/usdCap";
import { WSOL_MINT } from "@/lib/bouncer/chain/pda";
import { explorerUrl, getConnection } from "@/lib/bouncer/chain/rpc";
import { getClient } from "@/lib/bouncer/client";
import { atomsToNumber, fmtSol, fmtSolPrecise, fmtTokens, fmtTokensPrecise, numberToAtoms, shortAddr } from "@/lib/bouncer/format";
import { useNow, useWalletScoped } from "@/lib/bouncer/hooks";
import { peekPoolSwaps, refreshPoolSwaps } from "@/lib/bouncer/swaps";
import type { Launch } from "@/lib/bouncer/types";

/*
  The swap panel off mainnet: buy the launch's token with SOL, or sell it
  back, straight against the launch's Meteora DAMM v2 pool
  (lib/bouncer/chain/dammSwap.ts). The quote is read from the pool each time
  the amount changes and every ten seconds while the panel waits; the figure
  shown as "at least" is what the swap insists on, and below it the program
  refuses and only the network fee is paid. Quote and confirmation amounts
  carry enough digits that "about" and "at least" never read the same; the
  pool's fee is named in the token the pool takes it in, apart from the
  network fee and a first buy's account rent. The connected wallet signs; the
  site broadcasts and confirms, and says what landed with the swap's own
  numbers read back from the chain.
*/
const QUOTE_EVERY_MS = 10_000;
const BALANCES_EVERY_MS = 20_000;
const SOL_CHIPS = ["0.01", "0.05", "0.1"];
/* From this price move up the quote says so in the negative tone. A provisional line (review of 2026-10-07); the founder sets the figure. */
const BIG_MOVE_PCT = 10;

type Side = "buy" | "sell";

export function DevnetSwap({ launch, pool, onSwapped }: { launch: Launch; pool: string; onSwapped?: (signature: string) => void }) {
  const account = useAccount();
  const tx = useTx(account.address);
  const now = useNow(1000);
  /* the founder's item 1 (2026-10-16): the field is the bid page's, the dollars under the SOL figure inside it, at the live rate. */
  const { rate } = useCapRate(null);
  const sym = launch.token.symbol;
  const decimals = launch.token.decimals;
  const [side, setSide] = useState<Side>("buy");
  const [amount, setAmount] = useState("");
  const [info, setInfo] = useState<PoolInfo | null>(null);
  const [infoError, setInfoError] = useState<string | null>(null);
  const [quote, setQuote] = useState<{ key: string; q: SwapQuote } | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [quoteError, setQuoteError] = useState<{ key: string; message: string } | null>(null);
  /* Balances with the wallet they were read for, and the last swap's line for the wallet that signed (F14): another wallet's never shows, nor goes into this wallet's swap. */
  const [balState, setBalState] = useState<{ owner: string; balances: Balances } | null>(null);
  const [rent, setRent] = useState<bigint | null>(null);
  const [done, setDone] = useWalletScoped<{ text: string; signature: string }>(account.address);
  const [poolVersion, setPoolVersion] = useState(0);
  const address = account.address;
  const balances = balState && balState.owner === address ? balState.balances : null;
  const owner = useMemo(() => (address ? new PublicKey(address) : null), [address]);

  const token = useMemo(() => (info ? (info.a.mint.equals(WSOL_MINT) ? info.b : info.a) : null), [info]);
  const sol = useMemo(() => (info ? (info.a.mint.equals(WSOL_MINT) ? info.a : info.b) : null), [info]);

  /* The pool's state: read at mount and again after every swap and every quote cycle, so the quote is against the pool as it is. */
  useEffect(() => {
    let live = true;
    readPool(getConnection(), new PublicKey(pool), decimals)
      .then((p) => {
        if (!live) return;
        setInfo(p);
        setInfoError(null);
      })
      .catch((e) => live && setInfoError(`The pool could not be read: ${e instanceof Error ? e.message.slice(0, 120) : String(e)}`));
    return () => {
      live = false;
    };
  }, [pool, decimals, poolVersion]);

  useEffect(() => {
    getClient()
      .getRent(TOKEN_ACCOUNT_BYTES)
      .then(setRent)
      .catch(() => {});
  }, []);

  const refreshBalances = useCallback(() => {
    if (!owner || !token) return;
    const who = owner.toBase58();
    readBalances(getConnection(), owner, token)
      .then((b) => setBalState({ owner: who, balances: b }))
      .catch(() => {});
  }, [owner, token]);

  useEffect(() => {
    refreshBalances();
    const t = setInterval(refreshBalances, BALANCES_EVERY_MS);
    return () => clearInterval(t);
  }, [refreshBalances]);

  /* The amount in base units, or null when the field does not hold a usable number. */
  const amountIn = useMemo<bigint | null>(() => {
    const n = Number(amount.replace(",", "."));
    if (!amount.trim() || !Number.isFinite(n) || n <= 0) return null;
    return numberToAtoms(n, side === "buy" ? 9 : decimals);
  }, [amount, side, decimals]);

  const quoteKey = `${side}:${amountIn?.toString() ?? ""}:${info?.readAt ?? 0}`;
  const quoteTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    /* A quote or an error is shown only while its key is the current one, so nothing needs clearing here. */
    if (!info || !token || !sol || amountIn === null) return;
    let live = true;
    const key = quoteKey;
    const run = async () => {
      setQuoting(true);
      try {
        const q = await quoteSwap(getConnection(), info, side === "buy" ? sol.mint : token.mint, amountIn);
        if (!live) return;
        setQuote({ key, q });
      } catch (e) {
        if (!live) return;
        setQuoteError({ key, message: e instanceof Error ? e.message.slice(0, 160) : String(e) });
      } finally {
        if (live) setQuoting(false);
      }
    };
    quoteTimer.current = setTimeout(run, 350);
    /* While the panel waits, the pool is re-read and the quote with it. */
    const again = setInterval(() => setPoolVersion((n) => n + 1), QUOTE_EVERY_MS);
    return () => {
      live = false;
      if (quoteTimer.current) clearTimeout(quoteTimer.current);
      clearInterval(again);
    };
  }, [quoteKey, info, token, sol, amountIn, side]);

  const current = quote && quote.key === quoteKey ? quote.q : null;
  const currentError = quoteError && quoteError.key === quoteKey ? quoteError.message : null;
  const fmtOut = (atoms: bigint) => (side === "buy" ? `${fmtTokensPrecise(atoms, decimals)} ${sym}` : fmtSolPrecise(atoms));
  const impact = current?.priceImpactPct ?? 0;
  const bigMove = impact >= BIG_MOVE_PCT;

  const run = async () => {
    const signer = account.signer;
    if (!signer || account.signProblem || !info || !token || !sol || !current || amountIn === null || !owner || rent === null) return;
    setDone(null);
    const bal = balances ?? (await readBalances(getConnection(), owner, token));
    const r = await tx.run((onStage) => swapInPool(getConnection(), { info, inputMint: side === "buy" ? sol.mint : token.mint, outputMint: side === "buy" ? token.mint : sol.mint, amountIn, minOut: current.minOut, tokenAccountRent: rent, balances: bal }, signer, { onStage }));
    if (!r) return;
    setAmount("");
    setPoolVersion((n) => n + 1);
    refreshBalances();
    onSwapped?.(r.signature);
    /* The swap's own numbers, read back from the chain, not the quote. The node lists a signature a moment after it confirms, and a read already in flight may predate the swap, so this asks up to three times. */
    let mine = undefined as ReturnType<typeof peekPoolSwaps>[number] | undefined;
    for (let attempt = 0; attempt < 3 && !mine; attempt++) {
      if (attempt > 0) await new Promise((res) => setTimeout(res, 1500));
      await refreshPoolSwaps(pool).catch(() => {});
      mine = peekPoolSwaps(pool).find((s) => s.signature === r.signature);
    }
    const text = mine
      ? mine.side === "buy"
        ? `Bought ${fmtTokensPrecise(mine.tokenAtoms, decimals)} ${sym} for ${fmtSolPrecise(mine.solLamports)}.`
        : `Sold ${fmtTokensPrecise(mine.tokenAtoms, decimals)} ${sym} for ${fmtSolPrecise(mine.solLamports)}.`
      : "Landed.";
    setDone({ text, signature: r.signature });
  };

  const canSwap = !!account.address && !account.signProblem && !tx.busy && !!current && amountIn !== null && rent !== null && !!info;
  /* The SOL side in dollars at the live rate, under the figure (nothing for a token amount). */
  const payUsd = side === "buy" && amountIn !== null && amountIn > 0n && rate ? fmtUsd(solUsd(amountIn, rate.usdPerSol)) : null;

  return (
    <div className="flex flex-col gap-3" data-devnet-swap>
      <div className="grid grid-cols-2 gap-1 p-1 rounded-[8px] bg-panel-2" role="tablist" aria-label="Buy or sell">
        {(["buy", "sell"] as const).map((s) => (
          <button key={s} type="button" role="tab" aria-selected={side === s} className={`min-h-11 rounded-[6px] px-3 font-semibold transition ${side === s ? "bg-panel-3 text-text" : "text-text-2 hover:text-text"}`} onClick={() => { setSide(s); setAmount(""); setDone(null); tx.reset(); }}>
            {s === "buy" ? `Buy ${sym}` : `Sell ${sym}`}
          </button>
        ))}
      </div>

      <div>
        <label htmlFor="swap-in" className="text-text-3">
          You pay
        </label>
        <div className="relative mt-1">
          <input
            id="swap-in"
            type="text"
            inputMode="decimal"
            autoComplete="off"
            className="field figure text-[2rem] pr-24 py-3"
            /* .field is unlayered CSS, so a padding utility never reaches it (BidFlow sets its room the same way): room under the number for the dollar figure. */
            style={payUsd ? { paddingBottom: "2.75rem" } : undefined}
            placeholder="0.00"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            aria-label={side === "buy" ? "SOL to pay" : `${sym} to sell`}
          />
          <span className={`absolute right-4 text-text-3 text-[1.125rem] leading-none pointer-events-none wrap-any max-w-[40%] text-right ${payUsd ? "top-5" : "top-1/2 -translate-y-1/2"}`}>{side === "buy" ? "SOL" : sym}</span>
          {payUsd && (
            <span className="absolute left-4 bottom-3 num text-text-2 text-[1.125rem] leading-none pointer-events-none" data-pay-usd={payUsd}>
              {payUsd}
            </span>
          )}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {side === "buy"
          ? SOL_CHIPS.map((c) => (
              <button key={c} type="button" className="chip" onClick={() => setAmount(c)}>
                {c} SOL
              </button>
            ))
          : [25, 50, 100].map((pct) => (
              <button key={pct} type="button" className="chip" disabled={!balances || balances.atoms === 0n} onClick={() => balances && setAmount(String(atomsToNumber((balances.atoms * BigInt(pct)) / 100n, decimals)))}>
                {pct === 100 ? "All" : `${pct}%`}
              </button>
            ))}
        {owner && balances && (
          <span className="text-text-3 ml-auto num" data-balances>
            {side === "buy" ? fmtSol(balances.lamports) : `${fmtTokens(balances.atoms, decimals)} ${sym}`}
          </span>
        )}
      </div>

      <div className="rounded-[8px] bg-panel-2 p-3 min-h-[5.5rem]" aria-live="polite">
        {infoError ? (
          <p className="text-text-2 leading-snug">{infoError}</p>
        ) : amountIn === null ? (
          <p className="text-text-3 leading-snug">{side === "buy" ? `Enter SOL to see how much ${sym} the pool gives.` : `Enter ${sym} to see how much SOL the pool gives.`}</p>
        ) : currentError ? (
          <p className="text-text-2 leading-snug">{currentError}</p>
        ) : current ? (
          <>
            <p className="text-text-3">You get about</p>
            <p className="figure text-[1.375rem] mt-0.5 wrap-any" data-quote-out={current.amountOut.toString()}>
              {fmtOut(current.amountOut)}
            </p>
            <p className="text-text-2 mt-1 leading-snug num">At least {fmtOut(current.minOut)}.</p>
            {/* Astra's review of 337bed2, F1: the costs before the signature, one line, no dropdown (swapCosts.ts). */}
            <p className="text-text-3 leading-snug num" data-quote-costs>
              {swapCostLine({
                poolFee: current.feeIsSol ? fmtSolPrecise(current.fee) : `${fmtTokensPrecise(current.fee, decimals)} ${sym}`,
                networkFee: fmtSolPrecise(NETWORK_FEE_LAMPORTS),
                setup: setupCase({ side, connected: !!owner, hasTokenAccount: balances ? balances.hasTokenAccount : null, rent }),
                rentText: fmtSolPrecise,
                symbol: sym,
              })}
            </p>
            {impact >= 0.5 && (
              <p className={`leading-snug num ${bigMove ? "text-bad font-medium" : "text-text-3"}`} data-quote-impact={impact.toFixed(1)}>
                Moves the price {impact.toFixed(impact >= 10 ? 0 : 1)}%{bigMove ? ". Large for this pool." : "."}
              </p>
            )}
          </>
        ) : (
          <p className="text-text-3 leading-snug">{quoting ? "Quoting." : "Quoting."}</p>
        )}
      </div>

      {!account.address ? (
        <ConnectButton size="full" tone="primary" />
      ) : (
        <button type="button" className="btn btn-primary w-full" disabled={!canSwap} onClick={run} data-swap-button={side}>
          {tx.stage ? stageLabel(tx.stage, now) : side === "buy" ? `Buy ${sym}` : `Sell ${sym}`}
        </button>
      )}
      <StageLine stage={tx.stage} />
      <FailureNote failure={tx.failure} onRetry={() => tx.reset()} />
      {done && (
        <p className="text-text leading-snug" data-swap-done>
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
      {account.address && account.signProblem && <p className="text-text-2 leading-snug">{account.signProblem}</p>}
    </div>
  );
}
