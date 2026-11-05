"use client";

import { useEffect, useRef, useState } from "react";
import { TURNSTILE_SITE_KEY } from "@/lib/bouncer/attest";

/*
  The bot check before a bid on a gated launch (0.29; the gate of
  docs/ADVERSARIAL-GRIEFING-2026-10-20.md section 14.3) and before every new
  launch (action "create"): Cloudflare Turnstile. Its token is good for 300 s
  and one verification, so the page asks for a fresh one after every use
  (resetKey). The token goes to the attestation route with the launch and the
  wallet; the widget sees neither, and nothing about the bid.

  23c (the founder picked INVISIBLE, 2026-10-24; review/2026-10-24-23c-morning/DESIGN.md section 11):
  - Nothing is ever drawn. The widget renders in a container that is in the page but takes no space and cannot be
    seen. With the widget's mode set to Invisible in Cloudflare, no challenge exists; on any other mode a visitor
    Cloudflare wants to challenge is refused here instead of shown a box (before-interactive-callback).
  - A script load failure is retried twice first (RETRY_MS: 2 s, then 5 s).
  - Screen readers hear the state through one polite live region: checking, passed, or the line shown.
  24c (the fresh 24b review's L5; the founder approved the mocks in review/2026-10-24c-mocks/, the slow line at 7 s):
  - No answer after SLOW_MS: SLOW_TEXT, and the check keeps going; the line clears if it then passes.
  - The script not loaded after its retries: UNLOADED_TEXT (an ad blocker or the network).
  - Cloudflare's refusal, a widget error or its timeout: REFUSED_TEXT, which no longer blames an ad blocker.
*/
declare global {
  interface Window {
    turnstile?: {
      render(el: HTMLElement, opts: Record<string, unknown>): string;
      reset(id?: string): void;
      remove(id: string): void;
    };
  }
}

const SCRIPT = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
export const REFUSED_TEXT = "The bot check didn't pass. Reload to try again.";
export const UNLOADED_TEXT = "The bot check couldn't load. An ad blocker or a weak connection can stop it. Allow this site or switch networks, then reload.";
export const SLOW_TEXT = "The bot check is slow on this connection. Still trying.";
export const SLOW_MS = 7_000;
export const RETRY_MS = [2_000, 5_000] as const;
/* 24c fresh L2 (the founder 2026-10-24): a load that never answers (a dropped request) fails after LOAD_MS, so the retries and the load line run. */
export const LOAD_MS = 10_000;
let loading: Promise<void> | null = null;

export function loadOnce(): Promise<void> {
  if (typeof window === "undefined") return Promise.reject(new Error("no window"));
  if (window.turnstile) return Promise.resolve();
  if (!loading) {
    loading = new Promise<void>((resolve, reject) => {
      const s = document.createElement("script");
      const fail = (why: string) => {
        clearTimeout(timer);
        s.onload = s.onerror = null;
        s.remove();
        loading = null;
        reject(new Error(why));
      };
      s.src = SCRIPT;
      s.async = true;
      s.defer = true;
      s.onload = () => (window.turnstile ? (clearTimeout(timer), resolve()) : fail("no turnstile"));
      s.onerror = () => fail("script");
      /* Declared before any handler can run: nothing fires until the script is appended below. */
      const timer = setTimeout(() => fail("timeout"), LOAD_MS);
      document.head.appendChild(s);
    });
  }
  return loading;
}

/* The script, retried after RETRY_MS on a failure (an ad blocker, a flaky network), then given up. */
export async function loadTurnstile(load: () => Promise<void> = loadOnce, wait: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms))): Promise<void> {
  for (let i = 0; ; i++) {
    try {
      return await load();
    } catch (e) {
      if (i >= RETRY_MS.length) throw e;
      await wait(RETRY_MS[i]);
    }
  }
}

type Status = "checking" | "slow" | "passed" | "refused" | "unloaded";
/* The live region's words for a status, and whether they are shown (the rest are for screen readers only). */
export function statusLine(status: Status): { text: string; shown: boolean } {
  if (status === "refused") return { text: REFUSED_TEXT, shown: true };
  if (status === "unloaded") return { text: UNLOADED_TEXT, shown: true };
  if (status === "slow") return { text: SLOW_TEXT, shown: true };
  return { text: status === "passed" ? "Bot check passed." : "Bot check running.", shown: false };
}

export function BotCheck({ onToken, resetKey, action = "bid" }: { onToken: (token: string | null) => void; resetKey: number; action?: "bid" | "create" }) {
  const box = useRef<HTMLDivElement | null>(null);
  const widget = useRef<string | null>(null);
  const tokenFn = useRef(onToken);
  const alive = useRef(false);
  const gaveUp = useRef(false);
  /* 24c R5-L1 (the founder 2026-10-24): every reset is a new generation; a timer or a widget callback from an older one is ignored. */
  const gen = useRef(0);
  const [round, setRound] = useState(0);
  const [status, setStatus] = useState<Status>("checking");
  useEffect(() => {
    tokenFn.current = onToken;
  }, [onToken]);

  /* The widget for this generation: its callbacks answer only while it is the current one. */
  const renderWidget = () => {
    if (!alive.current || !box.current || !window.turnstile || widget.current) return;
    const own = gen.current;
    const current = () => alive.current && gen.current === own;
    const refuse = () => {
      if (!current()) return;
      setStatus("refused");
      tokenFn.current(null);
    };
    widget.current = window.turnstile.render(box.current, {
      sitekey: TURNSTILE_SITE_KEY,
      action,
      theme: "dark",
      size: "compact",
      appearance: "interaction-only",
      /* Cloudflare wants a click: never shown here (the founder: no box), so it is a refusal. */
      "before-interactive-callback": refuse,
      callback: (t: string) => {
        if (!current()) return;
        setStatus("passed");
        tokenFn.current(t);
      },
      "expired-callback": () => {
        if (!current()) return;
        setStatus("checking");
        tokenFn.current(null);
      },
      "timeout-callback": refuse,
      "error-callback": refuse,
    });
  };

  useEffect(() => {
    if (!TURNSTILE_SITE_KEY) return;
    alive.current = true;
    loadTurnstile()
      .then(renderWidget)
      .catch(() => {
        if (!alive.current) return;
        gaveUp.current = true;
        setStatus("unloaded");
        tokenFn.current(null);
      });
    return () => {
      alive.current = false;
      if (widget.current && window.turnstile) window.turnstile.remove(widget.current);
      widget.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- rendered once; the action never changes for a mounted widget
  }, []);

  /* A reset starts a fresh check: checking again, no token, a new generation (so the slow timer rearms), and a new widget whose callbacks are the only ones heard. */
  useEffect(() => {
    if (resetKey <= 0 || !TURNSTILE_SITE_KEY || gaveUp.current) return;
    gen.current += 1;
    setRound(gen.current);
    setStatus("checking");
    tokenFn.current(null);
    if (widget.current && window.turnstile) {
      window.turnstile.remove(widget.current);
      widget.current = null;
      renderWidget();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- renderWidget reads refs only
  }, [resetKey]);

  /* Still checking SLOW_MS after the last start or reset: say so, and keep going (the token's callback clears it). */
  useEffect(() => {
    if (status !== "checking" || !TURNSTILE_SITE_KEY) return;
    const own = gen.current;
    const t = setTimeout(() => {
      if (gen.current === own) setStatus((s) => (s === "checking" ? "slow" : s));
    }, SLOW_MS);
    return () => clearTimeout(t);
  }, [status, round]);

  const line = statusLine(status);
  if (!TURNSTILE_SITE_KEY) return <p className="text-bad leading-snug">{action === "create" ? "This site has no bot check set up, and every new launch needs one, so launches cannot be created from here." : "Bids are off here: no bot check is set up."}</p>;
  return (
    <div data-bot-check-widget data-status={status}>
      {/* In the page, never seen and taking no space: the invisible widget needs a home, not a box. */}
      <div ref={box} aria-hidden="true" className="absolute w-px h-px overflow-hidden opacity-0 pointer-events-none" style={{ clipPath: "inset(50%)" }} />
      <p role="status" aria-live="polite" className={line.shown ? "text-text-2 leading-snug" : "sr-only"} data-bot-check-status>
        {line.text}
      </p>
    </div>
  );
}
