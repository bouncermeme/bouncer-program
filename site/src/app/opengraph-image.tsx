import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ImageResponse } from "next/og";
import { BRAND } from "@/lib/brand";
import { DOOR } from "@/lib/brandMark";
import { SITE_CARD_ALT } from "@/lib/seo";
import { THEME } from "@/lib/theme";

/*
  The site's share card (launch candidate, 2026-10-22): the door and the
  wordmark on night, the domain. A launch keeps its own card
  (app/launch/[id]/opengraph-image.tsx). No twitter-image file (one at the root
  would replace every launch's card on X): pages name this card as twitter:image
  through lib/seo.ts SITE_CARD (23c).
  22e3 (the founder, 2026-10-23, the hero): the lit doorway of the home hero behind it
  (src/lib/bouncer/share/hero-og.jpg, 1200x630 from review/2026-10-23-hero/hero-desktop.png);
  the mark, the wordmark and the words stay drawn here, never in the picture.
  Rendered once at build: no request data, no chain read.
*/
export const alt = SITE_CARD_ALT;
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

const SHARE = join(process.cwd(), "src/lib/bouncer/share");
const FONTS = join(SHARE, "fonts");

export default async function Image() {
  const [switzer, black, door] = await Promise.all([readFile(join(FONTS, "Switzer-500.otf")), readFile(join(FONTS, "RedHatDisplay-900.woff")), readFile(join(SHARE, "hero-og.jpg"))]);
  const bg = `data:image/jpeg;base64,${door.toString("base64")}`;
  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", position: "relative", background: "#04070f", color: THEME.text, fontFamily: "Switzer" }}>
        {/* eslint-disable-next-line @next/next/no-img-element -- ImageResponse draws plain img only */}
        <img src={bg} width={1200} height={630} alt="" style={{ position: "absolute", left: 0, top: 0, width: 1200, height: 630 }} />
        <div style={{ position: "absolute", left: 0, top: 0, width: 1200, height: 630, display: "flex", background: "linear-gradient(90deg, rgba(4,7,15,0.82) 0%, rgba(4,7,15,0.5) 42%, rgba(4,7,15,0) 64%)" }} />
        <div style={{ position: "relative", display: "flex", flexDirection: "column", padding: 64, width: "100%", height: "100%" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 22 }}>
            <svg width={66} height={76} viewBox={`0 0 ${DOOR.width} ${DOOR.height}`}>
              <path d={DOOR.frame} fill={THEME.brand} />
              <path d={DOOR.leaf} fill={THEME.brand} fillRule="evenodd" stroke={THEME.brand} strokeWidth={DOOR.leafStroke} strokeLinejoin="round" />
            </svg>
            <span style={{ fontFamily: "Display", fontWeight: 900, fontSize: 76, letterSpacing: "-0.02em", lineHeight: 1 }}>{BRAND.name}</span>
          </div>
          <div style={{ display: "flex", flexDirection: "column", marginTop: "auto", marginBottom: "auto" }}>
            <div style={{ fontFamily: "Display", fontWeight: 900, fontSize: 84, lineHeight: 1.05, letterSpacing: "-0.02em" }}>No line to cut.</div>
            <div style={{ fontSize: 42, lineHeight: 1.2, marginTop: 18, color: THEME["text-2"] }}>Fair launches. One price.</div>
          </div>
          <div style={{ display: "flex", fontSize: 30, color: THEME["text-2"] }}>{BRAND.domain}</div>
        </div>
      </div>
    ),
    {
      ...size,
      fonts: [
        { name: "Switzer", data: switzer, style: "normal", weight: 500 },
        { name: "Display", data: black, style: "normal", weight: 900 },
      ],
    },
  );
}
