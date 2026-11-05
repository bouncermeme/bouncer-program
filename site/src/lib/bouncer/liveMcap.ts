"use client";
import { useEffect, useState } from "react";
import { PublicKey } from "@solana/web3.js";
import { getConnection, SITE_ROUTES } from "./chain/rpc";
import { chainClient } from "./chain/chainClient";
import { decodeDammPool, poolMcapLamports } from "./chain/pool";
import { watchPool, poolWebsocketUrl, type LivePoolMode } from "./livePool";
export interface LiveMcap { mcapLamports: bigint | null; readAt: number; mode: LivePoolMode }
/* launchId: through the site (SITE_ROUTES) the pool is read from the launch's shared snapshot, not by this browser. */
export function useLiveMcap(pool: string | null, mint: string, supply: bigint, launchId: string | null = null): LiveMcap | null {
  const key = `${pool}:${mint}:${supply}:${launchId ?? ""}`;
  const [state, setState] = useState<{ key: string; value: LiveMcap } | null>(null);
  useEffect(() => {
    if (!pool) return;
    const connection = getConnection(), address = new PublicKey(pool);
    const viaSite = SITE_ROUTES && launchId !== null;
    const ws = viaSite ? null : poolWebsocketUrl(connection.rpcEndpoint);
    return watchPool(pool, {
      now: () => Date.now(), later: (fn, ms) => setTimeout(fn, ms), clear: (id) => clearTimeout(id),
      read: async () => {
        if (viaSite) return chainClient.readPool(launchId);
        const v = await connection.getAccountInfoAndContext(address, "confirmed");
        return { data: v.value ? new Uint8Array(v.value.data) : null, slot: v.context.slot };
      },
      socket: ws ? () => new WebSocket(ws) : undefined,
      decode: (value) => {
        if (value === null) return null;
        const data = (value as { data?: unknown }).data;
        if (!Array.isArray(data) || typeof data[0] !== "string" || data[1] !== "base64") throw new Error("Unreadable account notification");
        return Uint8Array.from(atob(data[0]), (c) => c.charCodeAt(0));
      },
      emit: (v) => { const decoded = v.data ? decodeDammPool(v.data) : null; setState({ key, value: { mcapLamports: decoded ? poolMcapLamports(decoded, mint, supply) : null, readAt: v.readAt, mode: v.mode } }); },
    });
  }, [key, pool, mint, supply, launchId]);
  return state?.key === key ? state.value : null;
}
