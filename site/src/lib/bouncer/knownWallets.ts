/*
  Wallets that fund thousands of others: exchange hot wallets and faucets.
  A funding path that reaches one of these stops there and is not reported,
  because sharing an exchange with the creator says nothing about anyone.

  Provenance: these are the addresses public explorers label with these
  exchange names as of 2026-09-24. They were not verified from this session.
  Check every entry against Solscan or Solana FM before mainnet and extend the
  list from there. A wrong entry here only hides a link, which is the safe
  direction; it can never create one.

  Devnet: the faucet that answers requestAirdrop shows up as an ordinary
  transfer from its own address. scripts/probe-funding.ts prints it; add it
  here as kind "faucet" once seen.
*/

import type { KnownWallet } from "./funding";

export const KNOWN_WALLETS: KnownWallet[] = [
  { address: "5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9", label: "Binance", kind: "exchange" },
  { address: "H8sMJSCQxfKiFTCfDR3DUMLPwcRbM61LGFJ8N4dK3WjS", label: "Coinbase", kind: "exchange" },
  { address: "FWznbcNXWQuHTawe9RxvQ2LdCENssh12dsznf4RiouN5", label: "Kraken", kind: "exchange" },
  { address: "5VCwKtCXgCJ6kit5FybXjvriW3xELsFDhYrPSqtJNmcD", label: "OKX", kind: "exchange" },
  { address: "AC5RDfQFmDS1deWZos921JfqscXdByf8BKHs5ACWjtW2", label: "Bybit", kind: "exchange" },
];

export function knownWallet(address: string): KnownWallet | undefined {
  return KNOWN_WALLETS.find((k) => k.address === address);
}
