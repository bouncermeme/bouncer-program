/*
  One launch's accounts for everyone (2026-10-15, the launch data path's
  Phase C): the launch, its settlement record, the Config and the trading
  pool, as bytes, read from the server's RPC and kept at the CDN for 3 s
  while the launch moves and a minute once it is final. A thousand people
  watching one launch cost the RPC one read per cache period per region,
  not a read each. 404 without a server RPC, as the RPC route.

  Every answer leaves through the output policy (server/output.ts). When
  the day's read budget is spent (server/budget.ts) the reader serves what
  it last read, marked stale, on a short period; with nothing kept, 503.
*/
import { isPubkey, readSnapshot, serverHasRpc } from "@/lib/bouncer/server/snapshot";
import { answer, fail, route } from "@/lib/bouncer/server/output";
import { isBudgetExhausted } from "@/lib/bouncer/server/budget";
import { isLaunch, OutOfScope, parseHints } from "@/lib/bouncer/server/scope";
import { snapshotTiming } from "@/lib/bouncer/server/timing";

export const maxDuration = 20;

/* 24n (plan fix 3): 1 s while the launch moves (was 3 s, with 10 s stale), so a page polling every 2 s is never more than about 2 s behind the chain. 24o (F4, step 2): no stale-while-revalidate while live, so the CDN never answers with a copy past its second. */
const CACHE_LIVE = "public, max-age=0, s-maxage=1";
const CACHE_FINAL = "public, max-age=0, s-maxage=60, stale-while-revalidate=300";
const CACHE_STALE = "public, max-age=0, s-maxage=10";

export const GET = route(async (req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> => {
  if (!serverHasRpc()) return fail("notFound");
  const { id } = await ctx.params;
  if (!isPubkey(id)) return fail("badAddress");
  const startedAt = Date.now();
  try {
    /* Bouncer data only (server/scope.ts): not one of the program's launches, nothing is read. */
    if (!(await isLaunch(id, parseHints(req.headers)))) return fail("badAddress");
    const s = await readSnapshot(id);
    return answer(s, { cache: s.source === "stale" ? CACHE_STALE : s.final ? CACHE_FINAL : CACHE_LIVE, headers: { "server-timing": snapshotTiming(s.readAt, startedAt) } });
  } catch (e) {
    if (e instanceof OutOfScope) return fail("badAddress");
    return fail(isBudgetExhausted(e) ? "budgetSpent" : "rpcDown");
  }
});
