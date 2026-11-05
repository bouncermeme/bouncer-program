/*
  The board's one request for every pool's 24-hour volume: the summary the
  aggregator wrote last (lib/bouncer/server/volume.ts), read from the Blob
  store's origin, never its edge cache. Cached at this site's edge for a
  few seconds, so a busy board costs one read, not one per visitor. 503
  with no body to show until the first run has written a summary.

  Every answer leaves through the output policy (server/output.ts): the
  summary as a typed body, the failures by kind. A failed read is a kind
  and a scrubbed log line, never the store's words (2026-10-16, GPT-6's N1
  sibling and F2).
*/
import { readVolumeSummary } from "@/lib/bouncer/server/volume";
import { answer, fail, log, noteOf, route } from "@/lib/bouncer/server/output";
import { categoryOf } from "@/lib/bouncer/chain/upstreamError";

export const dynamic = "force-dynamic";

export const GET = route(async (): Promise<Response> => {
  try {
    const summary = await readVolumeSummary();
    if (!summary) return fail("volumeNone");
    return answer(summary, { cache: "public, s-maxage=15, stale-while-revalidate=45" });
  } catch (e) {
    log("error", { volume: "read failed", category: categoryOf(e), why: noteOf(e) });
    return fail("volumeUnreadable");
  }
});
