"use client";

import Link from "next/link";
import { clusterLabel } from "@/lib/bouncer/chain/cluster";
import { CLUSTER_NAME, RPC_URL } from "@/lib/bouncer/chain/rpc";
import { shortAddr } from "@/lib/bouncer/format";

/*
  What the launch, bid and settlement pages show in place of the skeleton
  once the RPC has answered that it holds no launch at this address: a
  launch made on another cluster, an address with a character wrong, or
  one the RPC has not seen yet. Says which RPC answered and when, and that
  the page keeps asking.
*/
export function MissingLaunch({ id, checkedAt }: { id: string; checkedAt: number }) {
  const net = clusterLabel(CLUSTER_NAME);
  let host = RPC_URL;
  try {
    host = new URL(RPC_URL).host;
  } catch {}
  const at = new Date(checkedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  return (
    <div className="pt-8 max-w-[34rem]">
      <div className="panel p-4 md:p-5" role="status">
        <p className="display text-[1.5rem] leading-tight">No launch at this address on {net}.</p>
        <p className="text-text-2 mt-2">
          {host} held no launch at <span className="mono">{shortAddr(id, 6, 6)}</span> at {at}. Another cluster, or a wrong character in the address, reads like this. Asking again every 15 seconds.
        </p>
        <Link href="/" className="btn btn-secondary w-full mt-4">
          Back to launches
        </Link>
      </div>
    </div>
  );
}
