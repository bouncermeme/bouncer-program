/*
  2026-10-24e (the founder's capacity decisions, item 2): many callers' reads in one upstream call. Every key asked for within
  `windowMs` of the first joins one batch (at most `max` keys, the method's own limit), so a final minute of 100 new
  bidders a second costs an instance a few reads a second instead of one each. The same key asked twice in a batch is
  read once. A failed batch fails every caller in it; a short answer fails the keys it left out.

  Used for the permit's balance read (app/api/attest, getMultipleAccounts) and the bid's status read (server/sendContext.ts,
  getSignatureStatuses).
*/
export function coalesce<K, V>(readMany: (keys: K[]) => Promise<V[]>, windowMs: number, max: number): (key: K) => Promise<V> {
  type Waiter = { resolve: (v: V) => void; reject: (e: unknown) => void };
  type Batch = { keys: K[]; waiters: Map<K, Waiter[]>; sent: boolean };
  let pending: Batch | null = null;
  const flush = (batch: Batch) => {
    if (batch.sent) return;
    batch.sent = true;
    if (pending === batch) pending = null;
    readMany(batch.keys).then(
      (values) => batch.keys.forEach((k, i) => batch.waiters.get(k)!.forEach((w) => (i < values.length ? w.resolve(values[i]) : w.reject(new Error("short answer"))))),
      (e) => batch.waiters.forEach((list) => list.forEach((w) => w.reject(e))),
    );
  };
  return (key) =>
    new Promise<V>((resolve, reject) => {
      if (!pending) {
        const fresh: Batch = { keys: [], waiters: new Map(), sent: false };
        pending = fresh;
        setTimeout(() => flush(fresh), windowMs);
      }
      const batch = pending;
      if (!batch.waiters.has(key)) {
        batch.keys.push(key);
        batch.waiters.set(key, []);
      }
      batch.waiters.get(key)!.push({ resolve, reject });
      if (batch.keys.length >= max) flush(batch);
    });
}
