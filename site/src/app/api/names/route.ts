/*
  The same-name notices the admin hid (v0.30 item 8, 8C; server/namesAdmin.ts), for every visitor's notice:

    GET   { hidden: ["<launch>><other>", ...] }   the CDN 30 s

  Each entry is one direction: that launch's notice no longer names that other launch. Only the directions: never
  the reasons, the admin or the times (those stay in the admin's audit). 404 without the shared store; the page then
  hides nothing, so every notice still shows (the safe side). Every answer leaves through the output policy.
*/
import { kvFromEnv } from "@/lib/bouncer/server/kv";
import { hiddenFrom, namesLog } from "@/lib/bouncer/server/namesAdmin";
import { answer, fail, route } from "@/lib/bouncer/server/output";

export const maxDuration = 10;

const CACHE = "public, max-age=0, s-maxage=30, stale-while-revalidate=60";

export const GET = route(async (): Promise<Response> => {
  const kv = kvFromEnv();
  if (!kv) return fail("notFound");
  try {
    return answer({ hidden: hiddenFrom(await namesLog(kv)) }, { cache: CACHE });
  } catch {
    return fail("namesDown");
  }
});
