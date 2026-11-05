/*
  The create page's picture, stored before the launch is created (2026-10-16,
  the founder's item 7 / readiness S8): one POST to the site's own /api/token with
  the name, the ticker and the picture as the data URL the form read, back
  come the metadata URI the create transaction carries (at most 200 bytes)
  and the picture's URL. The route answers with the output policy's fixed
  sentences, so what a refusal says here is the site's own sentence, never an
  exception's text.
*/
import { SOCIAL_WORDS } from "./socialLinks";

export interface UploadedToken {
  uri: string;
  image: string;
}

/* Socials A (2026-10-31): the fields a refusal can name (server/output.ts UPLOAD_FIELDS and the picture), so the page says it under that box. */
export type UploadField = "image" | "description" | "website" | "x" | "telegram";
const FIELDS: ReadonlySet<unknown> = new Set<UploadField>(["image", "description", "website", "x", "telegram"]);

export class UploadRefused extends Error {
  /* 24h: "image" when the route refused the picture itself (its answer's field), so the page says it under the picture's field. */
  constructor(sentence: string, public readonly field: UploadField | null = null) {
    super(sentence);
    this.name = "UploadRefused";
  }
}

const FALLBACK = "The picture could not be stored just now. Try again in a minute.";
const SOCIAL_KEYS = ["description", "website", "x", "telegram"] as const;

export async function uploadToken(input: { name: string; symbol: string; image: string; description?: string; website?: string; x?: string; telegram?: string }, fetchImpl: typeof fetch = fetch): Promise<UploadedToken> {
  let res: Response;
  try {
    res = await fetchImpl("/api/token", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
  } catch {
    throw new UploadRefused(FALLBACK);
  }
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  if (!res.ok) {
    const sentence = body && typeof body === "object" && typeof (body as { error?: unknown }).error === "string" ? (body as { error: string }).error : FALLBACK;
    const field = body && typeof body === "object" ? (body as { field?: unknown }).field : undefined;
    throw new UploadRefused(sentence, sentence !== FALLBACK && FIELDS.has(field) ? (field as UploadField) : null);
  }
  const b = body as { uri?: unknown; image?: unknown } | null;
  if (!b || typeof b.uri !== "string" || typeof b.image !== "string" || !/^https?:\/\//.test(b.uri)) throw new UploadRefused(FALLBACK);
  /*
    Ask 3 (SOCIALS-A-ANSWER.md): the route answers the description and links it stored, normalised. The form goes on
    only when they are what it sent; otherwise nothing is created and the first box that differs says so.
  */
  const stored = (body as { stored?: unknown }).stored;
  for (const f of SOCIAL_KEYS) {
    const want = input[f] ?? "";
    const got = stored && typeof stored === "object" ? (stored as Record<string, unknown>)[f] ?? "" : want === "" ? "" : undefined;
    if (got !== want) throw new UploadRefused(SOCIAL_WORDS.storedDiffers, f);
  }
  return { uri: b.uri, image: b.image };
}
