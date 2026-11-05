/*
  The program's Config account for everyone (2026-10-15, Phase C), as bytes,
  kept at the CDN for 10 s: the pages read it every 30 s, so a pause set by
  the admin shows within a minute as before. 404 without a server RPC.
  Beside the bytes, the day's read budget state (server/budget.ts), which
  the banner reads from here (2026-10-16), and the running Node version
  (process.version, a typed string: the security release of 2026-10-21,
  docs/SECURITY-CHECK-2026-10-21.md B6 item 2, the hosted version observable).

  Every answer leaves through the output policy (server/output.ts): a typed
  body, or a failure named by kind.
*/
import { readConfig, serverHasRpc } from "@/lib/bouncer/server/snapshot";
import { answer, fail, route } from "@/lib/bouncer/server/output";
import { budgetStatus, isBudgetExhausted } from "@/lib/bouncer/server/budget";
import { counterFingerprint, sharedCapConfig } from "@/lib/bouncer/server/sharedCap";

export const maxDuration = 20;

const CACHE = "public, max-age=0, s-maxage=10, stale-while-revalidate=20";
const CACHE_STALE = "public, max-age=0, s-maxage=10";

export const GET = route(async (): Promise<Response> => {
  if (!serverHasRpc()) return fail("notFound");
  try {
    const c = await readConfig();
    const b = budgetStatus();
    const p = budgetStatus(undefined, "price");
    /*
      shared: the hard cap the site and the keeper share is on (server/sharedCap.ts); false on a devnet pin without it (the Blob ledger alone).
      cap and counter (Astra 2026-10-17c, item 4): the cap in credits and the counter's fingerprint (counterFingerprint: 8 hex of sha256 of the
      store's hostname), so a reviewer can compare them with the keeper's without either project naming its store. Null when the cap is off.
      mode (the spend meter's revision 2, S5): "cap" under the hard cap, "count" on a mainnet pin, which counts and refuses no money-path call;
      there cap is null and alertAt is the day's figure the count alerts against. "ledger" otherwise.
    */
    const cap = sharedCapConfig();
    const counted = b.ledger === "count";
    const shared = (b.ledger === "cap" || counted) && cap.configured;
    const mode = counted ? "count" : b.ledger === "cap" ? "cap" : "ledger";
    return answer({ ...c, node: process.version, budget: { state: b.state, day: b.day, resetsAt: b.resetsAt, price: p.state, shared, mode, cap: shared && !counted ? cap.cap : null, alertAt: shared && counted ? cap.cap : null, counter: shared ? counterFingerprint(cap) : null } }, { cache: c.source === "stale" ? CACHE_STALE : CACHE });
  } catch (e) {
    return fail(isBudgetExhausted(e) ? "budgetSpent" : "rpcDown");
  }
});
