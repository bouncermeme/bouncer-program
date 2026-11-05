/*
  The admin's same-name notice control (v0.30 item 8, the founder 2026-10-27, review/2026-10-27-v030/FOUNDER-UI-DECISIONS.md:
  8C, a hidden notice is hidden entirely). Its signed message, shared by the server's check (server/namesAdmin.ts,
  which reads it back exactly) and the admin page (app/admin/names). The same form as the ticker release's
  (tickerAdminMessage.ts): one line of printable ASCII, fields joined by "; ", so a Ledger shows it as text. The first
  field names the action, and no action here shares a first field with the ticker release, so a signature for one is
  never read as the other.

    bouncer admin: hide a same-name notice        (or: show a same-name notice again; or: look at same-name notices)
    Admin: <wallet>
    Launch: <the launch whose notice changes>     (hide and show)
    Other: <the launch it stops or starts naming> (hide and show)
    Why: <1 to 120 printable ASCII characters, no ";", no space at either end>   (hide only)
    URI: https://<host>
    Chain ID: <cluster>
    Nonce: <22 base64url characters>
    Issued At: <ISO time>
    Expiration Time: <ISO time, at most ADMIN_MESSAGE_SECS after Issued At>

  A hidden pair is one direction: "Launch" stops naming "Other" in its notice. The other launch's own notice, and a
  third launch with the name, are unchanged (the approved mock, mocks-ui/README.md section 8).
*/
import { SEP } from "./tickerAdminMessage";

export { ADMIN_MESSAGE_SECS, adminNonce, SEP } from "./tickerAdminMessage";

export const NAMES_HEAD = { hide: "bouncer admin: hide a same-name notice", show: "bouncer admin: show a same-name notice again", look: "bouncer admin: look at same-name notices" } as const;
export type NamesAction = keyof typeof NAMES_HEAD;

/* Printable ASCII without ";" (the field separator), no space at either end: the ticker release's reason rule. */
export const NAMES_WHY_RE = /^[\x21-\x3a\x3c-\x7e](?:[\x20-\x3a\x3c-\x7e]{0,118}[\x21-\x3a\x3c-\x7e])?$/;

export interface NamesMessage {
  action: NamesAction;
  admin: string;
  launch: string | null;
  other: string | null;
  why: string | null;
  host: string;
  cluster: string;
  nonce: string;
  issuedAt: number;
  expiresAt: number;
}

export function namesMessage(m: NamesMessage): string {
  return [
    NAMES_HEAD[m.action],
    `Admin: ${m.admin}`,
    ...(m.action !== "look" ? [`Launch: ${m.launch}`, `Other: ${m.other}`] : []),
    ...(m.action === "hide" ? [`Why: ${m.why}`] : []),
    `URI: https://${m.host}`,
    `Chain ID: ${m.cluster}`,
    `Nonce: ${m.nonce}`,
    `Issued At: ${new Date(m.issuedAt * 1000).toISOString()}`,
    `Expiration Time: ${new Date(m.expiresAt * 1000).toISOString()}`,
  ].join(SEP);
}

/* One hidden direction: the launch whose notice no longer names the other. */
export const hiddenPair = (launch: string, other: string): string => `${launch}>${other}`;
