/*
  A launch's whole history for everyone (2026-10-15, Phase C): every event
  of every landed transaction that touched it, oldest first, read on the
  server (server/history.ts) and kept at the CDN for 20 s while the launch
  moves and 10 minutes once it is final. Before, each settlement page read
  it transaction by transaction for itself. 404 without a server RPC.

  Every answer leaves through the output policy (server/output.ts); a spent
  read budget (server/budget.ts) serves the last history read, marked stale.
*/
import { isPubkey, serverHasRpc } from "@/lib/bouncer/server/snapshot";
import { readLaunchHistory } from "@/lib/bouncer/server/history";
import { answer, fail, route } from "@/lib/bouncer/server/output";
import { isBudgetExhausted } from "@/lib/bouncer/server/budget";
import { isLaunch, OutOfScope, parseHints } from "@/lib/bouncer/server/scope";

/* A read through getTransactionsForAddress takes seconds; one transaction at a time (an RPC without it) can take the whole minute. */
export const maxDuration = 60;

const CACHE_LIVE = "public, max-age=0, s-maxage=20, stale-while-revalidate=40";
const CACHE_FINAL = "public, max-age=0, s-maxage=600, stale-while-revalidate=1200";
const CACHE_STALE = "public, max-age=0, s-maxage=20";

export const GET = route(async (req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> => {
  if (!serverHasRpc()) return fail("notFound");
  const { id } = await ctx.params;
  if (!isPubkey(id)) return fail("badAddress");
  try {
    /* Bouncer data only (server/scope.ts): not one of the program's launches, nothing is read. */
    if (!(await isLaunch(id, parseHints(req.headers)))) return fail("badAddress");
    const h = await readLaunchHistory(id);
    return answer(h, { cache: h.source === "stale" ? CACHE_STALE : h.final ? CACHE_FINAL : CACHE_LIVE });
  } catch (e) {
    if (e instanceof OutOfScope) return fail("badAddress");
    return fail(isBudgetExhausted(e) ? "budgetSpent" : "rpcDown");
  }
});
