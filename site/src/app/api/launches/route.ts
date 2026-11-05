/*
  The board for everyone (24d, the founder's caching directive; server/snapshot.ts readBoard): every launch's accounts as
  bytes, read from the server's RPC and kept at the CDN, so the home page's live cards and the launch page's creator
  panel cost the RPC one read per cache period per region, not one per visitor every 30 s.

    GET                  { slot, readAt, live: [{ launch, record }], finals: [id], source }   the CDN 2 s
    GET ?set=final       { launches: [{ launch, record }], source }                            the CDN 60 s
    GET ?set=pools       { slot, readAt, pools: [account], source }                            the CDN 2 s
                         (every trading pool the records name: the home cards' market caps)

  404 without a server RPC, as the RPC route. Every answer leaves through the output policy (server/output.ts); when
  the day's read budget is spent the reader serves what it last read, marked stale, on a short period.
*/
import { readBoard, readBoardPools, readFinalBoard, serverHasRpc } from "@/lib/bouncer/server/snapshot";
import { isBudgetExhausted } from "@/lib/bouncer/server/budget";
import { answer, fail, route } from "@/lib/bouncer/server/output";

export const maxDuration = 20;

/* 24n (plan fix 2): 2 s, stale for at most 1 s more (was 10), so the board polling every 3 s shows a new launch or bid within about 3 s. */
const CACHE_LIVE = "public, max-age=0, s-maxage=2, stale-while-revalidate=1";
const CACHE_FINAL = "public, max-age=0, s-maxage=60, stale-while-revalidate=300";
const CACHE_STALE = "public, max-age=0, s-maxage=10";

export const GET = route(async (req: Request): Promise<Response> => {
  if (!serverHasRpc()) return fail("notFound");
  const set = new URL(req.url).searchParams.get("set");
  try {
    if (set === "pools") {
      const p = await readBoardPools();
      return answer(p, { cache: p.source === "stale" ? CACHE_STALE : CACHE_LIVE });
    }
    if (set === "final") {
      const f = await readFinalBoard();
      return answer(f, { cache: f.source === "stale" ? CACHE_STALE : CACHE_FINAL });
    }
    const b = await readBoard();
    return answer(b, { cache: b.source === "stale" ? CACHE_STALE : CACHE_LIVE });
  } catch (e) {
    return fail(isBudgetExhausted(e) ? "budgetSpent" : "rpcDown");
  }
});
