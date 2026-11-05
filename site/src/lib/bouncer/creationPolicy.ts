/*
  Who may create, and which names are reserved (launch candidate, 2026-10-22,
  the founder). One module for the attestation service (server/attest.ts issueCreate)
  and the create form, so the two never disagree. No environment is read here:
  the server passes its env lists, the browser the build's hashed copies, and
  next.config.helpers.ts publishes those copies with this module's parser.

  Genesis mode: GENESIS_CREATORS (comma-separated wallets) set means creation
  permits go only to those wallets ("not-allowed" otherwise); a value with any
  entry that is not a wallet refuses everyone (fail closed). Unset, creation is
  public.

  The ticker (review M1, the founder 2026-10-22): A to Z and 0 to 9 only, 1 to 10
  characters (the program's metadata::MAX_SYMBOL is 10 bytes), for every
  creator, the reserved-name owners too. Anything else is refused ("reserved",
  rule "reserved-charset"). The check is on the bytes as sent, not after
  upper-casing, so ß (upper-cased SS) and ı (upper-cased I) are refused too.
  This closes the look-alike class for the ticker outright.

  Reserved names, permanent and independent of genesis: a create whose ticker
  OR name normalises to a reserved term is refused ("reserved", rule
  "reserved-term") unless the creator is in RESERVED_TICKER_OWNERS.
  normaliseTerm makes the skeleton both sides are compared on:
    1. the Unicode TR39 confusable skeleton, NFKD in place of NFD, with a
       reviewed supplement (confusables.ts: the generated TR39 table, the Unicode
       version and sha256 in confusablesData.ts; the small capitals ʙ ɴ ʀ ᴇ,
       negative squared 🅱 and regional indicators 🇧 in confusablesSupplement.ts),
       marks dropped, upper-cased;
    2. digits and symbols that stand for letters: 0→O, 1→I, 3→E, 4→A, 5→S,
       7→T, 8→B, @→A, and |, ! and L also to I (1 reads as I or L; the terms
       get the same fold, so neither reading escapes);
    3. any other letter (a letter of any script that is still not A to Z) is a
       WILDCARD, written "?": it is never silently dropped. Modifier letters
       (Lm: the Arabic tatweel, the Katakana long mark) are dropped like
       punctuation, as they were before, since they read as a line or a dash;
    4. everything else dropped (spaces, punctuation, $, dots, emoji, zero-width,
       and the digits no letter stands for: 2, 6, 9);
    5. runs of one letter collapsed (BOUUNCER, BOUNCERR); wildcards are not.
  A text is reserved when its skeleton matches a reserved term's skeleton
  exactly, or contains the skeleton of BOUNCER anywhere (BOUNCER2,
  BOUNCERFINANCE, THEBOUNCER). A wildcard matches any one letter, but a match
  needs a real majority of real Latin letters: at least ceil(n/2) + 1 of the
  term's n letters must be A to Z after the skeleton, not wildcards. So for
  BOUNCER (7): one or two unknown letters in an otherwise Latin BOUNCER are
  refused (ᏴOUNCER, BՕUNCER and a Cyrillic Ж in place of a letter: TR39 and
  the supplement map the known look-alikes, and the wildcard catches the ones
  no table knows), while three or more are not, and an all-CJK name (no Latin
  letter at all) is never refused. The reason for the bar: a letter no table
  maps to Latin is not known to look Latin, so it may stand in for a letter
  only beside a clear Latin majority, which is the shape of the attack (one
  swapped letter); a name mostly in another script is that script's word.
  The same text is also checked with its wildcards removed (the reading
  before this change), so a non-Latin letter inserted into BOUNCER (BOUN漢CER)
  still reads as BOUNCER.
  BOUNCE, BNCR and BOUNCR are refused only exactly: "contains BOUNCE" would
  also refuse BOUNCEHOUSE, BOUNCEBACK, BOUNCY and similar unrelated words, so
  that wider rule is left out on purpose. The trade-off: MOONBOUNCE and
  BOUNCEHOUSE pass; BOUNCE2 is refused (the 2 stands for no letter and is
  dropped, which leaves BOUNCE), as is BOUNCER anywhere.
*/
import { latinSkeleton } from "./confusables";

export const RESERVED_TERMS = ["BOUNCER", "BOUNCE", "BNCR", "BOUNCR", "BOUNCERMEME", "BOUNCER.MEME"] as const;
/* The term whose skeleton anywhere in a ticker or name reserves it. */
export const RESERVED_CORE = "BOUNCER";
/* A letter the skeleton could not read as Latin. */
export const WILDCARD = "?";

const DIGIT_FOLD: Record<string, string> = { "0": "O", "1": "I", "3": "E", "4": "A", "5": "S", "7": "T", "8": "B", "|": "I", "!": "I", L: "I", "@": "A" };

export function normaliseTerm(text: string): string {
  let out = "";
  for (const ch of latinSkeleton(text)) {
    const c = DIGIT_FOLD[ch] ?? ch;
    if (c >= "A" && c <= "Z" && c.length === 1) out += c;
    else if (/^\p{L}$/u.test(c) && !/^\p{Lm}$/u.test(c)) out += WILDCARD;
  }
  return out.replace(/([A-Z])\1+/g, "$1");
}

/* The skeleton read the way it was before wildcards: unknown letters removed. */
function withoutWildcards(k: string): string {
  return k.split(WILDCARD).join("").replace(/([A-Z])\1+/g, "$1");
}

/* Real Latin letters a match must have: a strict majority plus one, ceil(n/2) + 1 (BOUNCER 5 of 7, BOUNCE 4 of 6, BNCR 3 of 4). */
export function latinNeeded(termLength: number): number {
  return Math.min(termLength, Math.ceil(termLength / 2) + 1);
}

/* Does k match the term's skeleton t at position i (wildcards for any letter, with enough real letters)? */
function fitsAt(k: string, i: number, t: string): boolean {
  let real = 0;
  for (let j = 0; j < t.length; j++) {
    const c = k[i + j];
    if (c === t[j]) real++;
    else if (c !== WILDCARD) return false;
  }
  return real >= latinNeeded(t.length);
}

const TERM_SKELETONS: ReadonlyArray<readonly [string, string]> = RESERVED_TERMS.map((t) => [t, normaliseTerm(t)] as const);
const CORE_SKELETON = normaliseTerm(RESERVED_CORE);

/* The reserved term a text stands for, or null. */
export function reservedTermOf(text: string): string | null {
  const k = normaliseTerm(text);
  if (!k) return null;
  const plain = withoutWildcards(k);
  for (const [term, t] of TERM_SKELETONS) if ((k.length === t.length && fitsAt(k, 0, t)) || plain === t) return term;
  for (let i = 0; i + CORE_SKELETON.length <= k.length; i++) if (fitsAt(k, i, CORE_SKELETON)) return RESERVED_CORE;
  return plain.includes(CORE_SKELETON) ? RESERVED_CORE : null;
}

/* The program's metadata::MAX_SYMBOL (bytes; the ticker is ASCII, so characters). check-creation-policy holds it equal to contract BOUNDS.maxSymbol. */
export const TICKER_MAX = 10;
/* The ticker's whole alphabet, for every creator: A to Z and 0 to 9 once upper-cased, checked on the text as sent. */
export function tickerCharsetOk(symbol: string): boolean {
  return symbol.length >= 1 && symbol.length <= TICKER_MAX && /^[A-Za-z0-9]+$/.test(symbol);
}

export type ReservedRule = "reserved-charset" | "reserved-term";
/* Which of a create's two strings is reserved, if either: the ticker first (its alphabet, then the terms), then the name. */
export function reservedIn(name: string, symbol: string): { field: "symbol" | "name"; term: string; rule: ReservedRule } | null {
  if (!tickerCharsetOk(symbol)) return { field: "symbol", term: "", rule: "reserved-charset" };
  const s = reservedTermOf(symbol);
  if (s) return { field: "symbol", term: s, rule: "reserved-term" };
  const n = reservedTermOf(name);
  return n ? { field: "name", term: n, rule: "reserved-term" } : null;
}

/* ---------------- the wallet lists ---------------- */

const BASE58_KEY = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/*
  A comma- or space-separated env list of wallets: the one parser the server
  (server/attest.ts depsFromEnv) and the build's publication
  (next.config.helpers.ts publicLists) both use (review L2). "unset" when
  absent or blank. Otherwise every entry is checked first; then valid
  duplicates are folded into one. Any entry that is not a wallet, or a value
  with no entry at all (",,"), makes the list malformed with no wallets: the
  caller fails closed (a malformed genesis list refuses everyone, a malformed
  owner list owns nothing).
*/
export type WalletList = { set: false } | { set: true; wallets: ReadonlySet<string>; malformed: boolean };
export function parseWalletList(raw: string | undefined | null): WalletList {
  const s = (raw ?? "").trim();
  if (!s) return { set: false };
  const parts = s.split(/[\s,]+/).filter(Boolean);
  if (parts.length === 0 || !parts.every((p) => BASE58_KEY.test(p))) return { set: true, wallets: new Set(), malformed: true };
  return { set: true, wallets: new Set(parts), malformed: false };
}

/* Genesis mode: may this wallet be given a creation permit? */
export function creatorAllowed(list: WalletList, creator: string): boolean {
  if (!list.set) return true;
  if (list.malformed) return false;
  return list.wallets.has(creator);
}

/* A reserved-name owner (RESERVED_TICKER_OWNERS): a malformed list owns nothing. */
export function isReservedOwner(list: WalletList, creator: string): boolean {
  return list.set && !list.malformed && list.wallets.has(creator);
}

export type CreationRefusal = "not-allowed" | "reserved";
/*
  The whole policy for one creation: null when it may go on. The ticker's
  alphabet binds the owners too; only a reserved term is theirs to use. A
  charset refusal answers "reserved" (the service's reasons are fixed in
  server/attest.ts), with rule "reserved-charset" for the form and the log.
*/
export function creationRefusal(input: { creator: string; name: string; symbol: string; genesis: WalletList; owners: WalletList }): { why: CreationRefusal; field?: "symbol" | "name"; term?: string; rule?: ReservedRule } | null {
  if (!creatorAllowed(input.genesis, input.creator)) return { why: "not-allowed" };
  const r = reservedIn(input.name, input.symbol);
  if (!r) return null;
  if (r.rule === "reserved-charset") return { why: "reserved", field: r.field, rule: r.rule };
  if (isReservedOwner(input.owners, input.creator)) return null;
  return { why: "reserved", field: r.field, term: r.term, rule: r.rule };
}

/* ---------------- the browser's copy ---------------- */

/*
  The create form knows the lists only as hashes (next.config.ts publishes
  NEXT_PUBLIC_GENESIS_CREATOR_HASHES and NEXT_PUBLIC_RESERVED_OWNER_HASHES from
  the two server lists at build time), so no wallet list is shipped in the
  page. The hash: the first 32 hex digits of sha256("bouncer/creator/v1:" + wallet).
  An empty genesis hash list with genesis on means "nobody" (fail closed).
*/
export const WALLET_HASH_TAG = "bouncer/creator/v1:";
export async function walletHash(wallet: string): Promise<string> {
  const d = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(WALLET_HASH_TAG + wallet));
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, "0")).join("").slice(0, 32);
}
export interface HashedLists {
  genesisOn: boolean;
  genesis: ReadonlySet<string>;
  owners: ReadonlySet<string>;
}
export function hashedListsFrom(genesisOn: string | undefined, genesis: string | undefined, owners: string | undefined): HashedLists {
  const set = (s: string | undefined) => new Set((s ?? "").split(",").map((x) => x.trim()).filter((x) => /^[0-9a-f]{32}$/.test(x)));
  return { genesisOn: genesisOn === "1", genesis: set(genesis), owners: set(owners) };
}
