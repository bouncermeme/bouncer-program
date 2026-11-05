/*
  The admin's same-name notice control (v0.30 item 8; server/namesAdmin.ts). Behind the coming-soon gate like every
  /api route, limited per address by the proxy's "admin" class. Closed (404) unless this cluster's admin wallet is set
  (TICKER_ADMIN_WALLET_DEVNET or TICKER_ADMIN_WALLET_MAINNET, the ticker release's).

    POST { text (the signed message), signature (base58) }
      a "hide" or "show" message   { result: "ok", hidden: ["<launch>><other>", ...], audit: [...] }
      a "look" message             { hidden, audit }

  Every request is one message the admin signed; a signature that does not verify as the admin's gets one answer
  (adminRefused), a verified message that cannot be used says why ({ refused }). Every answer leaves through the
  output policy (server/output.ts).
*/
import bs58 from "bs58";
import { CLUSTER } from "@contract/active";
import { kvFromEnv } from "@/lib/bouncer/server/kv";
import { checkNamesMessage, lookNames, namesState, NamesNonceSpent, setPair } from "@/lib/bouncer/server/namesAdmin";
import { answer, fail, log, route } from "@/lib/bouncer/server/output";
import { adminWallet } from "@/lib/bouncer/server/tickerAdmin";

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
  const c = checkNamesMessage(body.text, sig, { admin, host: new URL(req.url).host, cluster: CLUSTER, nowSec: now() });
  if (!c.ok) {
    if (c.why === "signature" || c.why === "not-admin") return fail("adminRefused");
    log("info", { event: "names-admin", result: "refused", reason: c.why });
    return answer({ refused: c.why }, { status: 403, cache: "no-store" });
  }
  const kv = kvFromEnv();
  if (!kv) return fail("namesDown");
  try {
    if (c.m.action === "look") return answer(await lookNames(kv, c.m), { cache: "no-store" });
    const result = await setPair(kv, c.m, now());
    if (result === "nonce") return answer({ refused: "nonce" }, { status: 403, cache: "no-store" });
    log("info", { event: "NAMES_ADMIN", action: c.m.action, launch8: c.m.launch?.slice(0, 8) ?? null, other8: c.m.other?.slice(0, 8) ?? null });
    return answer({ result, ...(await namesState(kv)) }, { cache: "no-store" });
  } catch (e) {
    if (e instanceof NamesNonceSpent) return answer({ refused: "nonce" }, { status: 403, cache: "no-store" });
    return fail("namesDown");
  }
});
