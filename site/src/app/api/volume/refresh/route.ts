/*
  The cron's target (vercel.json: every minute; Vercel runs crons on the
  production deployment only). Vercel sends `Authorization: Bearer
  <CRON_SECRET>`; this refuses anything else. Fails closed (2026-10-16,
  GPT-6's F3): with no CRON_SECRET set the route does nothing and answers
  500, so a deployment that lost its secret cannot be driven by anyone. A
  local dev server that wants to run the refresh by hand sets the variable
  in .env.local and sends the bearer.

  One run reads every pool's new transactions and rewrites the two JSON
  files; the report says what it read, in counts and categories only
  (server/volume.ts: a failure is a category, never the provider's words).
  Every answer leaves through the output policy (server/output.ts).
*/
import { refreshVolumes } from "@/lib/bouncer/server/volume";
import { answer, fail, log, noteOf, route } from "@/lib/bouncer/server/output";
import { categoryOf } from "@/lib/bouncer/chain/upstreamError";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export const GET = route(async (req: Request): Promise<Response> => {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    log("error", { volume: "refresh refused: CRON_SECRET is not set, the route does nothing" });
    return fail("notConfigured");
  }
  if (req.headers.get("authorization") !== `Bearer ${secret}`) return fail("unauthorized");
  try {
    const { report } = await refreshVolumes();
    return answer(report);
  } catch (e) {
    log("error", { volume: "refresh failed", category: categoryOf(e), why: noteOf(e) });
    return fail("volumeRefreshFailed");
  }
});
