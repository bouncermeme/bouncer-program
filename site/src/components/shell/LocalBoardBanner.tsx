/*
  Takes the devnet banner's place on the local test board (2026-09-29). Same
  place, same rule: above everything, on every page, never dismissable.
*/
export function LocalBoardBanner() {
  return (
    <div className="w-full border-b border-line" style={{ background: "var(--note-soft)" }} role="note" aria-label="Local test board">
      <p className="w-full max-w-[1120px] mx-auto px-4 md:px-8 py-2 leading-snug text-[1rem]">
        <span className="font-semibold">Local test board.</span> These launches run on a test chain on the founder&apos;s PC, not on devnet or mainnet: every figure is read from that chain, and the SOL in it is free. Look only: the wallet button does not work here.
      </p>
    </div>
  );
}
