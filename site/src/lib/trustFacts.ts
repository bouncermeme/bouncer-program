/*
  The /trust page's facts that are not in the pin (22e3, the founder 2026-10-23). The program id, its sha256, the deploy
  slot, the upgrade authority on devnet, the treasury (Config.lp_owner) and the fee split come from the pin
  (contract/deployment*.json, read by the page). What the pin cannot hold yet is here, each from its record:
  - the Squads vaults decided for mainnet (docs/MAINNET-LAUNCH-PLAN.md A11.1 Squad A, upgrades, 3 of 3 with a 24 h
    time lock; A11.2 Squad B, settings, 2 of 3);
  - the treasury decided for mainnet's Config.lp_owner (MAINNET-LAUNCH-PLAN.md, the Ledger), shown until the mainnet
    pin records the Config's own;
  - the devnet keepers' public keys (keeper/README.md; mainnet's are new keys, listed at launch).
  scripts/check-trust.tsx fails when any of these disagrees with its record, or the page with the pin.
*/
export const MAINNET_UPGRADE_SQUAD = { vault: "GmnxXQ1VffBeUadhY3JVb496c6gGxNB39ZnJ7kMq1AYp", threshold: 3, members: 3, timeLockHours: 24 } as const;
export const MAINNET_SETTINGS_SQUAD = { vault: "QCKq5cxC9cyVVeRUo6PNqp5b2vpoWP5H6K8Ak9CieQn", threshold: 2, members: 3 } as const;
export const MAINNET_TREASURY = "GF5D3GRuypC1xogkfkCBypuBjESABAjjNKqktZh4bQza";
export const DEVNET_KEEPERS = ["4ED5AxoWFahAVsF4gLHrKFvGLrSxx1LYRgsH1rE7QTeh", "7H7KBwEki1X2ic4wGoVV9qffJadyGR1EaUnVica4fi2u"] as const;
/* Five independent seats reviewed the candidate; not a formal audit; the packet is public at launch. */
export const REVIEW_SEATS = 5;
