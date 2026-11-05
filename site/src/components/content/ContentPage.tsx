/*
  The shell of the site's reading pages (guide, FAQ, whitepaper, the legal pages;
  launch candidate, 2026-10-22), in the How page's design: one column, the display
  heading, a lead line, sections with the same h2. Body text is text-base or
  larger; no uppercase tracking labels. (D8, tag T: the legal pages' draft note is gone.)
*/
import type { ReactNode } from "react";

export function ContentPage({ title, lead, updated, children }: { title: string; lead?: ReactNode; updated?: string; children: ReactNode }) {
  return (
    <article className="pt-8 md:pt-14 max-w-[46rem] text-base" data-content-page={title}>
      <h1 className="display text-[1.75rem] md:text-[2rem] leading-tight">{title}</h1>
      {lead && <p className="text-text-2 text-[1.125rem] mt-2 leading-snug">{lead}</p>}
      {updated && <p className="text-text-3 mt-2">Last updated {updated}</p>}
      <div className="mt-2">{children}</div>
    </article>
  );
}

export function Section({ title, id, children }: { title: string; id?: string; children: ReactNode }) {
  return (
    <section id={id} className="scroll-mt-24">
      <h2 className="display text-[1.25rem] mt-10 mb-3">{title}</h2>
      <div className="flex flex-col gap-3 text-text-2 leading-relaxed">{children}</div>
    </section>
  );
}

export function Bullets({ items }: { items: ReactNode[] }) {
  return (
    <ul className="flex flex-col gap-2">
      {items.map((it, i) => (
        <li key={i} className="pl-4 relative before:content-['•'] before:absolute before:left-0 before:text-text-3">
          {it}
        </li>
      ))}
    </ul>
  );
}
