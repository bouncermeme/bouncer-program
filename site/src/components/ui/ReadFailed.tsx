"use client";

/*
  A read that failed, said as such, with a way to read again (the 0.28
  triage's F14, 2026-10-09): never shown as "no bid", "did not bid" or a
  wait that never ends. The page also reads again by itself every 20 s.
*/
export function ReadFailed({ what, onRetry, className = "" }: { what: string; onRetry: () => void; className?: string }) {
  return (
    <div className={`flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between ${className}`} role="status" data-read-failed>
      <p className="text-text-2 leading-snug">{what} could not be read just now.</p>
      <button type="button" className="btn btn-secondary sm:w-auto" onClick={onRetry}>
        Try again
      </button>
    </div>
  );
}
