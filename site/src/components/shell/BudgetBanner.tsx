"use client";

import { useEffect, useState } from "react";
import { SITE_ROUTES } from "@/lib/bouncer/chain/rpc";

/*
  The day's chain read budget, when it runs short (server/budget.ts). The
  server states it beside the Config (/api/config, `budget`): degraded once
  the soft line is passed (the endpoints serve what they last read), spent
  once the day's budget is. Read every minute, only on a build that reads
  through the site; nothing is shown while the budget is fine. Never
  dismissable: a figure that may lag is a thing a visitor should know.
*/
type State = "ok" | "degraded" | "exhausted";
const POLL_MS = 60_000;

export function BudgetBanner() {
  const [budget, setBudget] = useState<{ state: State; resetsAt: number } | null>(null);
  useEffect(() => {
    if (!SITE_ROUTES) return;
    let live = true;
    const read = async () => {
      try {
        const res = await fetch("/api/config", { cache: "no-store" });
        const header = res.headers.get("x-bouncer-budget") as State | null;
        const body = res.ok ? ((await res.json()) as { budget?: { state?: State; resetsAt?: number } }) : null;
        const state = body?.budget?.state ?? header ?? "ok";
        if (live) setBudget({ state, resetsAt: body?.budget?.resetsAt ?? 0 });
      } catch {
        /* no answer: nothing to say */
      }
    };
    void read();
    const timer = setInterval(read, POLL_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, []);
  if (!budget || budget.state === "ok") return null;
  const resets = budget.resetsAt ? new Date(budget.resetsAt).toISOString().slice(11, 16) : "00:00";
  return (
    <div className="w-full border-b border-line" style={{ background: "var(--note-soft)" }} role="note" aria-label="Chain reads limited" data-budget={budget.state}>
      <p className="w-full max-w-[1120px] mx-auto px-4 md:px-8 py-2 leading-snug text-[1rem]">
        {budget.state === "exhausted" ? (
          <>
            <span className="font-semibold">Chain reads used up for today.</span> Figures are the last known until {resets} UTC.
          </>
        ) : (
          <>
            <span className="font-semibold">Chain reads near today&apos;s limit.</span> Figures may lag until {resets} UTC.
          </>
        )}
      </p>
    </div>
  );
}
