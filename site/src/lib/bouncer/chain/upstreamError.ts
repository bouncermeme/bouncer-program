/*
  What an upstream (the RPC, the Blob store, a price source) did wrong, as a
  closed category and never as its words (2026-10-16, after GPT-6's final
  review: three rounds of patching message text, so the message is gone).
  The site's readers throw this instead of `new Error(upstreamText)`; a
  route answers a fixed sentence by category; a report counts categories;
  a log line carries the category and a scrubbed note at most. Shared by
  the browser's readers and the server's, so it lives beside the chain code
  and imports nothing.
*/
export type UpstreamKind =
  /* HTTP 429 or the node's -32005 */
  | "rate"
  /* the provider's quota or plan refused */
  | "quota"
  /* any other non-2xx */
  | "http"
  /* a JSON-RPC error the site does not read past its category */
  | "refused"
  /* no answer within the time allowed */
  | "timeout"
  /* the connection failed */
  | "unreachable"
  /* a 2xx that is not the JSON-RPC envelope the site reads */
  | "shape"
  /* the server has no endpoint configured */
  | "unconfigured";

export class UpstreamError extends Error {
  readonly kind: UpstreamKind;
  /* The HTTP status, when there was one. A number, never a body. */
  readonly status: number | null;
  constructor(kind: UpstreamKind, status: number | null = null) {
    super(`upstream ${kind}${status !== null ? ` ${status}` : ""}`);
    this.name = "UpstreamError";
    this.kind = kind;
    this.status = status;
  }
}

/* A JSON-RPC error that says the method does not exist, by its standard code or the provider's wording: the one classification of a refusal's text, so no server module reads it. */
export function isMethodNotFound(error: { code?: unknown; message?: unknown } | null | undefined): boolean {
  if (!error) return false;
  if (error.code === -32601) return true;
  return typeof error.message === "string" && /method not found|not supported|unknown method/i.test(error.message);
}

/* The category of any thrown value, for a report or a log: an UpstreamError's own, the site's own timeout sentences, a refusal for rate by its shape, else "other". Never the words. */
export function categoryOf(e: unknown): UpstreamKind | "budget" | "other" {
  if (e instanceof UpstreamError) return e.kind;
  const name = e instanceof Error ? e.name : "";
  if (name === "BudgetExhausted") return "budget";
  if (name === "TimeoutError" || name === "AbortError") return "timeout";
  const msg = e instanceof Error ? e.message : typeof e === "string" ? e : "";
  if (/time ran out|timed out/i.test(msg)) return "timeout";
  if (/(^|[^\d-])(429|-32005)([^\d]|$)|too many requests|rate limit|refused .* for rate/i.test(msg)) return "rate";
  if (/ECONNRESET|ECONNREFUSED|ENOTFOUND|fetch failed|network/i.test(msg)) return "unreachable";
  return "other";
}
