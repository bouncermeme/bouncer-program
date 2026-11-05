/*
  v0.32: collecting a parked payout (the founder approved the mocks on 2026-10-29, review/2026-10-29-v032/mocks; the interface
  is idl/INTERFACE-v0.32-NOTE.md, collect_parked). The bidder names where the tokens go, and the token program only
  checks the mint, so the destination is chosen here:

    - the wallet's own token account for the mint (its associated address, initialized, owned by the wallet): there;
    - nothing at that address: the associated account is made in the same transaction (its rent is the wallet's);
    - anything else at that address (a token account handed to another owner, which is how a winner's payout comes to
      be parked): a new token account owned by the wallet, made in the same transaction from a fresh keypair that
      signs it. Never the account at the associated address: its owner is not the bidder.

  The lamports go to the wallet itself. Only the second and third cases cost a token account's rent, so the fee line
  names it only then (the founder's call B).
*/
import { Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction } from "@solana/web3.js";
import { createAtaIdempotentIx, TOKEN_ACCOUNT_BYTES } from "./creatorFees";
import { collectParkedIx } from "./ix";
import { ataFor, bidPda, TOKEN_PROGRAM, tokenVaultPda, vaultPda } from "./pda";

export type TokenTarget =
  /* No tokens are parked (a refund's park): no token account is named. */
  | { kind: "none" }
  /* The wallet's own associated token account, ready. */
  | { kind: "own"; account: PublicKey }
  /* Nothing at the associated address yet: made in the same transaction. */
  | { kind: "create"; account: PublicKey }
  /* The associated address holds something the wallet cannot take tokens into: a new account from a fresh keypair. */
  | { kind: "fresh" };

/* SPL token account: mint at 0, owner at 32, state at 108 (1 initialized), 165 bytes, owned by the classic token program. */
export function tokenTargetFrom(info: { owner: PublicKey; data: Uint8Array } | null, ata: PublicKey, bidder: PublicKey, mint: PublicKey): TokenTarget {
  if (!info) return { kind: "create", account: ata };
  const d = info.data;
  const ok = info.owner.equals(TOKEN_PROGRAM) && d.length === TOKEN_ACCOUNT_BYTES && new PublicKey(d.subarray(0, 32)).equals(mint) && new PublicKey(d.subarray(32, 64)).equals(bidder) && d[108] === 1;
  return ok ? { kind: "own", account: ata } : { kind: "fresh" };
}

export const needsTokenAccount = (t: TokenTarget): boolean => t.kind === "create" || t.kind === "fresh";

/* The one read the destination needs: the wallet's associated address for the mint. */
export async function readTokenTarget(connection: { getAccountInfo: (k: PublicKey, c: "confirmed") => Promise<{ owner: PublicKey; data: Uint8Array | Buffer } | null> }, bidder: PublicKey, mint: PublicKey | null, tokens: bigint): Promise<TokenTarget> {
  if (tokens === 0n || !mint) return { kind: "none" };
  const ata = ataFor(bidder, mint, TOKEN_PROGRAM);
  const info = await connection.getAccountInfo(ata, "confirmed");
  return tokenTargetFrom(info ? { owner: info.owner, data: Uint8Array.from(info.data) } : null, ata, bidder, mint);
}

/* SPL token InitializeAccount3 (18): the account and the mint, the owner in the data; no rent sysvar. */
function initializeAccount3Ix(account: PublicKey, mint: PublicKey, owner: PublicKey): TransactionInstruction {
  return new TransactionInstruction({ programId: TOKEN_PROGRAM, keys: [{ pubkey: account, isSigner: false, isWritable: true }, { pubkey: mint, isSigner: false, isWritable: false }], data: Buffer.concat([Buffer.from([18]), owner.toBuffer()]) });
}

/* The collect, with the token account it needs first. `fresh` is the new account's keypair when the target is "fresh"; it signs too. */
export function collectParkedTransaction(k: { launch: PublicKey; bidder: PublicKey; mint: PublicKey | null; target: TokenTarget; rent: bigint; fresh: Keypair | null }): Transaction {
  const tx = new Transaction();
  let tokenDestination: PublicKey | null = null;
  if (k.target.kind !== "none") {
    if (!k.mint) throw new Error("tokens are parked but the launch has no mint");
    if (k.target.kind === "own") tokenDestination = k.target.account;
    else if (k.target.kind === "create") {
      tx.add(createAtaIdempotentIx(k.bidder, k.bidder, k.mint, TOKEN_PROGRAM));
      tokenDestination = k.target.account;
    } else {
      if (!k.fresh) throw new Error("a new token account needs its keypair");
      tx.add(SystemProgram.createAccount({ fromPubkey: k.bidder, newAccountPubkey: k.fresh.publicKey, lamports: Number(k.rent), space: TOKEN_ACCOUNT_BYTES, programId: TOKEN_PROGRAM }), initializeAccount3Ix(k.fresh.publicKey, k.mint, k.bidder));
      tokenDestination = k.fresh.publicKey;
    }
  }
  tx.add(collectParkedIx({ launch: k.launch, vault: vaultPda(k.launch), tokenVault: tokenDestination ? tokenVaultPda(k.launch) : null, tokenDestination, bid: bidPda(k.launch, k.bidder), bidder: k.bidder, destination: k.bidder }));
  tx.feePayer = k.bidder;
  return tx;
}
