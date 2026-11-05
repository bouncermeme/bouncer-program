/*
  The creator's wallet age behind a launch page (the founder, 2026-10-20), read
  once for everyone. Who the creator is comes from the launch's own snapshot
  (cached per launch), never from the caller, so the route walks only wallets
  that created a launch of this program. The walk (../walletAge.ts) is at
  most AGE_MAX_PAGES signature pages, charged to the day like every server
  read (snapshot.ts installs the metered fetch).

  Kept per creator: a complete answer never changes (a wallet's first
  transaction stays its first), so it is kept for as long as the instance
  lives; one that stopped at the page limit is read again after
  PARTIAL_KEEP_MS. Simultaneous misses share one walk. The endpoint puts
  the answer at the CDN on top of this.
*/
import { PublicKey } from "@solana/web3.js";
import { decodeLaunch } from "../chain/decode";
import { getConnection } from "../chain/rpc";
import { readWalletAge, type SignaturePage, type WalletAge } from "../walletAge";
import { readSnapshot } from "./snapshot";

const PARTIAL_KEEP_MS = 6 * 60 * 60_000;
const MAX_KEPT = 5_000;

export interface CreatorAge {
  id: string;
  creator: string;
  age: WalletAge;
  source: "chain" | "stale";
}

/* What the read needs, so a check can run it against a stub (no network). */
export interface WalletAgeDeps {
  snapshot: typeof readSnapshot;
  page: (address: string) => SignaturePage;
  now: () => number;
}
const DEFAULT_DEPS: WalletAgeDeps = {
  snapshot: readSnapshot,
  page: (address) => {
    const key = new PublicKey(address);
    return (before) => getConnection().getSignaturesForAddress(key, { before, limit: 1000 }, "confirmed");
  },
  now: () => Date.now(),
};
let currentDeps: WalletAgeDeps = DEFAULT_DEPS;

/* For a check of the endpoint: what the read uses when the route calls it with no deps; undefined restores the real ones. */
export function setWalletAgeDeps(deps?: WalletAgeDeps): void {
  currentDeps = deps ?? DEFAULT_DEPS;
}

const kept = new Map<string, { at: number; value: Promise<WalletAge> }>();

/* Null when the id names no readable launch. */
export async function readCreatorAge(id: string, deps: WalletAgeDeps = currentDeps): Promise<CreatorAge | null> {
  const s = await deps.snapshot(id);
  const launch = s.launch ? decodeLaunch(id, Uint8Array.from(Buffer.from(s.launch.data, "base64"))) : null;
  if (!launch) return null;
  const creator = launch.creator;
  const hit = kept.get(creator);
  let value: Promise<WalletAge>;
  if (hit) {
    const done = await hit.value.then((a) => a.complete, () => false);
    if (done || deps.now() - hit.at < PARTIAL_KEEP_MS) value = hit.value;
    else value = walk(creator, deps);
  } else value = walk(creator, deps);
  return { id, creator, age: await value, source: s.source };
}

function walk(creator: string, deps: WalletAgeDeps): Promise<WalletAge> {
  const value = readWalletAge(creator, deps.page(creator));
  const entry = { at: deps.now(), value };
  if (kept.size >= MAX_KEPT) kept.clear();
  kept.set(creator, entry);
  value.catch(() => {
    if (kept.get(creator) === entry) kept.delete(creator);
  });
  return value;
}

/* For a check: forget every kept age. */
export function forgetWalletAges(): void {
  kept.clear();
}
