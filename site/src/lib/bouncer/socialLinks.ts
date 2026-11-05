/*
  Socials in the token's metadata file (2026-10-30: Option A, every creator; plan B4, A16.4).
  The rules are the program lane's spec (review/2026-10-30-mainnet-steps/SOCIALS-A-SPEC.md section 2) with the
  frontend lane's amendments marked "amendment" (review/2026-10-30-socials-mock/SPEC-PROPOSAL.md), all twelve taken
  (review/2026-10-30-mainnet-steps/SOCIALS-A-ANSWER.md section 1). Copied from the mock with the route change (the
  answer's question 6), its sentences as at 4fbb1e4 (2026-10-31: the two limit sentences, R3's and R9's, all
  approved): the upload route (app/api/token/route.ts) imports it, so the form and the route share one rule from the
  first commit. One rule for the create form, the upload route and the pages that show the links, so the three never
  disagree:
  - a description of at most DESCRIPTION_MAX_CHARS characters and DESCRIPTION_MAX_BREAKS line breaks, stored as typed
    (NFC, trimmed); hidden characters are refused, not removed (a lone surrogate too: the server's change, so what
    is stored is what the fingerprint covers);
  - a website on https, a host name with a dot, stored as the URL parser writes it without its # part;
  - X as a handle or an x.com / twitter.com link, stored as https://x.com/<handle>; a community likewise;
  - Telegram as a name or a t.me link, stored as https://t.me/<name>; an invite likewise;
  - every stored link at most LINK_MAX_CHARS characters;
  - Bouncer's own site, X and Telegram (lib/site.ts OFFICIAL) refused in every box on every ticker but BOUNCER.
*/
import { OFFICIAL } from "../site";

export const DESCRIPTION_MAX_CHARS = 280;
export const DESCRIPTION_MAX_BREAKS = 3;
export const LINK_MAX_CHARS = 200;
/* What the parser is ever given: a bound against abuse, far above any link that could be stored within LINK_MAX_CHARS. */
const LINK_RAW_MAX = 2000;

export type LinkKind = "website" | "x" | "telegram";
export type SocialField = "description" | LinkKind;
export type SocialValues = Record<SocialField, string>;
export type CreatorLinks = Partial<Record<LinkKind, string>>;
/* The route's needs (SOCIALS-A-ANSWER.md ask 2): the four boxes in the order the route checks them, the closed list a refusal's field comes from. */
export const SOCIAL_FIELDS = ["description", "website", "x", "telegram"] as const satisfies readonly SocialField[];

/* The words under each box (the spec's section 2, and the same sentence the route answers, so a refusal reads the same either way). */
export const SOCIAL_WORDS = {
  websiteHttps: "Use a link that starts with https://",
  websiteAddress: "That is not a website address.",
  /* 2026-10-31: 280 and 200 are allowed, so the sentences say so exactly. */
  linkLong: `Keep the link to ${LINK_MAX_CHARS} characters or fewer.`,
  x: "Use an X handle (@name) or an x.com link.",
  telegram: "Use a Telegram name (@name) or a t.me link.",
  official: "Links to Bouncer's own site and accounts are for $BOUNCER only.",
  descriptionLong: `Use at most ${DESCRIPTION_MAX_CHARS} characters.`,
  descriptionHidden: "The description has characters that cannot be shown. Remove them and try again.",
  /* Amendment: the spec limits line breaks but gives no sentence for it. */
  descriptionBreaks: `Use at most ${DESCRIPTION_MAX_BREAKS} line breaks.`,
  /* Amendment: an X or Telegram link belongs in its own box, where its own rules hold. */
  websiteSocial: "Put X and Telegram links in their own boxes.",
  /* Ask 3 (SOCIALS-A-ANSWER.md): the route answers what it stored; anything else and nothing is created. New words, for approval. */
  storedDiffers: "This was stored differently from what you typed. Nothing was created. Try again.",
} as const;
export type SocialWord = keyof typeof SOCIAL_WORDS;
/* The route's needs: which of the words a refusal is, so the route names its kind in the output policy (server/output.ts) and never carries the text itself. */
export function wordOf(sentence: string): SocialWord | null {
  for (const [k, v] of Object.entries(SOCIAL_WORDS)) if (v === sentence) return k as SocialWord;
  return null;
}

/* The ticker that may carry Bouncer's own links (only the creator wallet can create it: creationPolicy.ts, the reserved ticker). */
export const OFFICIAL_TICKER = "BOUNCER";

/* The spec's hosts, and (amendment) the other names of the same sites: each link is stored on x.com or t.me. */
const X_HOSTS = new Set(["x.com", "www.x.com", "twitter.com", "www.twitter.com", "mobile.x.com", "mobile.twitter.com"]);
const TG_HOSTS = new Set(["t.me", "www.t.me", "telegram.me", "www.telegram.me"]);
/* Amendment: no X or Telegram host in the website box (each site and every name under it). */
const SOCIAL_HOST = /(^|\.)(x\.com|twitter\.com|t\.me|telegram\.me|telegram\.dog)$/;
/* Amendment: X's own pages, never someone's profile. */
const X_PAGES = new Set(["home", "explore", "search", "i", "settings", "notifications", "messages", "intent", "share", "login", "signup", "logout", "tos", "privacy", "compose", "hashtag"]);
const X_HANDLE = /^[A-Za-z0-9_]{1,15}$/;
const X_COMMUNITY = /^\/i\/communities\/(\d{1,25})$/;
/* Amendment: 4 to 32 (the spec says 5; Telegram sells 4-character names), starting with a letter as Telegram's names do. */
const TG_NAME = /^[A-Za-z][A-Za-z0-9_]{3,31}$/;
/* A name, or (amendment) its web preview /s/<name>, stored as the name. */
const TG_NAME_PATH = /^\/(?:s\/)?([^/]+)$/;
/* An invite, /+<code> or (amendment) the older /joinchat/<code>, stored as /+<code>. */
const TG_INVITE = /^\/(?:\+|joinchat\/)([A-Za-z0-9_-]{8,64})$/;

const officialPath = (href: string): string => new URL(href).pathname.replace(/^\/+|\/+$/g, "").toLowerCase();
const OFFICIAL_HOST = new URL(OFFICIAL.site.href).hostname;
const OFFICIAL_X = new Set([officialPath(OFFICIAL.x.href)]);
/* Amendment: the launch feed too, Bouncer's second Telegram. */
const OFFICIAL_TG = new Set([officialPath(OFFICIAL.telegramChat.href), officialPath(OFFICIAL.telegramFeed.href)]);
/* bouncer.meme and its subdomains, and (amendment) any host in which a label starts bouncer.meme (bouncer.meme.example.xyz, bouncer.meme-app.xyz, bouncer.memes.xyz). */
const HAS_OFFICIAL_HOST = new RegExp(`(^|\\.)${OFFICIAL_HOST.replace(/\./g, "\\.")}`);

/*
  Hidden characters: every control character but the line break (\p{Cc}: C0 and C1, tabs included), every format
  character (\p{Cf}: the direction marks, embeddings, overrides and isolates, the zero-width spaces, the soft hyphen, the
  byte order mark, the tag characters), the line and paragraph separators (U+2028, U+2029) and the Hangul fillers
  (U+115F, U+1160, U+3164, U+FFA0). Amendment: the zero-width joiners U+200C and U+200D are allowed, because emoji and
  several scripts need them, and tag characters are allowed inside a flag's emoji tag sequence (England, Scotland, Wales).
  The server's change (\p{Cs}): a lone surrogate (half of a pair, which a JSON escape can carry) cannot be shown and has
  no UTF-8 form; it would be stored as itself but fingerprinted as U+FFFD (server/tokenStore.ts tokenHash), so two
  different files would share one name. A whole pair (an emoji) is one character here and is not matched.

  2026-10-31 (T1, review/2026-10-31c-precheck/REPORT.md): \p{Cc}\p{Cf} let through characters that carry text nobody
  sees, so these are refused too: every default-ignorable character (\p{Default_Ignorable_Code_Point}: the variation
  selectors U+FE00..FE0F and U+E0100..E01EF, which can spell any bytes, U+034F, the tag characters, the Hangul fillers),
  private-use characters (\p{Co}) and unassigned ones (\p{Cn}), and a run of more than MARKS_MAX combining marks
  (\p{M}). Kept, and only these: the three flags made of tag characters, exactly (England, Scotland, Wales; TAG_FLAGS),
  where any black flag with 1 to 7 tag letters used to pass and, chained, spelled hidden words; and the joiners and
  selectors below (keptAt). The line break only where the caller allows it. The same rule for the name (T3, route.ts,
  no line breaks) and for the page that shows a description (chain/metadata.ts reads checkDescription).

  2026-10-31 (F3, the fix round's check of T1): "a character outside ASCII on both sides" and "after any emoji" still
  hid bytes (97 emoji carried 38 bytes nobody sees: a selector or not after each, a joiner or not between), so each
  is kept only where it changes what is drawn, and at most KEPT_MAX of them in one text:
  - U+FE0E or U+FE0F once, straight after an emoji that is not a component (\p{Emoji} but not \p{Emoji_Component}: no
    skin tone, regional indicator, tag or hair piece), or U+FE0F in a keycap (a digit, # or *, U+FE0F, U+20E3);
  - U+200D in an emoji sequence: a pictograph (\p{Extended_Pictographic}) on the right, and on the left a pictograph,
    a pictograph's U+FE0F or a skin tone;
  - U+200C and U+200D between two letters or marks of a script that shapes with them (JOINING: the cursive scripts and
    the Indic conjuncts), never beside a Latin, CJK or other letter, a space or a line break.
  What can still be hidden (INFERENCE): a U+200D between two pictographs that form no sequence, or a joiner between
  two letters of a joining script that do not join anyway; KEPT_MAX bounds it to a few bytes.
*/
const HIDDEN = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Default_Ignorable_Code_Point}\u2028\u2029\u115F\u1160\u3164\uFFA0]/u;
const TAG_FLAGS = /\u{1F3F4}\u{E0067}\u{E0062}(?:\u{E0065}\u{E006E}\u{E0067}|\u{E0073}\u{E0063}\u{E0074}|\u{E0077}\u{E006C}\u{E0073})\u{E007F}/gu;
const SELECTOR_AFTER = /^[^\P{Emoji}\p{Emoji_Component}]$/u;
const PICTOGRAPH = /^\p{Extended_Pictographic}$/u;
const SKIN_TONE = /^\p{Emoji_Modifier}$/u;
const JOINING = /^(?=[\p{L}\p{M}])[\p{Script_Extensions=Arabic}\p{Script_Extensions=Syriac}\p{Script_Extensions=Nko}\p{Script_Extensions=Mongolian}\p{Script_Extensions=Mandaic}\p{Script_Extensions=Devanagari}\p{Script_Extensions=Bengali}\p{Script_Extensions=Gurmukhi}\p{Script_Extensions=Gujarati}\p{Script_Extensions=Oriya}\p{Script_Extensions=Tamil}\p{Script_Extensions=Telugu}\p{Script_Extensions=Kannada}\p{Script_Extensions=Malayalam}\p{Script_Extensions=Sinhala}\p{Script_Extensions=Myanmar}\p{Script_Extensions=Khmer}]$/u;
/* F3: at most this many U+200C, U+200D, U+FE0E and U+FE0F kept in one text. */
export const KEPT_MAX = 24;
/* MARKS_MAX + 1 combining marks in a row. */
export const MARKS_MAX = 4;
const MARK_RUN = /\p{M}{5}/u;
/* F3: whether the joiner or selector at cs[i] is one of the kept forms. */
function keptAt(cs: string[], i: number): boolean {
  const [c, before, after] = [cs[i], cs[i - 1] ?? "", cs[i + 1] ?? ""];
  if (c === "\uFE0E" || c === "\uFE0F") return SELECTOR_AFTER.test(before) || (c === "\uFE0F" && /^[0-9#*]$/.test(before) && after === "\u20E3");
  if (c === "\u200D" && PICTOGRAPH.test(after) && (PICTOGRAPH.test(before) || SKIN_TONE.test(before) || (before === "\uFE0F" && PICTOGRAPH.test(cs[i - 2] ?? "")))) return true;
  return JOINING.test(before) && JOINING.test(after);
}
/* T1 and T3 (2026-10-31): whether a text holds a character that cannot be shown. `breaks` keeps the line break (the description; read as a space, so no joiner beside it is kept), else it is one too (the name). */
export function hasHiddenText(text: string, breaks: boolean): boolean {
  const cs = Array.from((breaks ? text.replace(/\n/g, " ") : text).replace(TAG_FLAGS, "\u{1F3F4}"));
  let kept = 0;
  for (let i = 0; i < cs.length; i++) {
    if (/^[\u200C\u200D\uFE0E\uFE0F]$/.test(cs[i]) && keptAt(cs, i)) kept++;
    else if (HIDDEN.test(cs[i])) return true;
  }
  return kept > KEPT_MAX || MARK_RUN.test(text);
}

/* The description as stored: NFC, trimmed. */
export const descriptionText = (raw: string): string => raw.normalize("NFC").trim();
export function checkDescription(raw: string): { text: string; chars: number; why: string | null } {
  const text = descriptionText(raw);
  const chars = Array.from(text).length;
  const breaks = text.split("\n").length - 1;
  const why = hasHiddenText(text, true) ? SOCIAL_WORDS.descriptionHidden : chars > DESCRIPTION_MAX_CHARS ? SOCIAL_WORDS.descriptionLong : breaks > DESCRIPTION_MAX_BREAKS ? SOCIAL_WORDS.descriptionBreaks : null;
  return { text, chars, why };
}

type Checked = { ok: true; value: string } | { ok: false; why: string };
const no = (why: string): Checked => ({ ok: false, why });
const yes = (value: string): Checked => (value.length > LINK_MAX_CHARS ? no(SOCIAL_WORDS.linkLong) : { ok: true, value });

/* An X or Telegram link as typed: with https://, with http:// or (amendment) without a scheme. Null when it does not parse or names a user, a password or a port. */
function linkOf(s: string): URL | null {
  try {
    const u = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`);
    return (u.protocol === "https:" || u.protocol === "http:") && !u.username && !u.password && !u.port ? u : null;
  } catch {
    return null;
  }
}

/*
  One box: null when it is empty, else the link as it will be stored or the sentence that refuses it. `official` is
  true only for BOUNCER (the form: the ticker BOUNCER from the creator wallet; the route: the creator's session; a
  page: the launch's own ticker), so BOUNCER can carry Bouncer's links and nobody else's token can.
*/
export function checkLink(kind: LinkKind, raw: string, official = false): Checked | null {
  const s = raw.trim();
  if (!s) return null;
  if (s.length > LINK_RAW_MAX) return no(SOCIAL_WORDS.linkLong);
  if (kind === "x") {
    let handle: string | null = null;
    let path: string;
    if (X_HANDLE.test(s.replace(/^@/, ""))) path = `/${s.replace(/^@/, "")}`;
    else {
      const u = linkOf(s);
      if (!u || !X_HOSTS.has(u.hostname)) return no(SOCIAL_WORDS.x);
      path = u.pathname.replace(/\/+$/, "");
    }
    const community = X_COMMUNITY.exec(path);
    if (!community) {
      handle = path.slice(1);
      if (!X_HANDLE.test(handle) || X_PAGES.has(handle.toLowerCase())) return no(SOCIAL_WORDS.x);
      if (!official && OFFICIAL_X.has(handle.toLowerCase())) return no(SOCIAL_WORDS.official);
    }
    return yes(community ? `https://x.com/i/communities/${community[1]}` : `https://x.com/${handle}`);
  }
  if (kind === "telegram") {
    let path: string;
    if (TG_NAME.test(s.replace(/^@/, ""))) path = `/${s.replace(/^@/, "")}`;
    else {
      const u = linkOf(s);
      if (!u || !TG_HOSTS.has(u.hostname)) return no(SOCIAL_WORDS.telegram);
      path = u.pathname.replace(/\/+$/, "");
    }
    const invite = TG_INVITE.exec(path);
    if (invite) return yes(`https://t.me/+${invite[1]}`);
    const name = TG_NAME_PATH.exec(path)?.[1] ?? "";
    if (!TG_NAME.test(name)) return no(SOCIAL_WORDS.telegram);
    if (!official && OFFICIAL_TG.has(name.toLowerCase())) return no(SOCIAL_WORDS.official);
    return yes(`https://t.me/${name}`);
  }
  if (!/^https:\/\//i.test(s)) return no(SOCIAL_WORDS.websiteHttps);
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return no(SOCIAL_WORDS.websiteAddress);
  }
  const host = u.hostname;
  /* A name with a dot: not an address in numbers, not localhost, no user, password or port. */
  if (u.protocol !== "https:" || u.username || u.password || u.port || !host.includes(".") || host.endsWith(".") || host.startsWith("[") || /^[\d.]+$/.test(host) || host === "localhost" || host.endsWith(".localhost")) return no(SOCIAL_WORDS.websiteAddress);
  /* So no X post, and none of Bouncer's own accounts in any of the forms those sites serve, reaches a page as a website (the spec's "all three"). */
  if (SOCIAL_HOST.test(host)) return no(SOCIAL_WORDS.websiteSocial);
  if (!official && HAS_OFFICIAL_HOST.test(host)) return no(SOCIAL_WORDS.official);
  u.hash = "";
  return yes(u.href);
}

/* The four boxes at once: each one's sentence (null when fine or empty), what would be stored, and whether the form may send. */
export function checkSocials(v: SocialValues, official = false): { ok: boolean; errors: Record<SocialField, string | null>; clean: Partial<SocialValues>; descriptionChars: number } {
  const d = checkDescription(v.description);
  const errors: Record<SocialField, string | null> = { description: d.why, website: null, x: null, telegram: null };
  const clean: Partial<SocialValues> = {};
  if (d.chars > 0 && d.why === null) clean.description = d.text;
  for (const k of ["website", "x", "telegram"] as const) {
    const c = checkLink(k, v[k], official);
    if (c?.ok) clean[k] = c.value;
    else if (c) errors[k] = c.why;
  }
  return { ok: Object.values(errors).every((e) => e === null), errors, clean, descriptionChars: d.chars };
}

/*
  The links a metadata file carries (its top-level website, twitter and telegram), each checked again with the same
  rule before a page shows it, Bouncer's own included; undefined when none passes. `official`: the launch's own ticker
  is BOUNCER (only the creator wallet can create it).
*/
export function creatorLinksOf(json: { website?: unknown; twitter?: unknown; telegram?: unknown }, official = false): CreatorLinks | undefined {
  const out: CreatorLinks = {};
  for (const [k, v] of [["website", json.website], ["x", json.twitter], ["telegram", json.telegram]] as const) {
    const c = typeof v === "string" ? checkLink(k, v, official) : null;
    if (c?.ok) out[k] = c.value;
  }
  return Object.keys(out).length ? out : undefined;
}

/*
  Option B on the pages (the frontend lane's proposal): what a link shows when it shows where it goes, short. A website
  shows its whole host (never cut from the right, where its real domain is), then as much of its path as fits; a host
  longer than the label keeps its right-hand end. X and Telegram start with their own fixed host, so only their path is
  ever cut.
*/
const LABEL_MAX = 32;
export function linkLabel(kind: LinkKind, href: string): string {
  const u = new URL(href);
  const path = u.pathname.replace(/\/+$/, "");
  const chars = (s: string) => Array.from(s);
  const clipEnd = (s: string) => (chars(s).length > LABEL_MAX ? `${chars(s).slice(0, LABEL_MAX - 1).join("")}\u2026` : s);
  if (kind === "x") return X_HANDLE.test(path.slice(1)) ? `@${path.slice(1)}` : clipEnd(`x.com${path}`);
  if (kind === "telegram") return clipEnd(`t.me${path}`);
  const host = u.hostname.replace(/^www\./, "");
  if (chars(host).length > LABEL_MAX) return `\u2026${chars(host).slice(-(LABEL_MAX - 1)).join("")}`;
  if (chars(host + path).length <= LABEL_MAX) return host + path;
  return chars(host).length + 2 <= LABEL_MAX ? `${host}/\u2026` : host;
}
