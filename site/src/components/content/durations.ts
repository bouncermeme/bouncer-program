/* A config duration in words: 43,200 s reads "12 hours", 600 s "10 minutes". */
export function durationText(secs: number): string {
  if (secs >= 3600 && secs % 3600 === 0) {
    const h = secs / 3600;
    return `${h} hour${h === 1 ? "" : "s"}`;
  }
  const m = Math.round(secs / 60);
  return `${m} minute${m === 1 ? "" : "s"}`;
}
