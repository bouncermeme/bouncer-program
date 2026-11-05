/*
  The one button after the window (the founder, 2026-10-07: "have the close button
  or beacon button sign as many transactions at once as possible"). From
  the launch, its bids and its record this composes everything that is due,
  through the shared rules in bundles.mjs, into the fewest transactions the
  chain accepts:

    Open past the window, or Closed, the beacon not posted: post_beacon
      (which closes the book itself on 0.27), every sealed bid's reveal, and
      settle when that opens the last bid, in one transaction; then
      create_pool, finish_mint and lock_liquidity, one transaction each (the
      runtime's instruction trace limit refuses them together, measured
      2026-10-07; finish_mint is the ninth 0.29 candidate's, the token's
      metadata and the mint authority's revocation, out of create_pool).
    Closed, the beacon posted: the reveals and settle, then the pool.
    Settled: the pool.
    Pool live, the creator's liquidity not locked: finish_mint while the
      mint authority is still held, then lock_liquidity.
    Pool live and locked, the mint authority still held: finish_mint alone.
    Finalized, the mint not finished (the eleventh candidate): finish_mint
      alone, paid from the metadata reserve.

  Whether the mint authority is held is the client's read of the mint
  (mintAuthorityHeld below), passed in; the keeper decides the same way
  (keeper/src/keeper.mjs, mintAuthorityHeld).

  Nothing here reads the chain: the client reads, this composes, bundles.mjs
  packs, signer.ts sends. A launch whose bids total under the floor is not
  this button's (End bidding closes it as failed), nor is one past its
  recovery deadline.
*/
import { AddressLookupTableAccount, PublicKey } from "@solana/web3.js";
import type { BidAccount, DrivePlan, Launch, SettlementRecord } from "../types";
import { bidsOpenAt } from "../beacon";
import { poolTreasury } from "../view";
import { beaconGroup, chunk, localTable, pack, poolGroup, revealItem, REVEAL_MAX, txFront } from "./bundles.mjs";
import { createPoolIx, finishMintIx, lockLiquidityIx, postBeaconIx, revealIx, settleIx } from "./ix";
import { LOOKUP_ADDRESSES, lookupTableFor } from "./lookupTables";
import { ataFor, bidPda, histogramPda, meteoraPoolPda, meteoraVaultPda, metadataPda, mintPda, poolCreatorPda, poolTokensPda, poolWsolPda, positionNftAccountPda, positionNftMintPda, positionPda, settlementPda, TOKEN_2022_PROGRAM, tokenVaultPda, vaultPda, WSOL_MINT } from "./pda";
import type { TxSigner } from "./signer";

export type Spec = ReturnType<typeof beaconGroup>;
export type Item = Spec["items"][number];

export interface Composed {
  kind: DrivePlan["kind"];
  specs: Spec[];
  beaconDue: boolean;
  sealed: number;
  settles: boolean;
  opensPool: boolean;
  finishesMint: boolean;
  locks: boolean;
}

const ZERO_SIG = new Uint8Array(48);

/* SPL Mint: the mint authority is a COption, its tag the first four bytes (1 held, 0 revoked). finish_mint revokes it, so held means the finish is still due. */
export function mintAuthorityHeld(data: Uint8Array | null): boolean {
  return !!data && data.length >= 4 && data[0] === 1 && data[1] === 0 && data[2] === 0 && data[3] === 0;
}

/* What is due, as instruction groups. `beacon` is the round's signature; null sizes the post with zeros. `mintHeld`: the pool's mint still has its authority (finish_mint due). Null when nothing here applies. */
export function composeDrive(launch: Launch, bids: BidAccount[], record: SettlementRecord | null, payer: PublicKey, beacon: Uint8Array | null, mintHeld = false): Composed | null {
  const a = launch.account;
  /* The eleventh candidate: the launch's own byte says finish_mint landed (Launch.mint_finished); the keeper asks both. */
  const finishDue = mintHeld && !a.mintFinished;
  const key = new PublicKey(launch.id);
  const creator = new PublicKey(a.creator);
  const mint = mintPda(creator, a.mintSalt);
  const settlement = settlementPda(key);
  const vault = vaultPda(key);

  const finishIx = () => finishMintIx({ launch: key, vault, tokenMint: mint, metadata: metadataPda(mint), payer, creator });
  const poolSpec = (createPool: boolean, finish: boolean, pool: PublicKey, poolPayer: PublicKey) => {
    const platformNft = positionNftMintPda(key, 1);
    const creatorNft = positionNftMintPda(key, 0);
    return poolGroup({
      createPool: createPool
        ? createPoolIx(
            {
              launch: key, settlement, vault, tokenMint: mint, tokenVault: tokenVaultPda(key),
              poolCreator: poolCreatorPda(key), poolWsol: poolWsolPda(key), poolTokens: poolTokensPda(key), payer,
              platformNftMint: platformNft, platformNftAccount: positionNftAccountPda(platformNft), platformPosition: positionPda(platformNft),
              pool, tokenAVault: meteoraVaultPda(mint, pool), tokenBVault: meteoraVaultPda(WSOL_MINT, pool),
              /* 0.28: the raise fee's two destinations, the launch's own creator and, v0.30, its treasury (lp_owner before 0.30). */
              creatorWallet: creator, treasury: new PublicKey(poolTreasury(a)),
            },
            { creator, mintSalt: a.mintSalt },
          )
        : null,
      finishMint: finish ? finishIx() : null,
      lockLiquidity: lockLiquidityIx({
        launch: key, settlement, vault, poolCreator: poolCreatorPda(key), payer, creator,
        creatorNftMint: creatorNft, creatorNftAccount: positionNftAccountPda(creatorNft), creatorPosition: positionPda(creatorNft), creatorNftAta: ataFor(creator, creatorNft, TOKEN_2022_PROGRAM),
        platformNftMint: platformNft, platformPosition: positionPda(platformNft), platformNftAccount: positionNftAccountPda(platformNft),
        /* The twelfth candidate: after release_pool_cash the pass through is gone and the slot takes the program id. */
        pool, poolPayer, poolWsol: record?.cashReleased ? null : poolWsolPda(key),
      }),
    });
  };

  if (a.state === "open" || a.state === "closed") {
    if (a.state === "open" && a.totalDeposits < a.floorValue) return null;
    const beaconDue = !a.beaconPosted;
    const sealed = bids.filter((b) => b.state === "sealed");
    const complete = a.revealedCount + a.invalidCount + sealed.length === a.bidCount;
    if (!beaconDue && sealed.length === 0 && !complete) return null;
    const reveals = chunk(sealed, REVEAL_MAX).map((c) =>
      revealItem(
        revealIx({ launch: key, vault, processor: payer, histogram: histogramPda(key) }, c.map((b) => new PublicKey(b.address))),
        c.length,
      ),
    );
    const specs: Spec[] = [
      beaconGroup({
        postBeacon: beaconDue ? postBeaconIx({ launch: key }, beacon ?? ZERO_SIG) : null,
        reveals,
        settle: complete ? settleIx({ launch: key, settlement, payer, creatorBid: a.creatorHasBid ? bidPda(key, creator) : null, vault, histogram: histogramPda(key) }) : null,
      }),
    ];
    if (complete) specs.push(poolSpec(true, true, meteoraPoolPda(mint), payer));
    return { kind: "finish", specs, beaconDue, sealed: sealed.length, settles: complete, opensPool: complete, finishesMint: complete, locks: complete };
  }
  if (a.state === "settled") {
    return { kind: "pool", specs: [poolSpec(true, true, meteoraPoolPda(mint), payer)], beaconDue: false, sealed: 0, settles: false, opensPool: true, finishesMint: true, locks: true };
  }
  if (a.state === "poolLive" && record && record.pool && record.poolPayer && record.lpLockState !== 3) {
    return { kind: "lock", specs: [poolSpec(false, finishDue, new PublicKey(record.pool), new PublicKey(record.poolPayer))], beaconDue: false, sealed: 0, settles: false, opensPool: false, finishesMint: finishDue, locks: true };
  }
  if ((a.state === "poolLive" || a.state === "finalized") && finishDue) {
    return { kind: "mint", specs: [poolGroup({ createPool: null, finishMint: finishIx(), lockLiquidity: null })], beaconDue: false, sealed: 0, settles: false, opensPool: false, finishesMint: true, locks: false };
  }
  return null;
}

/* The lookup table as the chain holds it (read by the client), or as this build knows it (for sizing), or none for a signer that takes legacy only. */
export function sizingTable(signer: Pick<TxSigner, "supportsV0"> | null, genesis: string | null): AddressLookupTableAccount | null {
  const addr = signer?.supportsV0 ? lookupTableFor(genesis) : null;
  return addr ? localTable(new PublicKey(addr), [...LOOKUP_ADDRESSES]) : null;
}

/* The plan for the page, without the chain: what the press does, in how many transactions and prompts, and what it fronts. */
export function drivePlan(launch: Launch, bids: BidAccount[], record: SettlementRecord | null, payer: string, signer: TxSigner | null, genesis: string | null, mintHeld = false): DrivePlan | null {
  const who = new PublicKey(payer);
  const c = composeDrive(launch, bids, record, who, null, mintHeld);
  if (!c) return null;
  const alt = sizingTable(signer, genesis);
  const packed = c.specs.flatMap((s) => pack(s, { payer: who, alt, price: 0 }));
  const items = c.specs.flatMap((s) => s.items);
  return {
    kind: c.kind,
    notBefore: c.beaconDue ? bidsOpenAt(launch.account.revealRound) : 0,
    beaconDue: c.beaconDue,
    sealed: c.sealed,
    settles: c.settles,
    opensPool: c.opensPool,
    finishesMint: c.finishesMint,
    locks: c.locks,
    transactions: packed.length,
    prompts: signer?.signAllTransactions || packed.length === 1 ? 1 : packed.length,
    front: BigInt(txFront(items)),
    labels: packed.map((p) => p.label),
  };
}
