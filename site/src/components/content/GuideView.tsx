"use client";

/*
  The user guide (launch candidate, 2026-10-22): creators and bidders, from
  create to claim. Every figure is the program's: the live config through
  useConfigLive, the pinned config for this cluster (PRODUCT) until the first
  read lands, the window and beacon constants, and the rents from the cluster
  (useSetupCost). Nothing here is a number typed by hand where the program has
  one, so a mainnet build reads mainnet's floor and devnet its own.

  The copy-fix batch (2026-10-31, approved; review/2026-10-31-copy-fixes; docs/marketing/USER-GUIDE.md "For editors",
  G1 to G14): the screens' own words for the image and ticker rules, the copycat rule, sign-in, Collect, trading,
  creator fees, Next step, the bid labels, finding a launch, the creator panel, fees and the scam warning.
  scripts/check-copy-fixes.ts holds each line to the screen it quotes.
*/
import Link from "next/link";
import { BRAND } from "@/lib/brand";
import { ContentPage, Section, Bullets } from "./ContentPage";
import { solExact } from "@/lib/bouncer/amountInput";
import { fmtSol } from "@/lib/bouncer/format";
import { revealDelayText } from "@/lib/bouncer/beacon";
import { useConfigLive, useSetupCost } from "@/lib/bouncer/hooks";
import { bpsPct, fmtVolumePct, GENESIS_OTHER_LAMPORTS, PRODUCT, tradingFeeSplit } from "@/lib/bouncer/product";
import { WINDOW_MAX_SECS, WINDOW_MIN_SECS } from "@/lib/bouncer/view";
import { BEACON, BOUNDS, FLOAT, TOKEN_DECIMALS } from "@contract/constants";
import { durationText } from "./durations";
import { MeteoraSplitInfo } from "@/components/ui/MeteoraSplitInfo";
import { HeldPayoutInfo } from "@/components/ui/HeldPayoutInfo";
import { V030 } from "@/lib/bouncer/v030";

const HALF_MILLIONS = Number(FLOAT / 10n ** BigInt(TOKEN_DECIMALS)) / 1e6;

export function GuideView() {
  const { config } = useConfigLive();
  const setup = useSetupCost();
  const floor = config?.floorValue ?? PRODUCT.floorValue;
  const minBid = config?.minBid ?? PRODUCT.minBid;
  const raiseFeeBps = config?.raiseFeeBps ?? PRODUCT.raiseFeeBps;
  const creatorShareBps = config?.raiseFeeCreatorShareBps ?? PRODUCT.raiseFeeCreatorShareBps;
  const crankBond = config?.crankBond ?? PRODUCT.crankBond;
  const abortAfter = Number(config?.abortAfterSecs ?? PRODUCT.abortAfterSecs);
  const split = tradingFeeSplit(config?.creatorLpBps ?? PRODUCT.creatorLpBps);
  const reward = BigInt(BOUNDS.deliveryRewardLamports);
  const fee = bpsPct(raiseFeeBps);
  const creatorRaise = bpsPct((raiseFeeBps * creatorShareBps) / 10_000);
  const bouncerRaise = bpsPct((raiseFeeBps * (10_000 - creatorShareBps)) / 10_000);
  const minWin = Math.round(WINDOW_MIN_SECS / 60);
  const maxWin = Math.round(WINDOW_MAX_SECS / 60);
  const half = `${HALF_MILLIONS} million`;

  return (
    <ContentPage title="Guide" lead={`Creating and bidding on ${BRAND.name}, step by step.`}>
      <nav className="mt-6 flex flex-wrap gap-x-5 gap-y-2" aria-label="On this page">
        {[
          ["#find", "Find"],
          ["#create", "Create"],
          ["#bid", "Bid"],
          ["#close", "At close"],
          ["#results", "Results"],
          ["#tokens", "Tokens and refunds"],
          ["#collect", "Collect"],
          ["#trade", "Trading"],
          ["#fees", "Fees"],
          ["#cost", "Launch cost"],
          ["#scams", "Scams"],
        ].map(([href, label]) => (
          <a key={href} href={href} className="link inline-flex items-center min-h-11">
            {label}
          </a>
        ))}
      </nav>

      {/* G10, G11 */}
      <Section title="Find a launch" id="find">
        <Bullets
          items={[
            <>The home page lists Live now, Recently cleared, Did not clear and No bids. Search by ticker, name or address.</>,
            <>A launch page shows the creator&apos;s wallet, its first transaction and its other launches. If the ticker failed before, it says: &ldquo;Check the creator before you bid.&rdquo;</>,
          ]}
        />
      </Section>

      <Section title="Create a launch" id="create">
        <p>Four fields: name, ticker, image, window. Everything else is the same for every launch.</p>
        <Bullets
          items={[
            /* G1, G2 */
            <>Name up to {PRODUCT.maxNameBytes} bytes. Ticker 1 to {PRODUCT.maxSymbolBytes} characters, A to Z or 0 to 9. Image: PNG, JPEG or WebP, under 20 MB, at least 64 px a side, cropped to a square.</>,
            /* G3 */
            <>A ticker that is live, trading, paying out or being created is taken, and so are its lookalikes. BOUNCER is reserved.</>,
            <>One launch being created per wallet at a time. If your last launches never went live, wait an hour.</>,
            <>A window from {minWin} to {maxWin} minutes. It is fixed: nobody can close it early or extend it.</>,
            /* G4 */
            <>Sign in first: one signature, no transaction, no fee, good for 24 hours. Then a bot check, and your wallet signs once. The launch opens in the same transaction.</>,
            <>You get no tokens for free. You can bid in your own launch like anyone else; your bid is labeled as the creator&apos;s.</>,
            /* G7 */
            <>You earn {creatorRaise} of the raise and {fmtVolumePct(split.creatorPct)} of all trading volume. Collect it on the trade page, under Your trading fees.</>,
          ]}
        />
      </Section>

      {/* G9, G14: "Your bid" is the field, the SOL you send; the deposit is what goes into the auction. */}
      <Section title="Bid" id="bid">
        <p>A bid is two numbers: Your bid, the SOL you send, and at up to a market cap of, your max. No limit: you pay whatever it clears at.</p>
        <Bullets
          items={[
            <>The least you can deposit is <span className="num">{solExact(minBid)}</span>.</>,
            <>Your max is rounded down to a step; the page shows the value it seals.</>,
            <>Your deposit is public. Your max is sealed: it is encrypted to a drand beacon round that is published after the window ends. Nobody can read it before then, {BRAND.name} included.</>,
            <>Verify commitment shows the launch&apos;s full terms before you sign.</>,
            <>In the final 90 seconds a priority fee is added, so your bid lands before the close.</>,
            <>One bid per wallet per launch. A bid cannot be changed, topped up or withdrawn while the window is open.</>,
            <>Your SOL sits in the program&apos;s vault for this launch, not with {BRAND.name}.</>,
          ]}
        />
      </Section>

      <Section title="What happens at close" id="close">
        <Bullets
          items={[
            <>The window ends on time.<span className="block">Needs <span className="num">{fmtSol(floor)}</span> by close, or all refundable.</span></>,
            <>About {revealDelayText(config?.revealMarginSecs ?? BEACON.revealMarginSecs)} later the beacon round is published, and every bid opens at once. Nobody has to be online.</>,
            <>The program finds one clearing market cap: the highest one at which the opened bids buy all {half} tokens for sale.</>,
          ]}
        />
      </Section>

      <Section title="Results" id="results">
        <Bullets
          items={[
            <>Everyone who gets in pays the same clearing market cap, whatever their max.</>,
            <>The highest max bids fill first and spend their whole deposit.</>,
            <>Bids right at the cutoff share what is left in proportion to their deposits, and get the rest of their deposit back.</>,
            <>Bids below the cutoff get their whole deposit back. A max equal to the clearing price can still be below the cutoff when higher max bids buy every token first.</>,
            /* Content sweep G-1 (the founder, 2026-10-27), with v0.30. */
            V030 ? (
              <>The pool is created on Meteora with the raise (less the {fee} launch fee) and the other {half} tokens. The liquidity is locked forever. <MeteoraSplitInfo voice="reader" /> Trading opens when everyone is paid. Each launch&apos;s results page shows the price, the fills and the working.</>
            ) : (
              <>The pool opens on Meteora with the raise (less the {fee} launch fee) and the other {half} tokens. The liquidity is locked forever. <MeteoraSplitInfo voice="reader" /> Each launch&apos;s results page shows the price, the fills and the working.</>
            ),
          ]}
        />
      </Section>

      <Section title="Tokens and refunds" id="tokens">
        <Bullets
          items={[
            /* G-2, G-3 (deleted) and G-4 with v0.30: every winner is pushed. */
            ...(V030
              ? [
                  <>Winners&apos; tokens are sent to their wallets, nothing to claim. Trading opens when everyone is paid. <HeldPayoutInfo /> Refunds go back the same way.</>,
                  <>When the keeper delivers your tokens, it is repaid <span className="num">{fmtSol(reward)}</span> plus the rent of your new token account, out of your bid account&apos;s rent. You keep the token account.</>,
                ]
              : [
                  <>The keeper delivers tokens and refunds a few minutes after the pool opens. Nothing to do.</>,
                  <>Or claim yourself on the launch page, any time, with one signature. Claiming is always available.</>,
                  <>When the keeper delivers your tokens, it is repaid <span className="num">{fmtSol(reward)}</span> plus the rent of your new token account, out of your bid account&apos;s rent. You keep the token account. A claim pays nothing to anyone.</>,
                ]),
            /* G8 */
            <>If your refund has not arrived, your bid card shows Refund: press it.</>,
            <>{BRAND.name}&apos;s keeper runs every step after the close. Any wallet can run one sooner, under Next step on the launch page.</>,
            <>
              The recovery deadline: if no pool has been created by the end of the window plus {durationText(abortAfter)}, anyone can end the launch and every deposit comes back in full.
            </>,
          ]}
        />
      </Section>

      {/* G5 */}
      <Section title="Held payouts: Collect" id="collect">
        <Bullets
          items={[
            <>Rarely, a winner&apos;s tokens or a refund can&apos;t be delivered. It is held for you in the program, and trading doesn&apos;t wait.</>,
            <>Connect the wallet you bid from and press Collect on the launch or trade page. One signature. Only that wallet can collect it, and there is no deadline.</>,
          ]}
        />
      </Section>

      {/* G6 */}
      <Section title="Trading" id="trade">
        <Bullets
          items={[
            <>When everyone is paid, Trade opens the trade page: the chart, Jupiter&apos;s swap (your wallet signs each swap) and Open settlement, with every bid and its result.</>,
            <>It also shows which winners were funded from the same source as the creator. Evidence, not a verdict.</>,
          ]}
        />
      </Section>

      {/* G13 */}
      <Section title="Fees" id="fees">
        <Bullets
          items={[
            <>Bidders: {config ? <span className="num">{solExact(config.processingCharge)}</span> : "a"} processing charge and the network fee. Refunds are free.</>,
            <>Every launch: {fee} of the raise, {creatorRaise} to the creator and {bouncerRaise} to {BRAND.name}.</>,
            <>Every trade: the pool&apos;s {fmtVolumePct(split.creatorPct + split.bouncerPct + split.meteoraPct)} fee. {fmtVolumePct(split.creatorPct)} of volume to the creator, {fmtVolumePct(split.bouncerPct)} to {BRAND.name}, {fmtVolumePct(split.meteoraPct)} to Meteora.</>,
            <>
              Every fee: <Link href="/fees" className="link">Fees and terms</Link>.
            </>,
          ]}
        />
      </Section>

      <Section title="What a launch costs the creator" id="cost">
        {setup ? (
          <p>
            About <span className="num">{fmtSol(crankBond + setup.total + GENESIS_OTHER_LAMPORTS)}</span> to start. Of it, <span className="num">{fmtSol(setup.total)}</span> is rent for the launch&apos;s accounts, kept on chain for good. <span className="num">{fmtSol(crankBond)}</span> is a prepay for the steps after the window; what they do not spend comes back to you when the liquidity is locked, or when the launch fails or is aborted. Your wallet shows the exact total before you sign.
          </p>
        ) : (
          <p>
            Rent for the launch&apos;s accounts, kept on chain for good, plus a <span className="num">{fmtSol(crankBond)}</span> prepay for the steps after the window. What the steps do not spend comes back to you. Your wallet shows the exact total before you sign.
          </p>
        )}
      </Section>

      {/* G12: the plan's E.4 warning. */}
      <Section title="Avoid scams" id="scams">
        <Bullets
          items={[
            <>Nobody from {BRAND.name} will DM you first or ask for your seed phrase, private key or funds.</>,
            <>The only site is {BRAND.domain}. Check a token&apos;s full mint address on its launch page, not its name or picture.</>,
            <>Nobody can release held tokens for you. Only Collect, from your own wallet.</>,
          ]}
        />
      </Section>
    </ContentPage>
  );
}
