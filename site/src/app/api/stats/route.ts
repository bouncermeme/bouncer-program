/*
  /stats' totals for everyone (22e3, the founder 2026-10-23; 23c: one shared snapshot): sums over the chain index
  (server/chainIndex.ts, server/stats.ts). Lamports as strings, counts as numbers, the slot and the read time beside
  them, so the page can show how old the figures are. 404 without a server RPC; a failed read is a failure, never
  zeros.

  23c: the totals are kept in the shared store for SNAPSHOT_SECS. Whichever instance finds them older reads the index
  and writes them back, so a flood across many instances costs at most one index read per instance a minute (the
  index's own coalescing and fleet budget) and usually none. Kept at the CDN for 5 minutes too; the proxy limits it
  per address (the "stats" class).

  Every answer leaves through the output policy (server/output.ts).
*/
import { readChainIndex, chainIndexAvailable } from "@/lib/bouncer/server/chainIndex";
import { statsOf } from "@/lib/bouncer/server/stats";
import { kvFromEnv, kvKey } from "@/lib/bouncer/server/kv";
import { answer, fail, route } from "@/lib/bouncer/server/output";
import { isBudgetExhausted } from "@/lib/bouncer/server/budget";
import { CLUSTER } from "@contract/active";

export const maxDuration = 30;

const CACHE = "public, max-age=0, s-maxage=300, stale-while-revalidate=600";
const CACHE_STALE = "public, max-age=0, s-maxage=60";
const SNAPSHOT_SECS = 300;

export const GET = route(async (): Promise<Response> => {
  if (!chainIndexAvailable()) return fail("notFound");
  const kv = kvFromEnv();
  const key = kvKey("stats", "v2", CLUSTER);
  if (kv) {
    try {
      const kept = await kv(["GET", key]);
      if (typeof kept === "string") {
        const j = JSON.parse(kept) as { readAt?: number; source?: string };
        if (typeof j.readAt === "number" && Date.now() - j.readAt < SNAPSHOT_SECS * 1000 && j.source === "chain") return answer(j, { cache: CACHE });
      }
    } catch {
      /* the store unread: read the index ourselves */
    }
  }
  try {
    const index = await readChainIndex();
    const t = statsOf(index);
    const body = {
      cluster: CLUSTER,
      slot: index.slot,
      readAt: index.readAt,
      source: index.source,
      launches: t.launches,
      cleared: t.cleared,
      ended: t.ended,
      live: t.live,
      bids: t.bids,
      raised: t.raised.toString(),
      locked: t.locked.toString(),
      refunded: t.refunded.toString(),
      refundLosing: t.refundLosing.toString(),
      refundChange: t.refundChange.toString(),
      refundFailed: t.refundFailed.toString(),
      toCreators: t.toCreators.toString(),
    };
    if (kv && index.source === "chain") await kv(["SET", key, JSON.stringify(body), "EX", 2 * SNAPSHOT_SECS]).catch(() => undefined);
    return answer(body, { cache: index.source === "stale" ? CACHE_STALE : CACHE });
  } catch (e) {
    return fail(isBudgetExhausted(e) ? "budgetSpent" : "rpcDown");
  }
});
