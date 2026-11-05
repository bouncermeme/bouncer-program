"use client";

import { useState } from "react";
import { Sheet } from "@/components/ui/Sheet";
import { clusterLabel, FAULT_HEADING, hostOf } from "@/lib/bouncer/chain/cluster";
import { shortAddr } from "@/lib/bouncer/format";
import { BOARD_LOCAL } from "@/lib/board";
import { useAccount } from "./AccountProvider";

/* The network check, in the wallet menu: the cluster the pin names, the RPC, and whether the program there is the pinned build. */
function NetworkLine() {
  const { cluster, walletChains, kind } = useAccount();
  if (!cluster) return <p className="text-text-3 mt-3">Checking the network.</p>;
  const rpcHost = hostOf(cluster.rpcUrl);
  if (!cluster.ok) {
    return (
      <p className="text-text mt-3 leading-snug">
        <span className="font-semibold">{FAULT_HEADING[cluster.fault ?? "rpc"]} </span>
        {cluster.problem}
      </p>
    );
  }
  return (
    <p className="text-text-3 mt-3 leading-snug">
      On {clusterLabel(cluster.pinned)} through {rpcHost}
      {cluster.rpcCluster === "local" ? " (a local validator)" : ""}. Program {cluster.program === "found" ? "found" : cluster.program}
      {cluster.bytes === "match" ? ", its bytes match the pin" : ""}
      {cluster.config === "found" ? ", config found" : ""}.
      {kind === "wallet" && walletChains ? ` This wallet offers ${walletChains.map((c) => c.replace("solana:", "")).join(", ")}.` : ""}
    </p>
  );
}

/* A stable, address-derived hue so a wallet is recognisable at a glance. */
function hue(address: string): number {
  let h = 0;
  for (let i = 0; i < address.length; i++) h = (h * 31 + address.charCodeAt(i)) % 360;
  return h;
}

export function ConnectButton({ size = "compact", tone = "secondary" }: { size?: "compact" | "full"; tone?: "secondary" | "primary" }) {
  const account = useAccount();
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  /* The local test board is look-only: no wallet can sign for a chain on the founder's PC. */
  if (BOARD_LOCAL) {
    return (
      <button type="button" className={`btn btn-secondary ${size === "full" ? "w-full" : "min-h-[2.625rem] px-4"}`} disabled aria-disabled="true">
        {size === "full" ? "Wallet off on the local test board" : "Wallet off"}
      </button>
    );
  }

  if (!account.address) {
    return (
      <button
        type="button"
        className={`btn ${tone === "primary" ? "btn-primary" : "btn-secondary"} ${size === "full" ? "w-full" : "min-h-[2.625rem] px-4"}`}
        onClick={account.openConnect}
        disabled={account.connecting}
      >
        {account.connecting ? "Connecting" : size === "full" ? "Connect wallet" : <><span className="min-[400px]:hidden">Connect</span><span className="hidden min-[400px]:inline">Connect wallet</span></>}
      </button>
    );
  }

  const h = hue(account.address);

  return (
    <>
      <button
        type="button"
        className={`chip ${size === "full" ? "w-full justify-center min-h-[3.25rem]" : ""}`}
        onClick={() => setOpen(true)}
        aria-label="Wallet menu"
      >
        <span
          className="inline-block w-2.5 h-2.5 rounded-full"
          style={{ background: `hsl(${h} 60% 62%)` }}
        />
        <span className="mono">{shortAddr(account.address)}</span>
      </button>

      <Sheet open={open} onClose={() => setOpen(false)} title={account.walletName ?? "Wallet"}>
        <div className="inset p-4 mb-3">
          <p className="text-text-3 mb-1">Connected address</p>
          <p className="mono break-all">{account.address}</p>
          {account.kind === "devkey" && (
            <p className="mt-2 text-text">Dev key. A keypair stored in this browser signs real devnet transactions. Unsafe by design; devnet only. Disconnecting forgets it.</p>
          )}
          <NetworkLine />
        </div>
        <div className="flex flex-col gap-2 sm:flex-row">
          <button
            type="button"
            className="btn btn-secondary flex-1"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(account.address!);
                setCopied(true);
                setTimeout(() => setCopied(false), 1400);
              } catch {}
            }}
          >
            {copied ? "Copied" : "Copy address"}
          </button>
          <button
            type="button"
            className="btn btn-ghost flex-1"
            onClick={() => {
              /* Rehearsal item 5: the menu closes at once; it never waits on the wallet. */
              setOpen(false);
              void account.disconnect();
            }}
          >
            Disconnect
          </button>
        </div>
      </Sheet>
    </>
  );
}
