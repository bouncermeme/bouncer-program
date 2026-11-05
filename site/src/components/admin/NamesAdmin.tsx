"use client";

/*
  The admin's same-name notices page (/admin/names; v0.30 item 8, the mock the founder approved: mocks-ui/README.md section 8,
  8a and 8b, with 8C, a hidden notice is hidden entirely). For the admin's phone wallet, like the ticker release
  (TickerAdmin.tsx): connect, type a ticker, a name or a launch, Look (no signature: the board's own list and the
  public hidden list), pick a pair, give a reason, Sign and suppress (one signature). "Undo: warn again" signs the
  reverse. Each action is one message (namesAdminMessage.ts) posted to /api/admin/names, which answers nothing to any
  other wallet. Nothing here touches the chain, a ticker's hold or the creation gate.
*/
import { useMemo, useState } from "react";
import bs58 from "bs58";
import { CLUSTER } from "@contract/active";
import { useAccount } from "@/components/wallet/AccountProvider";
import { boardFacts, sameNameOthers, tickerOf } from "@/lib/bouncer/boardSort";
import { shortAddr } from "@/lib/bouncer/format";
import { useHiddenPairs } from "@/lib/bouncer/hiddenPairs";
import { useLaunchList, useNowSec } from "@/lib/bouncer/hooks";
import { ADMIN_MESSAGE_SECS, adminNonce, hiddenPair, NAMES_WHY_RE, namesMessage, type NamesMessage } from "@/lib/bouncer/namesAdminMessage";
import type { Launch } from "@/lib/bouncer/types";

interface AuditLine {
  at?: string;
  action?: "hide" | "show";
  launch?: string;
  other?: string;
  why?: string | null;
}
interface Pair {
  launch: Launch;
  other: Launch;
  hidden: boolean;
}
type View = { step: "look" } | { step: "done"; launch: string; other: string };

const norm = (s: string) => s.trim().toLowerCase();
const auditTime = (iso?: string): string => {
  if (!iso) return "";
  const d = new Date(iso);
  return `${d.toLocaleString("en-US", { month: "short", timeZone: "UTC" })} ${d.getUTCDate()}, ${iso.slice(11, 16)} UTC`;
};
const pairText = (a: string, b: string) => `${shortAddr(a)} → ${shortAddr(b)}`;
/* The route's refusals, in the ticker release's words where they are the same. */
const REFUSED: Record<string, string> = {
  "not-admin": "This wallet is not the admin wallet.",
  signature: "This wallet is not the admin wallet.",
  "wrong-host": "The message named another site.",
  "wrong-cluster": "The message named another network.",
  expired: "The message expired. Try again.",
  "not-yet": "This phone's clock is ahead. Check it and try again.",
  "too-long": "The message lasted too long. Try again.",
  nonce: "That message was already used. Try again.",
};

export function NamesAdmin() {
  const account = useAccount();
  const { list } = useLaunchList();
  const nowSec = useNowSec(30_000);
  const publicHidden = useHiddenPairs();
  /* After a signed action, the route's own answer is the list (the public one is cached for up to a minute). */
  const [hiddenNow, setHiddenNow] = useState<ReadonlySet<string> | null>(null);
  const hidden = hiddenNow ?? publicHidden;
  const [query, setQuery] = useState("");
  const [looked, setLooked] = useState<string | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const [why, setWhy] = useState("");
  const [busy, setBusy] = useState(false);
  const [view, setView] = useState<View>({ step: "look" });
  const [note, setNote] = useState<string | null>(null);
  const [audit, setAudit] = useState<AuditLine[]>([]);

  const byId = useMemo(() => new Map((list ?? []).map((l) => [l.id, l])), [list]);
  const facts = useMemo(() => (list ? boardFacts(list) : null), [list]);
  /* Every pair the looked-up launches warn about now or would without the admin: the notice's own rule (boardSort.ts sameNameOthers), hidden directions included and marked. */
  const pairs = useMemo<Pair[]>(() => {
    if (!looked || !list || !facts) return [];
    const q = norm(looked);
    const hits = list.filter((l) => norm(l.token.symbol) === q || norm(l.token.name) === q || l.id === looked.trim());
    const out: Pair[] = [];
    for (const l of hits) {
      const c = sameNameOthers(l, facts.tickerLaunches.get(tickerOf(l.token.symbol)) ?? [], { nowSec });
      for (const o of c.launches) out.push({ launch: l, other: o, hidden: hidden.has(hiddenPair(l.id, o.id)) });
    }
    return out;
  }, [looked, list, facts, nowSec, hidden]);

  async function send(m: Omit<NamesMessage, "admin" | "host" | "cluster" | "nonce" | "issuedAt" | "expiresAt">): Promise<Record<string, unknown> | null> {
    const signer = account.signer;
    if (!signer?.signMessage || !account.address) {
      setNote("This wallet cannot sign a message.");
      return null;
    }
    const now = Math.floor(Date.now() / 1000);
    const text = namesMessage({ ...m, admin: account.address, host: window.location.host, cluster: CLUSTER, nonce: adminNonce(), issuedAt: now, expiresAt: now + ADMIN_MESSAGE_SECS - 60 });
    let signature: Uint8Array;
    try {
      signature = await signer.signMessage(new TextEncoder().encode(text));
    } catch {
      setNote("Not signed.");
      return null;
    }
    const res = await fetch("/api/admin/names", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text, signature: bs58.encode(signature) }), cache: "no-store" }).catch(() => null);
    if (!res) {
      setNote("The site did not answer. Try again.");
      return null;
    }
    const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (res.status === 404) {
      setNote("Same-name notices are closed on this site.");
      return null;
    }
    if (!res.ok) {
      const refused = typeof body?.refused === "string" ? body.refused : res.status === 403 ? "not-admin" : null;
      setNote(refused ? (REFUSED[refused] ?? `Refused: ${refused}.`) : "Same-name notices are unavailable just now. Try again.");
      return null;
    }
    if (Array.isArray(body?.hidden)) setHiddenNow(new Set((body.hidden as unknown[]).filter((x): x is string => typeof x === "string")));
    if (Array.isArray(body?.audit)) setAudit((body.audit as AuditLine[]).slice().reverse());
    return body;
  }

  async function act(action: "hide" | "show", launch: string, other: string) {
    const reason = why.trim();
    setNote(null);
    if (action === "hide" && !NAMES_WHY_RE.test(reason)) {
      setNote("A reason of 1 to 120 plain characters, without ;.");
      return;
    }
    setBusy(true);
    const body = await send({ action, launch, other, why: action === "hide" ? reason : null });
    setBusy(false);
    if (!body) return;
    if (action === "hide") setView({ step: "done", launch, other });
    else {
      setView({ step: "look" });
      setPicked(null);
      setWhy("");
    }
  }

  const header = (
    <div className="flex items-baseline justify-between mb-5">
      <h1 className="display text-[1.5rem]">Same-name notices</h1>
      <span className="pill pill-muted">Admin · {CLUSTER === "mainnet-beta" ? "mainnet" : CLUSTER}</span>
    </div>
  );

  if (!account.address) {
    return (
      <div className="pt-8 max-w-[34rem]">
        {header}
        <div className="panel p-4 md:p-5">
          <p className="font-semibold text-[1.125rem]">Connect the admin wallet</p>
          <p className="text-text-3 mt-1 mb-4">Only the admin wallet set for {CLUSTER === "mainnet-beta" ? "mainnet" : CLUSTER} can sign.</p>
          <button type="button" className="btn btn-primary w-full" onClick={account.openConnect}>
            Connect wallet
          </button>
        </div>
      </div>
    );
  }

  const pickedPair = pairs.find((p) => hiddenPair(p.launch.id, p.other.id) === picked) ?? null;
  const symbolOf = (id?: string) => (id ? byId.get(id)?.token.symbol : undefined);
  return (
    <div className="pt-8 max-w-[34rem]" data-names-admin>
      {header}
      {view.step === "done" && (
        <>
          <div className="panel p-4 md:p-5 mb-3">
            <p className="font-semibold text-[1.125rem]">Suppressed</p>
            <p className="text-text-3 mt-1 mb-4">
              {shortAddr(view.launch)} no longer warns about {shortAddr(view.other)}. Both launches stay listed; a third launch with this name still warns.
            </p>
            <button type="button" className="btn btn-ghost w-full" disabled={busy} onClick={() => void act("show", view.launch, view.other)}>
              Undo: warn again
            </button>
            {note && <p className="text-text-2 mt-2">{note}</p>}
          </div>
          <Audit lines={audit} symbolOf={symbolOf} />
        </>
      )}
      {view.step === "look" && (
        <>
          <div className="panel p-4 md:p-5 mb-3">
            <div className="flex gap-2">
              <input className="field flex-1 min-w-0" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Ticker, name or launch" aria-label="Ticker, name or launch" maxLength={64} />
              <button type="button" className="btn btn-primary" disabled={busy || !query.trim() || !list} onClick={() => { setLooked(query); setPicked(null); setNote(null); }}>
                Look
              </button>
            </div>
            {note && <p className="text-text-2 mt-2">{note}</p>}
          </div>
          {looked && (
            <div className="panel p-4 md:p-5 mb-3">
              {pairs.length === 0 && <p className="text-text-3">No same-name notice for {looked.trim()}.</p>}
              {pairs.map((p) => {
                const id = hiddenPair(p.launch.id, p.other.id);
                return (
                  <button
                    type="button"
                    key={id}
                    onClick={() => setPicked(id)}
                    className={`w-full flex items-center justify-between gap-3 py-3 text-left border-t border-line first:border-t-0 ${picked === id ? "outline outline-2 outline-accent rounded-[10px] px-2" : ""}`}
                  >
                    <span className="min-w-0">
                      <span className="mono block">{pairText(p.launch.id, p.other.id)}</span>
                      <span className="text-text-2 text-sm">
                        Both use {p.launch.token.symbol}. The other: {p.other.token.symbol} {p.other.token.name}.
                      </span>
                    </span>
                    <span className={`pill ${p.hidden ? "pill-muted" : "pill-bad"}`}>{p.hidden ? "Suppressed" : "Warns"}</span>
                  </button>
                );
              })}
            </div>
          )}
          {pickedPair && !pickedPair.hidden && (
            <div className="panel p-4 md:p-5 mb-3">
              <p className="font-semibold text-[1.125rem]">
                Stop {shortAddr(pickedPair.launch.id)} warning about {shortAddr(pickedPair.other.id)}
              </p>
              <label htmlFor="why" className="block text-text-2 text-sm mt-3 mb-1">
                Reason (kept in the audit)
              </label>
              <input id="why" className="field w-full" value={why} onChange={(e) => setWhy(e.target.value)} maxLength={120} />
              <button type="button" className="btn btn-primary w-full mt-3" disabled={busy || !why.trim()} onClick={() => void act("hide", pickedPair.launch.id, pickedPair.other.id)}>
                Sign and suppress
              </button>
              <p className="text-text-3 text-sm mt-2">One signature. Nothing on chain changes. Both launches stay listed.</p>
            </div>
          )}
          {pickedPair && pickedPair.hidden && (
            <div className="panel p-4 md:p-5 mb-3">
              <p className="text-text-3 mb-3">
                {shortAddr(pickedPair.launch.id)} no longer warns about {shortAddr(pickedPair.other.id)}.
              </p>
              <button type="button" className="btn btn-ghost w-full" disabled={busy} onClick={() => void act("show", pickedPair.launch.id, pickedPair.other.id)}>
                Undo: warn again
              </button>
            </div>
          )}
          {audit.length > 0 && <Audit lines={audit} symbolOf={symbolOf} />}
        </>
      )}
    </div>
  );
}

function Audit({ lines, symbolOf }: { lines: AuditLine[]; symbolOf: (id?: string) => string | undefined }) {
  return (
    <div className="panel p-4 md:p-5">
      <p className="font-semibold mb-1">Audit</p>
      {lines.slice(0, 20).map((a, i) => (
        <p key={i} className="text-text-2 text-sm py-2 border-t border-line first:border-t-0">
          {[auditTime(a.at), symbolOf(a.launch), a.launch && a.other ? pairText(a.launch, a.other) : null, a.action === "hide" ? "suppressed" : a.action === "show" ? "unsuppressed" : null, a.why ? `"${a.why}"` : null].filter(Boolean).join(" · ")}
        </p>
      ))}
    </div>
  );
}
