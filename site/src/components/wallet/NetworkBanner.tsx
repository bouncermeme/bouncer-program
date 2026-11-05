"use client";

import { FAULT_HEADING } from "@/lib/bouncer/chain/cluster";
import { useAccount } from "./AccountProvider";

/*
  Under the header on every page while the RPC did not answer (or took too
  long), is not the pinned cluster, lacks the program, holds a different
  build of it, or this browser cannot check it.
  The heading says which kind, the sentence names the thing; the signing
  buttons are disabled for the same reason wherever they appear. Nothing
  is shown while the check is still running or when it passed.
*/
export function NetworkBanner() {
  const { cluster, recheckCluster } = useAccount();
  if (!cluster || cluster.ok) return null;
  const heading = FAULT_HEADING[cluster.fault ?? "rpc"];
  return (
    <div className="w-full border-b border-line" style={{ background: "var(--note-soft)" }} role="status">
      <div className="w-full max-w-[1120px] mx-auto px-4 md:px-8 py-3 flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
        <p className="leading-snug wrap-any">
          <span className="font-semibold">{heading} </span>
          {cluster.problem}
        </p>
        <button type="button" className="btn btn-secondary shrink-0" onClick={recheckCluster}>
          Check again
        </button>
      </div>
    </div>
  );
}
