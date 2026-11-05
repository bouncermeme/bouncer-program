/* The avatar hue for a token with no image, from its mint address. Shared by the page avatar and the share card so both draw the same colour. */
export function hue(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
  return h;
}
