/*
  The creator sign-in (23c; server/session.ts). Behind the coming-soon gate like every /api route, limited per address
  by the proxy's "session" class.

    GET                                   { wallet: string | null }              who this browser is signed in as
    POST { action: "nonce", wallet }      { message, nonce }                     the message to sign (5 minutes)
    POST { action: "verify", wallet, nonce, signature (base58), signedMessage? (base64) }  { wallet, exp }
                                                                                 sets the httpOnly cookie for 24 h;
                                                                                 signedMessage: the bytes the wallet
                                                                                 says it signed (B22, a Ledger's envelope)
    POST { action: "out" }                { wallet: null }                       revokes it (24c, I4), then clears it; 503
                                                                                 and the cookie kept while the revocation
                                                                                 is not acknowledged (24d)

  24c: a cookie is read only on the host it was made for (I3), and a signed-out one is refused (I4).

  Every answer leaves through the output policy (server/output.ts).
*/
import { CLUSTER } from "@contract/active";
import { kvFromEnv } from "@/lib/bouncer/server/kv";
import { answer, fail, log, route } from "@/lib/bouncer/server/output";
import { cookieOf, isWallet, newSignIn, readSessionFull, SESSION_COOKIE, SESSION_SECS, sessionRevoked, sessionSecret, signOut, verifySignIn } from "@/lib/bouncer/server/session";

export const maxDuration = 10;

/* B22: room for signedMessage (a Ledger signs at most 1232 bytes of message plus its envelope header). */
const BODY_MAX = 2048;
const SIGNED_MAX = 1800;
const B64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const now = () => Math.floor(Date.now() / 1000);
const hostOf = (req: Request): string => new URL(req.url).host;
const cookieLine = (value: string, maxAge: number): string => `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`;

export const GET = route(async (req: Request): Promise<Response> => {
  const s = readSessionFull(sessionSecret(), cookieOf(req.headers.get("cookie")), CLUSTER, hostOf(req), now());
  const kv = kvFromEnv();
  let wallet: string | null = s?.wallet ?? null;
  if (s && kv) {
    try {
      if (await sessionRevoked(kv, s)) wallet = null;
    } catch {
      /* the store unread: the permit checks again and fails closed; this answer only shows or hides the sign-in step */
    }
  }
  return answer({ wallet }, { cache: "no-store" });
});

export const POST = route(async (req: Request): Promise<Response> => {
  type Body = { action?: unknown; wallet?: unknown; nonce?: unknown; signature?: unknown; signedMessage?: unknown };
  let body: Body | null = null;
  try {
    const text = await req.text();
    if (text.length <= BODY_MAX) body = JSON.parse(text) as Body;
  } catch {
    body = null;
  }
  if (!body || typeof body !== "object") return fail("sessionBody");
  const secret = sessionSecret();
  const kv = kvFromEnv();
  if (body.action === "out") {
    /* 24d (Astra R5-M1): the cookie is cleared only once its revocation is acknowledged; otherwise 503 and the cookie stays, so the sign-out can be sent again. */
    const s = readSessionFull(secret, cookieOf(req.headers.get("cookie")), CLUSTER, hostOf(req), now());
    if ((await signOut(kv, s, now())) === "retry") {
      log("info", { event: "session", result: "sign-out-unconfirmed" });
      return fail("sessionDown");
    }
    return answer({ wallet: null }, { cache: "no-store", headers: { "set-cookie": cookieLine("", 0) } });
  }
  if (!secret || !kv) return fail("sessionDown");
  if (!isWallet(body.wallet)) return fail("sessionBody");
  try {
    if (body.action === "nonce") {
      const n = await newSignIn(kv, { host: hostOf(req), wallet: body.wallet, cluster: CLUSTER, nowSec: now() });
      return answer({ message: n.text, nonce: n.nonce }, { cache: "no-store" });
    }
    const signed = body.signedMessage;
    const signedOk = signed === undefined || (typeof signed === "string" && signed.length > 0 && signed.length <= SIGNED_MAX && B64_RE.test(signed));
    if (body.action === "verify" && typeof body.signature === "string" && body.signature.length <= 100 && typeof body.nonce === "string" && body.nonce.length <= 32 && signedOk) {
      const signedMessage = typeof signed === "string" ? new Uint8Array(Buffer.from(signed, "base64")) : undefined;
      const v = await verifySignIn(kv, secret, { wallet: body.wallet, nonce: body.nonce, signature: body.signature, signedMessage, cluster: CLUSTER, host: hostOf(req), nowSec: now() });
      log("info", { event: "session", result: v.ok ? "signed-in" : "refused", reason: v.ok ? null : v.why });
      if (!v.ok) return v.why === "config" ? fail("sessionDown") : fail("sessionRefused");
      return answer({ wallet: body.wallet, exp: v.exp }, { cache: "no-store", headers: { "set-cookie": cookieLine(v.cookie, SESSION_SECS) } });
    }
    return fail("sessionBody");
  } catch {
    return fail("sessionDown");
  }
});
