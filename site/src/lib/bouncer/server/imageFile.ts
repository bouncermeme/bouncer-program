/*
  What an uploaded picture is, from its bytes alone (2026-10-16, the founder's
  item 7 / readiness S8): the kind by its signature, never by the file name
  or the declared type, and the size in pixels from the header, so the
  upload route can refuse anything that is not a square-ish image under the
  cap before it stores a byte. Four kinds, the ones every wallet and
  explorer renders: PNG, JPEG, WebP, GIF. No library: the headers are a few
  bytes each.

  Upload hardening (the founder, 2026-10-20): an SVG (or any XML) is named and
  refused outright (looksLikeSvg); a header past MAX_INPUT_SIDE pixels a
  side is refused before the decoder sees it; the stored picture is a fresh
  PNG (from a PNG or GIF) or WebP (from a JPEG or WebP), never the bytes
  that came in, so metadata, trailing bytes and polyglot payloads do not
  survive.
*/
export type ImageKind = "png" | "jpeg" | "webp" | "gif";
export interface ImageFacts {
  kind: ImageKind;
  contentType: string;
  width: number;
  height: number;
}

export const CONTENT_TYPES: Readonly<Record<ImageKind, string>> = { png: "image/png", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif" };

const be16 = (b: Uint8Array, o: number): number => (b[o] << 8) | b[o + 1];
const be32 = (b: Uint8Array, o: number): number => ((b[o] << 24) >>> 0) + (b[o + 1] << 16) + (b[o + 2] << 8) + b[o + 3];
const le16 = (b: Uint8Array, o: number): number => b[o] | (b[o + 1] << 8);
const le24 = (b: Uint8Array, o: number): number => b[o] | (b[o + 1] << 8) | (b[o + 2] << 16);
const ascii = (b: Uint8Array, o: number, n: number): string => String.fromCharCode(...b.subarray(o, o + n));

function png(b: Uint8Array): ImageFacts | null {
  if (b.length < 24) return null;
  if (!(b[0] === 0x89 && ascii(b, 1, 3) === "PNG" && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a)) return null;
  if (ascii(b, 12, 4) !== "IHDR") return null;
  return { kind: "png", contentType: CONTENT_TYPES.png, width: be32(b, 16), height: be32(b, 20) };
}

/* JPEG: walk the segments to the first start-of-frame marker, which carries the size. */
function jpeg(b: Uint8Array): ImageFacts | null {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  let o = 2;
  while (o + 4 <= b.length) {
    if (b[o] !== 0xff) return null;
    const marker = b[o + 1];
    if (marker === 0xff) {
      o++;
      continue;
    }
    /* Standalone markers carry no length. */
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
      o += 2;
      continue;
    }
    const len = be16(b, o + 2);
    if (len < 2) return null;
    const sof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (sof) {
      if (o + 9 > b.length) return null;
      return { kind: "jpeg", contentType: CONTENT_TYPES.jpeg, width: be16(b, o + 7), height: be16(b, o + 5) };
    }
    o += 2 + len;
  }
  return null;
}

function gif(b: Uint8Array): ImageFacts | null {
  if (b.length < 10) return null;
  const sig = ascii(b, 0, 6);
  if (sig !== "GIF87a" && sig !== "GIF89a") return null;
  return { kind: "gif", contentType: CONTENT_TYPES.gif, width: le16(b, 6), height: le16(b, 8) };
}

/* WebP: a RIFF container; the first chunk says which bitstream and carries the size. */
function webp(b: Uint8Array): ImageFacts | null {
  if (b.length < 30 || ascii(b, 0, 4) !== "RIFF" || ascii(b, 8, 4) !== "WEBP") return null;
  const chunk = ascii(b, 12, 4);
  if (chunk === "VP8 ") return { kind: "webp", contentType: CONTENT_TYPES.webp, width: le16(b, 26) & 0x3fff, height: le16(b, 28) & 0x3fff };
  if (chunk === "VP8L") {
    if (b[20] !== 0x2f) return null;
    const bits = b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24);
    return { kind: "webp", contentType: CONTENT_TYPES.webp, width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  if (chunk === "VP8X") return { kind: "webp", contentType: CONTENT_TYPES.webp, width: le24(b, 24) + 1, height: le24(b, 27) + 1 };
  return null;
}

/* The picture's kind and size, or null for anything that is not one of the four. */
export function imageFacts(bytes: Uint8Array): ImageFacts | null {
  const f = png(bytes) ?? jpeg(bytes) ?? webp(bytes) ?? gif(bytes);
  if (!f || !(f.width > 0 && f.height > 0)) return null;
  return f;
}

/* The largest picture accepted, in pixels a side, read from the header before anything is decoded. */
export const MAX_INPUT_SIDE = 4096;
export function withinSide(f: ImageFacts): boolean {
  return f.width <= MAX_INPUT_SIDE && f.height <= MAX_INPUT_SIDE;
}

/* An SVG or other XML document, by its first bytes: refused by name, whatever type it declared (one rule with the page since 24h). */
export { looksLikeSvg } from "@/lib/bouncer/imagePolicy";

/* Square or close to it: a side within a quarter of the other. The pages crop to a square; a banner would lose most of itself. */
export const MAX_ASPECT = 1.25;
export const MIN_SIDE = 64;
export function squareEnough(f: ImageFacts): boolean {
  const ratio = f.width > f.height ? f.width / f.height : f.height / f.width;
  return ratio <= MAX_ASPECT && Math.min(f.width, f.height) >= MIN_SIDE;
}

/* A data URL's bytes and declared type, or null when it is not one. The declared type is not trusted; the bytes are sniffed by the caller. */
export function dataUrlBytes(s: string, maxBytes: number): Uint8Array | null {
  const m = /^data:image\/[a-z0-9.+-]+;base64,([A-Za-z0-9+/=\s]+)$/i.exec(s);
  if (!m) return null;
  const b64 = m[1].replace(/\s+/g, "");
  /* Four base64 characters make three bytes: refuse before decoding what could not fit. */
  if ((b64.length * 3) / 4 > maxBytes + 3) return null;
  try {
    const bytes = Uint8Array.from(Buffer.from(b64, "base64"));
    return bytes.length <= maxBytes ? bytes : null;
  } catch {
    return null;
  }
}

/* ---- the whole picture, decoded (GPT-6 I1, 2026-10-17) ---- */

/* The longest side a stored picture keeps; larger ones are scaled down. Pages show at most 44 px; wallets a few hundred. */
export const MAX_SIDE = 1024;
/* The decoder's pixel bound: a header may claim any size, so the bound is what libvips is allowed to allocate. */
export const MAX_PIXELS = 16_000_000;

export interface DecodedImage {
  /* The picture re-encoded fresh, metadata stripped: PNG for a PNG or GIF source, WebP for a JPEG or WebP source. */
  bytes: Uint8Array;
  contentType: string;
  kind: ImageKind;
  width: number;
  height: number;
}

const FORMAT_KIND: Readonly<Record<string, ImageKind>> = { png: "png", jpeg: "jpeg", webp: "webp", gif: "gif" };

/*
  The picture decoded whole by sharp (libvips) and re-encoded. failOn "error"
  makes a truncated or forged file throw instead of decoding to garbage; the
  decoder's own kind and size must agree with the sniffed header; the pixel
  bound caps what a header can ask the decoder to allocate; the first frame
  only. The output is a fresh encoding (no EXIF, no ICC, no text chunks, no
  trailing bytes; sharp writes no metadata unless asked), PNG or WebP,
  scaled to MAX_SIDE at most. Null for anything that does
  not decode. Nothing the decoder says leaves this function: a caller gets
  null, never the decoder's words.
*/
export async function decodeImage(bytes: Uint8Array, facts: ImageFacts): Promise<DecodedImage | null> {
  try {
    const sharp = (await import("sharp")).default;
    const input = sharp(Buffer.from(bytes), { failOn: "error", limitInputPixels: MAX_PIXELS, animated: false, pages: 1 });
    const meta = await input.metadata();
    if (!meta.format || FORMAT_KIND[meta.format] !== facts.kind) return null;
    if (!meta.width || !meta.height || meta.width !== facts.width || meta.height !== facts.height) return null;
    const lossless = facts.kind === "png" || facts.kind === "gif";
    const pipeline = input.rotate().resize(MAX_SIDE, MAX_SIDE, { fit: "inside", withoutEnlargement: true });
    const { data, info } = await (lossless ? pipeline.png({ compressionLevel: 9 }) : pipeline.webp({ quality: 88 })).toBuffer({ resolveWithObject: true });
    if (!(info.width > 0 && info.height > 0) || data.length === 0) return null;
    return { bytes: new Uint8Array(data), contentType: lossless ? CONTENT_TYPES.png : CONTENT_TYPES.webp, kind: lossless ? "png" : "webp", width: info.width, height: info.height };
  } catch {
    return null;
  }
}
