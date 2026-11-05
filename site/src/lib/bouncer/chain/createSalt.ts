/*
  The mint salt of a creation attempt that has not been seen to land
  (2026-09-29). The salt fixes the mint, and so the launch's address, so a
  retry that reuses it is idempotent: if the first attempt landed after all,
  the retry is refused because the account exists, instead of creating a
  second launch that costs the creator 0.0508 SOL of rent for good and holds
  a second bond until the valve. It is written down before anything is sent
  and forgotten only once a launch is confirmed on chain.

  Kept per creator in this browser (localStorage), and in memory as well for
  a browser that refuses storage, so a reload or a retry after a timeout
  finds it.

  2026-10-29 (the founder's RFOR, launch DPqKSAFy…): a salt is kept with the time it
  was taken and is only reused within PENDING_SALT_MAX_AGE_MS. A create whose
  outcome the page never saw left R2's salt here a day earlier; the next
  create by that wallet found R2's launch at that address and went to it, with
  nothing sent. An attempt can land only while its creation permit lives,
  which is under the 60 minute window ceiling after the salt was taken
  (v0.31: the close at most build + 3,600 s, the permit dead at close − 240 +
  30), so an older salt is never an attempt still in flight. An older one, or
  one stored without its time (before this change), is forgotten and the
  create takes a new salt.
*/
import { WINDOW } from "@contract/constants";

const KEY = (creator: string) => `bouncer:create-salt:v1:${creator}`;
export const PENDING_SALT_MAX_AGE_MS: number = WINDOW.maxWindowSecs * 1_000;

interface Pending {
  salt: bigint;
  at: number;
}
const memory = new Map<string, Pending>();

/* "<salt>@<ms>"; anything else (a bare salt from before 2026-10-29) is null, and so stale. */
function parse(v: string): Pending | null {
  const m = /^(\d+)@(\d+)$/.exec(v);
  return m ? { salt: BigInt(m[1]), at: Number(m[2]) } : null;
}

export function pendingSalt(creator: string, nowMs: number = Date.now()): bigint | null {
  let stored: string | null = null;
  try {
    stored = globalThis.localStorage?.getItem(KEY(creator)) ?? null;
  } catch {}
  const p = stored !== null ? parse(stored) : (memory.get(creator) ?? null);
  if (p && Math.abs(nowMs - p.at) < PENDING_SALT_MAX_AGE_MS) return p.salt;
  if (stored !== null || p) clearPendingSalt(creator);
  return null;
}

/* A fresh salt, stored before it is used. Any u64 the creator has not used: random, so two launches by one wallet never collide. */
export function newPendingSalt(creator: string, nowMs: number = Date.now()): bigint {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  const salt = new DataView(bytes.buffer).getBigUint64(0, true);
  memory.set(creator, { salt, at: nowMs });
  try {
    globalThis.localStorage?.setItem(KEY(creator), `${salt}@${nowMs}`);
  } catch {}
  return salt;
}

export function clearPendingSalt(creator: string): void {
  memory.delete(creator);
  try {
    globalThis.localStorage?.removeItem(KEY(creator));
  } catch {}
}

/* A throwaway salt for a simulation, never stored: nothing is sent with it. */
export function simulationSalt(): bigint {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return new DataView(bytes.buffer).getBigUint64(0, true);
}
