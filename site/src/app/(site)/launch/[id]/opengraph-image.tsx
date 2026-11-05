import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { headers } from "next/headers";
import { ImageResponse } from "next/og";
import { hue } from "@/lib/bouncer/hue";
import { readShare } from "@/lib/bouncer/share/facts";
import { BRAND } from "@/lib/brand";
import { DOOR } from "@/lib/brandMark";
import { THEME } from "@/lib/theme";

/*
  The share preview is the card (the founder, 2026-09-27): the art, the ticker,
  the close time or "Cleared" (no market cap on a shared card; pick 4 is held), Deposited, and the launch's URL.
  Nothing else, and never the launch's account address as if it were a
  mint: the id appears only inside the URL. Figures come from the chain
  at request time (readShare); if the read fails the card says so in
  words and shows no figures.

  Fonts are static cuts of the site's own faces (Satori reads TTF, OTF and
  WOFF, not WOFF2, and not variable fonts): Switzer Medium, Commit Mono
  Bold and Red Hat Display ExtraBold and Black, with their licences beside
  them. Red Hat comes in Latin and Latin Extended halves; the ticker lists
  both (DisplayExt), so a letter like Ł stays in the display face. The ticker leads in the display face and the name sits under it, as
  on a card; the new look (proposed 2026-10-10, concept C) gives it C's
  night and blue and the door with the name at the foot.
*/
export const alt = `A ${BRAND.domain} launch`;
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";
export const dynamic = "force-dynamic";

const FONTS = join(process.cwd(), "src/lib/bouncer/share/fonts");

/* The site's tokens (globals.css, through lib/theme.ts), as Satori cannot read CSS variables. */
const C = {
  bg: THEME.bg,
  panel: THEME.panel,
  line: THEME["line-2"],
  text: THEME.text,
  text2: THEME["text-2"],
  text3: THEME["text-3"],
  brand: THEME.brand,
  brandText: THEME["brand-text"],
};

/* 76 px for a short name, down to 44 for the longest the program allows, so 32 wide letters fit the 852 px beside the art in three lines at most. */
function nameSize(name: string): number {
  const n = Array.from(name).length;
  return n <= 14 ? 76 : n <= 22 ? 58 : 44;
}

export default async function Image({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? BRAND.domain;
  const proto = h.get("x-forwarded-proto") ?? (host.startsWith("localhost") || host.startsWith("127.") ? "http" : "https");
  const url = `${proto}://${host}/launch/${id}`;
  const [switzer, mono, display, black, displayExt, read] = await Promise.all([
    readFile(join(FONTS, "Switzer-500.otf")),
    readFile(join(FONTS, "CommitMono-700.otf")),
    readFile(join(FONTS, "RedHatDisplay-800.woff")),
    readFile(join(FONTS, "RedHatDisplay-900.woff")),
    readFile(join(FONTS, "RedHatDisplay-ext-800.woff")),
    readShare(id),
  ]);
  const missing = read === "missing";
  const facts = read === "missing" ? null : read;
  const hh = hue(facts?.mint ?? id);

  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", background: C.bg, color: C.text, fontFamily: "Switzer", padding: 64 }}>
        <div style={{ display: "flex", height: 4, background: C.brand, marginBottom: 44 }} />
        <div style={{ display: "flex", alignItems: "center", gap: 40 }}>
          {facts?.image ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={facts.image} width={180} height={180} alt="" style={{ borderRadius: 16, objectFit: "cover" }} />
          ) : (
            <div
              style={{
                width: 180,
                height: 180,
                borderRadius: 16,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: 72,
                background: `linear-gradient(160deg, hsl(${hh} 26% 22%), hsl(${(hh + 30) % 360} 30% 12%))`,
                color: C.text,
              }}
            >
              {(facts?.symbol ?? "?").slice(0, 2)}
            </div>
          )}
          {/* The ticker leads (up to 10 characters; the type steps down with its length); the name under it may be 32 characters with no space, so it breaks wherever it must and never leaves the card (a 32-letter name ran off the right edge, 2026-10-01). */}
          <div style={{ display: "flex", flexDirection: "column", flex: 1, minWidth: 0 }}>
            <div style={{ display: "block", fontFamily: "Display, DisplayExt", fontWeight: 800, fontSize: nameSize(facts?.symbol ?? ""), lineHeight: 1.05, wordBreak: "break-word" }}>{facts ? facts.symbol : `A ${BRAND.domain} launch`}</div>
            <div style={{ display: "block", fontSize: 36, color: C.text2, marginTop: 12, lineHeight: 1.15, wordBreak: "break-word", lineClamp: 2 }}>{facts ? facts.name : ""}</div>
          </div>
        </div>

        <div style={{ display: "flex", marginTop: 56, gap: 72 }}>
          <div style={{ display: "flex", flexDirection: "column" }}>
            <div style={{ fontSize: 30, color: C.text3 }}>{facts ? (facts.status.startsWith("Closes") ? "Open" : "Status") : "Status"}</div>
            <div style={{ fontFamily: "Commit", fontSize: 52, marginTop: 8, color: facts?.status.startsWith("Closes") ? C.brandText : C.text }}>{facts ? facts.status : missing ? "No launch at this address" : "Could not be read just now"}</div>
          </div>
          {facts && (
            <div style={{ display: "flex", flexDirection: "column" }}>
              <div style={{ fontSize: 30, color: C.text3 }}>Deposited</div>
              <div style={{ fontFamily: "Commit", fontSize: 52, marginTop: 8 }}>{facts.deposited}</div>
            </div>
          )}
        </div>

        <div style={{ display: "flex", marginTop: "auto", paddingTop: 24, borderTop: `1px solid ${C.line}`, justifyContent: "space-between", alignItems: "center", gap: 32 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
            <svg width={35} height={40} viewBox={`0 0 ${DOOR.width} ${DOOR.height}`}>
              <path d={DOOR.frame} fill={C.brand} />
              <path d={DOOR.leaf} fill={C.brand} fillRule="evenodd" stroke={C.brand} strokeWidth={DOOR.leafStroke} strokeLinejoin="round" />
            </svg>
            <span style={{ fontFamily: "Display", fontWeight: 900, fontSize: 40, letterSpacing: "-0.01em" }}>{BRAND.name}</span>
          </div>
          <div style={{ fontFamily: "Commit", fontSize: 17, color: C.text2 }}>{url}</div>
        </div>
      </div>
    ),
    {
      ...size,
      fonts: [
        { name: "Switzer", data: switzer, style: "normal", weight: 500 },
        { name: "Commit", data: mono, style: "normal", weight: 700 },
        { name: "Display", data: display, style: "normal", weight: 800 },
        { name: "Display", data: black, style: "normal", weight: 900 },
        { name: "DisplayExt", data: displayExt, style: "normal", weight: 800 },
      ],
    },
  );
}
