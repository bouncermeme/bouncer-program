"use client";

/*
  /stats (22e3, the founder 2026-10-23: its own page, linked from the footer; not on the home page). The figures are
  /api/stats' sums over the chain (server/stats.ts says what each one counts), read once on load and every 5
  minutes, the CDN's period. While the first read is out the panel shows it is reading; when it fails and nothing
  was read, it says so instead of showing zeros. 23c (the founder approved, mock first): cleared means funded (a pool),
  refunds in three labelled parts, and the Meteora (i) on "Locked forever".
*/
import Link from "next/link";
import { useEffect, useState } from "react";
import { fmtAgo, fmtSol } from "@/lib/bouncer/format";
import { isMainnet } from "@/lib/bouncer/siteCluster";
import { CLUSTER } from "@contract/active";
import { MeteoraSplitInfo } from "@/components/ui/MeteoraSplitInfo";
import type { ReactNode } from "react";

interface Stats {
  readAt: number;
  launches: number;
  cleared: number;
  ended: number;
  raised: string;
  locked: string;
  refunded: string;
  refundLosing: string;
  refundChange: string;
  refundFailed: string;
  toCreators: string;
}

const REFRESH_MS = 300_000;

export function StatsView() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    const read = () =>
      fetch("/api/stats", { cache: "no-store" })
        .then((r) => (r.ok ? (r.json() as Promise<Stats>) : Promise.reject(new Error(String(r.status)))))
        .then((s) => live && (setStats(s), setFailed(false)), () => live && setFailed(true));
    void read();
    const t = setInterval(read, REFRESH_MS);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, []);

  const sol = (s: string | undefined) => fmtSol(BigInt(s ?? "0"));
  const items: [ReactNode, string, ReactNode][] = stats
    ? [
        ["Launches", String(stats.launches), `${stats.cleared} cleared · ${stats.ended} refundable`],
        ["Raised", sol(stats.raised), "in cleared launches"],
        [<>Locked forever{" "}<span className="inline-flex h-0 items-center align-middle" data-stats-locked-info>{/* No height: the 40 px (i) must not push this figure below its neighbours (the founder, 2026-10-24). */}<MeteoraSplitInfo voice="reader" /></span></>, sol(stats.locked), "pool liquidity, no key can pull it"],
        [
          "Refundable",
          sol(stats.refunded),
          <span key="r" className="flex flex-col gap-0.5" data-stats-refunds>
            <span>Losing bids {sol(stats.refundLosing)}</span>
            <span>Winners&apos; change {sol(stats.refundChange)}</span>
            <span>Failed launches {sol(stats.refundFailed)}</span>
          </span>,
        ],
        ["To creators", sol(stats.toCreators), "their part of the raise fee"],
      ]
    : [];

  return (
    <article className="pt-8 md:pt-14 max-w-[46rem]" data-stats>
      <h1 className="display text-[1.75rem] md:text-[2rem] leading-tight">Stats</h1>
      <p className="text-text-2 text-[1.125rem] mt-2 leading-snug">Bouncer in numbers, read from the chain.</p>
      {stats ? (
        <dl className="panel p-4 md:p-5 mt-6 grid grid-cols-2 gap-x-4 gap-y-5 md:grid-cols-3" data-stats-grid>
          {items.map(([k, v, sub], i) => (
            <div key={i} className={`min-w-0 ${i === 0 ? "col-span-2 md:col-span-1" : ""}`}>
              <dt className="text-text-3 leading-tight">{k}</dt>
              <dd className="figure text-[1.5rem] md:text-[1.75rem] mt-1 leading-none">{v}</dd>
              <dd className="text-text-3 mt-1.5 leading-tight">{sub}</dd>
            </div>
          ))}
        </dl>
      ) : (
        <p className="panel p-4 md:p-5 mt-6 text-text-2" role="status" data-stats-empty>
          {failed ? "The figures can't be read right now. Try again in a minute." : "Reading the chain…"}
        </p>
      )}
      <p className="text-text-3 mt-4">
        {stats ? <>Updated {fmtAgo(Math.floor(stats.readAt / 1000))}{isMainnet(CLUSTER) ? "" : " · devnet"} · </> : null}
        <Link className="link" href="/trust">
          Trust
        </Link>
      </p>
    </article>
  );
}
