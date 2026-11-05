/*
  The mark: an open door, redrawn as vectors from ChatGPT's concept C
  revision 4 (the new look proposed 2026-10-10, not approved yet). A frame
  and a leaf swung open on its right hinge, in blue. One geometry for the
  header, the share cards and the icons; scripts/make-icons.ts writes
  src/app/icon.svg, favicon.ico and apple-icon.png from it.

  DOOR       the mark at 24 px and up, with the knob cut through the leaf.
  DOOR_TILE  the favicon: a 32-unit tile on even units, so a tab draws it
             sharp at 16 px.

  The favicon, pass 2 (2026-10-10). the founder: the pass-1 tile (DOOR's frame
  and leaf, mint on night) "reads like an N/M" at 16 and 24 px. A night
  tile is 1.59:1 against a dark browser tab, so it vanishes there and only
  the blue drawing is left; any frame with a leaf inside it then reads as a
  letter (n, m, r, F). So at tab size the drawing inverts: the whole tile is
  the light through the doorway, in blue, and the leaf stands open in it as
  a night slab, hinge on the right as in DOOR, with a blue knob. Three blind
  judges ranked it first of five at 16 px ("a door ajar"); the pass-1 tile
  last ("n", "m"). The options and their reads are in
  screenshots/2026-10-10-new-look-pass2/favicon/.
*/
import { THEME } from "./theme";

/* From src/lib/theme.ts (the tokens of globals.css): the blue, and the night the icons and cards stand on. */
export const BRAND_BLUE: string = THEME.brand;
export const NIGHT: string = THEME.bg;

export const DOOR = {
  width: 28,
  height: 32,
  frame: "M0 30.5V5a5 5 0 0 1 5-5h18a5 5 0 0 1 5 5v25.5a1.5 1.5 0 0 1-1.5 1.5h-1A1.5 1.5 0 0 1 24 30.5V5.5A1.5 1.5 0 0 0 22.5 4h-17A1.5 1.5 0 0 0 4 5.5v25a1.5 1.5 0 0 1-1.5 1.5h-1A1.5 1.5 0 0 1 0 30.5Z",
  /* The leaf, then the knob as a second ring: drawn even-odd, the knob is a hole. The thin stroke in the same colour rounds the leaf's corners. */
  leaf: "M10.5 8.8 22 5.6v24.8l-11.5-2.8ZM15.3 18.4a1.5 1.5 0 1 0-3 0a1.5 1.5 0 1 0 3 0Z",
  leafStroke: 0.8,
} as const;

export const DOOR_TILE = {
  size: 32,
  radius: 7,
  /* The leaf, hinge edge full height on the right, free edge shorter on the left (tall at the hinge, standing on the floor), then the knob as a second ring: drawn even-odd, the knob is a hole the blue shows through. */
  leaf: "M22 4v24l-12-2V10ZM12 16h2v2h-2Z",
} as const;

/* The mark as an SVG string, for places that are not React (the icon script). */
export function doorSvg(color: string = BRAND_BLUE): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${DOOR.width} ${DOOR.height}"><path d="${DOOR.frame}" fill="${color}"/><path d="${DOOR.leaf}" fill="${color}" fill-rule="evenodd" stroke="${color}" stroke-width="${DOOR.leafStroke}" stroke-linejoin="round"/></svg>`;
}

/* The favicon tile: a rounded blue square, the open leaf in night on it. */
export function tileSvg(): string {
  const t = DOOR_TILE;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${t.size} ${t.size}"><rect width="${t.size}" height="${t.size}" rx="${t.radius}" fill="${BRAND_BLUE}"/><path d="${t.leaf}" fill="${NIGHT}" fill-rule="evenodd"/></svg>`;
}

/* The home-screen icon (iOS rounds the corners itself, so the square is full): the full door, knob and all, centred with room around it. */
export function appleSvg(): string {
  const s = 180;
  const h = 104;
  const w = (h * DOOR.width) / DOOR.height;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${s} ${s}"><rect width="${s}" height="${s}" fill="${NIGHT}"/><svg x="${(s - w) / 2}" y="${(s - h) / 2}" width="${w}" height="${h}" viewBox="0 0 ${DOOR.width} ${DOOR.height}"><path d="${DOOR.frame}" fill="${BRAND_BLUE}"/><path d="${DOOR.leaf}" fill="${BRAND_BLUE}" fill-rule="evenodd" stroke="${BRAND_BLUE}" stroke-width="${DOOR.leafStroke}" stroke-linejoin="round"/></svg></svg>`;
}
