/*
  The site's colours for the places that cannot read CSS variables: the
  launch card image (Satori), the coming-soon page (a string the proxy
  sends), the icons and the coming-soon card (scripts). The same values as
  the tokens in src/app/globals.css :root, name for name;
  scripts/check-theme.ts fails if the two differ.

  Blue retheme (the founder, 2026-10-19, for the blue X picture and banner): the
  near-black and its greys lean blue (hue about 215) instead of green. The
  blue itself is unchanged.
*/
export const THEME = {
  bg: "#0b0e13",
  panel: "#131922",
  line: "#242d3a",
  "line-2": "#303b4a",
  text: "#f4f7fb",
  "text-2": "#b9c3d0",
  "text-3": "#8f9bac",
  brand: "#1da1f2",
  "brand-text": "#53b8f7",
} as const;
