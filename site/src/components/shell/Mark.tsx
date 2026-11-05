import { DOOR } from "@/lib/brandMark";

/* The open door (src/lib/brandMark.ts), in the brand blue. size is the height; the width follows the door's 28 by 32. Its own module so the public whitepaper's header (PublicShell.tsx) draws it without importing AppHeader and its wallet button. */
export function Mark({ size = 28 }: { size?: number }) {
  return (
    <svg width={Math.round((size * DOOR.width) / DOOR.height)} height={size} viewBox={`0 0 ${DOOR.width} ${DOOR.height}`} aria-hidden="true">
      <path d={DOOR.frame} fill="var(--brand)" />
      <path d={DOOR.leaf} fill="var(--brand)" fillRule="evenodd" stroke="var(--brand)" strokeWidth={DOOR.leafStroke} strokeLinejoin="round" />
    </svg>
  );
}
