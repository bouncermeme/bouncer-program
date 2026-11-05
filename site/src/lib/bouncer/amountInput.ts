/*
  What a typed amount means, or why it is not read.

  2026-10-01: the deposit field stripped commas before parsing, so "1,5"
  (one and a half, the way most of Europe and Latin America write it) became
  15 SOL with a live bid button: ten times the money. The same field read
  "1e3" as 1,000 and "0x10" as 16, because it accepted anything JavaScript
  can turn into a number.

  The rule since (the manager, with the founder): nothing is guessed. A typed
  amount is digits with at most one decimal point, and anything else is
  refused with the reason in a sentence. A comma is always refused, in both
  fields: "1,5" is one and a half in Berlin and fifteen with a stray comma in
  New York, and a wrong guess costs someone ten times their money. The site
  never writes a comma into a field either, so what it puts there can always
  be edited without tripping this.

  Amounts are read from the text into whole lamports with integer arithmetic.
  No floating point touches a deposit.
*/

export type Refusal = { ok: false; empty: boolean; why: string };
export type SolRead = { ok: true; atoms: bigint } | Refusal;
export type UsdRead = { ok: true; usd: number } | Refusal;

const SOL_DECIMALS = 9;
const U64_MAX = (1n << 64n) - 1n;

/* ASCII digits only: \d without the unicode flag. "١٢" and "１２" are digits to a person and not to a parser, so they are refused rather than half read. */
const PLAIN = /^(\d+\.?\d*|\.\d+)$/;

const COMMA_SOL = "Commas are not read. 1,5 is one and a half to some people and fifteen to others, so nothing is guessed. Type a point for decimals and no separator for thousands: 1.5 or 1500.";
const COMMA_USD = "Commas are not read. 40,5 is forty and a half to some people and four hundred and five to others, so nothing is guessed. Type digits only, with a point for cents: 40000.";

function refuse(why: string, empty = false): Refusal {
  return { ok: false, empty, why };
}

/* The deposit, in SOL, to whole lamports. */
export function readSolInput(raw: string): SolRead {
  const t = raw.trim();
  if (t === "") return refuse("Type how much SOL to deposit.", true);
  if (t.includes(",")) return refuse(COMMA_SOL);
  if (!PLAIN.test(t)) return refuse("Digits and one decimal point only, like 0.5 or 12.");
  const [whole, frac = ""] = t.split(".");
  if (frac.length > SOL_DECIMALS) return refuse(`SOL has ${SOL_DECIMALS} decimal places and this has ${frac.length}.`);
  const atoms = BigInt(whole || "0") * 10n ** BigInt(SOL_DECIMALS) + BigInt(frac.padEnd(SOL_DECIMALS, "0") || "0");
  if (atoms === 0n) return refuse("Type an amount above zero.");
  if (atoms > U64_MAX) return refuse("That is more SOL than the program can hold in one bid.");
  return { ok: true, atoms };
}

/* The max market cap, in dollars. Two decimals at most: "40.000" is forty thousand to someone who groups with points, and is refused rather than read as forty. */
export function readUsdInput(raw: string): UsdRead {
  let t = raw.trim();
  if (t.startsWith("$")) t = t.slice(1).trim();
  if (t === "") return refuse("Type a market cap in dollars, or pick one below.", true);
  if (t.includes(",")) return refuse(COMMA_USD);
  if (!PLAIN.test(t)) return refuse("Digits only, like 40000. Letters such as k or m are not read.");
  const frac = t.split(".")[1] ?? "";
  if (frac.length > 2) return refuse("Dollars take two decimals at most. For forty thousand, type 40000.");
  const usd = Number(t);
  if (!Number.isFinite(usd)) return refuse("That figure is too large to read.");
  return { ok: true, usd };
}

/* What the site itself writes into the dollar field (a preset, the slider): plain digits, never a comma, cents only under a hundred dollars. */
export function usdFieldText(usd: number): string {
  return usd >= 100 ? String(Math.round(usd)) : String(Number(usd.toFixed(2)));
}

/* The deposit to the lamport, never rounded: "15 SOL", "1.5 SOL", "0.0015 SOL", "1,000 SOL". The page's ordinary figures round for reading; the amount about to be signed does not. */
export function solExact(atoms: bigint): string {
  const whole = atoms / 10n ** BigInt(SOL_DECIMALS);
  const frac = (atoms % 10n ** BigInt(SOL_DECIMALS)).toString().padStart(SOL_DECIMALS, "0").replace(/0+$/, "");
  return `${whole.toLocaleString("en-US")}${frac ? `.${frac}` : ""} SOL`;
}

/* Dollars for a deposit at a SOL price, for the "about $X" beside it. Display only; nothing is sealed or sent from it. */
export function solUsd(atoms: bigint, usdPerSol: number): number {
  return (Number(atoms) / 10 ** SOL_DECIMALS) * usdPerSol;
}

const ONES = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"];
const TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];
const SCALES = ["", " thousand", " million", " billion", " trillion"];

function under1000(n: number): string {
  const parts: string[] = [];
  if (n >= 100) {
    parts.push(`${ONES[Math.floor(n / 100)]} hundred`);
    n %= 100;
  }
  if (n >= 20) parts.push(n % 10 ? `${TENS[Math.floor(n / 10)]}-${ONES[n % 10]}` : TENS[Math.floor(n / 10)]);
  else if (n > 0) parts.push(ONES[n]);
  return parts.join(" ");
}

function wholeInWords(n: bigint): string {
  if (n === 0n) return "zero";
  const groups: string[] = [];
  let scale = 0;
  while (n > 0n) {
    const g = Number(n % 1000n);
    if (g > 0) groups.unshift(`${under1000(g)}${SCALES[scale]}`);
    n /= 1000n;
    scale++;
  }
  return groups.join(" ");
}

/*
  The deposit in words, exactly: "fifteen SOL", "one point five SOL", "zero
  point zero zero one five SOL". Digits after the point are read one by one,
  so no rounding hides in the words. Shown beside the figure before the
  wallet opens: a parser can be wrong about what someone typed, and a number
  spelled out is hard to misread by a factor of ten.
*/
export function solInWords(atoms: bigint): string {
  const whole = atoms / 10n ** BigInt(SOL_DECIMALS);
  const frac = (atoms % 10n ** BigInt(SOL_DECIMALS)).toString().padStart(SOL_DECIMALS, "0").replace(/0+$/, "");
  const point = frac
    ? ` point ${frac
        .split("")
        .map((d) => ONES[Number(d)])
        .join(" ")}`
    : "";
  return `${wholeInWords(whole)}${point} SOL`;
}
