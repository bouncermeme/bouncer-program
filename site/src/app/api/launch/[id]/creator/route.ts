/*
  The age of a launch's creator wallet for everyone (the founder, 2026-10-20, the
  creator panel on the launch page): the time of its first transaction as
  far as the server's RPC reaches, read once per creator (server/walletAge.ts)
  and kept at the CDN. The wallet is the launch's own creator, read from the
  launch; the caller names only the launch, so nothing else can be walked
  through here. 404 without a server RPC, as the RPC route.

  A complete answer never changes and stays at the CDN for a day; one that
  stopped at the page limit for an hour. Every answer leaves through the
  output policy (server/output.ts).
*/
import { isPubkey, serverHasRpc } from "@/lib/bouncer/server/snapshot";
import { readCreatorAge } from "@/lib/bouncer/server/walletAge";
import { answer, fail, route } from "@/lib/bouncer/server/output";
import { isBudgetExhausted } from "@/lib/bouncer/server/budget";
import { isLaunch, OutOfScope, parseHints } from "@/lib/bouncer/server/scope";

export const maxDuration = 30;

const CACHE_COMPLETE = "public, max-age=3600, s-maxage=86400, stale-while-revalidate=86400";
const CACHE_PARTIAL = "public, max-age=600, s-maxage=3600, stale-while-revalidate=3600";
const CACHE_STALE = "public, max-age=0, s-maxage=60";

export const GET = route(async (req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> => {
  if (!serverHasRpc()) return fail("notFound");
  const { id } = await ctx.params;
  if (!isPubkey(id)) return fail("badAddress");
  try {
    /* Bouncer data only (server/scope.ts): not one of the program's launches, nothing is read. */
    if (!(await isLaunch(id, parseHints(req.headers)))) return fail("badAddress");
    const c = await readCreatorAge(id);
    if (!c) return fail("badAddress");
    return answer({ id, creator: c.creator, firstTs: c.age.firstTs, complete: c.age.complete, transactions: c.age.transactions, readAt: Date.now() }, { cache: c.source === "stale" ? CACHE_STALE : c.age.complete ? CACHE_COMPLETE : CACHE_PARTIAL });
  } catch (e) {
    if (e instanceof OutOfScope) return fail("badAddress");
    return fail(isBudgetExhausted(e) ? "budgetSpent" : "rpcDown");
  }
});
