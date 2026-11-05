import { fmtDateTime } from "@/lib/bouncer/format";
import type { ConfigAccount } from "@/lib/bouncer/types";

/*
  The emergency update pause (Config byte 10, checklist S-15, C-07). While it
  is on, create_launch is refused and nothing else changes: every launch
  already running proceeds through every state. Disclosed, never hidden, with
  the timestamp the pause was set (offset 112).
*/
export function PauseBanner({ config }: { config: ConfigAccount }) {
  if (!config.emergencyUpdatePause) return null;
  return (
    <div className="inset p-4 border-accent-line" role="status">
      <p className="font-semibold">Launch creation is paused for a program update.</p>
      <p className="text-text-2 mt-1 leading-snug">
        Launches already running are unaffected: bids, settlement, payouts and refunds all proceed.
        {config.emergencyUpdatePauseTs > 0 && <> Paused since {fmtDateTime(config.emergencyUpdatePauseTs)}.</>}
      </p>
    </div>
  );
}
