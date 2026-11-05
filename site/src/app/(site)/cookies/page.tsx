import type { Metadata } from "next";
import { PAGE_META, pageMetadata } from "@/lib/seo";
import Link from "next/link";
import type { ReactNode } from "react";
import { ContentPage, Section } from "@/components/content/ContentPage";
import { CONTACT_EMAIL } from "@/lib/site";
import { QUICK_GUIDE_KEY, STORAGE_NOTICE_KEY } from "@/components/shell/storageNoticeKey";

export const metadata: Metadata = pageMetadata({ ...PAGE_META["/cookies"], path: "/cookies" });

/*
  Every cookie and storage item, as measured on the live site and read from the
  source on 2026-10-22 (the e2e test's storage probe): one cookie (bouncer_access,
  src/proxy.ts; since 23c also bouncer_creator, server/session.ts), the wallet adapter's walletName, the site's own bouncer:* keys, no
  sessionStorage, and Turnstile's frame. The dev and rehearsal keys exist only on
  test builds and are listed as such. A new item in the code belongs here too.
*/
const COOKIES: [string, ReactNode, string][] = [
  ["bouncer_access", <>Lets you into the site while it shows &quot;launching soon&quot;. Set only after you open an access link. Holds a hash of the key, never the key. HttpOnly, Secure.</>, "400 days"],
  ["bouncer_creator", <>Shows you signed in with your wallet to create a launch. Set only after you sign in. Holds your wallet address and a signature from us. HttpOnly, Secure, SameSite=Strict.</>, "24 hours"],
];
/* Turnstile's Invisible mode requires the policy to name Cloudflare's Turnstile Privacy Addendum (2026-10-24). */
const TURNSTILE_PRIVACY_URL = "https://www.cloudflare.com/turnstile-privacy-policy/";

const LOCAL: [string, ReactNode][] = [
  ["walletName", <>The wallet you last connected, so the site can reconnect it. Set by the wallet library when you connect.</>],
  ["bouncer:quick:<wallet>", <>Your saved quick bid amounts.</>],
  ["bouncer:board-sort", <>The order you picked for the Closed launches list.</>],
  ["bouncer:create-salt:v1:<creator>", <>A number that names the launch you are creating, kept until the create lands so a retry creates the same launch.</>],
  [STORAGE_NOTICE_KEY, <>That you closed the storage notice.</>],
  [QUICK_GUIDE_KEY, <>That you have seen the quick guide, so it does not open by itself again. The (i) button still opens it.</>],
  ["bouncer:dev-key, bouncer:dev-reject, bouncer:dev-delay-ms", <>Test builds only (dev-only): a test wallet for development. Never used on the live site.</>],
];

export default function CookiesPage() {
  return (
    <ContentPage title="Cookies and storage" updated="24 October 2026" lead="Two cookies, a few settings in your browser, no tracking.">
      <Section title="Cookies">
        <Table head={["Name", "What it does", "Lasts"]} rows={COOKIES.map(([n, w, l]) => [<code key="n">{n}</code>, w, l])} />
      </Section>

      <Section title="Browser storage (localStorage)">
        <p>Kept in your browser only. Nothing here is sent to us.</p>
        <Table head={["Key", "What it does"]} rows={LOCAL.map(([n, w]) => [<code key="n">{n}</code>, w])} />
        <p>sessionStorage is unused.</p>
      </Section>

      <Section title="Cloudflare Turnstile">
        <p>
          The check before a bid or a create runs in a frame served by Cloudflare (challenges.cloudflare.com). It sets no cookie on bouncer.meme; the frame keeps its own state under Cloudflare&apos;s rules.
          See Cloudflare&apos;s{" "}
          <a href={TURNSTILE_PRIVACY_URL} className="link" target="_blank" rel="noopener noreferrer">
            Turnstile Privacy Addendum
          </a>
          .
        </p>
      </Section>

      <Section title="Other sites">
        <p>
          A token&apos;s trade page embeds Dexscreener and Jupiter, which may set their own cookies. See the <Link href="/privacy" className="link">Privacy Policy</Link>.
        </p>
      </Section>

      <Section title="No analytics, no ads">
        <p>The site loads no analytics or advertising script. Clearing your browser&apos;s site data removes everything above.</p>
      </Section>

      <Section title="Contact">
        <p>
          <a href={`mailto:${CONTACT_EMAIL}`} className="link">
            {CONTACT_EMAIL}
          </a>
        </p>
      </Section>
    </ContentPage>
  );
}

function Table({ head, rows }: { head: string[]; rows: ReactNode[][] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left border-collapse">
        <thead>
          <tr className="text-text">
            {head.map((h) => (
              <th key={h} className="font-semibold py-2 pr-4 border-b border-line align-top">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              {r.map((c, j) => (
                <td key={j} className="py-2 pr-4 border-b border-line align-top break-words">
                  {c}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
