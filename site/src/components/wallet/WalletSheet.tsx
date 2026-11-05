"use client";

import { useWallet } from "@solana/wallet-adapter-react";
import { WalletReadyState } from "@solana/wallet-adapter-base";
import { useEffect, useMemo, useState } from "react";
import { Sheet } from "@/components/ui/Sheet";
import { clusterLabel } from "@/lib/bouncer/chain/cluster";
import { CLUSTER_NAME } from "@/lib/bouncer/chain/rpc";
import { useAccount } from "./AccountProvider";
import { clearWalletError, useWalletError } from "./walletErrors";
import { BRAND } from "@/lib/brand";

function isMobile(): boolean {
  if (typeof navigator === "undefined") return false;
  return /android|iphone|ipad|ipod/i.test(navigator.userAgent);
}

/*
  The wallet apps' own browsers, for a phone with no wallet in this browser (WALLET-FIXES.md W2, 2026-11-04). Each
  opens this page inside the app, where its wallet is injected and listed above. The list is not an allowlist: any
  Wallet Standard Solana wallet the browser registers is listed (Providers.tsx), MetaMask's and Jupiter's included.
  Phantom and Solflare as before; MetaMask's dapp link and Backpack's browse link are new and are proven on a real
  phone before they ship.
*/
export function openInLinks(href: string): { name: string; url: string }[] {
  if (!href) return [];
  const u = new URL(href);
  const page = encodeURIComponent(href);
  const ref = encodeURIComponent(u.origin);
  return [
    { name: "Phantom", url: `https://phantom.app/ul/browse/${page}?ref=${ref}` },
    { name: "Solflare", url: `https://solflare.com/ul/v1/browse/${page}?ref=${ref}` },
    { name: "MetaMask", url: `https://metamask.app.link/dapp/${u.host}${u.pathname}${u.search}` },
    { name: "Backpack", url: `https://backpack.app/ul/v1/browse/${page}?ref=${ref}` },
  ];
}

/* MetaMask lists its Solana wallet only once a Solana account is turned on in it (WALLET-FIXES.md, report 1). */
const METAMASK_LINE = "MetaMask: turn on a Solana account in it, then reload this page.";

export function WalletSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { wallets, select, connecting, connected, wallet } = useWallet();
  const account = useAccount();
  const walletError = useWalletError();
  /* Only read on the client, and only used once the sheet is open, so hydration never sees it. */
  const href = typeof window === "undefined" ? "" : window.location.href;
  const close = () => {
    clearWalletError();
    onClose();
  };
  useEffect(() => {
    if (open) clearWalletError();
  }, [open]);
  /* A connect closes the sheet for good, so a later disconnect from the wallet's side does not bring it back unasked. */
  useEffect(() => {
    if (open && connected) onClose();
  }, [open, connected, onClose]);

  const ready = useMemo(
    () =>
      wallets.filter(
        (w) => w.readyState === WalletReadyState.Installed || w.readyState === WalletReadyState.Loadable,
      ),
    [wallets],
  );

  const mobile = isMobile();
  const openIn = openInLinks(href);
  /* A wallet app without a link here (Jupiter Mobile and the rest) opens the page from its own browser: the address, copied. */
  const [copied, setCopied] = useState(false);
  const copyLink = () => {
    try {
      void navigator.clipboard.writeText(href).then(
        () => setCopied(true),
        () => setCopied(false),
      );
    } catch {}
  };
  const net = clusterLabel(CLUSTER_NAME);

  return (
    <Sheet open={open} onClose={close} title="Connect a wallet">
      {ready.length > 0 && (
        <ul className="flex flex-col gap-2 mb-3">
          {ready.map((w) => {
            const busy = connecting && wallet?.adapter.name === w.adapter.name;
            const unsafe = /unsafe/i.test(w.adapter.name);
            return (
              <li key={w.adapter.name}>
                <button
                  type="button"
                  className="w-full flex items-center gap-3 inset px-3 py-3 text-left hover:border-line-2 active:translate-y-px transition"
                  disabled={connecting}
                  onClick={() => {
                    clearWalletError();
                    try {
                      /* Selecting connects: the provider opens the wallet's own prompt. What the wallet answers arrives through walletErrors. */
                      select(w.adapter.name);
                    } catch {}
                  }}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={w.adapter.icon} alt="" width={36} height={36} className="rounded-[8px]" />
                  <span className="flex-1 font-semibold">
                    {w.adapter.name}
                    {unsafe && <span className="block text-text font-normal">Scripted, in this page. For rehearsing wallet failures on devnet.</span>}
                  </span>
                  <span className="text-text-3">{busy ? "Opening" : w.readyState === WalletReadyState.Installed ? "Detected" : "Open"}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {ready.length > 0 && <p className="text-text-3 leading-snug mb-3" data-wallet-not-listed>Not listed? {METAMASK_LINE}</p>}

      {ready.length === 0 && (
        <div className="inset p-4 mb-3" data-wallet-none>
          <p className="font-semibold mb-1">No Solana wallet found</p>
          <p className="text-text-2 mb-3">Install Phantom, Solflare or Backpack, or open {BRAND.domain} inside your wallet app&apos;s browser.</p>
          {mobile ? (
            <>
              <div className="grid grid-cols-2 gap-2">
                {openIn.map((l, i) => (
                  <a key={l.name} className={`btn ${i === 0 ? "btn-primary" : "btn-secondary"} w-full`} href={l.url} data-open-in={l.name}>
                    Open in {l.name}
                  </a>
                ))}
              </div>
              <button type="button" className="btn btn-ghost w-full mt-2" onClick={copyLink} data-copy-page-link>
                {copied ? "Link copied" : "Copy this page's link"}
              </button>
              <p className="text-text-2 mt-2 leading-snug">Another wallet app, like Jupiter: paste the link into its browser.</p>
            </>
          ) : (
            /* One under another at every width (the founder's 04e report, 2026-11-04): in one row the three no-wrap labels
               need about 440 px, the sheet's box gives 398, and Get Backpack ran past the sheet's edge. */
            <div className="flex flex-col gap-2" data-wallet-get>
              <a className="btn btn-secondary w-full" href="https://phantom.app/download" target="_blank" rel="noreferrer">
                Get Phantom
              </a>
              <a className="btn btn-secondary w-full" href="https://solflare.com/download" target="_blank" rel="noreferrer">
                Get Solflare
              </a>
              <a className="btn btn-secondary w-full" href="https://backpack.app/downloads" target="_blank" rel="noreferrer">
                Get Backpack
              </a>
            </div>
          )}
          <p className="text-text-2 mt-3 leading-snug" data-wallet-metamask>{METAMASK_LINE}</p>
        </div>
      )}

      {walletError && (
        <p className="mb-3 text-text" role="alert">
          {walletError.message} Nothing was sent.
        </p>
      )}

      <p className="text-text-3 leading-snug mb-3">
        {BRAND.name} is on {net}.{net === "devnet" ? " In Phantom: Settings, Developer settings, Testnet mode, Solana devnet, so the wallet shows what you sign." : ""}
      </p>

      {account.devKeyEnabled && (
        <button type="button" className="btn btn-ghost w-full" onClick={account.useDevKey}>
          Use a dev key (devnet only, unsafe: a keypair in this browser)
        </button>
      )}
    </Sheet>
  );
}
