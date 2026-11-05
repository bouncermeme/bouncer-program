"use client";

/*
  The recovery delay in words ("10 minutes", "12 hours"): the live Config's
  abort_after_secs (useConfigLive), the pinned config for this cluster
  (PRODUCT) until the first read lands. The same source the Guide, FAQ and
  Whitepaper read; for pages that are otherwise server-rendered (/terms, /risk).
*/
import { useConfigLive } from "@/lib/bouncer/hooks";
import { PRODUCT } from "@/lib/bouncer/product";
import { durationText } from "./durations";

export function RecoveryDelay() {
  const { config } = useConfigLive();
  const secs = Number(config?.abortAfterSecs ?? PRODUCT.abortAfterSecs);
  return <span data-recovery-delay={secs}>{durationText(secs)}</span>;
}
