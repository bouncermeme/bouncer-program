"use client";

import { useState } from "react";
import { explorerUrl } from "@/lib/bouncer/chain/rpc";
import { shortAddr } from "@/lib/bouncer/format";
import type { Launch } from "@/lib/bouncer/types";
import { mintIsLive } from "@/lib/bouncer/view";

/*
  The slot where launchpads put a truncated contract address and a copy
  glyph. the founder's rule (2026-09-27): until the pool opens it holds the
  ticker and a Copy link chip that copies this launch's page; once the
  pool is open the chip is replaced, same slot and size, by the real
  mint. Never both, and never the launch's own account address, which a
  screener would reject as not a mint.

  "Pool open" is read from the state byte: poolLive, or finalized with a
  record. That is when a mint certainly exists under both the pinned build
  (v0.18 mints at genesis) and the mint deferral coming in 0.19, which
  creates the mint in the same instruction that opens the pool.
*/
export { mintIsLive };

/*
  solscan (decision 3 of 2026-09-30): on the launch page header, once the
  pool is open, a plain Solscan link to the mint sits beside the chip. It is
  the only thing added; no "CA:" label, the slot keeps its width. Not on a
  home card: a card is itself one link, and a second link inside it is a
  tap-target problem at phone width.
*/
export function ShareSlot({ launch, ticker = true, solscan = false, className = "" }: { launch: Launch; ticker?: boolean; solscan?: boolean; className?: string }) {
  const live = mintIsLive(launch);
  return (
    <div className={`relative z-10 flex items-center gap-2 ${solscan ? "flex-wrap" : "shrink-0"} ${className}`}>
      {ticker && <span className="text-text-3 mono">{launch.token.symbol}</span>}
      {live ? <CopyChip value={launch.token.mint} label={shortAddr(launch.token.mint, 4, 4)} title="Copy the contract address (the mint)" mono /> : <CopyChip value={null} label="Copy link" title="Copy the link to this launch" launchId={launch.id} />}
      {live && solscan && (
        <a href={explorerUrl("token", launch.token.mint)} target="_blank" rel="noreferrer" className="link-accent inline-flex items-center gap-1 min-h-[2.75rem] px-1" data-solscan>
          Solscan
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M7 17L17 7M9 7h8v8" />
          </svg>
        </a>
      )}
    </div>
  );
}

function CopyChip({ value, label, title, mono = false, launchId }: { value: string | null; label: string; title: string; mono?: boolean; launchId?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className={`chip ${mono ? "mono" : ""} shrink-0 min-h-[2.25rem] px-3 min-w-[8.5rem] justify-center`}
      title={title}
      onClick={async (e) => {
        e.preventDefault();
        e.stopPropagation();
        const text = value ?? `${window.location.origin}/launch/${launchId}`;
        try {
          await navigator.clipboard.writeText(text);
          setDone(true);
          setTimeout(() => setDone(false), 1200);
        } catch {}
      }}
    >
      {done ? "Copied" : label}
      {!done && (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          {mono ? (
            <>
              <rect x="9" y="9" width="11" height="11" rx="2" />
              <path d="M5 15V6a2 2 0 0 1 2-2h9" />
            </>
          ) : (
            <>
              <path d="M10 14a4 4 0 0 0 5.66 0l3-3a4 4 0 0 0-5.66-5.66l-1 1" />
              <path d="M14 10a4 4 0 0 0-5.66 0l-3 3a4 4 0 0 0 5.66 5.66l1-1" />
            </>
          )}
        </svg>
      )}
    </button>
  );
}
