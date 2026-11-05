/*
  The create page's square crop (the founder approved the mock 2026-10-25: review/2026-10-25-founder-issues/image-crop-mock).
  A PNG, JPEG or WebP is accepted (no GIFs since 24h, lib/bouncer/imagePolicy.ts); the creator drags and zooms a square over it, and the page uploads that square, drawn at
  most 1,024 a side (never under 64), so the upload route's own checks (server/imageFile.ts: square, 64 to 4,096 a side,
  under 2 MB) always pass. The geometry is kept in the picture's own pixels, so it does not depend on the frame's size.
*/
export const PICK_MAX_BYTES = 20 * 1024 * 1024;
export const OUT_MAX_SIDE = 1024;
export const OUT_MIN_SIDE = 64;
export const ZOOM_MAX = 4;

/* Where the square is: its centre in the picture's pixels and the zoom (1: the square is the picture's short side). */
export interface Crop {
  cx: number;
  cy: number;
  zoom: number;
}

export function clampZoom(z: number): number {
  return Number.isFinite(z) ? Math.min(ZOOM_MAX, Math.max(1, z)) : 1;
}

/* The square's side in the picture's pixels. */
export function cropSide(w: number, h: number, zoom: number): number {
  return Math.min(w, h) / clampZoom(zoom);
}

/* The centre kept so the square never leaves the picture. */
export function clampCrop(w: number, h: number, c: Crop): Crop {
  const zoom = clampZoom(c.zoom);
  const half = cropSide(w, h, zoom) / 2;
  const cx = Number.isFinite(c.cx) ? Math.min(w - half, Math.max(half, c.cx)) : w / 2;
  const cy = Number.isFinite(c.cy) ? Math.min(h - half, Math.max(half, c.cy)) : h / 2;
  return { cx, cy, zoom };
}

export function centred(w: number, h: number): Crop {
  return { cx: w / 2, cy: h / 2, zoom: 1 };
}

/* The source square to draw, in the picture's pixels. */
export function cropRect(w: number, h: number, c: Crop): { sx: number; sy: number; side: number } {
  const k = clampCrop(w, h, c);
  const side = cropSide(w, h, k.zoom);
  return { sx: k.cx - side / 2, sy: k.cy - side / 2, side };
}

/* The uploaded square's side: the crop's own size, at most 1,024 and at least 64. */
export function outputSide(side: number): number {
  return Math.max(OUT_MIN_SIDE, Math.min(OUT_MAX_SIDE, Math.round(side)));
}

/* A drag of dx, dy screen pixels in a frame of `frame` pixels moves the centre the other way, in the picture's pixels. */
export function dragged(w: number, h: number, c: Crop, frame: number, dx: number, dy: number): Crop {
  const perPx = cropSide(w, h, c.zoom) / frame;
  return clampCrop(w, h, { cx: c.cx - dx * perPx, cy: c.cy - dy * perPx, zoom: c.zoom });
}

export interface Picked {
  url: string;
  name: string;
  type: string;
  bytes: number;
  w: number;
  h: number;
}

/* The square as the page uploads it: WebP where the browser encodes it, JPEG otherwise, under the upload route's 2 MB. */
export function drawSquare(img: CanvasImageSource, p: Pick<Picked, "w" | "h">, c: Crop): { url: string; side: number } {
  const r = cropRect(p.w, p.h, c);
  const side = outputSide(r.side);
  const canvas = document.createElement("canvas");
  canvas.width = side;
  canvas.height = side;
  const g = canvas.getContext("2d");
  if (!g) throw new Error("no canvas");
  g.imageSmoothingQuality = "high";
  g.drawImage(img, r.sx, r.sy, r.side, r.side, 0, 0, side, side);
  for (const q of [0.9, 0.8, 0.7]) {
    let url = canvas.toDataURL("image/webp", q);
    if (!url.startsWith("data:image/webp")) url = canvas.toDataURL("image/jpeg", q);
    if (url.length * 0.75 < 1.9 * 1024 * 1024) return { url, side };
  }
  return { url: canvas.toDataURL("image/jpeg", 0.6), side };
}
