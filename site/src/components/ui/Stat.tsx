import type { ReactNode } from "react";
import { Info } from "./Info";

/*
  A labelled figure. Amounts stay SOL and are never converted (the founder,
  2026-09-28); a market cap is passed in already as dollars (Cap). `info` is
  the sentence behind the figure, shown behind an "i" beside the label
  (the founder, 2026-10-07: the explanations go into tooltips, not under every
  figure). Each Stat spans three rows of the grid it sits in (a subgrid:
  label, figure, note), so across a row the labels, the figures and the notes
  each line up whatever wraps; a browser without subgrid gets three plain
  rows. The grid that holds Stats sets the columns and the gap between rows
  of Stats; the 4 px between a Stat's own lines is set here.
*/
export function Stat({
  label,
  value,
  sub,
  info,
  size = "md",
  tone,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  info?: ReactNode;
  size?: "md" | "lg";
  tone?: "accent" | "good" | "bad";
}) {
  const color = tone === "accent" ? "text-accent" : tone === "good" ? "text-good" : tone === "bad" ? "text-bad" : "text-text";
  return (
    <div className="min-w-0 grid grid-rows-subgrid row-span-3 gap-y-1 content-start">
      <div className="flex items-center gap-1 text-text-3 leading-tight">
        <p>{label}</p>
        {info && <Info text={info} label={`About ${label.toLowerCase()}`} />}
      </div>
      <p className={`figure ${size === "lg" ? "text-[2rem] md:text-[2.4rem]" : "text-[1.375rem]"} ${color} self-end`}>{value}</p>
      {sub ? <p className="text-text-2 leading-snug">{sub}</p> : <span />}
    </div>
  );
}
