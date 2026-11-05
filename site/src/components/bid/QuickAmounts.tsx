"use client";
import { solApprox } from "@/lib/bouncer/format";

import { useMemo, useState, useSyncExternalStore } from "react";
import { readSolInput, solExact } from "@/lib/bouncer/amountInput";

/*
  The quick amounts under the deposit field (the founder, 2026-10-07): they start
  at the least the field takes, and a bidder can replace the rest with their
  own. the founder, 2026-10-08: an amount here is the whole of what leaves the
  wallet, so the least is the launch's minimum bid (read from the launch) plus
  the costs that come out of it (BidFlow.tsx): a flat 0.02 SOL on a launch made
  under the 22e3 Config (product.ts leastSent). Their
  amounts are kept in this browser only, per wallet
  (localStorage bouncer:quick:<wallet>), read and written inside try/catch so
  a browser that refuses storage still shows the defaults. The minimum is
  always the first chip; a saved amount under it is dropped, since the
  program refuses such a bid.
  24j (the founder, 2026-10-25, review/2026-10-25-24j-bidform-mock): four chips, 0.02, 0.1, 0.5 and 1, then Edit, on one row
  at 390. The max market cap row's own quick caps (MaxCapPicker.tsx) are kept under the same key, as {sol, cap}; a
  saved plain list is the older form of the amounts alone.
*/
const LADDER = [0.001, 0.002, 0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50, 100];
const DEFAULTS = [0.1, 0.5, 1];
const KEEP = 4;

const toAtoms = (sol: number): bigint => BigInt(Math.round(sol * 1e9));

/* Lamports as the plain decimal the deposit field takes ("0.001", "2.5", "10"): no unit, no grouping, nothing the strict reader refuses. */
export function plainSol(atoms: bigint): string {
  const s = atoms.toString().padStart(10, "0");
  const frac = s.slice(-9).replace(/0+$/, "");
  return frac ? `${s.slice(0, -9)}.${frac}` : s.slice(0, -9);
}

/* The minimum, then 0.1, 0.5 and 1 above it (the ladder fills in for a launch whose minimum is above some of them), four in all, as the exact decimal strings the field takes. */
export function defaultQuick(min: bigint): string[] {
  const picked = DEFAULTS.map(toAtoms).filter((n) => n > min);
  const fill = LADDER.map(toAtoms).filter((n) => n > min && !picked.includes(n));
  const above = [...picked, ...fill].slice(0, KEEP - 1).sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
  return [min, ...above].map(plainSol);
}

const storageKey = (wallet: string | null) => `bouncer:quick:${wallet ?? "device"}`;

/* localStorage as an external store: the raw saved text is the snapshot (a string compares by value, so React sees a change only when the text changes), the server's snapshot is "nothing saved". */
const listeners = new Set<() => void>();
function subscribe(cb: () => void) {
  listeners.add(cb);
  window.addEventListener("storage", cb);
  return () => {
    listeners.delete(cb);
    window.removeEventListener("storage", cb);
  };
}
function readRaw(wallet: string | null): string | null {
  try {
    return window.localStorage.getItem(storageKey(wallet));
  } catch {
    return null;
  }
}
/* The saved text split into its two lists: a plain array is the amounts alone (the form before 24j). Either may be missing. */
export function savedParts(raw: string | null): { sol: unknown; cap: unknown } {
  if (!raw) return { sol: null, cap: null };
  try {
    const v = JSON.parse(raw);
    if (Array.isArray(v)) return { sol: v, cap: null };
    if (v && typeof v === "object") return { sol: (v as { sol?: unknown }).sol ?? null, cap: (v as { cap?: unknown }).cap ?? null };
  } catch {
    /* Unreadable: nothing saved. */
  }
  return { sol: null, cap: null };
}

/* One list saved, the other kept as it was; with neither left the key goes. */
export function saveQuick(wallet: string | null, part: "sol" | "cap", list: string[] | null) {
  try {
    const now = savedParts(readRaw(wallet));
    const next = { ...now, [part]: list };
    if (next.sol == null && next.cap == null) window.localStorage.removeItem(storageKey(wallet));
    else window.localStorage.setItem(storageKey(wallet), JSON.stringify(next));
  } catch {
    /* Storage refused (a private window, a full quota): the defaults stay. */
  }
  for (const l of listeners) l();
}

/* The saved text, read for its wallet; "" on the server. */
export function useSavedQuick(wallet: string | null): string | null {
  return useSyncExternalStore(
    subscribe,
    () => readRaw(wallet),
    () => null,
  );
}

/*
  24k (Astra R10-L1): the whole saved list, kept apart from the four chips shown. Every saved string the field would
  take, without repeats, whatever this launch's minimum; nothing is dropped for being under it or past the chips shown.
  Anything else is ignored. 24l (Claude N-2): in the order saved, which says what is shown (an older list is ascending).
*/
export function parseSavedFull(raw: string | null): bigint[] | null {
  const list = savedParts(raw).sol;
  if (!Array.isArray(list)) return null;
  const atoms = list
    .map((s) => (typeof s === "string" ? readSolInput(s) : null))
    .filter((r): r is { ok: true; atoms: bigint } => !!r && r.ok)
    .map((r) => r.atoms);
  return atoms.filter((n, i, all) => all.indexOf(n) === i);
}

const ascending = (x: bigint, y: bigint): number => (x < y ? -1 : x > y ? 1 : 0);

/* What the chips show from the whole list: the minimum first, then the first saved amounts above it, ascending, four in all. */
export function shownAmounts(full: bigint[], min: bigint): string[] {
  return [min, ...full.filter((n) => n > min).slice(0, KEEP - 1).sort(ascending)].map(plainSol);
}

/*
  An edit saved: the amounts in the edit, plus every saved amount the chips did not show (24k: Save never drops what it
  did not show). 24l (Claude N-2): the edit first, so what was just saved is what the chips show next; the ones not
  shown keep their place after it.
*/
export function mergeEdited(full: bigint[], shown: string[], edited: bigint[]): string[] {
  const shownAtoms = shown.map((s) => toAtomsExact(s));
  const hidden = full.filter((n) => !shownAtoms.includes(n));
  const all = [...[...edited].sort(ascending), ...hidden];
  return all.filter((n, i) => all.indexOf(n) === i).map(plainSol);
}
const toAtomsExact = (s: string): bigint => {
  const r = readSolInput(s);
  return r.ok ? r.atoms : -1n;
};

/* 24j (Astra R9-M2, the founder's lock): while a bid is being sent the chips and Edit are disabled and drawn at the site's disabled opacity. */
export const LOCKED = "opacity-40 cursor-not-allowed";

export function QuickAmounts({ min, wallet, selected, onPick, locked = false }: { min: bigint; wallet: string | null; selected: string; onPick: (sol: string) => void; locked?: boolean }) {
  const defaults = useMemo(() => defaultQuick(min), [min]);
  const raw = useSavedQuick(wallet);
  const full = useMemo(() => parseSavedFull(raw), [raw]);
  const [editing, setEditing] = useState(false);
  const [drafts, setDrafts] = useState<string[]>([]);
  const amounts = full && full.some((n) => n > min) ? shownAmounts(full, min) : defaults;

  const begin = () => {
    setDrafts(amounts.slice(1).concat(Array(Math.max(0, KEEP - amounts.length)).fill("")));
    setEditing(true);
  };
  /* Each draft read strictly (amountInput.ts); an empty slot is simply unused. */
  const reads = drafts.map((d) => (d.trim() === "" ? null : readSolInput(d)));
  const problems = reads.map((r) => (r === null ? null : !r.ok ? r.why : r.atoms < min ? `Minimum is ${solExact(min)}.` : null));
  const problem = problems.find((p) => p !== null) ?? null;
  const commit = () => {
    const edited = reads.filter((r): r is { ok: true; atoms: bigint } => !!r && r.ok).map((r) => r.atoms);
    saveQuick(wallet, "sol", mergeEdited(full ?? [], amounts.slice(1), edited));
    setEditing(false);
  };
  const reset = () => {
    saveQuick(wallet, "sol", null);
    setEditing(false);
  };

  if (editing && !locked) {
    return (
      <div className="mt-2" data-quick-editing>
        <p className="text-text-2 leading-snug">
          Your quick amounts, in SOL. The first stays {solExact(min)}, the least the field takes. Saved in this browser{wallet ? " for this wallet" : ""}.
        </p>
        <div className="flex flex-wrap gap-2 mt-2">
          <span className="chip num shrink-0" aria-disabled="true">
            {amounts[0]}
          </span>
          {drafts.map((d, i) => (
            <span key={i} className="relative basis-[7.5rem] grow-0">
              <input
                inputMode="decimal"
                className={`field num py-2 pr-11 ${problems[i] ? "border-bad" : ""}`}
                value={d}
                placeholder="0.00"
                aria-label={`Quick amount ${i + 2}`}
                autoComplete="off"
                /* Astra's frontend review of 2026-10-21, F6: a refused amount is marked invalid and points at the line that says why. */
                aria-invalid={!!problems[i]}
                aria-describedby={problems[i] ? "quick-note" : undefined}
                onChange={(e) => setDrafts(drafts.map((x, k) => (k === i ? e.target.value.slice(0, 16) : x)))}
              />
              <span className="absolute right-3 top-1/2 -translate-y-1/2 text-text-3">SOL</span>
            </span>
          ))}
        </div>
        {problem && (
          <p id="quick-note" className="text-bad mt-2 leading-snug" role="status">
            {problem}
          </p>
        )}
        <div className="flex flex-wrap gap-2 mt-3">
          <button type="button" className="btn btn-secondary" disabled={problem !== null} onClick={commit}>
            Save
          </button>
          <button type="button" className="btn btn-secondary" onClick={reset}>
            Back to default
          </button>
          <button type="button" className="link-accent px-2" onClick={() => setEditing(false)}>
            Cancel
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-2 mt-2" data-quick-amounts={amounts.join(",")}>
      {amounts.map((n) => (
        <button key={n} type="button" className={`chip num shrink-0 ${locked ? LOCKED : ""}`} data-on={selected === n} disabled={locked} onClick={() => onPick(n)}>
          {n === plainSol(min) ? solApprox(min) : n}
        </button>
      ))}
      <button type="button" className={`link-accent shrink-0 px-2 py-2 ${locked ? LOCKED : ""}`} disabled={locked} onClick={begin} aria-label="Edit the quick amounts">
        Edit
      </button>
    </div>
  );
}
