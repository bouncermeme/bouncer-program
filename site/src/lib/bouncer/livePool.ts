/* One active trading pool, confirmed accountSubscribe plus serialized fallback reads.
   No endpoint credentials are logged. The HTTP-only local board proxy stays polling. */
export type LivePoolMode = "connecting" | "subscribed" | "polling";
export interface LivePoolValue { data: Uint8Array | null; slot: number; readAt: number; mode: LivePoolMode }
interface SocketLike {
  onopen: ((e: Event) => void) | null; onmessage: ((e: MessageEvent) => void) | null;
  onerror: ((e: Event) => void) | null; onclose: ((e: CloseEvent) => void) | null;
  send(data: string): void; close(): void;
}
export interface LivePoolIO {
  now(): number; read(): Promise<{ data: Uint8Array | null; slot: number }>;
  socket?: () => SocketLike; emit(value: LivePoolValue): void;
  later(fn: () => void, ms: number): ReturnType<typeof setTimeout>;
  clear(id: ReturnType<typeof setTimeout>): void;
  decode(value: unknown): Uint8Array | null;
}
export function poolWebsocketUrl(endpoint: string): string | null {
  const u = new URL(endpoint);
  if (u.pathname.startsWith("/api/rpc")) return null;
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
  if (u.port) u.port = String(Number(u.port) + 1);
  return u.toString();
}
export function watchPool(address: string, io: LivePoolIO): () => void {
  let active = true, busy = false, mode: LivePoolMode = io.socket ? "connecting" : "polling";
  let latest: LivePoolValue = { data: null, slot: -1, readAt: 0, mode };
  let socket: SocketLike | null = null, subscription: number | null = null, retries = 0, subscribedAt: number | null = null;
  let pollTimer: ReturnType<typeof setTimeout> | undefined, reconnect: ReturnType<typeof setTimeout> | undefined, ack: ReturnType<typeof setTimeout> | undefined, readTimer: ReturnType<typeof setTimeout> | undefined;
  const emitMode = (next: LivePoolMode) => { mode = next; if (active) io.emit({ ...latest, mode }); };
  const accept = (data: Uint8Array | null, slot: number, started: number) => {
    if (!active || !Number.isSafeInteger(slot) || slot < 0 || slot < latest.slot || (slot === latest.slot && started < latest.readAt)) return;
    latest = { data, slot, readAt: io.now(), mode }; io.emit(latest);
  };
  const poll = async () => {
    if (!active || busy) return;
    busy = true; const started = io.now();
    try {
      /* A read that never answers gives up after 15 s, so one hung request cannot stop the polling. */
      const value = await new Promise<{ data: Uint8Array | null; slot: number }>((resolve, reject) => {
        readTimer = io.later(() => reject(new Error("pool read timed out")), 15_000);
        io.read().then(resolve, reject);
      });
      accept(value.data, value.slot, started);
    } catch { /* Last read retains its timestamp; UI labels it stale. */ }
    finally { if (readTimer) io.clear(readTimer); readTimer = undefined; busy = false; if (active) pollTimer = io.later(() => { void poll(); }, 20_000); }
  };
  const connect = () => {
    if (!active || !io.socket) return;
    emitMode("connecting"); subscription = null;
    let ws: SocketLike;
    const failed = () => {
      if (!active || socket !== ws) return;
      socket = null; if (ack) io.clear(ack); ack = undefined;
      ws.onclose = ws.onerror = null; ws.onmessage = ws.onopen = null;
      ws.close(); emitMode("polling");
      /* The budget is per outage: a subscription that held for a minute earns three fresh retries. */
      if (subscribedAt !== null && io.now() - subscribedAt >= 60_000) retries = 0;
      subscribedAt = null;
      if (retries < 3) { const delay = 1_000 * 2 ** retries++; reconnect = io.later(connect, delay); }
    };
    try { ws = io.socket(); socket = ws; } catch {
      emitMode("polling"); if (retries < 3) reconnect = io.later(connect, 1_000 * 2 ** retries++); return;
    }
    ack = io.later(failed, 10_000);
    ws.onopen = () => { if (active && socket === ws) ws.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "accountSubscribe", params: [address, { encoding: "base64", commitment: "confirmed" }] })); };
    ws.onmessage = (event) => {
      if (!active || socket !== ws) return;
      try {
        const message = JSON.parse(event.data);
        if (message.id === 1) {
          if (!Number.isSafeInteger(message.result) || message.result < 0) { failed(); return; }
          subscription = message.result; subscribedAt = io.now(); if (ack) io.clear(ack); ack = undefined; emitMode("subscribed");
        } else if (subscription !== null && message.method === "accountNotification" && message.params?.subscription === subscription) {
          const result = message.params.result; accept(io.decode(result.value), result.context.slot, io.now());
        }
      } catch { failed(); }
    };
    ws.onerror = ws.onclose = failed;
  };
  void poll(); connect();
  return () => {
    active = false; for (const timer of [pollTimer, reconnect, ack, readTimer]) if (timer) io.clear(timer);
    if (socket) {
      const ws = socket; socket = null; ws.onclose = ws.onerror = ws.onopen = ws.onmessage = null;
      if (subscription !== null) { try { ws.send(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "accountUnsubscribe", params: [subscription] })); } catch {} }
      ws.close();
    }
  };
}
