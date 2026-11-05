/*
  The funding report of a launch's winners for everyone (2026-10-15, Phase
  C): the server finds the winners in the launch's own history, walks their
  wallets once (server/funding.ts) and the answer stays at the CDN for 10
  minutes. ?bidders=a,b,c, the page's own list, is checked, never used
  (2026-10-16, GPT-6's A2): a wallet that is not a winner is refused, and no
  list changes what is walked. 404 without a server RPC.

  The order matters (GPT-6's re-review, N2 and N3, the same day): the cheap
  read (readWinners: the snapshot and the history, both cached) comes first;
  an incomplete history is 409 with retry-after and no caching; a list with
  a stranger is 400; only a request that passed both reaches the walk.

  Every answer leaves through the output policy (server/output.ts): the
  failures by kind, the report as a typed body. A spent read budget
  (server/budget.ts) is 503 with retry-after.
*/
import { isPubkey, serverHasRpc } from "@/lib/bouncer/server/snapshot";
import { MAX_WINNERS, readFunding, readWinners } from "@/lib/bouncer/server/funding";
import { answer, fail, route } from "@/lib/bouncer/server/output";
import { isBudgetExhausted } from "@/lib/bouncer/server/budget";
import { isLaunch, OutOfScope, parseHints } from "@/lib/bouncer/server/scope";

export const maxDuration = 60;

const CACHE = "public, max-age=0, s-maxage=600, stale-while-revalidate=1200";
const CACHE_STALE = "public, max-age=0, s-maxage=20";

export const GET = route(async (req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> => {
  if (!serverHasRpc()) return fail("notFound");
  const { id } = await ctx.params;
  const asked = (new URL(req.url).searchParams.get("bidders") ?? "").split(",").filter(Boolean);
  if (!isPubkey(id) || asked.length > MAX_WINNERS || !asked.every(isPubkey)) return fail("badList");
  try {
    /* Bouncer data only (server/scope.ts): not one of the program's launches, nothing is read. */
    if (!(await isLaunch(id, parseHints(req.headers)))) return fail("badList");
    const w = await readWinners(id);
    if (!w.complete) return fail("historyIncomplete");
    /*
      A wallet the server has not seen win. On a launch still delivering, the page's list can be ahead of the server's
      cached history (the e2e test of 2026-10-22: one 400 during SWRM's payouts): that is a history not caught up yet,
      409 with retry-after and nothing walked or cached. On a finalized launch every delivery is in, so it is a stranger: 400.
    */
    if (asked.some((b) => !w.winners.includes(b))) return fail(w.final ? "notWinners" : "historyIncomplete");
    const f = await readFunding(id);
    return answer({ id, winners: f.winners, walked: f.walked, report: f.report, complete: f.complete, readAt: Date.now(), source: f.source }, { cache: f.source === "stale" ? CACHE_STALE : CACHE });
  } catch (e) {
    if (e instanceof OutOfScope) return fail("badList");
    return fail(isBudgetExhausted(e) ? "budgetSpent" : "rpcDown");
  }
});
