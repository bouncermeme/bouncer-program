/*
  24e (the founder's capacity decisions, items 2 and 3): what a bid's send needs, for everyone (server/sendContext.ts): the
  program's deploy slot, the latest blockhash and its last valid height, the block height, and the launch's priority
  price (zero outside the last 90 seconds). Kept at the CDN for 1 s: a crowd bidding in the final minute costs the RPC a
  few reads a second, not several reads a bid. The signer reads its own blockhash from the RPC when this is unreachable.

  Every answer leaves through the output policy (server/output.ts).
*/
import { isPubkey, serverHasRpc } from "@/lib/bouncer/server/snapshot";
import { readSendContext } from "@/lib/bouncer/server/sendContext";
import { answer, fail, route } from "@/lib/bouncer/server/output";
import { isBudgetExhausted, isRateLimited } from "@/lib/bouncer/server/budget";
import { isLaunch, OutOfScope, parseHints } from "@/lib/bouncer/server/scope";

export const maxDuration = 15;

const CACHE = "public, max-age=0, s-maxage=1";

export const GET = route(async (req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> => {
  if (!serverHasRpc()) return fail("notFound");
  const { id } = await ctx.params;
  if (!isPubkey(id)) return fail("badAddress");
  try {
    if (!(await isLaunch(id, parseHints(req.headers)))) return fail("badAddress");
    const s = await readSendContext(id);
    if (!s) return fail("badAddress");
    return answer(s, { cache: CACHE });
  } catch (e) {
    if (e instanceof OutOfScope) return fail("badAddress");
    return fail(isBudgetExhausted(e) ? "budgetSpent" : isRateLimited(e) ? "rpcBusy" : "rpcDown");
  }
});
