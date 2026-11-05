/*
  D (22e3; the 22e2 reviews' fresh L4, Astra's note 2, adversarial I4): the devnet Config as set, baked in as the
  pages' fallback before the live Config arrives (or when it cannot be read). The program's decided devnet values
  (contract/constants.ts CONFIG_DEVNET) are the 0.05 SOL test set; since 2026-10-23 the devnet Config holds the
  mainnet terms (floor 10 SOL, 12 h recovery, the bot check on), and since the 22e3 deploy min_bid 17,683,840 (the founder:
  a flat 0.02 SOL least a bidder sends: 0.02 SOL less the bid's 0.00231616 of costs). The same values are
  programs/bouncer/localnet/devnet-config-record.json, verify-config's devnet record; scripts/check-contract.ts holds
  the two equal. Mainnet's fallback is the program's decided production set with min_bid 17,683,840 (product.ts
  MAINNET_MIN_BID, 23c), the value D-C2 writes.
*/
export const DEVNET_CONFIG_LIVE = {
  floorValue: 10_000_000_000n,
  minBid: 17_683_840n,
  abortAfterSecs: 43_200,
  attestBids: 1,
  processingCharge: 10_000n,
} as const;
