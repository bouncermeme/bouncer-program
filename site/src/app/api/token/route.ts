/*
  The creator's picture and metadata file, stored before the launch is
  created (2026-10-16, the founder's item 7 / readiness S8): the create page posts
  the name, the ticker and the picture as a data URL; this stores the
  picture and a metadata file in the token store and answers the URI the
  create transaction carries (at most 200 bytes, BOUNDS.maxUri) and the
  picture's URL. Everything is checked from the bytes: the kind by its
  signature, the size in pixels from its header, then the whole picture
  decoded and re-encoded fresh (server/imageFile.ts decodeImage; GPT-6
  2026-10-17 I1: a header alone used to pass), the name and the ticker by
  the program's own limits. Since 2026-10-20 (the founder, upload hardening) an
  SVG is refused by name, a header over 4096 pixels a side before it is
  decoded, and only the fresh PNG or WebP is stored. What is stored is read back before the URI is
  given out (tokenStore.putToken; GPT-6 I2). Counted against the day's upload budget
  (server/budget.ts) before anything is stored. Fails closed without a
  store. Every answer is the output policy's.

  Socials A (2026-10-30; review/2026-10-30-mainnet-steps/SOCIALS-A-SPEC.md
  section 3 with SOCIALS-A-ANSWER.md): four more optional fields,
  description, website, x and telegram, each a string when sent, checked
  and normalised by lib/bouncer/socialLinks.ts (the create form's own rule),
  in that order; any other key in the body is refused. A refusal names its
  box (output.ts failField, ask 2). Bouncer's own links only on the ticker
  BOUNCER exactly, from a reserved owner's signed-in session (R12). A value
  the policy would withhold from the answer is refused before anything is
  charged or stored. The fingerprint covers all seven values and the store
  never overwrites (server/tokenStore.ts: a file already there with other
  bytes is "uploadTaken", nothing written); the file carries both shapes,
  every empty field left out; a success answers what was stored, normalised
  (`stored`, ask 3). A lone surrogate in the name or the description is
  refused, so every value the fingerprint covers is the value stored.
*/
import { BOUNDS } from "@contract/constants";
import { CLUSTER } from "@contract/active";
import { answer, fail, failField, leaks, route, UPLOAD_FIELDS, type SocialFailureKind } from "@/lib/bouncer/server/output";
import { chargeUpload } from "@/lib/bouncer/server/budget";
import { dataUrlBytes, decodeImage, imageFacts, squareEnough, withinSide } from "@/lib/bouncer/server/imageFile";
import { refusedKind } from "@/lib/bouncer/imagePolicy";
import { hasTokenStore, legacyTokenFileJson, putToken, storedSocials, tokenFileJson, tokenHash } from "@/lib/bouncer/server/tokenStore";
import { siteOrigin } from "@/lib/bouncer/siteCluster";
import { checkSocials, hasHiddenText, OFFICIAL_TICKER, wordOf, type SocialValues, type SocialWord } from "@/lib/bouncer/socialLinks";
import { isReservedOwner, parseWalletList } from "@/lib/bouncer/creationPolicy";
import { cookieOf, readSessionFull, sessionSecret, sessionWallet } from "@/lib/bouncer/server/session";
import { kvFromEnv } from "@/lib/bouncer/server/kv";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/* The picture's cap in bytes (the form says 2 MB), and the JSON body that carries it base64-encoded plus the two names. */
export const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const MAX_BODY = 3 * 1024 * 1024;

const utf8Length = (s: string): number => new TextEncoder().encode(s).length;

/* Socials A: the keys a body may carry; any other is refused (uploadBody). */
const BODY_KEYS: ReadonlySet<string> = new Set(["name", "symbol", "image", ...UPLOAD_FIELDS]);
/* Socials A: a box's refusal (socialLinks.ts SOCIAL_WORDS) as the policy's kind; the route never carries the words. storedDiffers is the form's own. */
const SOCIAL_KIND: Record<Exclude<SocialWord, "storedDiffers">, SocialFailureKind> = {
  descriptionLong: "uploadDescriptionLong",
  descriptionHidden: "uploadDescriptionHidden",
  descriptionBreaks: "uploadDescriptionBreaks",
  websiteHttps: "uploadWebsiteHttps",
  websiteAddress: "uploadWebsiteAddress",
  websiteSocial: "uploadWebsiteSocial",
  linkLong: "uploadLinkLong",
  x: "uploadX",
  telegram: "uploadTelegram",
  official: "uploadOfficialLink",
};

/* Socials A, R12: Bouncer's own links are BOUNCER's only. On the route that is the creator's signed-in session (server/session.ts, the cookie the creation permit reads) on a reserved owner's wallet (RESERVED_TICKER_OWNERS: only it can create the ticker BOUNCER). No session, a store that cannot say, or any other wallet: false. */
async function officialSession(req: Request): Promise<boolean> {
  const cookie = readSessionFull(sessionSecret(), cookieOf(req.headers.get("cookie")), CLUSTER, new URL(req.url).host, Math.floor(Date.now() / 1000));
  if (!cookie) return false;
  const wallet = await sessionWallet(kvFromEnv(), cookie);
  return wallet !== null && isReservedOwner(parseWalletList(process.env.RESERVED_TICKER_OWNERS), wallet);
}

/* The body, read chunk by chunk and stopped at the cap in bytes, whatever content-length said (the RPC route's rule). */
async function readBody(req: Request): Promise<{ ok: true; text: string } | { ok: false; why: "tooLarge" | "body" }> {
  if (!req.body) return { ok: true, text: "" };
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY) {
        await reader.cancel().catch(() => undefined);
        return { ok: false, why: "tooLarge" };
      }
      chunks.push(value);
    }
  } catch {
    return { ok: false, why: "body" };
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.byteLength;
  }
  return { ok: true, text: new TextDecoder().decode(all) };
}

export const POST = route(async (req: Request): Promise<Response> => {
  if (!hasTokenStore()) return fail("uploadNotConfigured");
  const declared = Number(req.headers.get("content-length") ?? 0);
  if (declared > MAX_BODY) return fail("uploadTooLarge");
  const read = await readBody(req);
  if (!read.ok) return fail(read.why === "tooLarge" ? "uploadTooLarge" : "uploadBody");
  let body: unknown;
  try {
    body = JSON.parse(read.text);
  } catch {
    return fail("uploadBody");
  }
  if (typeof body !== "object" || body === null) return fail("uploadBody");
  /* Socials A: only the seven keys; each of the four optional ones a string when sent. */
  const sent = body as Record<string, unknown>;
  if (Object.keys(sent).some((k) => !BODY_KEYS.has(k))) return fail("uploadBody");
  if (UPLOAD_FIELDS.some((k) => sent[k] !== undefined && typeof sent[k] !== "string")) return fail("uploadBody");
  const { name, symbol, image } = body as { name?: unknown; symbol?: unknown; image?: unknown };
  if (typeof name !== "string" || typeof symbol !== "string" || typeof image !== "string") return fail("uploadBody");
  const cleanName = name.trim();
  const cleanSymbol = symbol.trim().toUpperCase();
  const nameBytes = utf8Length(cleanName);
  if (nameBytes < 1 || nameBytes > BOUNDS.maxName) return fail("uploadBadName");
  /* Socials A (the overwrite lock): a lone surrogate (a JSON escape can carry one) has no UTF-8 form; the file would store it as itself while the fingerprint covers U+FFFD, so two names would share one path. The program's name is UTF-8, so no launch could carry it anyway. */
  if (/\p{Cs}/u.test(cleanName)) return fail("uploadBadName");
  /* 2026-10-31 (T3, review/2026-10-31c-precheck/REPORT.md): the description's hidden-character rule (socialLinks.ts hasHiddenText, T1) with no line break, so no control, direction override or invisible character is stored in a name; the same sentence. */
  if (hasHiddenText(cleanName, false)) return fail("uploadBadName");
  /* 2026-10-31 (C3, approved "Copy fixes ok"): a ticker of 1 to 10 characters, as the attest route and creationPolicy.ts tickerCharsetOk already take (review/2026-10-31b-delta/COPY-FIXES-READINESS.md); the same sentence. */
  if (!/^[A-Z0-9]{1,10}$/.test(cleanSymbol) || utf8Length(cleanSymbol) > BOUNDS.maxSymbol) return fail("uploadBadName");
  /* Socials A: the four boxes by the form's own rule, in box order; the first refusal is answered under its box. The session is read only for the ticker BOUNCER. */
  const values = Object.fromEntries(UPLOAD_FIELDS.map((k) => [k, typeof sent[k] === "string" ? sent[k] : ""])) as SocialValues;
  const official = cleanSymbol === OFFICIAL_TICKER && (await officialSession(req));
  const socials = checkSocials(values, official);
  for (const k of UPLOAD_FIELDS) {
    const why = socials.errors[k];
    if (why === null) continue;
    const word = wordOf(why);
    return word && word !== "storedDiffers" ? failField(SOCIAL_KIND[word], k) : fail("uploadBody");
  }
  /* Socials A, ask 3: the success answer carries these; one the policy would withhold (a server secret or a key's shape) is refused here, before anything is charged or stored. */
  if (leaks(JSON.stringify(socials.clean))) return fail("withheld");
  const bytes = dataUrlBytes(image, MAX_IMAGE_BYTES);
  if (!bytes) return fail(image.length > MAX_IMAGE_BYTES ? "uploadTooLarge" : "uploadBadImage");
  /* 24h: the page's rule exactly (lib/bouncer/imagePolicy.ts refusedKind), on the bytes sent. */
  const mime = /^data:([^;,]{1,64})[;,]/i.exec(image)?.[1].toLowerCase() ?? "";
  const kind = refusedKind(bytes, "", mime);
  if (kind === "svg") return fail("uploadSvg");
  if (kind === "gif") return fail("uploadGif");
  const facts = imageFacts(bytes);
  if (!facts) return fail("uploadBadImage");
  if (!withinSide(facts)) return fail("uploadTooManyPixels");
  if (!squareEnough(facts)) return fail("uploadNotSquare");
  /* The whole picture decoded and re-encoded; a header alone, a truncated file or a forged one comes back null and is refused with the same sentence. */
  const picture = await decodeImage(bytes, facts);
  if (!picture) return fail("uploadBadImage");
  if (picture.bytes.length > MAX_IMAGE_BYTES) return fail("uploadTooLarge");
  /* Charged after the checks, so a refused picture costs nothing, and before the store is touched, so nothing is stored past the line. */
  if ((await chargeUpload()) === "refused") return fail("uploadBudgetSpent");
  /* Socials A: the fingerprint over all seven values (a file with none of the four keeps today's name). */
  const hash = tokenHash(picture.bytes, cleanName, cleanSymbol, socials.clean);
  const origin = siteOrigin();
  const imageUrl = `${origin}/api/token/${hash}`;
  const uri = `${imageUrl}.json`;
  if (utf8Length(uri) > BOUNDS.maxUri) return fail("uploadNotConfigured");
  /* Socials A: both shapes, every empty field left out; a file with none of the four also takes today's bytes at its path as the same file (a retry of an old upload). */
  const file = { name: cleanName, symbol: cleanSymbol, image: imageUrl };
  const none = Object.keys(socials.clean).length === 0;
  let put;
  try {
    put = await putToken(hash, { bytes: picture.bytes, contentType: picture.contentType }, tokenFileJson({ ...file, ...socials.clean }), none ? [legacyTokenFileJson(file)] : []);
  } catch {
    return fail("uploadStoreDown");
  }
  if (!put.ok) return fail("uploadTaken");
  /* Socials A, ask 3: what was stored, read back from the stored file, normalised; the form goes on only when it is what it sent. */
  return answer({ uri, image: imageUrl, hash, width: picture.width, height: picture.height, kind: picture.kind, stored: storedSocials(put.json) });
});

export const GET = route(async (): Promise<Response> => fail("notFound"));
