/*
  9C: one wallet's balance change in a landed transaction, from its account keys (static, then the lookup tables'
  writable and read-only ones, the order the balances use) and the node's pre and post balances. Null when the
  wallet is not in it, the balances do not line up or the transaction failed.
*/
export function balanceChange(
  tx: { keys: string[]; preBalances: readonly number[]; postBalances: readonly number[]; err: unknown },
  address: string,
): bigint | null {
  if (tx.err) return null;
  if (tx.preBalances.length !== tx.keys.length || tx.postBalances.length !== tx.keys.length) return null;
  const i = tx.keys.indexOf(address);
  if (i < 0) return null;
  return BigInt(tx.postBalances[i]) - BigInt(tx.preBalances[i]);
}

/*
  Round 28c (Astra A7; the founder's GO, 2026-10-28): what a landed commit did, from its own balances, never from a log line.
  A commit that came after the window closes the book instead: it moves nothing into the vault and the bid account it
  made is closed in the same instruction (lib.rs commit, BidOutcome::ClosedInstead), so the vault's change is zero and
  the bid account ends with no lamports. A placed bid moved the deposit and the charge into the vault and left the bid
  account holding its rent. "closedInstead" only on both; "placed" when either shows the bid; null when the transaction
  failed, the accounts are not in it or the balances say neither.
*/
export function commitVerdict(
  tx: { keys: string[]; preBalances: readonly number[]; postBalances: readonly number[]; err: unknown },
  bid: string,
  vault: string,
): "placed" | "closedInstead" | null {
  const vaultChange = balanceChange(tx, vault);
  const bidChange = balanceChange(tx, bid);
  if (vaultChange === null || bidChange === null) return null;
  const bidAfter = BigInt(tx.postBalances[tx.keys.indexOf(bid)]);
  if (vaultChange === 0n && bidAfter === 0n) return "closedInstead";
  if (vaultChange > 0n || bidAfter > 0n) return "placed";
  return null;
}
