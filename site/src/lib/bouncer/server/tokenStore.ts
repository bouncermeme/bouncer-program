/*
  Where a launch's picture and metadata file live (2026-10-16, the founder's item 7
  / readiness S8): the Vercel Blob store the site already writes the volume
  aggregate to, under token/<hash> (the picture, with its sniffed content
  type) and token/<hash>.json (the metadata file a wallet reads). The hash
  names the content, so the same picture with the same name and ticker lands
  on the same path and a retry stores nothing twice. The on-chain URI points
  at the site (/api/token/<hash>.json), which relays what is stored here, so
  the store behind it can move without touching any token.

  A check swaps the store for a stub (setTokenStore); without a token the
  routes fail closed (hasTokenStore).

  Socials A (2026-10-30; review/2026-10-30-mainnet-steps/SOCIALS-A-SPEC.md
  section 3 and SOCIALS-A-ANSWER.md), the overwrite lock: the hash also
  covers the description, the website, the X link and the Telegram link
  (tokenHash), the store never replaces a file (allowOverwrite false), and
  putToken looks both paths up first (TokenStore.exists, the Blob API, so
  nothing is fetched through the CDN before it exists; then the bytes of a
  file that is there): the same bytes are a harmless retry, any
  other bytes refuse the upload and nothing is written. Old files keep their
  names. The file carries both shapes (tokenFileJson), every empty field
  left out; the route answers what was stored (storedSocials, ask 3), and
  the attestation service reads a file's name and ticker (readTokenFacts,
  ask 1).

  Future backup (the founder, 2026-10-16, D): IPFS pinning. The same hash-named
  files pinned through a pinning service, the ipfs:// address written into
  the metadata file as a second image entry; the on-chain URI stays the
  site's, so nothing on chain changes when the backup is added.
*/
import { createHash } from "crypto";

export interface StoredFile {
  stream: ReadableStream<Uint8Array>;
  contentType: string;
  size: number | null;
}
export interface TokenStore {
  /* Socials A: creates a file; a file already at the path is never replaced (the Blob store throws). putToken reads the path first and again after a throw. */
  put(path: string, body: Uint8Array | string, contentType: string): Promise<void>;
  get(path: string): Promise<StoredFile | null>;
  /* Removes a file; a stub may leave it out. 2026-10-31 (T2, review/2026-10-31c-precheck/REPORT.md): putToken no longer calls it; nothing in this module removes a file. */
  del?(path: string): Promise<void>;
  /*
    Socials A: whether a file is at the path, asked of the store's API (the Blob store's head), never through the
    file's public URL. get() on a public blob fetches that URL through the CDN (@vercel/blob 2.8.1 get: useCache false
    adds cache=0 for private blobs only), so a get before the file exists could leave a 404 that the read-back after
    the write then meets. putToken and readTokenFacts ask this first and get() only a file that exists. A stub may
    leave it out; then the path is read.
  */
  exists?(path: string): Promise<boolean>;
}

const PREFIX = "token/";
export const HASH_RE = /^[0-9a-f]{32}$/;
export const FILE_RE = /^([0-9a-f]{32})(\.json)?$/;

let store: TokenStore | null = null;

/* For a check: a store that is not the Blob SDK; undefined restores it. */
export function setTokenStore(s?: TokenStore): void {
  store = s ?? null;
}

export const hasTokenStore = (): boolean => store !== null || Boolean(process.env.BLOB_READ_WRITE_TOKEN);

/* Socials A: the SDK calls the store makes, so a check can hand blobStoreOf a stand-in for the SDK and run this adapter offline. */
export type BlobSdk = Pick<typeof import("@vercel/blob"), "put" | "get" | "del" | "head" | "BlobNotFoundError">;

async function blobStore(): Promise<TokenStore> {
  return blobStoreOf(await import("@vercel/blob"));
}

export function blobStoreOf(blob: BlobSdk): TokenStore {
  return {
    async put(path, body, contentType) {
      await blob.put(path, typeof body === "string" ? body : Buffer.from(body), { access: "public", addRandomSuffix: false, allowOverwrite: false, contentType, cacheControlMaxAge: 31_536_000 });
    },
    async get(path) {
      const r = await blob.get(path, { access: "public", useCache: false });
      if (!r || r.statusCode !== 200 || !r.stream) return null;
      return { stream: r.stream, contentType: r.blob.contentType ?? "application/octet-stream", size: r.blob.size ?? null };
    },
    async del(path) {
      await blob.del(path);
    },
    /* Socials A: the API's answer (head), not the CDN's; a missing blob is BlobNotFoundError, anything else throws on (the caller fails closed). */
    async exists(path) {
      try {
        await blob.head(path);
        return true;
      } catch (e) {
        if (e instanceof blob.BlobNotFoundError) return false;
        throw e;
      }
    },
  };
}

const current = async (): Promise<TokenStore> => store ?? blobStore();

/* Socials A: the four optional fields as the route stores them (lib/bouncer/socialLinks.ts, normalised); an empty or missing one is left out everywhere. */
export interface TokenSocials {
  description?: string;
  website?: string;
  x?: string;
  telegram?: string;
}
const SOCIAL_ORDER = ["description", "website", "x", "telegram"] as const;
const present = (v: unknown): v is string => typeof v === "string" && v !== "";
/* Socials A: the tag that opens the fingerprint of a file with any of the four. */
const HASH_TAG_SOCIALS = "bouncer/token/socials-v1";

/*
  The content's name: the picture's bytes with the name and the ticker, so a different name is a different file.
  Socials A (the overwrite lock): with any of the four optional fields, sha256 over the tag, then the picture, the
  name, the ticker, the description, the website, the X link and the Telegram link in that order, each after its
  length in 8 bytes (big-endian), so no two sets of values give the same bytes; the first 32 hex characters. Each value
  is hashed as its UTF-8, which is the value stored because the route refuses a lone surrogate (socialLinks.ts HIDDEN
  for the description, route.ts for the name; the links are ASCII as the URL parser writes them). The tag
  opens with "b" and the form below opens with the route's picture, always a fresh PNG (0x89) or WebP ("R"), so the
  two forms never meet. With none of the four, the form below, unchanged since 79c87bd, so no old file moves.
*/
export function tokenHash(image: Uint8Array, name: string, symbol: string, socials: TokenSocials = {}): string {
  if (SOCIAL_ORDER.some((k) => present(socials[k]))) {
    const h = createHash("sha256").update(HASH_TAG_SOCIALS);
    for (const part of [image, name, symbol, ...SOCIAL_ORDER.map((k) => (present(socials[k]) ? socials[k] : ""))]) {
      const bytes = typeof part === "string" ? Buffer.from(part, "utf8") : part;
      const len = Buffer.alloc(8);
      len.writeBigUInt64BE(BigInt(bytes.byteLength));
      h.update(len).update(bytes);
    }
    return h.digest("hex").slice(0, 32);
  }
  return createHash("sha256").update(image).update("\0").update(name).update("\0").update(symbol).digest("hex").slice(0, 32);
}

/*
  Socials A: the token file (token/<hash>.json) a wallet or a tracker reads. Both shapes, since which fields each one
  reads is INFERENCE (SOCIALS-A-SPEC.md section 3): the top-level keys (external_url and website for the website,
  twitter for the X link, telegram) and the same links under extensions. Every empty field is left out entirely, the
  description too. The key order is fixed, so the same values are always the same bytes.
*/
export function tokenFileJson(f: { name: string; symbol: string; image: string } & TokenSocials): string {
  const links = { ...(present(f.website) ? { website: f.website } : {}), ...(present(f.x) ? { twitter: f.x } : {}), ...(present(f.telegram) ? { telegram: f.telegram } : {}) };
  return JSON.stringify({
    name: f.name,
    symbol: f.symbol,
    ...(present(f.description) ? { description: f.description } : {}),
    image: f.image,
    ...(present(f.website) ? { external_url: f.website } : {}),
    ...links,
    ...(Object.keys(links).length ? { extensions: links } : {}),
  });
}

/* Socials A: the bytes the route wrote before this change (79c87bd route.ts:106) for the same name, ticker and picture. A file with none of the four keeps its old name, so on a retry these bytes at that path are the same file, not another. */
export const legacyTokenFileJson = (f: { name: string; symbol: string; image: string }): string => JSON.stringify({ name: f.name, symbol: f.symbol, description: "", image: f.image });

/* Socials A, ask 3: the four as a stored file carries them at the top level (twitter is the X box), each a non-empty string or left out. */
export function storedSocials(json: string): TokenSocials {
  let j: unknown;
  try {
    j = JSON.parse(json);
  } catch {
    return {};
  }
  if (!j || typeof j !== "object" || Array.isArray(j)) return {};
  const o = j as Record<string, unknown>;
  const out: TokenSocials = {};
  for (const [k, v] of [["description", o.description], ["website", o.website], ["x", o.twitter], ["telegram", o.telegram]] as const) if (present(v)) out[k] = v;
  return out;
}

/* Socials A: what putToken found or wrote. `json` is the metadata file as stored (the one asked for, or an accepted older form of it). */
export type PutResult = { ok: true; json: string } | { ok: false; why: "taken" };
type Found = { bytes: Uint8Array; contentType: string };

async function readFound(s: TokenStore, path: string): Promise<Found | null> {
  const f = await s.get(path);
  return f ? { bytes: await readAll(f.stream), contentType: f.contentType } : null;
}

/* Socials A: what is at a path that may not exist yet: the store's API first (exists), and get() only for a file it says is there; a file it says is there and get() cannot read throws (the caller fails closed). A store without exists is read. */
async function lookup(s: TokenStore, path: string): Promise<Found | null> {
  if (!s.exists) return readFound(s, path);
  if (!(await s.exists(path))) return null;
  const f = await readFound(s, path);
  if (!f) throw new Error("the store holds a file it did not serve");
  return f;
}

/* Socials A: a create-only write. When the store throws, the path is looked up: the same bytes (an identical upload got there first) is "same", other bytes "taken"; nothing there, the store's own failure stands. */
async function createOnly(s: TokenStore, path: string, body: Uint8Array | string, contentType: string, same: (f: Found) => boolean): Promise<"written" | "same" | "taken"> {
  try {
    await s.put(path, body, contentType);
    return "written";
  } catch (e) {
    const now = await lookup(s, path).catch(() => null);
    if (!now) throw e;
    return same(now) ? "same" : "taken";
  }
}

/*
  Both files written, then both read back and compared byte for byte before
  the caller may hand out the URI (GPT-6 2026-10-17, I2: a failed second
  write left an orphan picture, and nothing checked what the store would
  serve). A second write that fails took the picture down with it, best
  effort, until T2 (below); a read-back that differs throws, and the route answers the store's
  sentence. The names are content hashes, so a retry writes the same bytes.

  Socials A, no overwrite at all: both paths are looked up before anything is
  written (lookup: the store's API says whether a file is there, and only a
  file that is there is read, so the read-back below is the first read of a
  new file, as before this change). A file already there with the same bytes is a harmless retry
  (`also` names older forms of the metadata file taken as the same file:
  legacyTokenFileJson); any other bytes answer "taken" and nothing is
  written. Only what is missing is written, create-only, and only a picture
  written by this call was ever taken down.

  2026-10-31 (T2, review/2026-10-31c-precheck/REPORT.md): nothing is taken
  down any more. The picture's path is its content's hash, so an identical
  upload that wrote the metadata file meanwhile, read both back and answered
  200 holds a URI to that same picture: taking it down after a failed or
  refused metadata write left that URI without its image. A picture under
  its own hash with no metadata file is harmless, and a retry reuses it
  (only the missing metadata file is written).
*/
export async function putToken(hash: string, image: { bytes: Uint8Array; contentType: string }, metadataJson: string, also: readonly string[] = []): Promise<PutResult> {
  const s = await current();
  const imagePath = `${PREFIX}${hash}`;
  const jsonPath = `${PREFIX}${hash}.json`;
  const accepted = [metadataJson, ...also];
  const imageIs = (f: Found): boolean => f.contentType === image.contentType && sameBytes(f.bytes, image.bytes);
  const jsonIs = (f: Found): string | null => (f.contentType === "application/json" ? (accepted.find((t) => t === new TextDecoder().decode(f.bytes)) ?? null) : null);
  const [hadImage, hadJson] = await Promise.all([lookup(s, imagePath), lookup(s, jsonPath)]);
  if ((hadImage && !imageIs(hadImage)) || (hadJson && jsonIs(hadJson) === null)) return { ok: false, why: "taken" };
  if (!hadImage) {
    const w = await createOnly(s, imagePath, image.bytes, image.contentType, imageIs);
    if (w === "taken") return { ok: false, why: "taken" };
  }
  /* T2: a failed or refused metadata write leaves the picture where it is (see above). */
  if (!hadJson && (await createOnly(s, jsonPath, metadataJson, "application/json", (f) => jsonIs(f) !== null)) === "taken") return { ok: false, why: "taken" };
  const [storedImage, storedJson] = await Promise.all([readFound(s, imagePath), readFound(s, jsonPath)]);
  if (!storedImage || !storedJson) throw new Error("the store did not read back what was written");
  if (!imageIs(storedImage)) throw new Error("the stored picture differs from what was written");
  const json = jsonIs(storedJson);
  if (json === null) throw new Error("the stored metadata differs from what was written");
  return { ok: true, json };
}

/* Socials A, ask 1 (server/attest.ts issueCreate): a stored metadata file's name and ticker by its hash; null when there is none. Throws when the store cannot answer or there is no store, so the permit fails closed. */
export async function readTokenFacts(hash: string): Promise<{ name: unknown; symbol: unknown } | null> {
  if (!HASH_RE.test(hash)) return null;
  if (!hasTokenStore()) throw new Error("no token store");
  const found = await lookup(await current(), `${PREFIX}${hash}.json`);
  if (!found) return null;
  try {
    const j: unknown = JSON.parse(new TextDecoder().decode(found.bytes));
    if (!j || typeof j !== "object" || Array.isArray(j)) return { name: null, symbol: null };
    return { name: (j as { name?: unknown }).name, symbol: (j as { symbol?: unknown }).symbol };
  } catch {
    return { name: null, symbol: null };
  }
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.byteLength;
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.byteLength;
  }
  return all;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) if (a[i] !== b[i]) return false;
  return true;
}

/* A stored file by its public name (<hash> or <hash>.json); null when there is none or the name is not one. */
export async function getToken(file: string): Promise<StoredFile | null> {
  if (!FILE_RE.test(file)) return null;
  const s = await current();
  return s.get(`${PREFIX}${file}`);
}
