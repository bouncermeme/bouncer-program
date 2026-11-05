/*
  v0.30 (review/2026-10-27-v030/SPEC.md; the founder's mocks 1B, 2B and 3C, FOUNDER-UI-DECISIONS.md): the pool is created with
  its token vault frozen, every bid is pushed (self-claim is gone), and a permissionless open_trading thaws the vault
  once everyone is paid. Every v0.30 state switches on from the pinned contract alone: the 0.30 Launch account carries
  trading_state (offset 704). site/contract was re-pinned to 0.30 on 2026-10-28 (7257d7c, IDL sha256 9653f8d0), so V030
  reads true; the claim instruction is gone from the site with it (SPEC 9).
*/
import { ACCOUNTS } from "@contract/constants";
import type { Launch } from "./types";

export const V030: boolean = "trading_state" in ACCOUNTS.Launch.fields;

/* Launch.trading_state: 0 a pool from before 0.30 (open with the pool, as today), 1 frozen since create_pool, 2 open. */
export const TRADING_FROZEN = 1;
export const TRADING_OPEN = 2;

/* The pool exists and its vault is frozen: everyone is being paid, nothing trades yet (2B, "Paying out"). Only in PoolLive: finalize needs the open (SPEC 3.6). */
export function tradingFrozen(launch: Launch): boolean {
  return V030 && launch.account.state === "poolLive" && launch.account.tradingState === TRADING_FROZEN;
}

/* Whether anything on the site may lead to trading: the mint is live (view.ts mintIsLive), the pool is known, and it is not frozen. On 0.29 this is the pool alone. Imports nothing from the site, so types.ts can read V030. */
export function tradingOpen(launch: Launch, pool: string | null | undefined): boolean {
  const s = launch.account.state;
  return (s === "poolLive" || (s === "finalized" && launch.recordExists)) && !!pool && !tradingFrozen(launch);
}
