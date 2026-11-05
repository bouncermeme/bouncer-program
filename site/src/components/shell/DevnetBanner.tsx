import { CLUSTER } from "@contract/active";

/*
  On every page, above everything, never dismissable (the founder, 2026-09-28:
  the test deploy will eventually be seen by someone who does not know it
  is a test). Shown whenever the pinned cluster is not mainnet, so it can
  only disappear by re-pinning the site to mainnet, never by a setting.
  the founder, 2026-10-23: "Nothing is audited yet." is gone from it; /risk and
  the whitepaper keep their "reviewed, not formally audited" wording.
*/
export function DevnetBanner() {
  const c: string = CLUSTER;
  if (c === "mainnet" || c === "mainnet-beta") return null;
  return (
    <div className="w-full border-b border-line" style={{ background: "var(--note-soft)" }} role="note" aria-label="Test site">
      <p className="w-full max-w-[1120px] mx-auto px-4 md:px-8 py-2 leading-snug text-[1rem]">
        <span className="font-semibold">Devnet test.</span> Nothing here has real value.
      </p>
    </div>
  );
}
