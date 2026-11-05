"use client";

import { useSyncExternalStore } from "react";

/*
  The last error the wallet adapter reported (a connect the person closed,
  a wallet that would not open), so the connect sheet can say it instead
  of the sheet just closing. The adapter reports through WalletProvider's
  onError; nothing else writes here.
*/
let last: { message: string; at: number } | null = null;
const listeners = new Set<() => void>();

export function reportWalletError(e: unknown): void {
  const raw = e instanceof Error ? e.message : String(e);
  const name = e instanceof Error ? e.name : "";
  let message: string;
  if (/reject|declin|denied|cancel/i.test(raw)) message = "Not connected: the prompt was closed.";
  else if (name === "WalletNotReadyError") message = "That wallet isn't ready. Install or unlock it, then retry.";
  else if (name === "WalletNotSelectedError") message = "No wallet was selected.";
  else if (/not connected/i.test(raw) || name === "WalletNotConnectedError") message = "The wallet is not connected.";
  else message = `Your wallet returned an error: ${raw || name || "unknown"}.`;
  last = { message, at: Date.now() };
  listeners.forEach((l) => l());
}

export function clearWalletError(): void {
  if (!last) return;
  last = null;
  listeners.forEach((l) => l());
}

function subscribe(fn: () => void) {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
const get = () => last;
const none = () => null;

export function useWalletError(): { message: string; at: number } | null {
  return useSyncExternalStore(subscribe, get, none);
}
