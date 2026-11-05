/*
  Round 28c (Opus M1, Fable F4, Terra T12; the founder's GO, 2026-10-28): the clock every chain timing on the site reads, the
  close_ts builder, the countdowns and the window checks. It is the cluster's clock: the block time of a recent
  confirmed slot (the stake-weighted time the program's Clock sysvar gives create_launch and commit), carried forward
  by this device's elapsed time. Until a read has answered, or when it never does, it is this device's clock, as before.

  Dispatch, 2026-10-28 (the founder's caching rule of 2026-10-24: live data from shared cached snapshots, never per-visitor
  RPC): the cluster is read by the server once for everyone (app/api/time, server/sendContext.ts readClusterAnchor, at
  most every 5 s an instance, the answer kept 1 s at the CDN); a page reads only that answer, never the RPC. The answer
  is set against the middle of its request, and a CDN copy's Age is added. A read slower than MAX_RTT_MS, or one that
  puts the cluster more than a week from this device, is not taken. Read again every RESYNC_MS while a clock is on
  screen, and before each create.
*/

export const RESYNC_MS = 5 * 60_000;
/* After a read that failed, the next try waits this long (the countdowns ask every second). */
export const RETRY_MS = 60_000;
export const READ_MS = 5_000;
export const MAX_RTT_MS = 5_000;
const MAX_OFFSET_MS = 7 * 86_400_000;

/* One read of the cluster's clock: the cluster's time in ms as the shared answer gives it, and this device's clock around the request. */
export interface ClusterTime {
  clusterMs: number;
  sentAt: number;
  receivedAt: number;
}
export type ClusterTimeReader = () => Promise<ClusterTime | null>;

/* How far the cluster's clock is ahead of this device's, in ms, from one read; null when the read is not usable. */
export function clusterOffsetMs(t: ClusterTime): number | null {
  const { clusterMs, sentAt, receivedAt } = t;
  if (!Number.isFinite(clusterMs) || clusterMs <= 0 || !Number.isFinite(sentAt) || !Number.isFinite(receivedAt)) return null;
  if (receivedAt < sentAt || receivedAt - sentAt > MAX_RTT_MS) return null;
  const offset = Math.round(clusterMs - (sentAt + receivedAt) / 2);
  return Math.abs(offset) > MAX_OFFSET_MS ? null : offset;
}

let offsetMs = 0;
let syncedAt: number | null = null;
let failedAt: number | null = null;
let inflight: Promise<boolean> | null = null;

/* The network clock now, in ms: this device's clock plus the cluster's measured lead (none until a read has answered). */
export function networkNowMs(device: number = Date.now()): number {
  return device + offsetMs;
}

/* The network clock now, in unix seconds. */
export function networkNowSec(): number {
  return Math.floor(networkNowMs() / 1000);
}

/* What the clock is running on: the cluster's lead and when it was read, or the device alone. */
export function networkClock(): { offsetMs: number; source: "cluster" | "device"; syncedAt: number | null } {
  return { offsetMs, source: syncedAt === null ? "device" : "cluster", syncedAt };
}

/* The shared answer (app/api/time). A CDN copy's Age (whole seconds) is the time since the server made it. */
export const TIME_ROUTE = "/api/time";
export function clusterTimeFrom(body: unknown, age: string | null, sentAt: number, receivedAt: number): ClusterTime | null {
  const ms = body && typeof body === "object" ? (body as { clusterMs?: unknown }).clusterMs : undefined;
  if (typeof ms !== "number" || !Number.isFinite(ms)) return null;
  const ageSec = age !== null && /^\d{1,4}$/.test(age.trim()) ? Number(age.trim()) : 0;
  return { clusterMs: ms + ageSec * 1000, sentAt, receivedAt };
}
const readCluster: ClusterTimeReader = async () => {
  if (typeof window === "undefined") return null;
  const sentAt = Date.now();
  const res = await fetch(TIME_ROUTE);
  const receivedAt = Date.now();
  if (!res.ok) return null;
  return clusterTimeFrom(await res.json(), res.headers.get("age"), sentAt, receivedAt);
};

function bounded<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      () => {
        clearTimeout(timer);
        resolve(null);
      },
    );
  });
}

/*
  Read the cluster's clock unless a read younger than maxAgeMs stands (or one failed within RETRY_MS). True when the
  clock runs on the cluster after it. Never throws and never takes longer than READ_MS: the device clock stands in.
*/
export function syncNetworkClock(opts: { maxAgeMs?: number; read?: ClusterTimeReader; now?: () => number } = {}): Promise<boolean> {
  const now = opts.now ?? Date.now;
  const maxAge = opts.maxAgeMs ?? RESYNC_MS;
  if (syncedAt !== null && now() - syncedAt < maxAge) return Promise.resolve(true);
  if (inflight) return inflight;
  if (failedAt !== null && now() - failedAt < RETRY_MS) return Promise.resolve(syncedAt !== null);
  const read = opts.read ?? readCluster;
  const p = bounded(read(), READ_MS).then((t) => {
    const offset = t ? clusterOffsetMs(t) : null;
    if (offset === null) {
      failedAt = now();
      return syncedAt !== null;
    }
    offsetMs = offset;
    syncedAt = now();
    failedAt = null;
    return true;
  });
  inflight = p;
  void p.finally(() => {
    if (inflight === p) inflight = null;
  });
  return p;
}

/* For the checks: back to the device clock, nothing read. */
export function resetNetworkClock(): void {
  offsetMs = 0;
  syncedAt = null;
  failedAt = null;
  inflight = null;
}
