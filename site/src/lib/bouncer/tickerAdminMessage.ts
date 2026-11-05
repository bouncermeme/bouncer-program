/*
  The admin ticker release's signed message (docs/TICKER-RELEASE-DESIGN-2026-10-24.md), shared by the server's check
  (server/tickerAdmin.ts, which reads it back exactly), the CLI (scripts/ticker-release.ts) and the admin page
  (app/admin/tickers, 2026-10-25: the founder's phone wallet signs it with signMessage). One line of printable ASCII, fields
  separated by "; ", so a Ledger shows it as text.
*/
export const ADMIN_MESSAGE_SECS = 300;
export const SEP = "; ";
export const HEAD = { release: "bouncer admin: release a ticker hold", look: "bouncer admin: look at a ticker" } as const;

export interface AdminMessage {
  action: "release" | "look";
  admin: string;
  ticker: string;
  key: string;
  launch: string | null;
  why: string | null;
  host: string;
  cluster: string;
  nonce: string;
  issuedAt: number;
  expiresAt: number;
}

export function adminMessage(m: AdminMessage): string {
  return [
    HEAD[m.action],
    `Admin: ${m.admin}`,
    `Ticker: ${m.ticker}`,
    `Ticker key: ${m.key}`,
    ...(m.action === "release" ? [`Launch: ${m.launch}`, `Why: ${m.why}`] : []),
    `URI: https://${m.host}`,
    `Chain ID: ${m.cluster}`,
    `Nonce: ${m.nonce}`,
    `Issued At: ${new Date(m.issuedAt * 1000).toISOString()}`,
    `Expiration Time: ${new Date(m.expiresAt * 1000).toISOString()}`,
  ].join(SEP);
}

/* A message's nonce: 16 random bytes in base64url, 22 characters (the server's NONCE_RE). Web Crypto, so the page and node both have it. */
export function adminNonce(): string {
  const b = new Uint8Array(16);
  globalThis.crypto.getRandomValues(b);
  return btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
