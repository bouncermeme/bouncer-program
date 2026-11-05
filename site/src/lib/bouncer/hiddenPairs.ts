"use client";

/*
  The same-name notices the admin hid (v0.30 item 8, 8C; app/api/names), as "<launch>><other>" directions for the
  notice's rule (boardSort.ts sameNameOthers). Read through the site's route at most once a minute and shared by every
  notice and card on the page. A read that fails, or a page without the site's routes, hides nothing: every notice
  shows (the safe side).
*/
import { useEffect, useState } from "react";
import { SITE_ROUTES } from "./chain/rpc";

const EMPTY: ReadonlySet<string> = new Set();
const FRESH_MS = 60_000;
let held: { at: number; set: ReadonlySet<string> } | null = null;
let inflight: Promise<ReadonlySet<string>> | null = null;

async function readHidden(): Promise<ReadonlySet<string>> {
  if (!SITE_ROUTES) return EMPTY;
  if (held && Date.now() - held.at < FRESH_MS) return held.set;
  inflight ??= fetch("/api/names", { cache: "no-store" })
    .then((r) => (r.ok ? (r.json() as Promise<{ hidden?: unknown }>) : null))
    .then((j) => {
      if (!j || !Array.isArray(j.hidden)) return EMPTY;
      const set: ReadonlySet<string> = new Set(j.hidden.filter((x): x is string => typeof x === "string" && x.includes(">")));
      held = { at: Date.now(), set };
      return set;
    })
    .catch(() => EMPTY)
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

export function useHiddenPairs(): ReadonlySet<string> {
  const [set, setSet] = useState<ReadonlySet<string>>(held?.set ?? EMPTY);
  useEffect(() => {
    let live = true;
    void readHidden().then((s) => live && setSet(s));
    return () => {
      live = false;
    };
  }, []);
  return set;
}
