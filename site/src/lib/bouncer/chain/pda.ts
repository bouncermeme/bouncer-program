/*
  Every address the site derives, from the pin's seeds and the program ids
  the IDL names on its instruction accounts. Nothing is typed by hand: the
  seeds are SEEDS, the fixed program addresses are read from the pinned
  bouncer.json at the account they appear on.
*/
import { PublicKey } from "@solana/web3.js";
import idl from "@contract/bouncer.json";
import { EXTERNAL, SEEDS } from "@contract/constants";
import { PROGRAM_ID } from "@contract/active";

interface IdlSeed {
  kind: string;
  value?: number[];
  path?: string;
}
interface IdlAccount {
  name: string;
  address?: string;
  pda?: { seeds: IdlSeed[]; program?: { kind: string; value?: number[] } };
}
interface IdlInstruction {
  name: string;
  accounts: IdlAccount[];
}
const INSTRUCTIONS = (idl as unknown as { instructions: IdlInstruction[] }).instructions;

function idlAccount(instruction: string, account: string): IdlAccount {
  const ins = INSTRUCTIONS.find((i) => i.name === instruction);
  const acc = ins?.accounts.find((a) => a.name === account);
  if (!acc) throw new Error(`pinned IDL has no account ${account} on ${instruction}`);
  return acc;
}

/* A fixed program id the IDL names on an instruction account. */
export function idlAddress(instruction: string, account: string): PublicKey {
  const acc = idlAccount(instruction, account);
  if (!acc.address) throw new Error(`pinned IDL: ${instruction}.${account} has no fixed address`);
  return new PublicKey(acc.address);
}

/* A constant seed the IDL gives on a PDA account, by position. */
function idlConstSeed(instruction: string, account: string, index: number): Uint8Array {
  const acc = idlAccount(instruction, account);
  const seed = acc.pda?.seeds[index];
  if (!seed || seed.kind !== "const" || !seed.value) throw new Error(`pinned IDL: ${instruction}.${account} seed ${index} is not a constant`);
  return Uint8Array.from(seed.value);
}

export const PROGRAM = new PublicKey(PROGRAM_ID);
export const METADATA_PROGRAM = new PublicKey(EXTERNAL.metadataProgram);
/* 0.19 took the token program, the rent sysvar and the metadata account off create_launch; deliver names the token programs (claim did until v0.30 removed it), finish_mint (0.29, the ninth candidate; create_pool until then) the rent sysvar. */
export const TOKEN_PROGRAM = idlAddress("deliver", "token_program");
export const SYSTEM_PROGRAM = idlAddress("create_launch", "system_program");
export const RENT_SYSVAR = idlAddress("finish_mint", "rent");
export const ASSOCIATED_TOKEN_PROGRAM = idlAddress("deliver", "associated_token_program");

const utf8 = (s: string) => new TextEncoder().encode(s);
const pda = (seeds: Uint8Array[], program: PublicKey = PROGRAM) => PublicKey.findProgramAddressSync(seeds, program)[0];

export function configPda(): PublicKey {
  return pda([utf8(SEEDS.config)]);
}

/* v0.30: the platform's fee vault, PDA ["fee_vault"]: the platform position's fee owner (Config.lp_owner on a 0.30 deployment), which splits what it collects 60/40 between the treasury and the burn vault. No key holds it. */
export function feeVaultPda(): PublicKey {
  return pda([utf8(SEEDS.feeVault)]);
}
export function launchPda(tokenMint: PublicKey): PublicKey {
  return pda([utf8(SEEDS.launch), tokenMint.toBytes()]);
}
/* 0.19: the launch token's mint is ["mint", creator, mint_salt as u64 little endian]. Nothing exists there until create_pool. */
export function mintPda(creator: PublicKey, mintSalt: bigint): PublicKey {
  const salt = new Uint8Array(8);
  new DataView(salt.buffer).setBigUint64(0, mintSalt, true);
  return pda([utf8(SEEDS.mint), creator.toBytes(), salt]);
}
export function vaultPda(launch: PublicKey): PublicKey {
  return pda([utf8(SEEDS.vault), launch.toBytes()]);
}
export function tokenVaultPda(launch: PublicKey): PublicKey {
  return pda([utf8(SEEDS.tokenVault), launch.toBytes()]);
}
export function bidPda(launch: PublicKey, bidder: PublicKey): PublicKey {
  return pda([utf8(SEEDS.bid), launch.toBytes(), bidder.toBytes()]);
}
/* How many bumps the program's init misses before it finds this bid account's (255 down to the bump): what commit's compute grows with (terms.ts commitComputeUnits). */
export function bidBumpMisses(launch: PublicKey, bidder: PublicKey): number {
  return 255 - PublicKey.findProgramAddressSync([utf8(SEEDS.bid), launch.toBytes(), bidder.toBytes()], PROGRAM)[1];
}
export function settlementPda(launch: PublicKey): PublicKey {
  return pda([utf8(SEEDS.settlement), launch.toBytes()]);
}
/* 0.29: the Instructions sysvar, which commit reads to find the Ed25519 attestation just before it (passed whether or not the launch requires one). */
export const INSTRUCTIONS_SYSVAR = new PublicKey("Sysvar1nstructions1111111111111111111111111");
/* 0.29: the Ed25519 signature-verify precompile; its instruction carries the attestation. */
export const ED25519_PROGRAM = new PublicKey("Ed25519SigVerify111111111111111111111111111");
/* 0.29: the launch's histogram, ["hist", launch]: created by create_launch, grown by grow_histogram, written by reveal, read by settle, never closed. */
export function histogramPda(launch: PublicKey): PublicKey {
  return pda([utf8(SEEDS.hist), launch.toBytes()]);
}
/* Metaplex's metadata account for a mint: the IDL gives the seed and the program on finish_mint's metadata account (create_pool's until the ninth 0.29 candidate, create_launch's until 0.18). */
export function metadataPda(tokenMint: PublicKey): PublicKey {
  const prefix = idlConstSeed("finish_mint", "metadata", 0);
  const program = new PublicKey(idlConstSeed("finish_mint", "metadata", 1));
  return pda([prefix, program.toBytes(), tokenMint.toBytes()], program);
}
/* The associated token account, derived the standard way under the program the IDL names. */
export function ataAddress(owner: PublicKey, tokenMint: PublicKey): PublicKey {
  return pda([owner.toBytes(), TOKEN_PROGRAM.toBytes(), tokenMint.toBytes()], ASSOCIATED_TOKEN_PROGRAM);
}

export function parsePubkey(s: string): PublicKey | null {
  try {
    return new PublicKey(s);
  } catch {
    return null;
  }
}

/*
  The pool steps (create_pool, lock_liquidity, burn_unsold), INTERFACE v0.21.
  Our PDAs come from the seeds the IDL gives on those instructions; the
  cp-amm PDAs the IDL leaves open (the pool and its two vaults) use the
  derivation of the Rust smoke client that landed every devnet pool of the
  0.21 soak (gt-vec-client smoke.rs, Met::new). Fixed addresses are the IDL's.
*/
export const CP_AMM_PROGRAM = idlAddress("create_pool", "cp_amm_program");
export const METEORA_CONFIG = idlAddress("create_pool", "meteora_config");
export const POOL_AUTHORITY = idlAddress("create_pool", "pool_authority");
export const EVENT_AUTHORITY = idlAddress("create_pool", "event_authority");
export const TOKEN_2022_PROGRAM = idlAddress("create_pool", "token_2022_program");
export const WSOL_MINT = idlAddress("create_pool", "wsol_mint");
export const TOKEN_METADATA_PROGRAM = idlAddress("finish_mint", "token_metadata_program");

export function poolCreatorPda(launch: PublicKey): PublicKey {
  return pda([idlConstSeed("create_pool", "pool_creator", 0), launch.toBytes()]);
}
export function poolWsolPda(launch: PublicKey): PublicKey {
  return pda([idlConstSeed("create_pool", "payer_wsol", 0), launch.toBytes()]);
}
export function poolTokensPda(launch: PublicKey): PublicKey {
  return pda([idlConstSeed("create_pool", "payer_tokens", 0), launch.toBytes()]);
}
/* ["position_nft", launch, which]: 1 the platform's position, 0 the creator's (INTERFACE create_pool, lock_liquidity). */
export function positionNftMintPda(launch: PublicKey, which: 0 | 1): PublicKey {
  return pda([utf8("position_nft"), launch.toBytes(), Uint8Array.of(which)]);
}
/* cp-amm's PDAs for a position, seeds and program from the IDL (create_pool.platform_nft_account, platform_position). */
export function positionNftAccountPda(nftMint: PublicKey): PublicKey {
  return pda([idlConstSeed("create_pool", "platform_nft_account", 0), nftMint.toBytes()], CP_AMM_PROGRAM);
}
export function positionPda(nftMint: PublicKey): PublicKey {
  return pda([idlConstSeed("create_pool", "platform_position", 0), nftMint.toBytes()], CP_AMM_PROGRAM);
}
/* cp-amm ["pool", config, max(mint, wsol), min(mint, wsol)], compared as 32 raw bytes. */
export function meteoraPoolPda(tokenMint: PublicKey): PublicKey {
  const a = tokenMint.toBytes();
  const b = WSOL_MINT.toBytes();
  let cmp = 0;
  for (let i = 0; i < 32 && cmp === 0; i++) cmp = a[i] - b[i];
  const [hi, lo] = cmp > 0 ? [a, b] : [b, a];
  return pda([utf8("pool"), METEORA_CONFIG.toBytes(), hi, lo], CP_AMM_PROGRAM);
}
export function meteoraVaultPda(mint: PublicKey, pool: PublicKey): PublicKey {
  return pda([utf8("token_vault"), mint.toBytes(), pool.toBytes()], CP_AMM_PROGRAM);
}
/* An associated token account under a given token program (Token-2022 for the LP position NFTs). */
export function ataFor(owner: PublicKey, mint: PublicKey, tokenProgram: PublicKey): PublicKey {
  return pda([owner.toBytes(), tokenProgram.toBytes(), mint.toBytes()], ASSOCIATED_TOKEN_PROGRAM);
}
