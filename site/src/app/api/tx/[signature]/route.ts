/*
  24e (the founder's capacity decisions, item 2): a sent transaction's status, for the signer's confirmation loop
  (chain/signer.ts settle). Every status an instance is asked for within 150 ms is one getSignatureStatuses upstream
  (server/sendContext.ts readStatus), so the RPC cost of a crowd confirming does not grow with the crowd. Any signature
  may be asked: the cost is bounded by the batching, not by the caller. Kept at the CDN for 1 s while it is still moving,
  a minute once finalized (server/statusCache.ts; 24g, Astra 24f R7-M3: an error alone is not final).

  Every answer leaves through the output policy (server/output.ts): the node's error typed, never its text.
*/
import bs58 from "bs58";
import { serverHasRpc } from "@/lib/bouncer/server/snapshot";
import { readStatus } from "@/lib/bouncer/server/sendContext";
import { answer, fail, route } from "@/lib/bouncer/server/output";
import { isBudgetExhausted, isRateLimited } from "@/lib/bouncer/server/budget";
import { statusCache } from "@/lib/bouncer/server/statusCache";

export const maxDuration = 10;

const SIGNATURE = /^[1-9A-HJ-NP-Za-km-z]{86,88}$/;
/* 64 bytes in base58: anything else the node refuses, and the whole batch with it. */
function isSignature(s: string): boolean {
  if (!SIGNATURE.test(s)) return false;
  try {
    return bs58.decode(s).length === 64;
  } catch {
    return false;
  }
}

export const GET = route(async (_req: Request, ctx: { params: Promise<{ signature: string }> }): Promise<Response> => {
  if (!serverHasRpc()) return fail("notFound");
  const { signature } = await ctx.params;
  if (!isSignature(signature)) return fail("badSignature");
  try {
    const s = await readStatus(signature);
    return answer(s, { cache: statusCache(s.status) });
  } catch (e) {
    return fail(isBudgetExhausted(e) ? "budgetSpent" : isRateLimited(e) ? "rpcBusy" : "rpcDown");
  }
});
