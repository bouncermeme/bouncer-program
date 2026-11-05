import type { Metadata } from "next";
import { PAGE_META, pageMetadata } from "@/lib/seo";
import Link from "next/link";
import { Bullets, ContentPage, Section } from "@/components/content/ContentPage";
import { CONTACT_EMAIL, OPERATED_BY } from "@/lib/site";

export const metadata: Metadata = pageMetadata({ ...PAGE_META["/privacy"], path: "/privacy" });

/*
  Privacy Policy, from docs/LEGAL-PAGES-DRAFT-2026-10-16.md section 2, with every row
  stated as the site does it at the launch candidate (2026-10-22): the attestation
  service's counters keep a hash of the address (server/attest.ts hashOf), a permit is
  kept until it expires (ATTEST_LIFE_SECS), the per-client limits in rateLimit.ts and
  the Upstash counters hash the address too, the cookies are bouncer_access and (23c)
  bouncer_creator (server/session.ts), no analytics script is loaded. Third parties the
  browser talks to: the wallet, Cloudflare Turnstile, the Solana RPC, drand, and on the
  trade page Dexscreener and Jupiter's plugin (Bubblemaps is a link out since B7). Turnstile's Invisible mode
  requires this page to name Cloudflare's Turnstile Privacy Addendum (2026-10-24).
*/
const TURNSTILE_PRIVACY_URL = "https://www.cloudflare.com/turnstile-privacy-policy/";
export default function PrivacyPage() {
  return (
    <ContentPage title="Privacy Policy" updated="4 November 2026" lead="Version 0.1. Bouncer has no accounts. We never ask for your name, email, phone or ID.">
      <Section title="Who is responsible">
        <p>
          {OPERATED_BY}. Write to{" "}
          <a href={`mailto:${CONTACT_EMAIL}`} className="link">
            {CONTACT_EMAIL}
          </a>
          .
        </p>
      </Section>

      <Section title="What we see">
        <Bullets
          items={[
            <><span className="text-text font-semibold">Your wallet address.</span> Your browser uses it to build transactions and show your bids. It is public on Solana.</>,
            <>
              <span className="text-text font-semibold">Permit requests.</span> Before a bid or a create, the site asks our permit service for a signed permit. The service sees the wallet, the launch and, for a
              create, the launch&apos;s settings. It never sees your maximum or your deposit. A permit is kept for about 10 minutes, until it expires. The site keeps a list of the launches created through it.
            </>,
            <>
              <span className="text-text font-semibold">Your network address.</span> Limits on requests count per address, for windows of one minute to one day. The counters store a hash of the address, never the
              address itself.
            </>,
            <>
              <span className="text-text font-semibold">Creator sign-in.</span> Before a create, your wallet signs one message (not a transaction). We keep the wallet and a one-time code for 5 minutes,
              then a cookie for 24 hours. A ticker you reserve is recorded with your wallet and the launch&apos;s address, and that record is kept indefinitely.
              A launch you start but never create counts against your wallet for 24 hours; two in a day pause launches from that wallet for 1 hour.
            </>,
            <><span className="text-text font-semibold">Hosting logs.</span> Vercel hosts the site and logs requests (address, browser, time) to serve pages and stop abuse.</>,
            <><span className="text-text font-semibold">Token images.</span> An image a creator uploads is stored with its launch and is public.</>,
            <><span className="text-text font-semibold">On-chain activity.</span> Every bid, launch and transaction is public and permanent on Solana. We cannot change or delete it.</>,
          ]}
        />
        <p>We do not run analytics or advertising, and we do not sell data.</p>
      </Section>

      <Section title="Services your browser talks to">
        <Bullets
          items={[
            <>Your wallet, under its own privacy policy.</>,
            <>
              Cloudflare Turnstile, the check before a bid or a create. Cloudflare sees your address and browser signals. Its use is covered by Cloudflare&apos;s{" "}
              <a href={TURNSTILE_PRIVACY_URL} className="link" target="_blank" rel="noopener noreferrer">
                Turnstile Privacy Addendum
              </a>
              .
            </>,
            <>A Solana RPC provider, directly or through our server route, to read the chain and send transactions.</>,
            <>The drand network, to seal and open maximums.</>,
            <>On a token&apos;s trade page: Dexscreener (the chart) and Jupiter (the swap form). Each may set its own cookies. The Bubblemaps link opens their own site.</>,
          ]}
        />
      </Section>

      <Section title="Our public channels">
        <p>Bouncer posts launch activity from the public chain to its channels on Telegram and X. A post can include a token&apos;s name, its market cap and amounts raised.</p>
      </Section>

      <Section title="Cookies and browser storage">
        <p>
          Two cookies: one after you open an access link, one after you sign in to create. A few settings in your browser&apos;s storage. The <Link href="/cookies" className="link">Cookies</Link> page lists each one.
        </p>
      </Section>

      <Section title="Your choices">
        <p>
          You can use the site without giving us anything beyond what your browser sends to load a page. You can clear browser storage at any time. To ask about data we hold, write to{" "}
          <a href={`mailto:${CONTACT_EMAIL}`} className="link">
            {CONTACT_EMAIL}
          </a>
          .
        </p>
      </Section>

      <Section title="Children">
        <p>The site is not for anyone under 18.</p>
      </Section>

      <Section title="Changes">
        <p>We will post changes here with a new date.</p>
      </Section>
    </ContentPage>
  );
}
