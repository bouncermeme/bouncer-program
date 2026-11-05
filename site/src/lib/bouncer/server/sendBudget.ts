/*
  24e (the founder's capacity decisions, item 2): the fallback send's own budget. A wallet that sends for itself (the default
  since 2026-10-15) puts nothing on the site's RPC; a wallet that can only sign hands the site its signed bytes, and the
  route (app/api/rpc) sends them on the project's key. That path is metered here per instance: at most
  SEND_FALLBACK_PER_SECOND sends a second (20 unless set), with a burst of as many, so a crowd of signing-only wallets
  cannot use up the provider's send rate that the rest of the site depends on. A send over it is refused as busy (429)
  before anything is forwarded or charged; the client's own backoff tries again (chain/rpc.ts fetchWithBackoff), and a
  send never forwarded can only expire, nothing taken.

  Per instance, not across the fleet: the provider's own limit is the fleet's, and the day's credit budget
  (server/budget.ts) still applies to every send.
*/
export const SEND_FALLBACK_DEFAULT = 20;

export function sendRateFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.SEND_FALLBACK_PER_SECOND);
  return Number.isFinite(n) && n > 0 ? n : SEND_FALLBACK_DEFAULT;
}

/* A token bucket: `rate` a second, holding at most `rate`. 24g (Astra 24f F5): `back` returns tokens taken for sends that were then refused before forwarding (the day's budget), so a refusal spends no send. */
export type SendBucket = ((n: number) => boolean) & { back: (n: number) => void };
export function sendBucket(rate: number, now: () => number = Date.now): SendBucket {
  let tokens = rate;
  let at = now();
  const take = (n: number) => {
    const t = now();
    tokens = Math.min(rate, tokens + ((t - at) / 1000) * rate);
    at = t;
    if (tokens < n) return false;
    tokens -= n;
    return true;
  };
  return Object.assign(take, { back: (n: number) => void (tokens = Math.min(rate, tokens + Math.max(0, n))) });
}
