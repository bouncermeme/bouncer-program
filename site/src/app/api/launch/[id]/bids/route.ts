/*
  A launch's bid accounts for everyone (2026-10-15, Phase C): one
  getProgramAccounts on the server per cache period, 5 s while bids can
  still move and 5 minutes once the launch is final, instead of one per
  visitor per look (3 on one load of the auction page). 404 without a
  server RPC.

  Every answer leaves through the output policy (server/output.ts); a spent
  read budget (server/budget.ts) serves the last list read, marked stale.

  In pages (2026-10-20, S4; lib/bouncer/bidPages.ts): BID_PAGE bids in
  address order, ?after=<address> for the next, `next` null on the last.
  The whole list is one read on the server whichever page is asked for.

  24n (plan fix 4, the live deposit feed): ?recent=<n> (1 to 20) answers the newest n deposits by placed_ts, with the
  list's length, about 3 KB where the whole list is about 300 KB at 1,000 bids; `v` (the slot of the browser's copy of
  the launch) only keys the CDN's copy, so a feed that saw the launch move never gets the copy from before it. The
  server scans the bid accounts again only when the launch moved (server/snapshot.ts readBids). While bids can move the
  CDN keeps an answer 1 s (was 5 s).

  24o (F4): while bids can move, no stale-while-revalidate (step 2), and Server-Timing says how old the answer is
  (step 1, server/timing.ts).
*/
import { isPubkey, readBids, recentOf, RECENT_MAX, serverHasRpc } from "@/lib/bouncer/server/snapshot";
import { answer, fail, route } from "@/lib/bouncer/server/output";
import { isBudgetExhausted } from "@/lib/bouncer/server/budget";
import { isLaunch, OutOfScope, parseHints } from "@/lib/bouncer/server/scope";
import { pageOf } from "@/lib/bouncer/bidPages";
import { snapshotTiming } from "@/lib/bouncer/server/timing";

export const maxDuration = 20;

const CACHE_LIVE = "public, max-age=0, s-maxage=1";
const CACHE_FINAL = "public, max-age=0, s-maxage=300, stale-while-revalidate=600";
const CACHE_STALE = "public, max-age=0, s-maxage=10";

export const GET = route(async (req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> => {
  if (!serverHasRpc()) return fail("notFound");
  const { id } = await ctx.params;
  if (!isPubkey(id)) return fail("badAddress");
  const params = new URL(req.url).searchParams;
  const after = params.get("after");
  if (after !== null && !isPubkey(after)) return fail("badAddress");
  const recentRaw = params.get("recent");
  const recent = recentRaw === null ? null : /^[1-9][0-9]?$/.test(recentRaw) && Number(recentRaw) <= RECENT_MAX ? Number(recentRaw) : NaN;
  const v = params.get("v");
  if (Number.isNaN(recent) || (recent !== null && after !== null) || (v !== null && !/^[0-9]{1,12}$/.test(v))) return fail("badAddress");
  const startedAt = Date.now();
  try {
    /* Bouncer data only (server/scope.ts): not one of the program's launches, nothing is read. */
    if (!(await isLaunch(id, parseHints(req.headers)))) return fail("badAddress");
    const b = await readBids(id);
    const opts = { cache: b.source === "stale" ? CACHE_STALE : b.final ? CACHE_FINAL : CACHE_LIVE, headers: { "server-timing": snapshotTiming(b.readAt, startedAt) } };
    if (recent !== null) return answer({ ...b, bids: recentOf(b.bids, recent), next: null, total: b.bids.length }, opts);
    const page = pageOf(b.bids, after);
    return answer({ ...b, bids: page.items, next: page.next, total: page.total }, opts);
  } catch (e) {
    if (e instanceof OutOfScope) return fail("badAddress");
    return fail(isBudgetExhausted(e) ? "budgetSpent" : "rpcDown");
  }
});
