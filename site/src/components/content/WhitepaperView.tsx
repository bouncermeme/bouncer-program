/*
  The whitepaper, version 2 (2026-10-31): the founder's text, review/2026-10-31-whitepaper/WHITEPAPER-V2.md, as data in
  whitepaperText.ts (scripts/gen-whitepaper.ts writes it; scripts/check-whitepaper-v2.tsx holds it to the file). The
  structure is the approved mock's (review/2026-10-31-whitepaper-public/round3b): ten sections, section 9 "What happens
  at launch" (roadmap option B), the fee table as one block per fee on phones, "/fees" and "/risk" as plain text. The
  figures are the text's (mainnet terms); nothing here reads the chain or the live Config. A paragraph that is all bold
  ("Step by step.") is drawn as a label line; the fee table's "(1)" note sits under it in the grey note colour, at the
  reading pages' text-base (the mock drew it smaller; check-content-pages holds body text to text-base).
*/
import type { ReactNode } from "react";
import { ContentPage, Section, Bullets } from "./ContentPage";
import { WP_INTRO, WP_LEAD, WP_SECTIONS, WP_TITLE, type WpBlock } from "./whitepaperText";

export function WhitepaperView() {
  return (
    <ContentPage title={WP_TITLE} lead={WP_LEAD}>
      <p className="text-text-2 leading-relaxed mt-4" data-wp-intro>
        {WP_INTRO}
      </p>
      {WP_SECTIONS.map((s) => (
        <Section key={s.id} title={s.title} id={s.id}>
          {s.blocks.map((b, i) => (
            <Block key={i} b={b} />
          ))}
        </Section>
      ))}
    </ContentPage>
  );
}

function Block({ b }: { b: WpBlock }) {
  if (b.t === "ul") return <Bullets items={b.items.map(inline)} />;
  if (b.t === "ol")
    return (
      <ol className="flex flex-col gap-2 list-decimal pl-5 marker:text-text-3">
        {b.items.map((it, j) => (
          <li key={j} className="pl-1">
            {inline(it)}
          </li>
        ))}
      </ol>
    );
  if (b.t === "table") return <Table head={b.head} rows={b.rows} />;
  if (/^\*\*[^*]+\*\*$/.test(b.text))
    return (
      <p className="text-text font-semibold mt-2" data-wp-label>
        {b.text.slice(2, -2)}
      </p>
    );
  if (/^\(\d\) /.test(b.text))
    return (
      <p className="text-text-3 leading-snug -mt-1" data-wp-note>
        {inline(b.text)}
      </p>
    );
  return <p>{inline(b.text)}</p>;
}

/* **bold** only; everything else is the text as written. */
function inline(text: string): ReactNode {
  const parts = text.split(/\*\*([^*]+)\*\*/);
  return parts.length === 1
    ? text
    : parts.map((p, i) =>
        i % 2 ? (
          <strong key={i} className="text-text font-semibold">
            {p}
          </strong>
        ) : (
          p
        ),
      );
}

/* The cookies page's table (app/cookies/page.tsx), so the reading pages share one table. A table of five columns or
   more (the fees) does not fit a phone: below md each row stands as its own block, the first cell its title and every
   other cell under its column's name, drawn by CSS from data-label (the header row stays for screen readers). A table
   that stays a table keeps each heading on one line ("Max MC" at 390, the founder's ask). */
function Table({ head, rows }: { head: string[]; rows: string[][] }) {
  const stack = head.length >= 5;
  const m = (cls: string) => (stack ? cls : "");
  return (
    <div className="overflow-x-auto" data-wp-table data-wp-table-stacked={stack || undefined}>
      <table className={`w-full text-left border-collapse ${m("max-md:block")}`}>
        <thead className={m("max-md:sr-only")}>
          <tr className="text-text">
            {head.map((h) => (
              <th key={h} className={`font-semibold py-2 pr-4 border-b border-line align-top ${stack ? "" : "whitespace-nowrap"}`}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className={m("max-md:block")}>
          {rows.map((r, i) => (
            <tr key={i} className={m("max-md:block max-md:py-3 max-md:border-b max-md:border-line")}>
              {r.map((c, j) => (
                <td
                  key={j}
                  data-label={j ? head[j] : undefined}
                  className={`py-2 pr-4 border-b border-line align-top break-words ${
                    stack
                      ? j
                        ? "max-md:grid max-md:grid-cols-[6.5rem_1fr] max-md:gap-3 max-md:border-0 max-md:py-0.5 max-md:pr-0 max-md:before:content-[attr(data-label)] max-md:before:text-text-3"
                        : "max-md:block max-md:border-0 max-md:py-0 max-md:pb-1 max-md:text-text max-md:font-semibold"
                      : ""
                  }`}
                >
                  {inline(c)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
