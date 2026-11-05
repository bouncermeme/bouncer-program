/*
  Which pictures the site refuses by kind, one rule for the create page and the upload route (24h, the founder 2026-10-25:
  no GIFs for now; wording approved from review/2026-10-25-gif-refusal-mock). The page reads a file's first bytes and
  the route reads the bytes it was sent, and both ask refusedKind, so a GIF renamed .png, or an SVG renamed anything,
  is refused at both. The browser's type and the file's name refuse too on the page, before anything is read.
  Animated GIF logos are a future upgrade (docs/MAINNET-LAUNCH-PLAN.md).
*/
export const GIF_REFUSED = "GIF pictures are not accepted. Use a PNG, JPEG or WebP.";
export const SVG_REFUSED = "SVG pictures are not accepted. Use a PNG, JPEG or WebP.";
/* What the page reads of a file before anything else: enough for both signatures (an SVG may start with a comment). */
export const HEAD_BYTES = 512;

export function isGif(b: Uint8Array): boolean {
  if (b.length < 6) return false;
  const sig = String.fromCharCode(...b.subarray(0, 6));
  return sig === "GIF87a" || sig === "GIF89a";
}

/* An SVG (or any XML) by its first bytes: an optional byte-order mark and whitespace, then the markup's start. */
export function looksLikeSvg(bytes: Uint8Array): boolean {
  let o = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0;
  while (o < bytes.length && (bytes[o] === 0x20 || bytes[o] === 0x09 || bytes[o] === 0x0a || bytes[o] === 0x0d)) o++;
  const head = String.fromCharCode(...bytes.subarray(o, o + 256)).toLowerCase();
  return head.startsWith("<?xml") || head.startsWith("<svg") || head.startsWith("<!doctype svg") || (head.startsWith("<!--") && head.includes("<svg"));
}

/* The kind a picture is refused for, from its bytes and, on the page, its type and name; null when it is not refused by kind. */
export function refusedKind(head: Uint8Array, name = "", type = ""): "gif" | "svg" | null {
  if (type === "image/svg+xml" || /\.svg$/i.test(name) || looksLikeSvg(head)) return "svg";
  if (type === "image/gif" || /\.gif$/i.test(name) || isGif(head)) return "gif";
  return null;
}
