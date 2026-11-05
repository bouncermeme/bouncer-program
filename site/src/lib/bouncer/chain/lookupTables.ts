/*
  The address lookup table the pool transaction uses, by the cluster's genesis
  hash (the keying the keeper's alt.json uses too). The table holds the eleven
  fixed addresses create_pool and lock_liquidity carry, in this order, so the
  two fit one version 0 transaction. measure/create-alt.ts creates one per
  cluster with the devnet creator key and freezes it, so nothing can be
  appended, deactivated or closed afterwards. At send time the table is read
  from the chain and whatever it holds is what the message compiles against,
  so an entry here that is wrong costs a bigger transaction (the fallback is
  two legacy ones), never a wrong account.
*/
import type { PublicKey } from "@solana/web3.js";
import { GENESIS_HASH } from "./cluster";
import { ASSOCIATED_TOKEN_PROGRAM, CP_AMM_PROGRAM, EVENT_AUTHORITY, METEORA_CONFIG, POOL_AUTHORITY, RENT_SYSVAR, SYSTEM_PROGRAM, TOKEN_2022_PROGRAM, TOKEN_METADATA_PROGRAM, TOKEN_PROGRAM, WSOL_MINT } from "./pda";

/* The keeper's LOOKUP_ADDRESSES order (keeper/src/keeper.mjs). */
export const LOOKUP_ADDRESSES: readonly PublicKey[] = [TOKEN_METADATA_PROGRAM, RENT_SYSVAR, WSOL_MINT, METEORA_CONFIG, POOL_AUTHORITY, EVENT_AUTHORITY, CP_AMM_PROGRAM, TOKEN_2022_PROGRAM, TOKEN_PROGRAM, SYSTEM_PROGRAM, ASSOCIATED_TOKEN_PROGRAM];

/* Genesis hash to table address. Mainnet has none yet: the pool steps go as two legacy transactions there until one is created and recorded. */
export const LOOKUP_TABLES: Readonly<Record<string, string>> = {
  /* Created and frozen 2026-10-07 12:50 UTC by measure/create-alt.ts (measure/create-alt.log): 11 addresses, authority none. */
  [GENESIS_HASH.devnet]: "HsMCvy131aGNQfdMVoNDrU9bv3k87WjVBDBSG6BSVBsE",
};

export function lookupTableFor(genesis: string | null): string | null {
  const t = genesis ? LOOKUP_TABLES[genesis] : undefined;
  return t ? t : null;
}
