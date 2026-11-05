/*
  The reviewed supplement to Unicode TR39's confusables.txt (launch candidate,
  2026-10-22, the founder; review M1). TR39 maps a character to a prototype, and for
  the forms below the prototype is not a Latin letter (the Latin small capitals
  ʙ ɴ ʀ ᴇ are their own prototypes; Cyrillic в goes to ʙ) or there is no entry
  at all (the negative circled and negative squared letters, the regional
  indicators). Each of them reads as the Latin capital given here, so for the
  reserved-name check (creationPolicy.ts) they are that capital.

  Used twice, always the same way: scripts/gen-confusables.ts composes it after
  a TR39 prototype (в → ʙ → B), and confusables.ts looks a character up here
  when the generated TR39 table has no Latin mapping for it. The TR39 table
  wins where it maps a character to Latin.

  Code points are written out, not pasted, so the review reads what is mapped.
  Names are the Unicode character names; the small capitals marked (TR39) are
  named that way in confusables.txt 16.0.0 itself.
*/

const A_Z = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
function run(first: number): Array<[number, string]> {
  return Array.from(A_Z, (letter, i) => [first + i, letter] as [number, string]);
}

const ENTRIES: Array<[number, string]> = [
  /* Latin letter small capitals (IPA Extensions and Phonetic Extensions). */
  [0x0262, "G"], // ɢ LATIN LETTER SMALL CAPITAL G (TR39)
  [0x026a, "I"], // ɪ LATIN LETTER SMALL CAPITAL I (TR39)
  [0x0274, "N"], // ɴ LATIN LETTER SMALL CAPITAL N
  [0x0276, "OE"], // ɶ LATIN LETTER SMALL CAPITAL OE (TR39)
  [0x0280, "R"], // ʀ LATIN LETTER SMALL CAPITAL R (TR39)
  [0x0281, "R"], // ʁ LATIN LETTER SMALL CAPITAL INVERTED R
  [0x028f, "Y"], // ʏ LATIN LETTER SMALL CAPITAL Y (TR39)
  [0x0299, "B"], // ʙ LATIN LETTER SMALL CAPITAL B (TR39)
  [0x029b, "G"], // ʛ LATIN LETTER SMALL CAPITAL G WITH HOOK
  [0x029c, "H"], // ʜ LATIN LETTER SMALL CAPITAL H (TR39)
  [0x029f, "L"], // ʟ LATIN LETTER SMALL CAPITAL L (TR39)
  [0x1d00, "A"], // ᴀ LATIN LETTER SMALL CAPITAL A (TR39)
  [0x1d01, "AE"], // ᴁ LATIN LETTER SMALL CAPITAL AE
  [0x1d03, "B"], // ᴃ LATIN LETTER SMALL CAPITAL BARRED B
  [0x1d04, "C"], // ᴄ LATIN LETTER SMALL CAPITAL C (TR39)
  [0x1d05, "D"], // ᴅ LATIN LETTER SMALL CAPITAL D (TR39)
  [0x1d06, "D"], // ᴆ LATIN LETTER SMALL CAPITAL ETH
  [0x1d07, "E"], // ᴇ LATIN LETTER SMALL CAPITAL E (TR39)
  [0x1d09, "I"], // ᴉ LATIN SMALL LETTER TURNED I
  [0x1d0a, "J"], // ᴊ LATIN LETTER SMALL CAPITAL J (TR39)
  [0x1d0b, "K"], // ᴋ LATIN LETTER SMALL CAPITAL K (TR39; its prototype is ĸ)
  [0x1d0c, "L"], // ᴌ LATIN LETTER SMALL CAPITAL L WITH STROKE
  [0x1d0d, "M"], // ᴍ LATIN LETTER SMALL CAPITAL M (TR39; its prototype is ʍ)
  [0x1d0e, "N"], // ᴎ LATIN LETTER SMALL CAPITAL REVERSED N (TR39)
  [0x1d0f, "O"], // ᴏ LATIN LETTER SMALL CAPITAL O (TR39)
  [0x1d11, "O"], // ᴑ LATIN SMALL LETTER SIDEWAYS O
  [0x1d18, "P"], // ᴘ LATIN LETTER SMALL CAPITAL P (TR39)
  [0x1d19, "R"], // ᴙ LATIN LETTER SMALL CAPITAL REVERSED R (TR39)
  [0x1d1a, "R"], // ᴚ LATIN LETTER SMALL CAPITAL TURNED R
  [0x1d1b, "T"], // ᴛ LATIN LETTER SMALL CAPITAL T (TR39)
  [0x1d1c, "U"], // ᴜ LATIN LETTER SMALL CAPITAL U (TR39)
  [0x1d20, "V"], // ᴠ LATIN LETTER SMALL CAPITAL V (TR39)
  [0x1d21, "W"], // ᴡ LATIN LETTER SMALL CAPITAL W (TR39)
  [0x1d22, "Z"], // ᴢ LATIN LETTER SMALL CAPITAL Z (TR39)
  [0x1d29, "P"], // ᴩ GREEK LETTER SMALL CAPITAL RHO (TR39)
  [0x1d7b, "I"], // ᵻ LATIN SMALL CAPITAL LETTER I WITH STROKE (TR39)
  [0x1d7e, "U"], // ᵾ LATIN SMALL CAPITAL LETTER U WITH STROKE (TR39)
  [0xa730, "F"], // ꜰ LATIN LETTER SMALL CAPITAL F
  [0xa731, "S"], // ꜱ LATIN LETTER SMALL CAPITAL S (TR39)
  [0xa7af, "Q"], // ꞯ LATIN LETTER SMALL CAPITAL Q
  [0x0138, "K"], // ĸ LATIN SMALL LETTER KRA (the prototype TR39 gives ᴋ)

  /* The folds this module had before TR39 (creationPolicy.ts, 74a1dc6), kept where TR39 has no Latin prototype. */
  [0x0410, "A"], [0x0430, "A"], [0x0412, "B"], [0x0432, "B"], [0x0415, "E"], [0x0435, "E"], [0x0401, "E"], [0x0451, "E"], // А а В в Е е Ё ё
  [0x041a, "K"], [0x043a, "K"], [0x041c, "M"], [0x043c, "M"], [0x041d, "H"], [0x043d, "H"], [0x041e, "O"], [0x043e, "O"], // К к М м Н н О о
  [0x0420, "P"], [0x0440, "P"], [0x0421, "C"], [0x0441, "C"], [0x0422, "T"], [0x0442, "T"], [0x0423, "Y"], [0x0443, "Y"], // Р р С с Т т У у
  [0x0425, "X"], [0x0445, "X"], [0x0405, "S"], [0x0455, "S"], [0x0406, "I"], [0x0456, "I"], [0x0408, "J"], [0x0458, "J"], // Х х Ѕ ѕ І і Ј ј
  [0x051a, "Q"], [0x051b, "Q"], [0x051c, "W"], [0x051d, "W"], [0x042c, "B"], [0x044c, "B"], [0x042a, "B"], [0x0426, "U"], [0x0446, "U"], // Ԛ ԛ Ԝ ԝ Ь ь Ъ Ц ц
  [0x0391, "A"], [0x03b1, "A"], [0x0392, "B"], [0x03b2, "B"], [0x0395, "E"], [0x03b5, "E"], [0x0396, "Z"], [0x0397, "H"], // Α α Β β Ε ε Ζ Η
  [0x0399, "I"], [0x03b9, "I"], [0x039a, "K"], [0x03ba, "K"], [0x039c, "M"], [0x039d, "N"], [0x039f, "O"], [0x03bf, "O"], // Ι ι Κ κ Μ Ν Ο ο
  [0x03a1, "P"], [0x03c1, "P"], [0x03a4, "T"], [0x03c4, "T"], [0x03a5, "Y"], [0x03c5, "U"], [0x03a7, "X"], [0x03c7, "X"], // Ρ ρ Τ τ Υ υ Χ χ
  [0x03bd, "V"], [0x03f9, "C"], [0x03f2, "C"], // ν Ϲ ϲ
  [0x0131, "I"], [0x017f, "S"], [0x00df, "SS"], [0x1e9e, "SS"], // ı ſ ß ẞ

  /* Enclosed letters with no decomposition and no TR39 entry (squared 🄰 decomposes under NFKD; listed so the table is whole). */
  ...run(0x1f130), // 🄰..🅉 SQUARED LATIN CAPITAL LETTER A..Z
  ...run(0x1f150), // 🅐..🅩 NEGATIVE CIRCLED LATIN CAPITAL LETTER A..Z
  ...run(0x1f170), // 🅰..🆉 NEGATIVE SQUARED LATIN CAPITAL LETTER A..Z
  ...run(0x1f1e6), // 🇦..🇿 REGIONAL INDICATOR SYMBOL LETTER A..Z
];

/* Character → Latin capitals. Every value is A to Z only (check-creation-policy holds it). */
export const SUPPLEMENT: Readonly<Record<string, string>> = Object.freeze(Object.fromEntries(ENTRIES.map(([cp, latin]) => [String.fromCodePoint(cp), latin])));
