import { useEffect, useMemo, useState } from "react";
import { PublicKey } from "@solana/web3.js";
import { decodeDammPool, poolMcapLamports, tradingSince } from "./chain/pool";
import { getConnection, SITE_ROUTES } from "./chain/rpc";
import { chainClient } from "./chain/chainClient";
import { fmtSol } from "./format";
import { CLUSTER } from "@contract/active";

/*
  What a settled coin is doing on the market (the founder, 2026-10-06: the closed
  cards and the trading view show the current market cap and the volume).

  Market cap: read from the chain on every network. Each launch's record names
  its Meteora DAMM v2 pool; the pool account's sqrt_price is the spot price,
  and the market cap is that price times the total supply (chain/pool.ts). One
  getMultipleAccounts read for a whole board, re-read whenever the board is.

  Volume, one source per network (the founder, 2026-10-07: "3 should have the real
  volume"). On mainnet it is Dexscreener's 24-hour figure in dollars, from its
  public API. Off mainnet, which Dexscreener does not index, it is the SOL
  that went through the pool in the last 24 hours, read from the pool's own
  swap transactions by this site's server (lib/bouncer/server/volume.ts, run
  every minute, served as one JSON at /api/volume) and shown in SOL, since no
  index prices a devnet coin. The page polls both (the 0.28 triage's F15,
  2026-10-09: mainnet's figure was read once per page), so a swap shows on
  the card within about a minute without a reload. Dexscreener also reports a market
  cap; the chain figure is shown instead so the same number appears on every
  network.
*/
export const ON_MAINNET = (CLUSTER as string) === "mainnet-beta" || (CLUSTER as string) === "mainnet";

export interface PoolEntry {
  id: string;
  pool: string;
  mint: string;
  supply: bigint;
  /* 24o: the launch's close_ts (0 when unset): a trading start before it is not believed (chain/pool.ts tradingSince). */
  closeTs?: number;
}

export interface PoolMcap {
  /* Null when the pool account is missing, is not a cp_amm pool of the pinned layout, does not pair the mint with SOL, or has no price. */
  mcapLamports: bigint | null;
  readAt: number;
  /* 24o: the unix second trading opened, from the same pool account (chain/pool.ts tradingSince); null when it cannot be told. */
  tradingSince?: number | null;
}

/* One pool account read: its market cap and trading start, from the same bytes (both read paths below). */
export const poolFigures = (pool: ReturnType<typeof decodeDammPool>, e: PoolEntry, readAt: number): PoolMcap => ({
  mcapLamports: pool ? poolMcapLamports(pool, e.mint, e.supply) : null,
  readAt,
  tradingSince: pool ? tradingSince(pool, e.mint, e.closeTs ?? 0) : null,
});

/*
  The read behind usePoolMcaps: null when a read failed. 24d (the founder's caching directive): through the site the pools
  come from its shared read (/api/launches?set=pools); only a pool it has not reached yet (one opened since its last
  scan) is read from the RPC here.
*/
export async function readPoolMcaps(entries: PoolEntry[]): Promise<Map<string, PoolMcap> | null> {
  const map = new Map<string, PoolMcap>();
  const c = getConnection();
  let todo = entries;
  if (SITE_ROUTES) {
    const shared = await chainClient.readBoardPools().catch(() => null);
    if (shared) {
      const readAt = Date.now();
      for (const e of entries) {
        const data = shared.get(e.pool);
        const pool = data ? decodeDammPool(data) : null;
        if (data) map.set(e.id, poolFigures(pool, e, readAt));
      }
      todo = entries.filter((e) => !shared.has(e.pool));
    }
  }
  for (let i = 0; i < todo.length; i += 100) {
    const chunk = todo.slice(i, i + 100);
    const infos = await c.getMultipleAccountsInfo(chunk.map((e) => new PublicKey(e.pool)), "confirmed").catch(() => null);
    if (!infos) return null;
    const readAt = Date.now();
    chunk.forEach((e, k) => {
      const info = infos[k];
      const pool = info ? decodeDammPool(new Uint8Array(info.data)) : null;
      map.set(e.id, poolFigures(pool, e, readAt));
    });
  }
  return map;
}

/* The pools' spot-price market caps, by launch id, one chunked getMultipleAccounts per read; null until the first read lands. `version` changes force a re-read (the trading page after a swap). */
export function usePoolMcaps(entries: PoolEntry[], version = ""): Map<string, PoolMcap> | null {
  const key = `${entries.map((e) => `${e.id}:${e.pool}`).join(",")}|${version}`;
  const [state, setState] = useState<{ key: string; map: Map<string, PoolMcap> } | null>(null);
  useEffect(() => {
    if (entries.length === 0) return;
    let live = true;
    readPoolMcaps(entries).then((map) => {
      if (live && map) setState({ key, map });
    });
    return () => {
      live = false;
    };
    /* The entries' identity follows the board's reads, so this re-reads at the board's cadence; the key keeps a same-content list from reading twice. */
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  /* While a re-read runs (a new version after a swap, a changed list), the last map stands: a launch not in it reads as loading on its own, and a figure does not blink to "…" between reads. */
  return state ? state.map : null;
}

/* loading: not read yet (or a pool the server has not reached yet). unavailable: the source answered without a figure, or did not answer. usd: Dexscreener's. sol: the server's sum of the pool's swaps, with the time it was written. */
export type Volume = { kind: "loading" } | { kind: "unavailable" } | { kind: "usd"; usd24: number; url: string | null } | { kind: "sol"; lamports24: bigint; swaps24: number; asOf: number };

interface DexPair {
  pairAddress?: string;
  url?: string;
  volume?: { h24?: number };
}

const DEX_CACHE_MS = 60_000;
const dexCache = new Map<string, { at: number; pair: DexPair | null }>();

/*
  Dexscreener's pairs, up to 30 per call, cached a minute. A pool missing from
  the result is one Dexscreener did not answer for (a refusal, a 429, a
  network error): it is not cached, so the next poll asks again, and the page
  keeps its last figure meanwhile. A pool it answered with no pair is null.
  Exported for the node check (measure/dex-volume.ts); the page calls it only
  on mainnet.
*/
export async function fetchDexPairs(pools: string[]): Promise<Map<string, DexPair | null>> {
  const out = new Map<string, DexPair | null>();
  const need = pools.filter((p) => {
    const hit = dexCache.get(p);
    if (hit && Date.now() - hit.at < DEX_CACHE_MS) {
      out.set(p, hit.pair);
      return false;
    }
    return true;
  });
  for (let i = 0; i < need.length; i += 30) {
    const chunk = need.slice(i, i + 30);
    try {
      const r = await fetch(`https://api.dexscreener.com/latest/dex/pairs/solana/${chunk.map(encodeURIComponent).join(",")}`, { cache: "no-store" });
      if (!r.ok) continue;
      const j = (await r.json()) as { pairs?: DexPair[] | null; pair?: DexPair | null };
      const pairs: DexPair[] = j?.pairs ?? (j?.pair ? [j.pair] : []);
      for (const p of chunk) {
        const pair = pairs.find((x) => x.pairAddress === p) ?? null;
        dexCache.set(p, { at: Date.now(), pair });
        out.set(p, pair);
      }
    } catch {
      /* Not answered: left out of the result and of the cache. */
    }
  }
  return out;
}

/* The shape /api/volume serves (lib/bouncer/server/volume.ts, VolumeSummary), as far as the page reads it. */
interface VolumeSummary {
  generatedAt: number;
  pools: Record<string, { sol24: string; swaps24: number }>;
}

/* How often the page asks the server again off mainnet: the server rewrites the file every minute, so a swap is on the card within about a minute and a half at the most. */
const VOLUME_POLL_MS = 20_000;
/* On mainnet, just over Dexscreener's one-minute cache here: a poll at exactly the cache's age would find the entry still fresh (it is stamped after the answer arrives) and refresh only every other minute. */
const DEX_POLL_MS = DEX_CACHE_MS + 5_000;

/* The site's own summary, or null when it has none yet or did not answer. */
export async function fetchVolumeSummary(): Promise<VolumeSummary | null> {
  try {
    const r = await fetch("/api/volume", { cache: "no-store" });
    if (!r.ok) return null;
    return (await r.json()) as VolumeSummary;
  } catch {
    return null;
  }
}

/* 24-hour volume per pool address, from the network's one source: Dexscreener on mainnet, the site's server off it, both polled. */
export function useVolumes(pools: string[]): Map<string, Volume> {
  const key = pools.join(",");
  const [state, setState] = useState<{ key: string; map: Map<string, Volume> } | null>(null);
  useEffect(() => {
    if (pools.length === 0) return;
    let live = true;
    /* The last figures read, kept for a pool Dexscreener did not answer for this time. */
    let last = new Map<string, Volume>();
    const read = async () => {
      const map = new Map<string, Volume>();
      if (ON_MAINNET) {
        const pairs = await fetchDexPairs(pools);
        for (const p of pools) {
          if (!pairs.has(p)) {
            map.set(p, last.get(p) ?? { kind: "unavailable" });
            continue;
          }
          const pair = pairs.get(p);
          const v = pair?.volume?.h24;
          map.set(p, typeof v === "number" ? { kind: "usd", usd24: v, url: typeof pair?.url === "string" ? pair.url : null } : { kind: "unavailable" });
        }
      } else {
        const summary = await fetchVolumeSummary();
        for (const p of pools) {
          const v = summary?.pools[p];
          /* A summary without this pool: the server has not reached it yet (a pool opened since its last run), so the card keeps "…" rather than a figure nobody measured. */
          map.set(p, !summary ? { kind: "unavailable" } : v ? { kind: "sol", lamports24: BigInt(v.sol24), swaps24: v.swaps24, asOf: summary.generatedAt } : { kind: "loading" });
        }
      }
      last = map;
      if (live) setState({ key, map });
    };
    void read();
    const timer = setInterval(() => void read(), ON_MAINNET ? DEX_POLL_MS : VOLUME_POLL_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return useMemo(() => {
    const map = new Map<string, Volume>();
    for (const p of pools) map.set(p, state && state.key === key ? (state.map.get(p) ?? { kind: "unavailable" }) : { kind: "loading" });
    return map;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, state]);
}

/* The volume figure as the page prints it: dollars from Dexscreener, SOL from the pool's own swaps. */
export function volumeText(v: Volume | undefined): { text: string; muted: boolean } {
  if (!v || v.kind === "loading") return { text: "…", muted: true };
  if (v.kind === "unavailable") return { text: "unavailable", muted: true };
  if (v.kind === "sol") return { text: fmtSol(v.lamports24), muted: false };
  return { text: fmtUsdVolume(v.usd24), muted: false };
}

export function fmtUsdVolume(usd: number): string {
  if (usd >= 1_000_000) return `$${(usd / 1_000_000).toFixed(usd >= 10_000_000 ? 0 : 1)}M`;
  if (usd >= 1_000) return `$${(usd / 1_000).toFixed(usd >= 10_000 ? 0 : 1)}k`;
  return `$${usd.toFixed(usd >= 100 ? 0 : 2)}`;
}
