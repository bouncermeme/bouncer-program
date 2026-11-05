/*
  The admin ticker release (server/tickerAdmin.ts; docs/TICKER-RELEASE-DESIGN-2026-10-24.md). Behind the coming-soon
  gate like every /api route, limited per address by the proxy's "admin" class. Closed (404) unless this cluster's
  admin wallet is set (TICKER_ADMIN_WALLET_DEVNET or TICKER_ADMIN_WALLET_MAINNET).

    POST { text (the signed message), signature (base58) }
      a "look" message      { holds: [{ launch, kind, released, until? }], audit: [...], slot }
      a "release" message   { result, kind, until?, slot }

  Every request is one message the admin signed (scripts/ticker-release.ts, or a wallet's signMessage): nothing
  is answered to anyone else, not even which launches hold a ticker. A signature that does not verify as the admin's
  gets one answer (adminRefused); a verified message that cannot be used says why ({ refused }).

  Every answer leaves through the output policy (server/output.ts).
*/
import bs58 from "bs58";
import { CLUSTER } from "@contract/active";
import { readTickerIndex } from "@/lib/bouncer/server/chainIndex";
import { kvFromEnv } from "@/lib/bouncer/server/kv";
import { answer, fail, log, route } from "@/lib/bouncer/server/output";
import { adminWallet, checkAdminMessage, lookKey, NonceSpent, releaseHold, releaseLogLine } from "@/lib/bouncer/server/tickerAdmin";

export const maxDuration = 20;

const BODY_MAX = 2048;
const now = () => Math.floor(Date.now() / 1000);

export const POST = route(async (req: Request): Promise<Response> => {
  const admin = adminWallet(CLUSTER);
  if (!admin) return fail("notFound");
  type Body = { text?: unknown; signature?: unknown };
  let body: Body | null = null;
  try {
    const text = await req.text();
    if (text.length <= BODY_MAX) body = JSON.parse(text) as Body;
  } catch {
    body = null;
  }
  if (!body || typeof body.text !== "string" || typeof body.signature !== "string" || body.signature.length > 100) return fail("adminBody");
  let sig: Uint8Array;
  try {
    sig = bs58.decode(body.signature);
  } catch {
    return fail("adminBody");
  }
  const c = checkAdminMessage(body.text, sig, { admin, host: new URL(req.url).host, cluster: CLUSTER, nowSec: now() });
  if (!c.ok) {
    if (c.why === "signature" || c.why === "not-admin") return fail("adminRefused");
    log("info", { event: "ticker-admin", result: "refused", reason: c.why });
    return answer({ refused: c.why }, { status: 403, cache: "no-store" });
  }
  const kv = kvFromEnv();
  if (!kv) return fail("adminDown");
  try {
    const index = await readTickerIndex();
    if (c.m.action === "look") {
      const r = await lookKey(kv, c.m, index);
      return answer({ ...r, slot: index.slot }, { cache: "no-store" });
    }
    const r = await releaseHold(kv, c.m, index, now());
    log("info", releaseLogLine(c.m, r, index.slot));
    return answer({ ...r, slot: index.slot }, { cache: "no-store" });
  } catch (e) {
    if (e instanceof NonceSpent) return answer({ refused: "nonce" }, { status: 403, cache: "no-store" });
    return fail("adminDown");
  }
});
