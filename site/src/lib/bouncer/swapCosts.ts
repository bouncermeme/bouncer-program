/*
  The swap's costs, said once under "At least" (Astra's review of 337bed2,
  F1): the Details dropdown went (the founder's notes, items 2 and 3), and with it
  the only statement of what a swap costs beyond the amount. One visible
  line now says three things before the signature: the pool fee is already
  in the quote, the network fee, and the account setup a first buy leaves in
  the new token account (only when it applies; "checking" while the
  wallet's balances load, "if this is your first" when no wallet is
  connected, so the line never implies there is none when it does not know).
  The minimum the swap enforces is not here: it is the "At least" line above
  and the quote's minOut, passed to the swap unchanged.
*/

export type SetupCase = { kind: "none" } | { kind: "first"; rent: bigint } | { kind: "maybe"; rent: bigint } | { kind: "checking" };

/* Which account-setup statement applies. A sell never creates the token account; a buy does when the wallet has none. */
export function setupCase(args: { side: "buy" | "sell"; connected: boolean; hasTokenAccount: boolean | null; rent: bigint | null }): SetupCase {
  if (args.side === "sell") return { kind: "none" };
  if (args.rent === null) return { kind: "checking" };
  if (!args.connected) return { kind: "maybe", rent: args.rent };
  if (args.hasTokenAccount === null) return { kind: "checking" };
  return args.hasTokenAccount ? { kind: "none" } : { kind: "first", rent: args.rent };
}

/* The line, from figures already formatted by the caller (the pool fee in its own token, the network fee and the rent in SOL). */
export function swapCostLine(args: { poolFee: string; networkFee: string; setup: SetupCase; rentText: (lamports: bigint) => string; symbol: string }): string {
  const { setup, symbol } = args;
  const head = `Includes the pool fee, ${args.poolFee}. Network fee ${args.networkFee}.`;
  switch (setup.kind) {
    case "none":
      return head;
    case "first":
      return `${head} Account setup ${args.rentText(setup.rent)}, kept with your new ${symbol} account.`;
    case "maybe":
      return `${head} Account setup ${args.rentText(setup.rent)} if this is your first ${symbol}.`;
    case "checking":
      return `${head} Account setup: checking.`;
  }
}
