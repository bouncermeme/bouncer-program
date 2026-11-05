import type { Metadata } from "next";
import { PAGE_META, pageMetadata } from "@/lib/seo";
import Link from "next/link";
import { Bullets, ContentPage, Section } from "@/components/content/ContentPage";
import { RecoveryDelay } from "@/components/content/RecoveryDelay";
import { CONTACT_EMAIL, OPERATED_BY } from "@/lib/site";
import { UPGRADE_AUTHORITY_SENTENCE } from "@/lib/bouncer/siteCluster";
import { V030 } from "@/lib/bouncer/v030";

export const metadata: Metadata = pageMetadata({ ...PAGE_META["/terms"], path: "/terms" });

/*
  Terms of Use, from docs/LEGAL-PAGES-DRAFT-2026-10-16.md section 1 (launch candidate,
  2026-10-22). The draft's [LAWYER] decisions (restricted locations, the liability cap,
  governing law and disputes) are left open; the page no longer says they are pending
  review (D8, tag T, 2026-11-02).
*/
export default function TermsPage() {
  return (
    <ContentPage title="Terms of Use" updated="4 November 2026" lead={<>Version 0.1. These terms are between you and Bouncer (&quot;we&quot;, &quot;us&quot;).</>}>
      <Section title="Agreeing to these terms">
        <p>
          By using bouncer.meme, or by signing any transaction through it, you agree to these terms, the <Link href="/privacy" className="link">Privacy Policy</Link>, the{" "}
          <Link href="/risk" className="link">Risk Disclosure</Link> and the <Link href="/fees" className="link">Fees</Link> page. If you do not agree, do not use the site.
        </p>
      </Section>

      <Section title="What Bouncer is">
        <p>
          Bouncer is a website for creating and bidding in token launches on Solana. Each launch is a sealed-bid auction run by a program on Solana (the &quot;Program&quot;). When an auction clears, the Program
          {/* T-5 (the founder, 2026-10-27), with v0.30. */}
          {V030 ? <>creates the token and a Meteora pool for it, locks the pool&apos;s liquidity, pays out every winner and then opens trading.</> : <>creates the token, opens a Meteora pool for it and locks the pool&apos;s liquidity.</>}
        </p>
        <p>The site builds transactions for you to check and sign in your own wallet. Once a transaction is confirmed it is on the blockchain, and nobody can reverse it.</p>
      </Section>

      <Section title="What Bouncer does not do">
        <Bullets
          items={[
            <><span className="text-text font-semibold">We do not hold your funds.</span> Deposits sit in the Program&apos;s vault, not in a wallet we control. We never see your keys or seed phrase.</>,
            <><span className="text-text font-semibold">We do not give advice.</span> Nothing on the site is investment, financial, legal or tax advice.</>,
            <><span className="text-text font-semibold">We do not vouch for tokens.</span> Creators make launches. We do not check creators or endorse any token, name or image.</>,
            <><span className="text-text font-semibold">We are not a broker, exchange or custodian.</span></>,
          ]}
        />
      </Section>

      <Section title="Who may use the site">
        <Bullets
          items={[
            <>You are 18 or older, or the age of majority where you live if that is higher.</>,
            <>You are not on a sanctions list (including OFAC, the UN, the EU and the UK), and not owned or controlled by someone who is.</>,
            <>Using the site is lawful where you are.</>,
            <>You do not use a VPN or proxy to get around these limits.</>,
          ]}
        />
      </Section>

      <Section title="How a launch works">
        <Bullets
          items={[
            <>The creator sets a name, ticker, image and window. The platform sets the floor, the minimum bid and the fees. A launch keeps the terms it was created with.</>,
            <>A bidder sends SOL and a sealed maximum market cap. The deposit is public; the maximum stays sealed until the window ends. One bid per wallet, and it cannot be changed or withdrawn.</>,
            <>At close the Program finds one clearing price and every winner pays it. The highest max bids fill first, so a max bid at or above the price does not guarantee tokens.</>,
            <>If deposits stay under the floor, the launch fails and every deposit can be taken back.</>,
            <>If no pool has been created by the recovery deadline (the end of the window plus <RecoveryDelay />), the launch fails and every deposit can be taken back.</>,
            /* T-7, with v0.30. */
            V030 ? (
              <>Once the pool has been created, the deadline no longer applies. A winning bid&apos;s SOL is in the pool and is not refunded: the winner is owed tokens and any unspent SOL. Losing bids get their deposit back. Trading opens only after every bid is paid out or refunded.</>
            ) : (
              <>Once the pool has opened, the deadline no longer applies. A winning bid&apos;s SOL is in the pool and is not refunded: the winner is owed tokens and any unspent SOL. Losing bids get their deposit back.</>
            ),
            <>The creator gets no tokens unless they bid like anyone else, at the same price. A creator&apos;s bid is labeled.</>,
          ]}
        />
        <p>
          The <Link href="/guide" className="link">Guide</Link> explains each step.
        </p>
      </Section>

      <Section title="Fees">
        <p>
          The <Link href="/fees" className="link">Fees</Link> page is part of these terms. A launch pays the fees in force when it was created. You also pay Solana network fees and account rent, which go to
          the network, not to us.
        </p>
      </Section>

      <Section title="If you create a launch">
        <Bullets
          items={[
            <>You have the right to use the name, ticker and image, and they do not infringe anyone&apos;s rights.</>,
            <>Your launch is not a scam or an impersonation, and does not mislead buyers.</>,
            <>You will not call your token an investment, promise returns, or say Bouncer backs it.</>,
            <>You follow every law that applies to you and your token.</>,
          ]}
        />
        <p>Your share of the launch fee and your trading earnings are paid by the Program and by Meteora&apos;s program, not by us.</p>
      </Section>

      <Section title="What you may not do">
        <Bullets
          items={[
            <>Break any law or sanctions rule, or help someone else do so.</>,
            <>Manipulate a market, including wash trading and pump-and-dump schemes.</>,
            <>Launch a token that impersonates a person, project or brand, or infringes someone&apos;s rights.</>,
            <>Post or link to illegal, hateful or harassing content.</>,
            <>Attack, overload or try to break the site, or get around a limit we set.</>,
          ]}
        />
      </Section>

      <Section title="What we can do on the site">
        <p>We can hide a launch, name or image from the site, block access for any person, wallet or location, and change, pause or stop any part of the site.</p>
        <p>Hiding something on the site changes nothing on the blockchain. {V030 ? "Bids already placed are still paid out or refunded through the Program." : "Bids already placed can still be claimed or refunded through the Program."}</p>
      </Section>

      <Section title="The Program and other services">
        <p>{UPGRADE_AUTHORITY_SENTENCE} An upgrade can change how the Program works.</p>
        <p>
          Pools run on Meteora&apos;s program, which Meteora controls and can upgrade or pause. The site also relies on Solana RPC providers, your wallet, the drand randomness network and Cloudflare. We do not
          control them.
        </p>
      </Section>

      <Section title="Risk, warranties and liability">
        <p>
          You can lose everything you put in. Read the <Link href="/risk" className="link">Risk Disclosure</Link>. The site and the Program are provided &quot;as is&quot;, with no promise that they work, stay
          available or are free of bugs.
        </p>
      </Section>

      <Section title="Changes">
        <p>We may change these terms and will post the new version with a new date. A launch already created keeps its fees.</p>
      </Section>

      <Section title="Contact">
        <p>
          {OPERATED_BY}. Write to{" "}
          <a href={`mailto:${CONTACT_EMAIL}`} className="link">
            {CONTACT_EMAIL}
          </a>
          .
        </p>
      </Section>
    </ContentPage>
  );
}
