/*
  Round 28c (Opus M1, Fable F4, Terra T12; Dispatch 2026-10-28, under the founder's caching rule of 2026-10-24): the
  cluster's clock for every page, from one shared read (server/sendContext.ts readClusterAnchor: the block time of a
  recent confirmed slot, read at most once every 5 s an instance), carried to this answer by the server's elapsed time.
  Kept at the CDN for 1 s. The page's network clock (netClock.ts) offsets from it; no visitor reads the RPC for the time.
  Without it (an RPC that does not answer, no server RPC) the page keeps its device clock.

  Every answer leaves through the output policy (server/output.ts).
*/
import { serverHasRpc } from "@/lib/bouncer/server/snapshot";
import { clusterNowMs, readClusterAnchor } from "@/lib/bouncer/server/sendContext";
import { answer, fail, route } from "@/lib/bouncer/server/output";
import { isBudgetExhausted, isRateLimited } from "@/lib/bouncer/server/budget";

export const maxDuration = 15;

const CACHE = "public, max-age=0, s-maxage=1";

export const GET = route(async (): Promise<Response> => {
  if (!serverHasRpc()) return fail("notFound");
  try {
    const a = await readClusterAnchor();
    return answer({ clusterMs: clusterNowMs(a), slot: a.slot }, { cache: CACHE });
  } catch (e) {
    return fail(isBudgetExhausted(e) ? "budgetSpent" : isRateLimited(e) ? "rpcBusy" : "rpcDown");
  }
});
