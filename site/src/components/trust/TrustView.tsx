/*
  /trust (22e3, the founder 2026-10-23; review/2026-10-23-additions/PLAN.md section 2): what runs Bouncer, and who can
  change it. Short rows, numbers over prose. Nothing is typed here: the program, its build, the devnet upgrade
  authority, the treasury (v0.30: Config.treasury; U-3), the fee vault and the fee split come from the pin (contract/active.ts); what the pin
  cannot hold yet comes from lib/trustFacts.ts. The render follows the pinned cluster: on mainnet the upgrade row is
  the Squads multisig with its time lock and the keepers are listed at launch; on devnet the one key and the devnet
  keepers, with the mainnet plan beside them.
*/
import type { ReactNode } from "react";
import { DEPLOYMENT, ON_MAINNET_PIN } from "@contract/active";
import { BOUNDS } from "@contract/constants";
import { feeVaultPda } from "@/lib/bouncer/chain/pda";
import { bpsPct, fmtSharePct, fmtVolumePct, platformSplit, tradingFeeSplit } from "@/lib/bouncer/product";
import { V030 } from "@/lib/bouncer/v030";
import { BRAND } from "@/lib/brand";
import { DEVNET_KEEPERS, MAINNET_SETTINGS_SQUAD, MAINNET_TREASURY, MAINNET_UPGRADE_SQUAD, REVIEW_SEATS } from "@/lib/trustFacts";
import { OFFICIAL } from "@/lib/site";

const short = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`;

function Row({ k, v, sub }: { k: string; v: ReactNode; sub?: ReactNode }) {
  return (
    <div className="grid grid-cols-[8.5rem_1fr] md:grid-cols-[12rem_1fr] gap-3 items-baseline py-2.5 border-b border-line last:border-b-0">
      <dt className="text-text-3">{k}</dt>
      <dd className="min-w-0">
        <div className="text-text leading-snug wrap-any">{v}</div>
        {sub && <div className="text-text-3 leading-snug mt-0.5 wrap-any">{sub}</div>}
      </dd>
    </div>
  );
}
const Addr = ({ a }: { a: string }) => (
  <span className="mono" title={a} data-address={a}>
    {short(a)}
  </span>
);
const Ok = ({ children }: { children: ReactNode }) => (
  <span className="inline-flex items-center gap-1.5">
    <span className="w-2 h-2 rounded-full bg-good inline-block" aria-hidden="true" />
    {children}
  </span>
);
const Wait = ({ children }: { children: ReactNode }) => (
  <span className="inline-flex items-center gap-1.5">
    <span className="w-2 h-2 rounded-full bg-text-3 inline-block" aria-hidden="true" />
    {children}
  </span>
);

export function TrustView({ mainnet = ON_MAINNET_PIN }: { mainnet?: boolean }) {
  const d = DEPLOYMENT;
  const c = d.config;
  /* v0.30: the raise fee, the creator's share of it and the creator's LP share are program constants (TermsPinned 6092), read from the pin. */
  const raiseFeeBps = BOUNDS.raiseFeeBps;
  const share = BOUNDS.raiseFeeCreatorShareBps;
  const split = tradingFeeSplit(BOUNDS.creatorLpBps);
  const bouncerRaise = bpsPct((raiseFeeBps * (10_000 - share)) / 10_000);
  const creatorRaise = bpsPct((raiseFeeBps * share) / 10_000);
  /* U-3 (the founder, 2026-10-27): the treasury is Config.treasury (the Ledger, FOUNDER-DECISIONS) once a 0.30 deployment is recorded; until then the decided address. The fee vault, lp_owner's role since 0.30, is its own row. */
  const treasury = (c as { treasury?: string }).treasury || MAINNET_TREASURY;
  const feeVault = feeVaultPda().toBase58();
  const slot = Number(d.deployed_in_slot);
  const upgrade = MAINNET_UPGRADE_SQUAD;
  const settings = MAINNET_SETTINGS_SQUAD;
  return (
    <article className="pt-8 md:pt-14 max-w-[46rem]" data-trust>
      <h1 className="display text-[1.75rem] md:text-[2rem] leading-tight">Trust</h1>
      <p className="text-text-2 text-[1.125rem] mt-2 leading-snug">What runs {BRAND.name}, and who can change it.</p>

      <h2 className="display text-[1.25rem] mt-8 mb-1">Program</h2>
      <dl className="panel px-4">
        <Row k="Program ID" v={<Addr a={d.program_id} />} />
        <Row
          k="Build"
          v={
            <>
              {d.interface_version} · sha256 <span className="mono">{d.on_chain.sha256.slice(0, 8)}</span>
            </>
          }
          sub={slot > 0 ? `${mainnet ? "mainnet" : "devnet"} slot ${slot.toLocaleString("en-US")}` : "mainnet slot at deploy"}
        />
        <Row k="Verified build" v={<Wait>solana-verify after the source opens</Wait>} />
        <Row k="Reviews" v={<Ok>{REVIEW_SEATS} independent reviews</Ok>} sub="Not a formal audit · packet public at launch" />
      </dl>

      <h2 className="display text-[1.25rem] mt-8 mb-1">Who can change it</h2>
      <dl className="panel px-4">
        {mainnet ? (
          <Row
            k="Upgrades"
            v={
              <>
                Squads multisig, {upgrade.threshold} of {upgrade.members} · <b>{upgrade.timeLockHours} h time lock</b>
              </>
            }
            sub={
              <>
                vault <Addr a={upgrade.vault} />
              </>
            }
          />
        ) : (
          <Row
            k="Upgrades"
            v={
              <>
                One key today · <Addr a={d.upgrade_authority} />
              </>
            }
            sub={`devnet · at mainnet: Squads multisig, ${upgrade.threshold} of ${upgrade.members}, ${upgrade.timeLockHours} h time lock`}
          />
        )}
        <Row
          k="Settings"
          v={
            <>
              Squads multisig, {settings.threshold} of {settings.members}
            </>
          }
          sub={
            <>
              {mainnet ? null : "at mainnet · "}vault <Addr a={settings.vault} /> · new launches only; a running launch keeps its terms
            </>
          }
        />
        {/* U-1 (the founder, 2026-10-27). */}
        <Row k="Payouts, refunds" v={<Ok>No key can block them</Ok>} />
      </dl>

      <h2 className="display text-[1.25rem] mt-8 mb-1">Money</h2>
      <dl className="panel px-4">
        <Row k="Deposits" v="In the program's vault, one per launch, not with us" />
        <Row
          k={`${BRAND.name}'s fees`}
          v={
            <>
              <b>{bouncerRaise}</b> of a raise · <b>{fmtVolumePct(split.bouncerPct)}</b> of volume{V030 ? ` (${fmtSharePct(platformSplit(split.bouncerPct).treasuryPct)} treasury, ${fmtSharePct(platformSplit(split.bouncerPct).burnPct)} buy and burn BOUNCER)` : ""}
            </>
          }
          sub={`Creators earn ${creatorRaise} of the raise and ${fmtVolumePct(split.creatorPct)} of all trading volume`}
        />
        <Row k="Treasury Wallet" v={<Addr a={treasury} />} sub="Ledger" />
        <Row k="Fee vault" v={<Addr a={feeVault} />} sub="Program account, no key" />
        <Row
          k="Keepers"
          v={
            mainnet ? (
              "New keys, listed at launch"
            ) : (
              <>
                {DEVNET_KEEPERS.map((k, i) => (
                  <span key={k}>
                    {i > 0 ? " · " : ""}
                    <Addr a={k} />
                  </span>
                ))}
              </>
            )
          }
          sub={mainnet ? "they run the steps, they cannot move deposits" : "devnet · they run the steps, they cannot move deposits"}
        />
      </dl>

      <h2 className="display text-[1.25rem] mt-8 mb-1">Official</h2>
      <dl className="panel px-4">
        <Row
          k="Site"
          v={
            <a className="link" href={OFFICIAL.site.href}>
              {OFFICIAL.site.label}
            </a>
          }
        />
        <Row
          k="X"
          v={
            <a className="link" href={OFFICIAL.x.href}>
              {OFFICIAL.x.label}
            </a>
          }
        />
        <Row
          k="Telegram"
          v={
            <>
              <a className="link" href={OFFICIAL.telegramChat.href}>
                {OFFICIAL.telegramChat.label}
              </a>{" "}
              ·{" "}
              <a className="link" href={OFFICIAL.telegramFeed.href}>
                {OFFICIAL.telegramFeed.label}
              </a>
            </>
          }
          sub="chat · launch feed"
        />
      </dl>
      <p className="text-text-3 mt-4">Anything else claiming to be {BRAND.name} is not.</p>
    </article>
  );
}
