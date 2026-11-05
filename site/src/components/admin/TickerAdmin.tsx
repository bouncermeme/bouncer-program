"use client";

/*
  The admin ticker release page (/admin/tickers; the founder approved the mock, review/2026-10-24d-ticker-release-mocks,
  2026-10-24). For the admin's phone wallet (Phantom in its in-app browser): connect, type a ticker, Look (one
  signature), pick a hold, give a reason, Release (one signature). Each action is one message signed with the wallet's
  signMessage and posted to /api/admin/ticker-release, the route the CLI uses (scripts/ticker-release.ts). The route
  answers nothing to any other wallet. Nothing here touches the chain.
*/
import { useState } from "react";
import bs58 from "bs58";
import { CLUSTER } from "@contract/active";
import { useAccount } from "@/components/wallet/AccountProvider";
import { shortAddr } from "@/lib/bouncer/format";
import { tickerKey } from "@/lib/bouncer/tickerKey";
import { ADMIN_MESSAGE_SECS, adminMessage, adminNonce, type AdminMessage } from "@/lib/bouncer/tickerAdminMessage";

type HoldKind = "live" | "funded" | "pending" | "free" | "unknown" | "other-key";
interface Hold {
  launch: string;
  kind: HoldKind;
  released: boolean;
  until?: number;
}
interface AuditLine {
  at?: string;
  ticker?: string;
  launch?: string | null;
  kind?: string;
  result?: string;
  why?: string | null;
}
interface Looked {
  ticker: string;
  key: string;
  slot: number;
  holds: Hold[];
  audit: AuditLine[];
}
type View = { step: "look" } | { step: "released"; launch: string } | { step: "notYet"; launch: string; until: number; mins: number } | { step: "said"; text: string };

const utc = (sec: number): string => `${new Date(sec * 1000).toISOString().slice(11, 16)} UTC`;
const auditTime = (iso?: string): string => {
  if (!iso) return "";
  const d = new Date(iso);
  return `${d.getUTCDate()} ${d.toLocaleString("en-GB", { month: "short", timeZone: "UTC" })} ${iso.slice(11, 16)}`;
};
const canRelease = (h: Hold): boolean => !h.released && (h.kind === "funded" || h.kind === "pending" || h.kind === "free");
function holdLine(h: Hold): { kind: string; pill: string; tone: string } {
  if (h.released) return { kind: "Released by the admin", pill: "Released", tone: "pill-good" };
  if (h.kind === "funded") return { kind: "Pool live", pill: "Trading", tone: "pill-live" };
  if (h.kind === "live") return { kind: "Auction open · can't release", pill: "Live", tone: "pill-bad" };
  if (h.kind === "pending") return { kind: h.until ? `Permit valid · can go ${utc(h.until)}` : "Being created", pill: "Pending", tone: "pill-muted" };
  if (h.kind === "free") return { kind: "Free on chain", pill: "Free", tone: "pill-muted" };
  return { kind: "Not this ticker's launch", pill: "Other", tone: "pill-muted" };
}
/* The route's refusals, in a few words. */
const REFUSED: Record<string, string> = {
  "not-admin": "This wallet is not the admin wallet.",
  signature: "This wallet is not the admin wallet.",
  "wrong-host": "The message named another site.",
  "wrong-cluster": "The message named another network.",
  expired: "The message expired. Try again.",
  "not-yet": "This phone's clock is ahead. Check it and try again.",
  "too-long": "The message lasted too long. Try again.",
  ticker: "Not a ticker.",
  reserved: "A reserved name. It is never released here.",
  nonce: "That message was already used. Try again.",
  live: "Live: an auction is running. It can't be released.",
  unknown: "That launch is not known.",
  "other-key": "That launch holds another ticker.",
};

export function TickerAdmin() {
  const account = useAccount();
  const [ticker, setTicker] = useState("");
  const [looked, setLooked] = useState<Looked | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const [why, setWhy] = useState("");
  const [busy, setBusy] = useState(false);
  const [view, setView] = useState<View>({ step: "look" });
  const [note, setNote] = useState<string | null>(null);

  async function send(m: Omit<AdminMessage, "admin" | "host" | "cluster" | "nonce" | "issuedAt" | "expiresAt">): Promise<Record<string, unknown> | null> {
    const signer = account.signer;
    if (!signer?.signMessage || !account.address) {
      setNote("This wallet cannot sign a message.");
      return null;
    }
    const now = Math.floor(Date.now() / 1000);
    const text = adminMessage({ ...m, admin: account.address, host: window.location.host, cluster: CLUSTER, nonce: adminNonce(), issuedAt: now, expiresAt: now + ADMIN_MESSAGE_SECS - 60 });
    let signature: Uint8Array;
    try {
      signature = await signer.signMessage(new TextEncoder().encode(text));
    } catch {
      setNote("Not signed.");
      return null;
    }
    const res = await fetch("/api/admin/ticker-release", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text, signature: bs58.encode(signature) }), cache: "no-store" }).catch(() => null);
    if (!res) {
      setNote("The site did not answer. Try again.");
      return null;
    }
    const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (res.status === 404) {
      setNote("The release is closed on this site.");
      return null;
    }
    if (!res.ok) {
      const refused = typeof body?.refused === "string" ? body.refused : res.status === 403 ? "not-admin" : null;
      setNote(refused ? (REFUSED[refused] ?? `Refused: ${refused}.`) : "The release is unavailable just now. Try again.");
      return null;
    }
    return body;
  }

  async function look() {
    const t = ticker.trim().toUpperCase();
    const key = tickerKey(t);
    setNote(null);
    if (!key) {
      setNote("Not a ticker.");
      return;
    }
    setBusy(true);
    const body = await send({ action: "look", ticker: t, key, launch: null, why: null });
    setBusy(false);
    if (!body) return;
    setLooked({ ticker: t, key, slot: Number(body.slot ?? 0), holds: (body.holds as Hold[]) ?? [], audit: ((body.audit as AuditLine[]) ?? []).slice().reverse() });
    setPicked(null);
    setView({ step: "look" });
  }

  async function release() {
    if (!looked || !picked) return;
    const reason = why.trim();
    setNote(null);
    if (!/^[\x21-\x3a\x3c-\x7e](?:[\x20-\x3a\x3c-\x7e]{0,118}[\x21-\x3a\x3c-\x7e])?$/.test(reason)) {
      setNote("A reason of 1 to 120 plain characters, without ;.");
      return;
    }
    setBusy(true);
    const body = await send({ action: "release", ticker: looked.ticker, key: looked.key, launch: picked, why: reason });
    setBusy(false);
    if (!body) return;
    const result = String(body.result ?? "");
    const line: AuditLine = { at: new Date().toISOString(), ticker: looked.ticker, launch: picked, result, why: reason };
    setLooked({ ...looked, audit: [line, ...looked.audit] });
    if (result === "released" || result === "already") setView({ step: "released", launch: picked });
    else if (result === "kept" && typeof body.until === "number") setView({ step: "notYet", launch: picked, until: body.until, mins: Math.max(1, Math.ceil((body.until - Date.now() / 1000) / 60)) });
    else setView({ step: "said", text: REFUSED[result] ?? `Not released: ${result}.` });
  }

  const header = (
    <div className="flex items-baseline justify-between mb-5">
      <h1 className="display text-[1.5rem]">Ticker release</h1>
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

  const pickedHold = looked?.holds.find((h) => h.launch === picked) ?? null;
  return (
    <div className="pt-8 max-w-[34rem]" data-ticker-admin>
      {header}
      {view.step === "released" && looked && (
        <>
          <div className="panel p-4 md:p-5 mb-3">
            <p className="font-semibold text-[1.125rem]">Released</p>
            <p className="text-text-3 mt-1">
              {shortAddr(view.launch)} no longer holds {looked.ticker}. Its token is untouched.
            </p>
          </div>
          <Audit lines={looked.audit} />
          <button type="button" className="btn btn-ghost w-full mt-3" onClick={() => { setView({ step: "look" }); setLooked(null); setTicker(""); setWhy(""); }}>
            Look up another ticker
          </button>
        </>
      )}
      {view.step === "notYet" && (
        <div className="panel p-4 md:p-5">
          <p className="font-semibold text-[1.125rem]">Not yet</p>
          <p className="text-text-3 mt-1 mb-4">
            A permit for {shortAddr(view.launch)} can still land. It can go at {utc(view.until)} (in {view.mins} min).
          </p>
          <button type="button" className="btn btn-ghost w-full" onClick={() => setView({ step: "look" })}>
            Back
          </button>
        </div>
      )}
      {view.step === "said" && (
        <div className="panel p-4 md:p-5">
          <p className="text-text-2 mb-4">{view.text}</p>
          <button type="button" className="btn btn-ghost w-full" onClick={() => setView({ step: "look" })}>
            Back
          </button>
        </div>
      )}
      {view.step === "look" && (
        <>
          <div className="panel p-4 md:p-5 mb-3">
            <div className="flex gap-2">
              <input className="field flex-1 min-w-0" value={ticker} onChange={(e) => setTicker(e.target.value)} placeholder="Ticker" aria-label="Ticker" autoCapitalize="characters" maxLength={10} />
              <button type="button" className="btn btn-primary" disabled={busy || !ticker.trim()} onClick={() => void look()}>
                Look
              </button>
            </div>
            {looked && (
              <p className="text-text-3 text-sm mt-2">
                Key {looked.key} · slot {looked.slot.toLocaleString("en-US")}
              </p>
            )}
            {note && <p className="text-text-2 mt-2">{note}</p>}
          </div>
          {looked && (
            <div className="panel p-4 md:p-5 mb-3">
              {looked.holds.length === 0 && <p className="text-text-3">Nothing holds {looked.ticker}.</p>}
              {looked.holds.map((h) => {
                const l = holdLine(h);
                const can = canRelease(h);
                return (
                  <button
                    type="button"
                    key={h.launch}
                    disabled={!can}
                    onClick={() => setPicked(h.launch)}
                    className={`w-full flex items-center justify-between gap-3 py-3 text-left border-t border-line first:border-t-0 ${picked === h.launch ? "outline outline-2 outline-accent rounded-[10px] px-2" : ""}`}
                  >
                    <span>
                      <span className="mono block">{shortAddr(h.launch)}</span>
                      <span className="text-text-2 text-sm">{l.kind}</span>
                    </span>
                    <span className={`pill ${l.tone}`}>{l.pill}</span>
                  </button>
                );
              })}
            </div>
          )}
          {looked && pickedHold && (
            <div className="panel p-4 md:p-5 mb-3">
              <p className="font-semibold text-[1.125rem]">Release {shortAddr(pickedHold.launch)}</p>
              <label htmlFor="why" className="block text-text-2 text-sm mt-3 mb-1">
                Reason (kept in the audit)
              </label>
              <input id="why" className="field w-full" value={why} onChange={(e) => setWhy(e.target.value)} maxLength={120} />
              <button type="button" className="btn btn-primary w-full mt-3" disabled={busy || !why.trim()} onClick={() => void release()}>
                Sign and release
              </button>
              <p className="text-text-3 text-sm mt-2">One signature. Nothing on chain changes.</p>
            </div>
          )}
          {looked && looked.audit.length > 0 && <Audit lines={looked.audit} />}
        </>
      )}
    </div>
  );
}

function Audit({ lines }: { lines: AuditLine[] }) {
  return (
    <div className="panel p-4 md:p-5">
      <p className="font-semibold mb-1">Audit</p>
      {lines.slice(0, 20).map((a, i) => (
        <p key={i} className="text-text-2 text-sm py-2 border-t border-line first:border-t-0">
          {[auditTime(a.at), a.ticker, a.launch ? shortAddr(a.launch) : null, a.result ?? a.kind, a.why ? `"${a.why}"` : null].filter(Boolean).join(" · ")}
        </p>
      ))}
    </div>
  );
}
