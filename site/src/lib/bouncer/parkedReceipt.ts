"use client";

import { useSyncExternalStore } from "react";

/*
  v0.32: a collect this page made, per launch and wallet. The bid account closes with it, so the box that showed the
  Collect button keeps the result ("Collected ...") from here, wherever on the page it stands (the trade page's box, the
  winner box, the refund box). In memory only: after a reload the bid's own history says what happened.
*/
export interface ParkedReceipt {
  signature: string;
  tokens: bigint;
  lamports: bigint;
}

const receipts = new Map<string, ParkedReceipt>();
const listeners = new Set<() => void>();
const keyOf = (launchId: string, address: string) => `${launchId}:${address}`;

export function setParkedReceipt(launchId: string, address: string, r: ParkedReceipt): void {
  receipts.set(keyOf(launchId, address), r);
  listeners.forEach((l) => l());
}

export function getParkedReceipt(launchId: string, address: string | null): ParkedReceipt | null {
  return address ? (receipts.get(keyOf(launchId, address)) ?? null) : null;
}

export function useParkedReceipt(launchId: string, address: string | null): ParkedReceipt | null {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => getParkedReceipt(launchId, address),
    () => null,
  );
}
