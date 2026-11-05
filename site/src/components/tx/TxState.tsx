"use client";

import { isPlainRefusal } from "@/lib/bouncer/chain/errors";
import { useCallback, useState } from "react";
import { explorerUrl } from "@/lib/bouncer/chain/rpc";
import { TxFailure, type OnStage, type TxStage } from "@/lib/bouncer/chain/signer";
import { shortAddr } from "@/lib/bouncer/format";
import { useNow } from "@/lib/bouncer/hooks";

/*
  One place every page reads a transaction's progress and its outcome from,
  so a bid, a launch, a refund, a claim and an abort tell the same truth in
  the same words: what the wallet is doing now, and afterwards whether
  money moved.
*/

export interface Tx {
  stage: TxStage | null;
  failure: TxFailure | null;
  busy: boolean;
  run<T>(fn: (onStage: OnStage) => Promise<T>): Promise<T | null>;
  reset(): void;
}

/*
  `address` is the page's account. A failure belongs to the wallet that
  pressed (the 0.28 triage's F14): after a switch it is not shown under the
  other wallet, and it shows again if that wallet comes back. A failure that
  is about the switch itself (walletSwitched, walletDisconnected) stays up,
  since explaining the switch is its whole job. The stage is not filtered:
  the wallet prompt it describes is real whoever is connected.

  24o (Astra's 24n E2E F2): one failure per wallet. An unknown outcome is
  shown only under the wallet that sent it (24l had shown it under any
  wallet, so b8 saw b6's unknown as its own), and another wallet's run or
  reset clears only that wallet's own entry, so b6's unresolved outcome is
  still there when b6 comes back. A run's failure goes to the wallet it
  started under, whoever is connected when it ends.
*/
export interface TxFailures {
  byOwner: ReadonlyMap<string | null, TxFailure>;
  /* The latest walletSwitched or walletDisconnected explanation, shown under any wallet until a run or a reset. */
  switched: TxFailure | null;
}
export const NO_FAILURES: TxFailures = { byOwner: new Map(), switched: null };
export function failureFor(f: TxFailures, address: string | null): TxFailure | null {
  return f.byOwner.get(address) ?? f.switched;
}
export function failuresCleared(f: TxFailures, owner: string | null): TxFailures {
  if (!f.byOwner.has(owner) && f.switched === null) return f;
  const byOwner = new Map(f.byOwner);
  byOwner.delete(owner);
  return { byOwner, switched: null };
}
export function failureRecorded(f: TxFailures, owner: string | null, failure: TxFailure): TxFailures {
  const byOwner = new Map(f.byOwner);
  byOwner.set(owner, failure);
  return { byOwner, switched: failure.reason === "walletSwitched" || failure.reason === "walletDisconnected" ? failure : f.switched };
}

export function useTx(address: string | null = null): Tx {
  const [stage, setStage] = useState<TxStage | null>(null);
  const [failed, setFailed] = useState<TxFailures>(NO_FAILURES);
  const run = useCallback(
    async <T,>(fn: (onStage: OnStage) => Promise<T>): Promise<T | null> => {
      const owner = address;
      setFailed((f) => failuresCleared(f, owner));
      setStage({ step: "building" });
      try {
        const r = await fn(setStage);
        setStage(null);
        return r;
      } catch (e) {
        const failure = e instanceof TxFailure ? e : new TxFailure("unknown", "siteBug", e instanceof Error ? e.message : String(e), { cause: e });
        setFailed((f) => failureRecorded(f, owner, failure));
        setStage(null);
        return null;
      }
    },
    [address],
  );
  const reset = useCallback(() => {
    setFailed((f) => failuresCleared(f, address));
    setStage(null);
  }, [address]);
  return { stage, failure: failureFor(failed, address), busy: stage !== null, run, reset };
}

function elapsed(since: number, now: number): string {
  const s = Math.max(0, Math.floor((now - since) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/* Short label for a button while a transaction is in flight. */
export function stageLabel(stage: TxStage, now: number): string {
  switch (stage.step) {
    case "building":
      return "Building";
    case "simulating":
      return "Simulating";
    case "wallet":
      return stage.count && stage.count > 1 ? `Approve ${stage.count} transactions ${elapsed(stage.since, now)}` : `Waiting for your wallet ${elapsed(stage.since, now)}`;
    case "sending":
      return stage.total && stage.total > 1 ? `Sending ${stage.index} of ${stage.total}` : "Sending";
    case "confirming":
      return stage.total && stage.total > 1 ? `Confirming ${stage.index} of ${stage.total} ${elapsed(stage.since, now)}` : `Confirming ${elapsed(stage.since, now)}`;
    case "resolving":
      return `Reading the chain ${elapsed(stage.since, now)}`;
  }
}

/*
  The sentence under a button while a transaction is in flight. Copy pass,
  2026-10-02: the button itself already reads Building, Simulating and
  Sending, so those stages say nothing more here. The sentence appears where
  it carries something the button does not: that nothing is sent before the
  wallet approves, that a transaction expires, and a signature to look up.
*/
export function StageLine({ stage }: { stage: TxStage | null }) {
  const now = useNow(1000);
  if (!stage) return null;
  const t = now;
  let text: string;
  switch (stage.step) {
    case "building":
    case "simulating":
    case "sending":
      return null;
    case "wallet": {
      const s = Math.floor((t - stage.since) / 1000);
      const many = stage.count && stage.count > 1 ? `${stage.count} transactions in one prompt` : null;
      text = stage.again
        ? `The rest expired before they were sent. Approve the rebuilt ${many ?? "transaction"}; the ones that landed stay landed.`
        : s < 45
          ? many
            ? `Approve ${many}. Nothing is sent until you do; they go one after another, each confirmed before the next.`
            : "Approve in your wallet. Nothing is sent until you do."
          : "Still waiting for your wallet. It expires in about a minute; after that nothing is sent.";
      break;
    }
    case "confirming":
      text = stage.total && stage.total > 1 ? `Sent ${stage.index} of ${stage.total}. Waiting for confirmation of ${shortAddr(stage.signature, 6, 6)}.` : `Sent. Waiting for confirmation of ${shortAddr(stage.signature, 6, 6)}.`;
      break;
    /* 24k (the founder, 2026-10-25): one line wherever this stage shows, with or without a signature. */
    case "resolving":
      text = "Checking the chain… about a minute.";
      break;
  }
  return (
    <p className="text-text-2 mt-2 leading-snug" aria-live="polite">
      {text}
    </p>
  );
}

function reasonSentence(f: TxFailure): string {
  const d = f.detail;
  switch (f.reason) {
    case "walletDeclined":
      return "You declined in your wallet.";
    case "walletDisconnected":
      return "Your wallet disconnected before it signed.";
    case "walletSwitched":
      return d.signedAs
        ? `Your wallet signed as ${shortAddr(d.signedAs, 6, 6)}, not ${d.expected ? shortAddr(d.expected, 6, 6) : "the account this page is using"}. Switch back in the wallet, or reconnect, and try again.`
        : `Your wallet switched to a different account while the prompt was open${d.expected ? ` (this page was using ${shortAddr(d.expected, 6, 6)})` : ""}. Switch back, or reconnect, and try again.`;
    case "walletUnsupported":
      return f.message;
    case "walletError":
      return `Your wallet returned an error: ${f.message}`;
    case "expired":
      return f.message;
    case "insufficientFunds":
      return f.message;
    case "refused":
      /* 0.25: the refusals in errors.ts's plain set read as their own sentence, with no "the program refused" and no code; the code stays in the detail. */
      /* Another program's refusal (Meteora's) is named for it; its code is never one of the pin's. */
      if (f.detail.program) return f.kind === "landedFailed" ? `${f.detail.program} refused it: ${f.message}` : `${f.detail.program} refused it before anything was sent: ${f.message}`;
      if (isPlainRefusal(f.detail.code)) return f.message;
      return f.kind === "landedFailed" ? `The program refused it: ${f.message}` : `The program refused it before anything was sent: ${f.message}`;
    case "rpcUnreachable":
      return f.message;
    case "botCheck":
      return f.message;
    case "pinUnconfirmed":
      return f.message;
    case "unresolved":
      return f.message;
    case "siteBug":
      return `Something in the site went wrong: ${f.message}`;
  }
}

/* The outcome, money first. */
export function FailureNote({ failure, onRetry, onCheck }: { failure: TxFailure | null; onRetry?: () => void; onCheck?: () => void }) {
  if (!failure) return null;
  /* A signature is shown only for something that reached the network. A transaction the wallet signed too late, or one that expired unseen, has a signature too, but the explorer would show nothing for it. */
  const sig = failure.kind === "nothingSent" ? null : (failure.detail.signature ?? null);
  /* One tone for all three: the accent is the go colour in the new look (blue), never a caution. */
  let money: string;
  if (failure.kind === "nothingSent") money = "Nothing was sent and nothing left your wallet.";
  else if (failure.kind === "landedFailed") money = "It landed and was refused. The network fee was paid; nothing else moved.";
  else money = "This page could not tell whether it landed.";
  /* A batch that broke after some of it landed: say which, then the failed one's own truth. */
  const before = failure.detail.sentBefore ?? [];
  if (before.length) {
    const n = failure.detail.batchTotal ?? before.length + 1;
    const next = failure.kind === "nothingSent" ? "the next was not sent" : failure.kind === "landedFailed" ? "the next landed and was refused, its fee paid" : "whether the next landed could not be told";
    money = `${before.length} of ${n} transactions landed (${before.map((b) => b.label.split("+").join(", ").split("post_beacon").join("unsealing key").split("_").join(" ")).join("; ")}); ${next}. Press the button again for what is left.`;
  }
  return (
    <div className="inset p-4 mt-3" role="alert">
      <p className="font-semibold text-text">{money}</p>
      <p className="text-text-2 mt-1 leading-snug">{reasonSentence(failure)}</p>
      {sig && (
        <p className="text-text-3 mt-2 mono break-all">
          Signature {shortAddr(sig, 8, 8)}.{" "}
          <a className="underline" href={explorerUrl("tx", sig)} target="_blank" rel="noreferrer">
            Open it on the explorer
          </a>
          .
        </p>
      )}
      {failure.kind === "unknown" && (
        <p className="text-text-2 mt-2 leading-snug">Check your wallet&apos;s activity before retrying. A second try can&apos;t be paid twice.</p>
      )}
      {(onRetry || onCheck) && (
        <div className="flex flex-col gap-2 mt-3 sm:flex-row">
          {onRetry && failure.kind === "nothingSent" && (
            <button type="button" className="btn btn-secondary flex-1" onClick={onRetry}>
              Try again
            </button>
          )}
          {onCheck && failure.kind !== "nothingSent" && (
            <button type="button" className="btn btn-secondary flex-1" onClick={onCheck}>
              Read the chain again
            </button>
          )}
        </div>
      )}
    </div>
  );
}
