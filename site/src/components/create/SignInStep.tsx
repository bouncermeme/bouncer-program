"use client";

/*
  The creator sign-in on /create (23c; server/session.ts, app/api/session/route.ts). A creation permit reserves the
  ticker, so the server wants proof this wallet asked: one signed message a day, no transaction, no fee. Shown in the
  launch panel above the bot check until the browser holds a session for the connected wallet.
  24c (the fresh 24b review's M3; the founder approved the mock in review/2026-10-24c-mocks/ (a)): a create refused for the
  session (it ran out on an open page) brings this step back with EXPIRED_TEXT under its button, no reload needed.
*/
import bs58 from "bs58";
import { useCallback, useEffect, useRef, useState } from "react";
import type { TxSigner } from "@/lib/bouncer/chain/signer";

export const EXPIRED_TEXT = "Signed out after 24 hours. Sign in again.";
/* The existing failure line (unchanged wording). */
export const RETRY_TEXT = "Sign-in didn't work just now. Try again.";
/*
  The message fetched ahead stays usable for 3 minutes of its 5 (NONCE_SECS), fetched again once it is 2 minutes old.
  24g (Astra 24f R7-M2): the age is looked at every REFRESH_CHECK_MS, so a held message is replaced well before it
  stops being usable (at most about 2 min 15 s old plus the fetch), and its age counts from when it was asked for.
*/
export const MESSAGE_FRESH_MS = 180_000;
export const MESSAGE_REFRESH_MS = 120_000;
export const REFRESH_CHECK_MS = 15_000;
/*
  How long the button waits on a wallet that has not answered before it can be tapped again (2026-10-29, the founder's
  phone test on Phantom: the sheet opened only on the third tap). Then the button reads "Sign in" again with
  "Try again." under it, the founder's exact words, and a tap asks the wallet again at once with the same message; a late
  answer to the earlier request is still used while nothing newer has started.
*/
export const WALLET_WAIT_MS = 4_000;
export const TRY_AGAIN_TEXT = "Try again.";
/* 24i (Astra R8-L1): a session read after an overtaken verify is tried this many times, a second apart and growing, before the page shows signed out. */
export const RECONCILE_TRIES = 3;
/*
  24j (Astra R9-L2): each session read gives up after RECONCILE_READ_MS, and the whole reconciliation after
  RECONCILE_BUDGET_MS, so a read that never answers cannot hold Create waiting. A 5xx is tried again like a failed read;
  any other answer is the server's word. Past the budget the page shows signed out with RETRY_TEXT, and the sign-in
  control is back.
*/
export const RECONCILE_READ_MS = 5_000;
export const RECONCILE_BUDGET_MS = 15_000;

/* One read of the session: the wallet, null for none, or a throw (no answer in time, a 5xx, a network failure). */
export async function readSessionOnce(get: (signal: AbortSignal) => Promise<Response>, ms: number): Promise<string | null> {
  const abort = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      abort.abort();
      reject(new Error("session read timed out"));
    }, ms);
  });
  try {
    return await Promise.race([
      (async () => {
        const r = await get(abort.signal);
        if (r.status >= 500) throw new Error(`session read ${r.status}`);
        const j = r.ok ? ((await r.json()) as { wallet?: unknown }) : { wallet: null };
        return typeof j.wallet === "string" ? j.wallet : null;
      })(),
      late,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/*
  The reconciliation's reads, bounded: RECONCILE_TRIES at most, each within RECONCILE_READ_MS and all within
  RECONCILE_BUDGET_MS (the waits between them included). "stale" ends it at once with nothing to show.
*/
export async function reconcileReads(
  get: (signal: AbortSignal) => Promise<Response>,
  stale: () => boolean,
  opts: { tries?: number; readMs?: number; budgetMs?: number; now?: () => number; wait?: (ms: number) => Promise<void> } = {},
): Promise<{ kind: "wallet"; wallet: string | null } | { kind: "failed" } | { kind: "stale" }> {
  const tries = opts.tries ?? RECONCILE_TRIES;
  const now = opts.now ?? Date.now;
  const wait = opts.wait ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const end = now() + (opts.budgetMs ?? RECONCILE_BUDGET_MS);
  for (let i = 0; i < tries; i++) {
    if (stale()) return { kind: "stale" };
    const left = end - now();
    if (left <= 0) break;
    try {
      const wallet = await readSessionOnce(get, Math.min(opts.readMs ?? RECONCILE_READ_MS, left));
      return stale() ? { kind: "stale" } : { kind: "wallet", wallet };
    } catch {
      const pause = 1_000 * 2 ** i;
      if (i + 1 >= tries || now() + pause >= end) break;
      await wait(pause);
    }
  }
  return stale() ? { kind: "stale" } : { kind: "failed" };
}
/* 24d (Astra R5-M1; wording approved by the founder): a sign-out the server did not acknowledge. */
export const SIGN_OUT_FAILED_TEXT = "Couldn't sign out. Try again.";

/*
  Sign-out for this browser (24d): signed out only when the server answers 200, having written the revocation; any
  other answer, or none, leaves the session as it was and says SIGN_OUT_FAILED_TEXT, so the same sign-out can be tried
  again. No control on the site calls it yet (a sign-out button needs an approved mock).
*/
export async function signOutRequest(send: (body: object) => Promise<Response>): Promise<{ ok: true } | { ok: false; problem: string }> {
  try {
    const r = await send({ action: "out" });
    return r.ok ? { ok: true } : { ok: false, problem: SIGN_OUT_FAILED_TEXT };
  } catch {
    return { ok: false, problem: SIGN_OUT_FAILED_TEXT };
  }
}

/* The wallet this browser is signed in as (null: none, or another), a sign-in for the connected one, and expire() for a create the server refused for the session. */
export function useCreatorSession(address: string | null): { signedIn: boolean | null; signIn: (signer: TxSigner) => Promise<void>; expire: () => void; busy: boolean; tryAgain: boolean; problem: string | null } {
  const [wallet, setWallet] = useState<string | null | undefined>(undefined);
  /*
    The wallet a sign-in is waiting on, and which tap: the button is busy only for the wallet the page is using now.
    24i (Claude L2): an account change overtakes the tap (its signature is never verified), so the button is freed at
    once, even when the same wallet comes back while its prompt is open; a tap clears only its own busy state.
  */
  const [busyFor, setBusyFor] = useState<{ wallet: string; mine: number } | null>(null);
  /* The tap whose wallet has not answered within WALLET_WAIT_MS: the button is free again with "Try again." under it. */
  const [waitedFor, setWaitedFor] = useState<{ wallet: string; mine: number } | null>(null);
  const [busyAddress, setBusyAddress] = useState(address);
  if (busyAddress !== address) {
    setBusyAddress(address);
    setBusyFor(null);
    setWaitedFor(null);
  }
  const release = (mine: number) => setBusyFor((b) => (b !== null && b.mine === mine ? null : b));
  const answered = (mine: number) => setWaitedFor((w) => (w !== null && w.mine === mine ? null : w));
  const [problem, setProblem] = useState<string | null>(null);
  /*
    24g (Astra 24f R7-L1): a sign-in belongs to the wallet the page was using when it was tapped. When the account
    changes, or a newer tap starts, an older one's late signature is never sent to verify; a verify that was already on
    its way when it was overtaken is followed by a read of the session the server now holds, so the page shows the
    cookie's wallet, never a guess.
  */
  const current = useRef(address);
  const attempt = useRef(0);
  const verified = useRef(0);
  useEffect(() => {
    current.current = address;
    attempt.current++;
  }, [address]);
  const getSession = useCallback((signal: AbortSignal) => fetch("/api/session", { cache: "no-store", signal }), []);
  const readSession = useCallback(() => readSessionOnce(getSession, RECONCILE_READ_MS), [getSession]);
  /*
    24i (Astra R8-L1): after a verify that was overtaken in flight, the cookie may belong to either wallet. The page
    claims nothing (signed-in unknown: Create waits, in its existing words) until the server's session is read; a read
    that fails is tried again, and after RECONCILE_TRIES the page shows signed out, so the sign-in step comes back. A
    newer sign-in or a newer reconciliation makes an older one's answer moot.
  */
  const reconciling = useRef(0);
  const reconcile = useCallback(
    async (seen: number) => {
      const turn = ++reconciling.current;
      const stale = () => seen !== verified.current || turn !== reconciling.current;
      setWallet(undefined);
      const r = await reconcileReads(getSession, stale);
      if (r.kind === "wallet") setWallet(r.wallet);
      else if (r.kind === "failed") {
        setWallet(null);
        setProblem(RETRY_TEXT);
      }
    },
    [getSession],
  );
  useEffect(() => {
    let live = true;
    readSession().then((w) => live && setWallet(w), () => live && setWallet(null));
    return () => {
      live = false;
    };
  }, [address, readSession]);
  /*
    2026-10-25 (the founder, Phantom on an iPhone: about five taps before the prompt opened): the message is fetched before
    the tap, so the tap's first await is the wallet's signMessage. A phone wallet's in-app browser opens its sheet only
    for a request made inside the tap; the nonce's round trip (the gate, the store, a cold instance) used to sit
    between them. The message is kept fresh well inside NONCE_SECS (300 s) and fetched again when the page comes
    back from the background (timers sleep there). Without a fresh one, the tap fetches it first, as before.
    24g (R7-M2): an answer replaces the held message only when it was asked for later, so overlapping fetches never
    put an older message back.
  */
  const ahead = useRef<{ wallet: string; message: string; nonce: string; at: number } | null>(null);
  const hold = (m: { wallet: string; message: string; nonce: string; at: number }) => {
    if (!ahead.current || ahead.current.wallet !== m.wallet || m.at > ahead.current.at) ahead.current = m;
  };
  const post = useCallback((body: object) => fetch("/api/session", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), cache: "no-store" }), []);
  const fetchMessage = useCallback(
    async (who: string) => {
      const at = Date.now();
      const n = await post({ action: "nonce", wallet: who });
      const { message, nonce } = (n.ok ? await n.json() : {}) as { message?: string; nonce?: string };
      if (!message || !nonce) throw new Error("nonce");
      return { wallet: who, message, nonce, at };
    },
    [post],
  );
  const needed = address !== null && wallet !== undefined && wallet !== address;
  useEffect(() => {
    if (!needed || !address) {
      ahead.current = null;
      return;
    }
    let live = true;
    let asking = false;
    const refresh = () => {
      if (asking) return;
      if (ahead.current && ahead.current.wallet === address && Date.now() - ahead.current.at < MESSAGE_REFRESH_MS) return;
      asking = true;
      fetchMessage(address).then(
        (m) => {
          asking = false;
          if (live) hold(m);
        },
        () => {
          asking = false;
        },
      );
    };
    refresh();
    const timer = setInterval(refresh, REFRESH_CHECK_MS);
    const back = () => document.visibilityState === "visible" && refresh();
    document.addEventListener("visibilitychange", back);
    return () => {
      live = false;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", back);
    };
  }, [needed, address, fetchMessage]);
  const signIn = useCallback(
    async (signer: TxSigner) => {
      if (!signer.signMessage) {
        setProblem("This wallet can't sign a message. Use another wallet to create.");
        return;
      }
      const mine = ++attempt.current;
      const ours = () => attempt.current === mine && current.current === signer.address;
      setBusyFor({ wallet: signer.address, mine });
      setWaitedFor(null);
      setProblem(null);
      /* A wallet that has not answered in WALLET_WAIT_MS frees the button, with "Try again." under it; an answer that still comes later is used while nothing newer has started. */
      /* After a failed tap, the next one is ready at once too. */
      const again = () =>
        fetchMessage(signer.address).then(
          (m) => attempt.current === mine && hold(m),
          () => {},
        );
      const stuck = setTimeout(() => {
        release(mine);
        if (attempt.current !== mine) return;
        setWaitedFor({ wallet: signer.address, mine });
      }, WALLET_WAIT_MS);
      try {
        const held = ahead.current;
        const ready = held && held.wallet === signer.address && Date.now() - held.at < MESSAGE_FRESH_MS ? held : null;
        /*
          The held message stays held until a sign-in is verified (the server keeps each nonce until it is spent or
          NONCE_SECS pass), so a tap after an unanswered or refused one signs at once too, never after a fetch.
        */
        /* The prompt first: no await before signMessage when the message is ready. */
        const m = ready ?? (await fetchMessage(signer.address));
        const bytes = new TextEncoder().encode(m.message);
        /* B22: with the bytes the wallet signed when it says (a Ledger's off-chain envelope); the server checks them against the message. */
        const out = signer.signMessageWithBytes ? await signer.signMessageWithBytes(bytes) : { signature: await signer.signMessage(bytes), signedMessage: null };
        /* Overtaken while the wallet was open (another tap, another account): this signature is never verified. */
        if (!ours()) return;
        const signedMessage = out.signedMessage ? btoa(Array.from(out.signedMessage, (b) => String.fromCharCode(b)).join("")) : undefined;
        const v = await post({ action: "verify", wallet: signer.address, nonce: m.nonce, signature: bs58.encode(out.signature), ...(signedMessage ? { signedMessage } : {}) });
        if (!v.ok) throw new Error("verify");
        if (ours()) {
          verified.current++;
          setWallet(signer.address);
          setProblem(null);
        } else {
          /* Its cookie may have landed after a newer sign-in's: show the session the server holds now. */
          void reconcile(verified.current);
        }
      } catch (e) {
        if (attempt.current === mine) {
          setProblem(/reject/i.test(e instanceof Error ? e.message : "") ? "Sign-in cancelled. Nothing was sent." : RETRY_TEXT);
          void again();
        }
      } finally {
        clearTimeout(stuck);
        release(mine);
        answered(mine);
      }
    },
    [fetchMessage, post, reconcile],
  );
  const expire = useCallback(() => {
    setWallet(null);
    setProblem(EXPIRED_TEXT);
  }, []);
  return {
    signedIn: wallet === undefined ? null : address !== null && wallet === address,
    signIn,
    expire,
    busy: busyFor !== null && busyFor.wallet === address,
    tryAgain: busyFor === null && waitedFor !== null && waitedFor.wallet === address,
    problem,
  };
}

export function SignInStep({ onSignIn, busy, tryAgain = false, problem }: { onSignIn: () => void; busy: boolean; tryAgain?: boolean; problem: string | null }) {
  return (
    <div className="inset p-4 mt-4" data-sign-in>
      <p className="font-semibold text-text">Prove this wallet is yours</p>
      <p className="text-text-2 leading-snug mt-1">One signature. No transaction, no fee. Good for 24 hours.</p>
      <button type="button" className="btn btn-secondary w-full mt-3" disabled={busy} onClick={onSignIn}>
        {busy ? "Check your wallet" : "Sign in"}
      </button>
      {/* The live region is always there (so a message is announced), but takes no space until it has one. */}
      <p className={problem || tryAgain ? "text-text-2 leading-snug mt-2" : "sr-only"} role="status" aria-live="polite" data-sign-in-status>
        {problem ?? (tryAgain ? TRY_AGAIN_TEXT : null)}
      </p>
    </div>
  );
}
