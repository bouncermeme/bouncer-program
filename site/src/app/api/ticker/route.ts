/*
  /create's copycat check (22e3; 23c for copycat v2, review/2026-10-24-23c-morning/DESIGN.md): whether a ticker is free
  for this wallet now. Advisory only: the creation permit (server/attest.ts issueCreate) checks everything again and
  is the authority. The answer is the hold's kind ("free", "live", "trading", "paying" (P-T2), "pending"), never the holding launch or
  its wallet. The wallet matters only for its own pending reservation (a retry of its own launch reads free).

  The same rules as the permit (server/reservations.ts tickerGate over chainIndex.ts readTickerIndex): a finalized
  snapshot under two minutes old, the reservations read from the store. Anything that cannot be trusted answers 503
  ticker-unchecked, never free. Kept at the CDN for 30 s per ticker and wallet; the proxy limits it per address (the
  "ticker" class) and the index's fleet budget bounds the RPC reads behind it.

  Every answer leaves through the output policy (server/output.ts).
*/
import { PublicKey } from "@solana/web3.js";
import { readTickerIndex, chainIndexAvailable } from "@/lib/bouncer/server/chainIndex";
import { kvFromEnv } from "@/lib/bouncer/server/kv";
import { rk, tickerGate } from "@/lib/bouncer/server/reservations";
import { answer, fail, log, route } from "@/lib/bouncer/server/output";
import { tickerCharsetOk } from "@/lib/bouncer/creationPolicy";
import { tickerKey } from "@/lib/bouncer/tickerKey";

export const maxDuration = 20;

const CACHE = "public, max-age=0, s-maxage=30, stale-while-revalidate=30";

function isWallet(s: string): boolean {
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s)) return false;
  try {
    return new PublicKey(s).toBase58() === s;
  } catch {
    return false;
  }
}

export const GET = route(async (req: Request): Promise<Response> => {
  const q = new URL(req.url).searchParams;
  const symbol = (q.get("s") ?? "").trim();
  const wallet = (q.get("w") ?? "").trim();
  const key = tickerKey(symbol);
  if (!tickerCharsetOk(symbol) || !key || !isWallet(wallet)) return fail("tickerBody");
  if (!chainIndexAvailable()) return fail("notFound");
  const kv = kvFromEnv();
  if (!kv) return fail("attestTickerUnchecked");
  try {
    const index = await readTickerIndex();
    const mine = await kv(["GET", rk.wallet(wallet)]);
    const gate = await tickerGate(kv, key, typeof mine === "string" ? mine : null, index, undefined, (r) => log("info", r));
    const hold = gate.taken ? (gate.why === "funded" ? (gate.paying ? "paying" : "trading") : gate.why) : null;
    return answer({ free: !gate.taken, hold, slot: index.slot }, { cache: CACHE });
  } catch {
    return fail("attestTickerUnchecked");
  }
});
