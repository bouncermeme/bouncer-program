/*
  A launch's histogram for everyone (24d, the founder's caching directive; server/snapshot.ts readHistogram): the
  settlement page's clearing figures and self check, read from the server's RPC and kept at the CDN, instead of
  19,272 bytes from the RPC per visitor. Nothing writes the histogram after settle, so a settled launch's answer
  stays an hour; before that, 5 s. 404 without a server RPC, as the RPC route. Every answer leaves through the
  output policy (server/output.ts).
*/
import { isPubkey, readHistogram, serverHasRpc } from "@/lib/bouncer/server/snapshot";
import { answer, fail, route } from "@/lib/bouncer/server/output";
import { isBudgetExhausted } from "@/lib/bouncer/server/budget";
import { isLaunch, OutOfScope, parseHints } from "@/lib/bouncer/server/scope";

export const maxDuration = 20;

const CACHE_SETTLED = "public, max-age=0, s-maxage=3600, stale-while-revalidate=86400";
const CACHE_LIVE = "public, max-age=0, s-maxage=5, stale-while-revalidate=10";
const CACHE_STALE = "public, max-age=0, s-maxage=10";

export const GET = route(async (req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> => {
  if (!serverHasRpc()) return fail("notFound");
  const { id } = await ctx.params;
  if (!isPubkey(id)) return fail("badAddress");
  try {
    /* Bouncer data only (server/scope.ts): not one of the program's launches, nothing is read. */
    if (!(await isLaunch(id, parseHints(req.headers)))) return fail("badAddress");
    const h = await readHistogram(id);
    return answer(h, { cache: h.source === "stale" ? CACHE_STALE : h.settled && h.histogram ? CACHE_SETTLED : CACHE_LIVE });
  } catch (e) {
    if (e instanceof OutOfScope) return fail("badAddress");
    return fail(isBudgetExhausted(e) ? "budgetSpent" : "rpcDown");
  }
});
