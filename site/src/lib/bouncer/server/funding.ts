/*
  The funding report of a settled launch's winners, walked once for everyone
  (2026-10-15, Phase C). Before, every settlement page walked the winners'
  wallets itself: up to 2 signature pages and 24 transactions per winner,
  38 transaction reads a minute per visitor on the measured page. Here the
  server walks them (funding.ts, the same walk, the same report) and the
  endpoint (app/api/launch/[id]/funding) keeps the answer at the CDN for 10
  minutes.

  Who the winners are is the server's finding, never the caller's list
  (2026-10-16, GPT-6's A2: a list of 200 arbitrary wallets made a fresh
  walk per distinct set). They come from the launch's own history (the
  Delivered events that were not a loser's; server/history.ts, cached per
  launch), the creator is dropped as the page drops them (book.ts
  fundingWinners), at most MAX_WINNERS are walked, and the report is kept
  per launch: one walk per launch per KEEP_MS per instance, whatever anyone
  asks.

  Two steps, in this order (GPT-6's N2 and N3, the same day): readWinners
  is the cheap one, the snapshot and the history, both cached per launch,
  and it is what the endpoint checks a caller's list against and what it
  refuses on before any wallet is walked; readFunding is the paid one, the
  walk, and it never runs for a request the endpoint refused. A history
  that did not reach the launch's creation names no complete set, so the
  endpoint answers 409 (try again) rather than walk a partial set or trust
  a caller's list against one.
*/
import { walkFunding, type FundingProvider, type FundingReport } from "../funding";
import { KNOWN_WALLETS } from "../knownWallets";
import { rpcFundingProvider } from "../rpcFunding";
import { connectionFetch, getConnection } from "../chain/rpc";
import { decodeLaunch } from "../chain/decode";
import type { DecodedEvent } from "../chain/events";
import { readLaunchHistory } from "./history";
import { readSnapshot } from "./snapshot";

const KEEP_MS = 10 * 60_000;
/* Winners walked per launch at most, in the history's delivery order; a report of a bigger launch says which were walked. */
export const MAX_WINNERS = 200;

export interface LaunchWinners {
  /* The chain, or stale when the snapshot or the history it was read from was (server/budget.ts). */
  source: "chain" | "stale";
  /* Every winner the history shows, the creator included, sorted. */
  winners: string[];
  /* The winners a report covers: the creator dropped, capped at MAX_WINNERS, sorted. */
  walked: string[];
  /* True when the history reached the launch's creation, so `winners` is the whole set. */
  complete: boolean;
  final: boolean;
  /* The launch's creator, when the launch exists, and whether its settlement record does (no record: nothing to walk). */
  creator: string | null;
  hasRecord: boolean;
}

export interface LaunchFunding extends LaunchWinners {
  report: FundingReport | null;
}

/* What the reads need, so a check can run them against a stub (no network). */
export interface FundingDeps {
  snapshot: typeof readSnapshot;
  history: typeof readLaunchHistory;
  walk: typeof walkFunding;
  provider: () => FundingProvider;
  now: () => number;
}
const DEFAULT_DEPS: FundingDeps = {
  snapshot: readSnapshot,
  history: readLaunchHistory,
  walk: walkFunding,
  /* The server's RPC is keyed: shorter pauses and bigger batches than a browser's walk, well under 50 requests a second. */
  provider: () => rpcFundingProvider(getConnection(), { pauseMs: 100, batchSize: 8 }, connectionFetch()),
  now: () => Date.now(),
};

/* The winners by the history: every bidder a Delivered event names, a loser's delivery (a refund at settle) excepted. Delivery order kept, each once. */
export function winnersOf(events: readonly DecodedEvent[]): string[] {
  const out: string[] = [];
  for (const e of events) {
    if (e.name !== "Delivered" || e.data.loser === true) continue;
    const b = String(e.data.bidder ?? "");
    if (b && !out.includes(b)) out.push(b);
  }
  return out;
}

const reports = new Map<string, { at: number; set: string; value: Promise<FundingReport | null> }>();
let currentDeps: FundingDeps = DEFAULT_DEPS;

/* For a check of the endpoint: what the reads use when the route calls them with no deps; undefined restores the real ones. */
export function setFundingDeps(deps?: FundingDeps): void {
  currentDeps = deps ?? DEFAULT_DEPS;
}

/* The cheap step: the snapshot and the history, both cached per launch. No wallet is walked here. */
export async function readWinners(id: string, deps: FundingDeps = currentDeps): Promise<LaunchWinners> {
  const [s, h] = await Promise.all([deps.snapshot(id), deps.history(id)]);
  const launch = s.launch ? decodeLaunch(id, Uint8Array.from(Buffer.from(s.launch.data, "base64"))) : null;
  const ordered = winnersOf(h.events);
  const winners = [...ordered].sort();
  const creator = launch?.creator ?? null;
  const walked = launch && s.record ? ordered.filter((b) => b !== launch.creator).slice(0, MAX_WINNERS).sort() : [];
  return { winners, walked, complete: h.complete, final: s.final, creator, hasRecord: s.record !== null, source: s.source === "stale" || h.source === "stale" ? "stale" : "chain" };
}

/* The paid step: the walk over `walked`, one per launch per KEEP_MS per instance. The endpoint calls this only for a request it did not refuse. */
export async function readFunding(id: string, deps: FundingDeps = currentDeps): Promise<LaunchFunding> {
  const w = await readWinners(id, deps);
  if (w.creator === null || !w.hasRecord || w.walked.length === 0) return { ...w, report: null };
  const set = w.walked.join(",");
  const hit = reports.get(id);
  let value: Promise<FundingReport | null>;
  if (hit && hit.set === set && deps.now() - hit.at < KEEP_MS) value = hit.value;
  else {
    value = deps.walk({ launchId: id, creator: w.creator, bidders: w.walked, provider: deps.provider(), known: KNOWN_WALLETS, source: "rpc", now: Math.floor(deps.now() / 1000) });
    const entry = { at: deps.now(), set, value };
    reports.set(id, entry);
    value.catch(() => {
      if (reports.get(id) === entry) reports.delete(id);
    });
  }
  return { ...w, report: await value };
}

/* For a check: forget every kept report. */
export function forgetFundingReports(): void {
  reports.clear();
}
