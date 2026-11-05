import type { Metadata } from "next";
import { PAGE_META, pageMetadata } from "@/lib/seo";
import Link from "next/link";
import type { ReactNode } from "react";
import { ContentPage, Section } from "@/components/content/ContentPage";
import { RecoveryDelay } from "@/components/content/RecoveryDelay";
import { CONTACT_EMAIL } from "@/lib/site";
import { UPGRADE_AUTHORITY_SENTENCE } from "@/lib/bouncer/siteCluster";
import { V030 } from "@/lib/bouncer/v030";

export const metadata: Metadata = pageMetadata({ ...PAGE_META["/risk"], path: "/risk" });

/* Risk Disclosure, from docs/LEGAL-PAGES-DRAFT-2026-10-16.md section 3 (launch candidate, 2026-10-22). */
const RISKS: [string, ReactNode][] = [
  ["Crypto is risky.", <>Tokens and SOL can lose most or all of their value, fast. Most new tokens fail. A fair start does not protect you from what happens after.</>],
  ["No guarantees.", <>Nothing on the site is a price floor or a promise of value. {V030 ? <>The pool is created at the clearing price less the launch fee, with rounding. Trading opens when everyone is paid; after that the market sets the price.</> : <>The pool opens at the clearing price less the launch fee&apos;s share, with rounding; after that the market sets the price.</>}</>],
  ["Not financial advice.", <>Nothing on the site is investment, financial, legal or tax advice. Decide for yourself, or ask your own adviser.</>],
  ["Transactions are irreversible.", <>A confirmed transaction cannot be undone, by you or by us. Your bid is final: one per wallet, no changes, no withdrawal while the auction runs.</>],
  ["A high maximum does not guarantee tokens.", <>Every winner pays the same price, but the highest max bids fill first. You may get all, some or none of what you bid for.</>],
  ["Smart contracts can fail.", <>The Program could have bugs that lose funds. It has been reviewed, not formally audited. Its source opens after the first live launch. {UPGRADE_AUTHORITY_SENTENCE} An upgrade can change how it works.</>],
  ["Meteora runs the pool.", <>The pool, its locked liquidity and the trading fees run on Meteora&apos;s program. Meteora can upgrade it, and its operator can pause a pool. &quot;Locked&quot; means locked under Meteora&apos;s rules.</>],
  ["Sealed bids depend on drand.", <>Maximums are sealed to a public randomness network Bouncer does not run. If it published early, maximums could be read before close; if it never published, the launch would fail and refund.</>],
  ["Steps after the auction.", V030 ? (
      <>Opening bids, creating the pool, paying out and opening trading are separate transactions. If no pool has been created by the recovery deadline (the end of the window plus <RecoveryDelay />), the launch fails and you may need to take your deposit back yourself. Once the pool has been created, a winning bid&apos;s SOL is in the pool and is not refunded, even if delivery is late: you are owed tokens and any unspent SOL. If a delivery stalls, anyone, you included, can send it from the launch page. If a payout ever cannot go through, Bouncer&apos;s multisig can open trading before everyone is paid; the program records it on chain.</>
    ) : (
      <>Opening bids, opening the pool and paying out are separate transactions. If no pool has opened by the recovery deadline (the end of the window plus <RecoveryDelay />), the launch fails and you may need to take your deposit back yourself. Once the pool has opened, a winning bid&apos;s SOL is in the pool and is not refunded, even if delivery is late: you are owed tokens and any unspent SOL, and may need to claim them yourself.</>
    )],
  ["Your maximum is in SOL.", <>SOL&apos;s dollar price moves while the auction runs.</>],
  ["Large winners can sell.", <>A large winner paid the same price as you and can sell at any time. Check the largest allocation on the results page.</>],
  ["Your wallet is yours to keep safe.", <>If you lose your keys or sign a malicious transaction, nobody can recover your funds.</>],
  ["Law and tax.", <>Rules on tokens differ by place and change. Your taxes and your compliance are yours.</>],
];

export default function RiskPage() {
  return (
    <ContentPage title="Risk Disclosure" updated="22 October 2026" lead="Read this before you bid or create. You can lose everything you put in.">
      <Section title="The risks">
        <ul className="flex flex-col gap-3">
          {RISKS.map(([lead, rest]) => (
            <li key={lead}>
              <span className="text-text font-semibold">{lead}</span> {rest}
            </li>
          ))}
        </ul>
      </Section>

      <Section title="Costs">
        <p>
          Creating a launch includes Solana account rent that is never returned. See <Link href="/fees" className="link">Fees</Link>.
        </p>
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
