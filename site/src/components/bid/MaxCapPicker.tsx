"use client";

import { useMemo, useState } from "react";
import { Info } from "@/components/ui/Info";
import { Sheet } from "@/components/ui/Sheet";
import { readUsdInput, usdFieldText } from "@/lib/bouncer/amountInput";
import { fmtSol } from "@/lib/bouncer/format";
import { MAX_TICK } from "@/lib/bouncer/grid";
import { GRID_COARSE_STEP_PERCENT, GRID_FINE_STEP_PERCENT, GRID_FINE_TICKS } from "@contract/constants";
/* the founder's item 21 (2026-10-16): the slider and its axis are gone; the field and the chips remain. Item 22: the field cannot sit under the minimum market cap (the floor at the live price): it says so with the figure, and a blur moves it there. */
import type { CapRate, RateStatus } from "@/lib/bouncer/solPrice";
import type { Launch, LaunchAccount } from "@/lib/bouncer/types";
import { capUsd, fmtCap, fmtUsdCompact, tickForUsdCap, type UsdCapTick } from "@/lib/bouncer/usdCap";
import { mcapAtTick } from "@/lib/bouncer/view";
import { LOCKED, saveQuick, savedParts, useSavedQuick } from "./QuickAmounts";
import { Refused } from "./Refused";

/*
  "I bid 2 SOL at up to a $40,000 market cap" (the founder, 2026-09-28). The max
  is typed in dollars; the deposit stays SOL. Every market cap here is a
  dollar figure at the live quote, and none is ever shown in SOL.

  The program's grid is in SOL, from the launch's floor: 0.29, 2,407 steps,
  0.25 percent apart up to 100 times the floor (a 2,000 SOL market cap on
  the production floor), 1 percent above. A typed dollar cap is converted at the live price and
  rounded DOWN to a step, never up, because a sealed bid cannot take back a
  max higher than the one typed. The sealed figure shows under the field as
  the bidder types; their text is never rewritten; the step above is one tap
  away. At the moment of sealing, BidFlow reads both price sources fresh and
  re-converts; if the step moved it asks before the wallet opens.

  The top step is the "no limit" bid. It is reached only by the No limit
  chip, never by typing a large figure or dragging the slider to its end.

  With no fresh quote, nothing here can be priced and nothing falls back to
  SOL: the field, the slider, the chips and No limit are all disabled and
  the section says why (BidFlow keeps the bid button off too).
*/

/* A typed figure that could not be read keeps the bidder's text and carries the reason; it resolves to no step, so nothing can be sealed from it. */
export type CapChoice = { kind: "none" } | { kind: "usd"; text: string; usd: number; problem?: string } | { kind: "tick"; tick: number } | { kind: "nolimit" };

/* The step a choice seals at, at a price. "none" and a typed figure outside the grid resolve to no step. */
export function resolveCap(a: LaunchAccount, choice: CapChoice, usdPerSol: number | null): UsdCapTick | { kind: "none" } | { kind: "nolimit" } {
  if (choice.kind === "none") return { kind: "none" };
  if (choice.kind === "nolimit") return { kind: "nolimit" };
  if (choice.kind === "tick") return { kind: "step", tick: choice.tick };
  if (choice.problem) return { kind: "none" };
  if (usdPerSol == null) return { kind: "none" };
  return tickForUsdCap(a, choice.usd, usdPerSol);
}

/* The sealed step, or MAX_TICK for no limit, or null when the choice cannot be sealed. */
export function sealedTick(r: ReturnType<typeof resolveCap>): number | null {
  return r.kind === "step" ? r.tick : r.kind === "nolimit" ? MAX_TICK : null;
}

/*
  24j (the founder, 2026-10-25, review/2026-10-25-24j-bidform-mock): $10k, $50k, No limit, then Edit, on one row that wraps
  like the amount chips (never a sideways scroll). Edit changes only these two chips, the amount row's pattern: kept in
  this browser beside the quick amounts (QuickAmounts.tsx), read strictly, two at most. The field is never touched by it.
*/
const PRESETS = [10_000, 50_000];
const KEEP_CAPS = 2;

/*
  The saved caps read strictly: dollar figures the field would take, without repeats. 24k (Astra R10-L1): the whole
  list is kept; the row shows the first two, and an edit saved keeps the ones it did not show. 24l (Claude N-2): in the
  order saved (an edit first, the ones not shown after it), so the row shows what was just saved.
*/
export function parseSavedCaps(raw: string | null): number[] | null {
  const list = savedParts(raw).cap;
  if (!Array.isArray(list)) return null;
  const usd = list.map((t) => (typeof t === "string" ? readUsdInput(t) : null)).filter((r): r is { ok: true; usd: number } => !!r && r.ok).map((r) => r.usd);
  const unique = usd.filter((n, i, all) => all.indexOf(n) === i);
  return unique.length ? unique : null;
}

export function MaxCapPicker({
  launch,
  deposit,
  choice,
  onChange,
  rate,
  status,
  wallet = null,
  locked = false,
}: {
  launch: Launch;
  deposit: bigint;
  choice: CapChoice;
  onChange: (c: CapChoice) => void;
  rate: CapRate | null;
  status: RateStatus;
  wallet?: string | null;
  /* 24j (Astra R9-M2, the founder's lock): a bid is being sent; nothing here may change it. */
  locked?: boolean;
}) {
  const [help, setHelp] = useState(false);
  const raw = useSavedQuick(wallet);
  const savedCaps = useMemo(() => parseSavedCaps(raw), [raw]);
  const caps = useMemo(() => (savedCaps ?? PRESETS).slice(0, KEEP_CAPS).sort((x, y) => x - y), [savedCaps]);
  const [editing, setEditing] = useState(false);
  const [drafts, setDrafts] = useState<string[]>([]);
  const a = launch.account;
  const usdPerSol = rate?.usdPerSol ?? null;
  const resolved = resolveCap(a, choice, usdPerSol);
  const tick = sealedTick(resolved);
  const noLimit = choice.kind === "nolimit";
  const startMcap = mcapAtTick(a, 0);
  const topMcap = mcapAtTick(a, MAX_TICK);

  /* Chips at round dollar caps, snapped down to the grid at the live price; only those strictly inside the grid (a chip under the minimum market cap is not shown). */
  const presets = useMemo(() => (usdPerSol == null ? [] : caps.filter((u) => tickForUsdCap(a, u, usdPerSol).kind === "step")), [a, usdPerSol, caps]);
  const capReads = drafts.map((t) => (t.trim() === "" ? null : readUsdInput(t)));
  const capProblem = capReads.map((r) => (r && !r.ok ? r.why : null)).find((p) => p !== null) ?? null;
  const beginCaps = () => {
    setDrafts(caps.map(usdFieldText).concat(Array(Math.max(0, KEEP_CAPS - caps.length)).fill("")));
    setEditing(true);
  };
  const commitCaps = () => {
    const edited = capReads.filter((r): r is { ok: true; usd: number } => !!r && r.ok).map((r) => r.usd);
    const hidden = (savedCaps ?? []).filter((u) => !caps.includes(u));
    const all = [...[...edited].sort((x, y) => x - y), ...hidden].filter((u, i, a) => a.indexOf(u) === i);
    saveQuick(wallet, "cap", all.length ? all.map(usdFieldText) : null);
    setEditing(false);
  };

  /* What a chip or the floor writes into the field is plain digits, never a comma: the field refuses commas, and its own text must stay editable. */
  const text = choice.kind === "usd" ? choice.text : choice.kind === "tick" && usdPerSol != null ? usdFieldText(capUsd(mcapAtTick(a, choice.tick), usdPerSol)) : "";

  if (!rate) {
    return (
      <div>
        <p className="display text-[1.25rem]">Your max market cap</p>
        <div className="inset p-4 mt-2">
          <p className="font-semibold">{status === "loading" ? "Reading the SOL price…" : "Market caps can’t be priced right now."}</p>
          {status !== "loading" && (
            <p className="text-text-2 mt-1 leading-snug">
              The SOL price is unavailable, and a market cap is only ever sealed in dollars you can see. Bidding waits until it is back, No limit included. Trying again every 30 seconds.
            </p>
          )}
        </div>
      </div>
    );
  }

  const r = rate.usdPerSol;
  const mcap = tick != null ? mcapAtTick(a, tick) : null;
  const depositText = deposit > 0n ? fmtSol(deposit) : "your deposit";

  /*
    The text stays as typed. It used to be filtered: "-40000" became 40000, "1e9" became 19, "40k" became 40, and a
    comma was stripped, so "40,5" sealed as 405. Now it is read strictly (amountInput.ts) or refused with the reason.
  */
  const setText = (t: string) => {
    const shown = t.slice(0, 24);
    const r = readUsdInput(shown);
    onChange(r.ok ? { kind: "usd", text: shown, usd: r.usd } : r.empty ? { kind: "none" } : { kind: "usd", text: shown, usd: 0, problem: r.why });
  };
  /* Every control that changes the max, off while a bid is being sent. */
  const pick = (c: CapChoice) => {
    if (!locked) onChange(c);
  };

  return (
    <div>
      <div className="flex items-center justify-between gap-3">
        <label htmlFor="maxcap" className="display text-[1.25rem]">
          at up to a market cap of
        </label>
        <button
          type="button"
          className="w-8 h-8 rounded-full border border-line-2 text-text-2 flex items-center justify-center font-semibold hover:bg-panel-2 shrink-0"
          onClick={() => setHelp(true)}
          aria-label="What is max market cap"
        >
          ?
        </button>
      </div>

      <div className={`relative mt-2 ${locked ? LOCKED : ""}`}>
        <span className="absolute left-4 top-1/2 -translate-y-1/2 text-text-3 figure text-[2rem]">$</span>
        <input
          id="maxcap"
          disabled={locked}
          inputMode="decimal"
          className="field figure text-[2rem] py-3"
          style={{ paddingLeft: "2.75rem" }}
          value={noLimit ? "" : text}
          placeholder={noLimit ? "No limit" : "40000"}
          onChange={(e) => {
            if (!locked) setText(e.target.value);
          }}
          onBlur={() => {
            if (resolved.kind === "below") pick({ kind: "tick", tick: 0 });
          }}
          autoComplete="off"
          /* Astra's frontend review of 2026-10-21, F6: the line under the field describes it; a refused figure marks it invalid. */
          aria-invalid={choice.kind === "usd" && !!choice.problem}
          aria-describedby="maxcap-note"
        />
      </div>

      {(noLimit || (choice.kind === "usd" && choice.problem) || resolved.kind !== "none") && (
      <div id="maxcap-note" className="mt-2 leading-snug" aria-live="polite">
        {noLimit ? (
          <p className="text-text">
            <span className="font-semibold">No limit.</span> You pay whatever it clears at.
          </p>
        ) : choice.kind === "usd" && choice.problem ? (
          <p data-cap-refused>
            <Refused why={choice.problem} />
          </p>
        ) : resolved.kind === "step" && mcap != null ? (
          <>
            <p className="text-text">
              Sealed as <span className="num font-semibold">{fmtCap(mcap, r)}</span>
              {choice.kind === "usd" ? `, rounded down to a ${resolved.tick < GRID_FINE_TICKS ? GRID_FINE_STEP_PERCENT : GRID_COARSE_STEP_PERCENT}% step.` : "."}
            </p>
            {choice.kind === "usd" && resolved.tick + 1 < MAX_TICK && (
              <button type="button" className={`link-accent mt-1 ${locked ? LOCKED : ""}`} disabled={locked} onClick={() => pick({ kind: "tick", tick: resolved.tick + 1 })}>
                Use {fmtCap(mcapAtTick(a, resolved.tick + 1), r)} instead
              </button>
            )}
          </>
        ) : resolved.kind === "below" ? (
          <p className="text-text" data-cap-below>
            Under the minimum market cap, about {fmtCap(startMcap, r)}.{" "}
            <button type="button" className={`link-accent ${locked ? LOCKED : ""}`} disabled={locked} onClick={() => pick({ kind: "tick", tick: 0 })}>
              Use {fmtCap(startMcap, r)}
            </button>
          </p>
        ) : resolved.kind === "top" ? (
          <p className="text-text">
            That is above the top of the grid, about {fmtCap(topMcap, r, { compact: true })}. The top is the No limit bid; choose No limit below if that is what you mean.
          </p>
        ) : null}
      </div>
      )}

      {editing && !locked ? (
        <div className="mt-3" data-cap-editing>
          {/* 24k (the founder): the line behind an (i), not inline. */}
          <div className="flex flex-wrap items-center gap-2">
            {drafts.map((d, i) => (
              <span key={i} className="relative basis-[8.5rem] grow-0">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-text-3">$</span>
                <input
                  inputMode="decimal"
                  className={`field num py-2 ${capReads[i] && !capReads[i]!.ok ? "border-bad" : ""}`}
                  style={{ paddingLeft: "1.75rem" }}
                  value={d}
                  placeholder="10000"
                  aria-label={`Quick market cap ${i + 1}`}
                  autoComplete="off"
                  aria-invalid={!!capReads[i] && !capReads[i]!.ok}
                  aria-describedby={capProblem ? "cap-quick-note" : undefined}
                  onChange={(e) => setDrafts(drafts.map((x, k) => (k === i ? e.target.value.slice(0, 16) : x)))}
                />
              </span>
            ))}
            <Info text={<>Your quick market caps, in dollars. Saved in this browser{wallet ? " for this wallet" : ""}.</>} label="About quick market caps" />
          </div>
          {capProblem && (
            <p id="cap-quick-note" className="text-bad mt-2 leading-snug" role="status">
              {capProblem}
            </p>
          )}
          <div className="flex flex-wrap gap-2 mt-3">
            <button type="button" className="btn btn-secondary" disabled={capProblem !== null} onClick={commitCaps}>
              Save
            </button>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => {
                saveQuick(wallet, "cap", null);
                setEditing(false);
              }}
            >
              Back to default
            </button>
            <button type="button" className="link-accent px-2" onClick={() => setEditing(false)}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2 mt-3" data-cap-chips={presets.join(",")}>
          {presets.map((u) => (
            <button key={u} type="button" className={`chip num shrink-0 ${locked ? LOCKED : ""}`} disabled={locked} data-on={choice.kind === "usd" && choice.usd === u} onClick={() => pick({ kind: "usd", text: usdFieldText(u), usd: u })}>
              {fmtUsdCompact(u)}
            </button>
          ))}
          <button type="button" className={`chip shrink-0 ${locked ? LOCKED : ""}`} disabled={locked} data-on={noLimit} onClick={() => pick({ kind: "nolimit" })}>
            No limit
          </button>
          <button type="button" className={`link-accent shrink-0 px-2 py-2 ${locked ? LOCKED : ""}`} disabled={locked} onClick={beginCaps} aria-label="Edit the market cap amounts">
            Edit
          </button>
        </div>
      )}

      {/* 24j (the founder's option B, 2026-10-25): the box keeps one line, the one price; the fill order beside it stays in the ? sheet (the 10/05 rule). 15 px under 640 px, as the footer, so it holds one line at 390. */}
      {tick != null && mcap != null && (
        <div className="mt-4 rounded-[10px] border border-line overflow-hidden" data-one-price-box>
          <div className="p-3 md:p-4 bg-good-soft">
            <p className="text-good leading-snug text-[0.9375rem] sm:text-base">Everyone who gets in pays the same price.</p>
          </div>
        </div>
      )}

      <Sheet open={help} onClose={() => setHelp(false)} title="Max market cap">
        <div className="flex flex-col gap-3 text-text-2 text-[1.0625rem] leading-relaxed">
          <p>Everyone who gets in, gets in at the same market cap. Your max is the highest you&apos;d buy at, and it is also your place in line: a higher max fills before a lower one. Bidding high does not make you pay more.</p>
          <p>The highest max bids fill first, and everyone who gets in pays the same market cap, the one it clears at, however high their max. If the max bids above yours buy everything, or it clears above your max, {depositText} is refunded in full.</p>
          <p>No limit means whatever it clears at, up to about {fmtCap(topMcap, r, { compact: true })} today.</p>
          <p className="text-text-3">A sealed max moves with SOL in dollars until the launch settles.</p>
        </div>
        <button type="button" className="btn btn-secondary w-full mt-5" onClick={() => setHelp(false)}>
          Got it
        </button>
      </Sheet>
    </div>
  );
}
