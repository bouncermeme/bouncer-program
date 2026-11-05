/*
  JSON for the site's own endpoints (2026-10-15): a bigint travels as
  { "$bigint": "123" } and comes back a bigint, so an event decoded on the
  server reads in the browser exactly as one decoded there. Nothing else is
  changed.
*/
export function toJson(value: unknown): string {
  return JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? { $bigint: v.toString() } : v));
}

export function fromJson<T = unknown>(text: string): T {
  return JSON.parse(text, (_k, v) => (v && typeof v === "object" && typeof (v as { $bigint?: unknown }).$bigint === "string" ? BigInt((v as { $bigint: string }).$bigint) : v)) as T;
}
