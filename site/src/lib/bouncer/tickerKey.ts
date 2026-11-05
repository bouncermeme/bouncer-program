/*
  The copycat key a ticker is compared on (23c, policy t2; review/2026-10-24-23c-morning/DESIGN.md section 2). One
  module for the create form, /api/ticker and the creation permit, so the three never disagree. A ticker is ASCII
  A-Z and 0-9 (creationPolicy.ts tickerCharsetOk); anything else has no key.

    1. upper-case;
    2. digits that stand for letters: 0→O 1→I 3→E 4→A 5→S 7→T 8→B, and L→I (1, I and l look alike once case is
       folded); 2, 6 and 9 stand for no letter and are dropped;
    3. VV→W (the founder, 2026-10-24), before repeats collapse, so VVIF is WIF; V is never U, so WIF, VIF and UIF differ;
    4. runs of one letter collapse (PEEPE→PEPE, MOON→MON);
    5. a ticker that keys to nothing (69, 666, 2) keys to its upper-cased raw text in its own namespace.

  The key carries its version (t2:PEPE, t2r:69): a later policy is a new version, never a silent change of what an
  existing reservation means. The official-brand reservations (BOUNCER and friends) stay creationPolicy.ts's.
*/
export const TICKER_POLICY = "t2";
const ALNUM = /^[A-Za-z0-9]{1,10}$/;
const FOLD: Record<string, string> = { "0": "O", "1": "I", "3": "E", "4": "A", "5": "S", "7": "T", "8": "B", L: "I" };
const DROPPED = new Set(["2", "6", "9"]);

/* The skeleton alone (no version), or "" when nothing is left. */
export function tickerSkeleton(ticker: string): string {
  let out = "";
  for (const ch of ticker.toUpperCase()) {
    if (DROPPED.has(ch)) continue;
    out += FOLD[ch] ?? ch;
  }
  return out.replace(/VV/g, "W").replace(/([A-Z])\1+/g, "$1");
}

/* The versioned key, or null for a ticker outside the alphabet. */
export function tickerKey(ticker: string): string | null {
  if (typeof ticker !== "string" || !ALNUM.test(ticker)) return null;
  const k = tickerSkeleton(ticker);
  return k ? `${TICKER_POLICY}:${k}` : `${TICKER_POLICY}r:${ticker.toUpperCase()}`;
}

/* The collision classes DESIGN.md documents, as pairs that share a key (scripts/check-copycat-v2.ts holds them). */
export const COLLISION_CLASSES: ReadonlyArray<{ id: string; same: readonly string[]; differ?: readonly string[] }> = [
  { id: "C1 case", same: ["pepe", "PEPE", "PePe"] },
  { id: "C2 digit for letter", same: ["PEPE", "P3P3", "PEP3"], differ: ["PEPX"] },
  { id: "C3 L reads as I", same: ["WIF", "WLF", "W1F"] },
  { id: "C4 dropped digits", same: ["PEPE", "PEPE2", "PE6PE9"] },
  { id: "C5 repeats", same: ["MOON", "MON", "MOOON", "M00N"] },
  { id: "C6 double V", same: ["WIF", "VVIF"], differ: ["VIF", "UIF"] },
  { id: "C7 empty keeps its raw text", same: ["69"], differ: ["666", "2", "96"] },
];
