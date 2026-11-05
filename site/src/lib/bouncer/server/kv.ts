/*
  One Upstash REST command on the counter the site and the keeper share (sharedCap.ts), for the 23c modules: the
  ticker reservations (server/reservations.ts), the chain index's fleet budget and watermark (server/chainIndex.ts),
  the shared /stats snapshot and the sign-in nonces (server/session.ts). The same transport as attest.ts: POST the
  command as a JSON array, a deadline, and every failure the one KvDown, so a caller can tell "no answer" (uncertain:
  never treat as a refusal or a success) from an answer.
*/
import { sharedCapConfig, storeSpace, type Configured } from "./sharedCap";

export class KvDown extends Error {
  constructor() {
    super("kv");
    this.name = "KvDown";
  }
}
export const isKvDown = (e: unknown): boolean => e instanceof KvDown || (e instanceof Error && e.name === "KvDown");

export type Kv = (command: (string | number)[]) => Promise<unknown>;

export function kvOf(cfg: Configured): Kv {
  return async (command) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
    try {
      const res = await globalThis.fetch(cfg.url, { method: "POST", headers: { authorization: `Bearer ${cfg.token}`, "content-type": "application/json" }, body: JSON.stringify(command.map(String)), cache: "no-store", signal: controller.signal });
      if (!res.ok) throw new KvDown();
      const j = (await res.json()) as { result?: unknown };
      if (!j || typeof j !== "object" || !("result" in j)) throw new KvDown();
      return j.result;
    } catch {
      throw new KvDown();
    } finally {
      clearTimeout(timer);
    }
  };
}

/* The deployment's store, or null when it is not configured. */
export function kvFromEnv(env: NodeJS.ProcessEnv = process.env): Kv | null {
  const c = sharedCapConfig(env);
  return c.configured ? kvOf(c) : null;
}

/* A key in this program's space on the store: <area>/<genesis8>/<parts...>. */
export const kvKey = (area: string, ...parts: string[]): string => `${area}/${storeSpace()}/${parts.join("/")}`;
