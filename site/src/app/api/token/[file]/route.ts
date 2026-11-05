/*
  A launch's stored picture (/api/token/<hash>) or metadata file
  (/api/token/<hash>.json), relayed from the token store with a long cache:
  the name is the content's hash, so what it serves never changes. The
  on-chain URI points here, so wallets, explorers and the site's own cards
  read through this route. A name that is not a hash, or a file that does
  not exist, is the policy's notFound. Every answer is the output policy's.
*/
import { fail, relayStored, route } from "@/lib/bouncer/server/output";
import { FILE_RE, getToken, hasTokenStore } from "@/lib/bouncer/server/tokenStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = route(async (_req: Request, ctx: { params: Promise<{ file: string }> }): Promise<Response> => {
  const { file } = await ctx.params;
  if (!FILE_RE.test(file)) return fail("notFound");
  if (!hasTokenStore()) return fail("notFound");
  let stored;
  try {
    stored = await getToken(file);
  } catch {
    return fail("uploadStoreDown");
  }
  if (!stored) return fail("notFound");
  return relayStored(stored.stream, stored.contentType, { size: stored.size });
});
