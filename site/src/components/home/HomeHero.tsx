import { preload } from "react-dom";

/*
  The home hero. the founder, 2026-10-10 (the second pass of the new look,
  relayed by the manager): "a hero area on home ("Everyone competes on
  price, not speed." with the door)". This overrides ruling D1's wordless
  front page (2026-09-27) for this one line; D1's other half stands: no
  launch is promoted into it, and the boards follow straight after.
  the founder, 2026-10-16 (item 15, decided): one headline with one line under
  it. the founder, 2026-10-20: the headline is "No line to cut." (it replaced
  "No bots at the door.": the site no longer mentions bots); the line
  under it stays.

  the founder, 2026-10-23 (22e3, the hero): the lit doorway (review/2026-10-23-hero)
  behind the headline, on the home page only, never behind a chart or a bid
  form. The words stay live HTML, never in the picture. the founder's second call
  the same day: half the height, so Live now lands well up the first screen:
  about 30vh (at most 300 px) from 768 px, about 210 px on phones. At those heights the
  portrait crop cannot hold the door and the lines, so every width shows the
  landscape doorway:
  - phones (the founder's third call: the words inside the picture): the frame is
    drawn 141.6% of the box wide and shifted left 20.7% and up 14.8% of the
    box width, so the door stands right of the words and the lines run along
    the bottom; the words sit top left on the dark wall, over a scrim from the
    top; the box is 59vw tall (230 px at 390, 212 at 360);
  - from 768 px: the picture stands at the right, 160% of the box tall and
    raised 30%, so the door and the lines leaving it stay whole; its left
    edge fades into the wall's navy, and the words sit on the left.
  AVIF then WebP then a PNG fallback (public/hero), two widths; the LCP image
  is preloaded. A scrim keeps the words at WCAG AA on every
  pixel they can sit on (scripts/check-home-hero.ts).
*/
export const HERO_WIDTHS = [960, 1536] as const;
/* The file stem (kept apart from the width so no source line reads like a Tailwind class built at runtime: check-lc-fixes T1). */
const STEM = "/hero/hero-desktop";
const file = (w: number, ext: string) => `${STEM}-${w}.${ext}`;
const set = (ext: string) => HERO_WIDTHS.map((w) => `${file(w, ext)} ${w}w`).join(", ");
/* Phones: 141.6% of the box, which is 100vw less the 16 px gutters. From 768 px: the picture is 2.4 box heights wide (160% of a 1.5 frame), min(30vh, 300px) tall. */
const SIZES = "(min-width: 768px) min(72vh, 720px), calc((100vw - 32px) * 1.42)";

export function HomeHero() {
  preload(file(HERO_WIDTHS[0], "avif"), { as: "image", type: "image/avif", imageSrcSet: set("avif"), imageSizes: SIZES, fetchPriority: "high" });
  return (
    <section className="relative h-[clamp(190px,59vw,240px)] md:h-[min(30vh,300px)] md:min-h-[220px]" data-home-hero>
      <div className="absolute inset-0 overflow-hidden rounded-[14px] border border-line bg-[#04070f]" data-home-hero-frame>
        <picture>
          <source type="image/avif" srcSet={set("avif")} sizes={SIZES} />
          <source type="image/webp" srcSet={set("webp")} sizes={SIZES} />
          {/* A plain img in a picture: format fallbacks need source sets, which next/image does not take. */}
          <img
            src="/hero/hero-desktop-1024.png"
            alt=""
            width={1536}
            height={1024}
            fetchPriority="high"
            decoding="async"
            className="absolute left-[-20.7%] top-0 mt-[-14.8%] w-[141.6%] h-auto max-w-none md:left-auto md:mt-0 md:right-0 md:top-[-30%] md:h-[160%] md:w-auto md:[mask-image:linear-gradient(90deg,transparent_0,#000_30%)]"
            data-home-hero-image
          />
        </picture>
        {/* The scrim under the words: from the top on phones, from the left from 768 px. */}
        <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(4,7,15,0.7)_0,rgba(4,7,15,0.35)_40%,rgba(4,7,15,0)_65%)] md:bg-[linear-gradient(90deg,rgba(4,7,15,0.8)_0,rgba(4,7,15,0.6)_45%,rgba(4,7,15,0)_65%)] lg:bg-[linear-gradient(90deg,rgba(4,7,15,0.78)_0,rgba(4,7,15,0.45)_38%,rgba(4,7,15,0)_60%)]" aria-hidden="true" />
      </div>
      {/* The words, live HTML over the picture: top left on phones, on the left and centred from 768 px. */}
      <div className="absolute left-0 top-0 z-[1] p-4 min-[420px]:p-5 md:inset-y-0 md:flex md:flex-col md:justify-center md:p-0 md:px-12 lg:px-14 md:max-w-[34rem] reveal" style={{ "--i": 0 } as React.CSSProperties}>
        <h1 className="display-xl w-fit text-[1.5rem] leading-[1.08] min-[420px]:text-[1.75rem] md:text-[2.5rem] lg:text-[3rem] max-w-[17ch] text-text">No line to cut.</h1>
        <p className="w-fit text-text-2 text-base md:text-[1.1875rem] mt-1 md:mt-2.5 leading-snug" data-home-tagline>
          Fair launches. One price.
        </p>
      </div>
    </section>
  );
}
