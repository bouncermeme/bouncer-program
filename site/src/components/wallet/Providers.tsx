"use client";

import { ConnectionProvider, WalletProvider } from "@solana/wallet-adapter-react";
import { useMemo, type ReactNode } from "react";
import { DEV_WALLET_ENABLED } from "@/lib/bouncer/client";
import { RPC_URL } from "@/lib/bouncer/chain/rpc";
import { BOARD_LOCAL } from "@/lib/board";
import { installRehearsalWallet } from "@/lib/bouncer/dev/rehearsalWallet";
import { AccountProvider } from "./AccountProvider";
import { reportWalletError } from "./walletErrors";

/*
  Wallet connect only. The adapter discovers Wallet Standard wallets on its
  own (Phantom, Solflare, Backpack, and the rest), and on Android it adds
  the Mobile Wallet Adapter. Nothing here ever holds a key or a balance.
  Connect errors go to walletErrors so the sheet can say them.

  With NEXT_PUBLIC_DEV_WALLET=1 the rehearsal wallet registers itself here,
  before the adapter looks, so it appears in the sheet like an extension.
*/
if (typeof window !== "undefined" && DEV_WALLET_ENABLED) installRehearsalWallet();

export function Providers({ children }: { children: ReactNode }) {
  const endpoint = useMemo(() => RPC_URL, []);
  return (
    <ConnectionProvider endpoint={endpoint} config={{ commitment: "confirmed" }}>
      <WalletProvider wallets={[]} autoConnect={!BOARD_LOCAL} onError={reportWalletError}>
        <AccountProvider>{children}</AccountProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}
