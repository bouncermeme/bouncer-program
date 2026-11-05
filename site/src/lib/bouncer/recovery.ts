"use client";

/*
  The recovery fixes 9A, 9C and 9D (the founder, 2026-10-27, review/2026-10-27-v030/FOUNDER-UI-DECISIONS.md item 9;
  the mocks and their figures in mocks-ui/README.md section 9, the 24n report's b4).

  9A: "Recover deposit" names everything the refund pays back: the deposit, the processing charge (returned when
  nobody opened the bid) and the bid account's rent, to the lamport (solExact). b4: 17,683,840 + 10,000 + 2,296,160
  = 0.01999 SOL, where the old figure, the deposit alone in the three-decimal format, read 0.018 SOL.

  9C: once the refund lands, "Recovered: X is back in your wallet." says what the wallet actually gained: the signer's
  balance after the transaction less before it, read from the landed transaction (the refund less the network fee;
  b4: 0.019985 SOL). Until that read answers, the line keeps its old words, "your deposit".

  9D: the receipt is kept per wallet and launch, here, not in the component that sent it. The recover notice and the
  refund view both read it, so the switch to the Aborted view (the recovery cancels the launch) and a reload keep it,
  and the refund view never says "did not bid" to a wallet that holds one. It lives in this browser only
  (localStorage, every access guarded) and holds only what the landed transaction proved: its signature, its slot,
  the deposit as it was and the net once read.
*/
import { useCallback, useEffect, useSyncExternalStore } from "react";
import { CLUSTER } from "@contract/active";
import { getClient } from "./client";
import type { BidAccount } from "./types";

export { balanceChange } from "./chain/balance";

export interface RecoveryReceipt {
  /* Which button sent it: RecoverNotice's "Recover deposit" (9A/9C) or RefundView's "Refund". */
  via: "recover" | "refund";
  signature: string;
  slot: number | null;
  /* The bid's deposit as it was before the refund closed the account. */
  deposit: bigint;
  /* The signer's balance change in the landed transaction; null until read. */
  net: bigint | null;
}

/* 9A: what the refund pays back: the deposit, the processing charge (zeroed when a reveal paid it) and the bid account's rent. */
export function recoverBack(bid: Pick<BidAccount, "deposit" | "processingCharge">, bidRent: bigint): bigint {
  return bid.deposit + bid.processingCharge + bidRent;
}

/* ---------- the receipt store ---------- */

const PREFIX = "bouncer.recovery.v1";
const SIGNATURE = /^[1-9A-HJ-NP-Za-km-z]{64,88}$/;
const INTEGER = /^-?\d{1,20}$/;

const keyOf = (launchId: string, wallet: string) => `${PREFIX}:${CLUSTER}:${launchId}:${wallet}`;
/* What this page holds per key: undefined before the first look in storage, null when there is none. One object per receipt, so useSyncExternalStore sees a stable snapshot. */
const held = new Map<string, RecoveryReceipt | null>();
const listeners = new Set<() => void>();
/* Keys whose net is being read (or was read and stayed unknown) in this page's life: one read each. */
const netReads = new Set<string>();

function parse(raw: string | null): RecoveryReceipt | null {
  if (!raw) return null;
  try {
    const o = JSON.parse(raw) as Record<string, unknown>;
    if (o.via !== "recover" && o.via !== "refund") return null;
    if (typeof o.signature !== "string" || !SIGNATURE.test(o.signature)) return null;
    if (o.slot !== null && !(typeof o.slot === "number" && Number.isSafeInteger(o.slot) && o.slot >= 0)) return null;
    if (typeof o.deposit !== "string" || !INTEGER.test(o.deposit)) return null;
    if (o.net !== null && !(typeof o.net === "string" && INTEGER.test(o.net))) return null;
    return { via: o.via, signature: o.signature, slot: o.slot as number | null, deposit: BigInt(o.deposit), net: o.net === null ? null : BigInt(o.net as string) };
  } catch {
    return null;
  }
}

function stored(key: string): RecoveryReceipt | null {
  try {
    return parse(window.localStorage.getItem(key));
  } catch {
    return null;
  }
}

export function readReceipt(launchId: string, wallet: string): RecoveryReceipt | null {
  const key = keyOf(launchId, wallet);
  let r = held.get(key);
  if (r === undefined) {
    r = typeof window === "undefined" ? null : stored(key);
    held.set(key, r);
  }
  return r;
}

export function saveReceipt(launchId: string, wallet: string, r: RecoveryReceipt): void {
  const key = keyOf(launchId, wallet);
  held.set(key, r);
  try {
    window.localStorage.setItem(key, JSON.stringify({ ...r, deposit: r.deposit.toString(), net: r.net === null ? null : r.net.toString() }));
  } catch {
    /* This page still holds it; a reload will not. */
  }
  for (const l of listeners) l();
}

/* 9C: read the net once for a receipt that has none (just landed, or saved before the read answered), then keep it. */
function fillNet(launchId: string, wallet: string, r: RecoveryReceipt): void {
  const key = keyOf(launchId, wallet);
  if (r.net !== null || netReads.has(key)) return;
  netReads.add(key);
  void getClient()
    .walletChange(r.signature, wallet)
    .then(
      (net) => {
        const now = readReceipt(launchId, wallet);
        if (net !== null && net > 0n && now && now.signature === r.signature) saveReceipt(launchId, wallet, { ...now, net });
      },
      () => {},
    );
}

/* The receipt for this launch and wallet, shared by every component that asks; null with no wallet. */
export function useRecoveryReceipt(launchId: string, wallet: string | null): [RecoveryReceipt | null, (r: RecoveryReceipt) => void] {
  const subscribe = useCallback((cb: () => void) => {
    listeners.add(cb);
    return () => {
      listeners.delete(cb);
    };
  }, []);
  const getSnapshot = useCallback(() => (wallet ? readReceipt(launchId, wallet) : null), [launchId, wallet]);
  const getServerSnapshot = useCallback(() => null, []);
  const receipt = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  useEffect(() => {
    if (wallet && receipt && receipt.net === null) fillNet(launchId, wallet, receipt);
  }, [launchId, wallet, receipt]);
  const save = useCallback((r: RecoveryReceipt) => {
    if (!wallet) return;
    saveReceipt(launchId, wallet, r);
    fillNet(launchId, wallet, r);
  }, [launchId, wallet]);
  return [receipt, save];
}
