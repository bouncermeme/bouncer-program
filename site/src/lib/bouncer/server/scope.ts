/*
  Bouncer-only reads (Astra's review of candidate-2026-10-17c, the founder's
  requirement): the site spends RPC credits on Bouncer data and nothing
  else. The RPC route checked each call by method and argument shape, so an
  unrelated wallet's balance, another token's mint, a stranger's signature
  list or any transaction could be read through the site's keyed endpoint
  and counted against the shared cap. Here every call is checked by
  ACCOUNT before any paid call: what is asked must be the program, its
  fixed companions, a launch the program created, an account derived from
  one (its record, vaults, mint, metadata, pool, position accounts), or a
  wallet's own accounts in the context of a launch (its bid, its token
  account for a launch's mint); a signature must be one this site handed
  out or one the caller proves with the signed Bouncer transaction it
  belongs to; a transaction must call the program (or the pool program on
  one of the program's pools). Everything else is refused with a fixed
  sentence and nothing is forwarded.

  How the server knows the launches: one scan of the program's Launch
  accounts (keys and the token mint field, a getProgramAccounts on the
  Bouncer program, 10 credits), on a miss and at most once per SCAN_FLOOR_MS
  per instance: the only paid call a stranger's probe can cause, and it
  reads Bouncer data. Derived accounts are computed, never read: the PDAs
  of a launch and its mint, every kind for every launch the program created
  (the founder's rule after candidate-2026-10-17d, whose board could not read a
  launch's mint and metadata: the site must show everything it needs, the
  filter only keeps out what it does not): derived once per launch per
  instance on the first miss and remembered, so a repeat costs a lookup.
  The wallet kinds (a bid, token accounts) are derived per wallet over the
  same launches. A launch the browser just created is named by its
  derivation (creator and salt), which this module checks arithmetically,
  so the creator's page works before the next scan.

  Signatures: the route learns the ones it hands out (a send's result, a
  signature list of an allowed address). A browser that lands on another
  instance proves a sent transaction by attaching it, signed
  (x-bouncer-sent): the first signature must be the one asked, the message
  must pass the transaction rule, and the Ed25519 signature must verify
  under the fee payer, so the signature can only belong to that Bouncer
  transaction. A signature from an allowed address's list is re-learned by
  reading that address's newest 1,000 signatures (x-bouncer-scope f=), a
  Bouncer read, at most once per SIGS_FLOOR_MS per address.

  The headers prove nothing by themselves and open nothing beyond this
  module's arithmetic: a wallet header lets a caller read that wallet's
  lamports and its accounts derived with a known launch, one wallet per
  request. Nothing here names what it hears; a refusal is a boolean to the
  route, which answers the policy's fixed sentence.
*/
import { PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import { createPublicKey, verify as verifySignature } from "node:crypto";
import { ACCOUNTS } from "@contract/constants";
import { LOOKUP_TABLES } from "../chain/lookupTables";
import { decodeTransaction, type DecodedTransaction } from "../chain/txScope";
import {
  ASSOCIATED_TOKEN_PROGRAM,
  bidPda,
  configPda,
  CP_AMM_PROGRAM,
  EVENT_AUTHORITY,
  launchPda,
  metadataPda,
  METEORA_CONFIG,
  meteoraPoolPda,
  meteoraVaultPda,
  mintPda,
  POOL_AUTHORITY,
  poolCreatorPda,
  poolTokensPda,
  poolWsolPda,
  positionNftAccountPda,
  positionNftMintPda,
  positionPda,
  RENT_SYSVAR,
  histogramPda,
  ED25519_PROGRAM,
  INSTRUCTIONS_SYSVAR,
  settlementPda,
  SYSTEM_PROGRAM,
  TOKEN_2022_PROGRAM,
  TOKEN_METADATA_PROGRAM,
  TOKEN_PROGRAM,
  tokenVaultPda,
  vaultPda,
  WSOL_MINT,
  ataFor,
} from "../chain/pda";
import { isBudgetExhausted, meteredFetch } from "./budget";
import { DEPLOYMENT as deployment } from "@contract/active";

/* A read that reached a launch endpoint for an address that is not one of the program's launches. */
export class OutOfScope extends Error {
  constructor() {
    super("not a launch of this program");
    this.name = "OutOfScope";
  }
}

const PROGRAM_ID: string = deployment.program_id;
const PROGRAM_DATA: string = deployment.program_data_account;
const COMPUTE_BUDGET = "ComputeBudget111111111111111111111111111111";
const CLOCK_SYSVAR = "SysvarC1ock11111111111111111111111111111111";
const LOADER = "BPFLoaderUpgradeab1e11111111111111111111111";
const B58 = /^[1-9A-HJ-NP-Za-km-z]+$/;
const SCAN_FLOOR_MS = 15_000;
const SIGS_FLOOR_MS = 10_000;
const UPSTREAM_MS = 10_000;
const MAX_HINT_LAUNCHES = 16;
const MAX_HINT_DERIVATIONS = 2;
const MAX_PROOFS = 2;
const MAX_SCOPE_HEADER = 1_500;
const MAX_SENT_HEADER = 4_000;
const MAX_HANDED = 20_000;
/* The derivation memo's bound; the resolved set itself is the index of every derived account (about 21 a launch, 5 more per wallet and launch) and is not trimmed. */
const MAX_DERIVED = 400_000;
const MAX_WALLETS = 500;

/* The program ids a transaction sent through the site may call: the program and the programs its instructions and the pool steps compose. 0.29: the Ed25519 precompile, whose instruction carries the bid attestation just before commit. */
const ALLOWED_PROGRAMS: ReadonlySet<string> = new Set([PROGRAM_ID, SYSTEM_PROGRAM.toBase58(), TOKEN_PROGRAM.toBase58(), TOKEN_2022_PROGRAM.toBase58(), ASSOCIATED_TOKEN_PROGRAM.toBase58(), CP_AMM_PROGRAM.toBase58(), TOKEN_METADATA_PROGRAM.toBase58(), COMPUTE_BUDGET, ED25519_PROGRAM.toBase58()]);
/* Accounts any visitor may read: the program, its data account and Config, the programs above, the pool program's fixed accounts, the sysvars, the lookup tables. Not the wrapped-SOL mint: no page reads it, and Astra's probe names it as unrelated. */
const FIXED: ReadonlySet<string> = new Set([...ALLOWED_PROGRAMS, PROGRAM_DATA, configPda().toBase58(), deployment.config.address, RENT_SYSVAR.toBase58(), CLOCK_SYSVAR, INSTRUCTIONS_SYSVAR.toBase58(), LOADER, METEORA_CONFIG.toBase58(), POOL_AUTHORITY.toBase58(), EVENT_AUTHORITY.toBase58(), ...Object.values(LOOKUP_TABLES)]);

export const isPubkey = (s: unknown): s is string => {
  if (typeof s !== "string" || s.length < 32 || s.length > 44 || !B58.test(s)) return false;
  try {
    return bs58.decode(s).length === 32;
  } catch {
    return false;
  }
};
export const isSignature = (s: unknown): s is string => {
  if (typeof s !== "string" || s.length < 86 || s.length > 88 || !B58.test(s)) return false;
  try {
    return bs58.decode(s).length === 64;
  } catch {
    return false;
  }
};

/* ---- what the browser says about its context ---- */

export interface ScopeHints {
  /* The connected wallet, if any: its lamports and its accounts derived with a known launch may be read. */
  wallet: string | null;
  /* Launch ids in view. Each is checked against the known set (or derivable) before it opens anything. */
  launches: string[];
  /* A launch named by its derivation: launchPda(mintPda(creator, salt)), for a launch created a moment ago. */
  derivations: { creator: string; salt: bigint }[];
  /* The allowed address whose signature list the asked signatures came from. */
  from: string | null;
  /* Signed transactions the browser sent, for their signatures' status and read-back on another instance. */
  sent: { signature: string; bytes: string }[];
}
export const NO_HINTS: ScopeHints = { wallet: null, launches: [], derivations: [], from: null, sent: [] };

/* x-bouncer-scope: w=<wallet>;l=<launch>,<launch>;m=<creator>:<salt>;f=<address>. x-bouncer-sent: <signature>.<base64>,... Anything malformed is dropped, never refused. */
export function parseHints(headers: Headers | null | undefined): ScopeHints {
  const out: ScopeHints = { wallet: null, launches: [], derivations: [], from: null, sent: [] };
  if (!headers) return out;
  const scope = headers.get("x-bouncer-scope") ?? "";
  if (scope.length > 0 && scope.length <= MAX_SCOPE_HEADER) {
    for (const part of scope.split(";")) {
      const eq = part.indexOf("=");
      if (eq <= 0) continue;
      const k = part.slice(0, eq).trim();
      const v = part.slice(eq + 1).trim();
      if (k === "w" && isPubkey(v)) out.wallet = v;
      else if (k === "f" && isPubkey(v)) out.from = v;
      else if (k === "l") {
        for (const id of v.split(",")) if (isPubkey(id) && out.launches.length < MAX_HINT_LAUNCHES && !out.launches.includes(id)) out.launches.push(id);
      } else if (k === "m") {
        for (const d of v.split(",")) {
          const [creator, salt] = d.split(":");
          if (isPubkey(creator) && /^\d{1,20}$/.test(salt ?? "") && out.derivations.length < MAX_HINT_DERIVATIONS) {
            const n = BigInt(salt);
            if (n <= 0xffffffffffffffffn) out.derivations.push({ creator, salt: n });
          }
        }
      }
    }
  }
  const sent = headers.get("x-bouncer-sent") ?? "";
  if (sent.length > 0 && sent.length <= MAX_SENT_HEADER) {
    for (const item of sent.split(",")) {
      const dot = item.indexOf(".");
      if (dot <= 0 || out.sent.length >= MAX_PROOFS) continue;
      const signature = item.slice(0, dot).trim();
      const bytes = item.slice(dot + 1).trim();
      if (isSignature(signature) && bytes.length <= 1_800 && /^[A-Za-z0-9+/]+={0,2}$/.test(bytes)) out.sent.push({ signature, bytes });
    }
  }
  return out;
}

/* ---- the launches ---- */

/* Launch id to token mint: from the scan, and from a derivation a request proved (or a check primed). */
const known = new Map<string, string>();
const proven = new Map<string, string>();
const mints = new Set<string>();
let lastScanAt = 0;
/* Whether a scan on this instance ever answered with the list (24d): the board is not served from an empty set it never read. */
let listed = false;
let scanning: Promise<void> | null = null;
let clock: () => number = Date.now;

const upstreamUrl = (): string | null => process.env.RPC_UPSTREAM || process.env.BOARD_RPC_UPSTREAM || null;
const isKnownLaunch = (id: string): boolean => known.has(id) || proven.has(id);

function remember(target: Map<string, string>, launch: string, mint: string): void {
  target.set(launch, mint);
  mints.add(mint);
}

/*
  The scan: every Launch account's key and token mint, through the metered
  fetch (10 credits to the day; BudgetExhausted propagates to the caller,
  which answers the budget's refusal). An answer that is not the list is
  ignored: nothing it says is kept or logged, and the floor still applies.
*/
async function scan(): Promise<void> {
  const url = upstreamUrl();
  if (!url) return;
  const body = {
    jsonrpc: "2.0",
    id: 1,
    method: "getProgramAccounts",
    params: [PROGRAM_ID, { encoding: "base64", commitment: "confirmed", dataSlice: { offset: ACCOUNTS.Launch.fields.token_mint.offset, length: 32 }, filters: [{ dataSize: ACCOUNTS.Launch.len }, { memcmp: { offset: 0, bytes: bs58.encode(Uint8Array.from(ACCOUNTS.Launch.discriminator)) } }] }],
  };
  let json: unknown = null;
  try {
    const res = await meteredFetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), cache: "no-store", signal: AbortSignal.timeout(UPSTREAM_MS) });
    if (!res.ok) return;
    json = await res.json();
  } catch (e) {
    /* The upstream unreachable, late or unreadable: nothing learned, nothing said; the budget's own refusal is the caller's to answer. */
    if (isBudgetExhausted(e)) throw e;
    return;
  }
  const list = (json as { result?: unknown } | null)?.result;
  if (!Array.isArray(list)) return;
  listed = true;
  for (const item of list) {
    const pubkey = (item as { pubkey?: unknown } | null)?.pubkey;
    const data = (item as { account?: { data?: unknown } } | null)?.account?.data;
    const b64 = Array.isArray(data) ? data[0] : typeof data === "string" ? data : null;
    if (!isPubkey(pubkey) || typeof b64 !== "string") continue;
    const bytes = Buffer.from(b64, "base64");
    if (bytes.length !== 32) continue;
    remember(known, pubkey, new PublicKey(bytes).toBase58());
  }
}

/* Scan once per floor per instance, callers of the same moment sharing one. Returns whether a scan ran. */
async function scanIfDue(): Promise<boolean> {
  const now = clock();
  if (scanning) {
    await scanning;
    return true;
  }
  if (now - lastScanAt < SCAN_FLOOR_MS) return false;
  lastScanAt = now;
  scanning = scan().finally(() => {
    scanning = null;
  });
  await scanning;
  return true;
}

/* A derivation hint checked arithmetically: the launch of mintPda(creator, salt). Proven launches stay known on this instance. */
function proveDerivations(hints: ScopeHints): string[] {
  const out: string[] = [];
  for (const d of hints.derivations) {
    try {
      const mint = mintPda(new PublicKey(d.creator), d.salt);
      const launch = launchPda(mint).toBase58();
      remember(proven, launch, mint.toBase58());
      out.push(launch);
    } catch {
      /* not a key: dropped */
    }
  }
  return out;
}

/* 24d: every launch the scans found or a request proved (server/snapshot.ts readBoard), the scan run first when one is due (at most once per SCAN_FLOOR_MS per instance). BudgetExhausted propagates. */
export async function knownLaunches(): Promise<string[]> {
  await scanIfDue();
  if (!listed) throw new Error("the launch list was never read on this instance");
  return [...new Set([...known.keys(), ...proven.keys()])];
}

/* Whether an id is one of the program's launches: known, derivable from the hints, or found by a scan when one is due. BudgetExhausted propagates. */
export async function isLaunch(id: string, hints: ScopeHints = NO_HINTS): Promise<boolean> {
  if (!isPubkey(id)) return false;
  if (isKnownLaunch(id)) return true;
  if (proveDerivations(hints).includes(id)) return true;
  if (await scanIfDue()) return isKnownLaunch(id);
  return false;
}

/* ---- the accounts derived from a launch ---- */

type LaunchKind = "record" | "histogram" | "vault" | "tokenVault" | "poolCreator" | "poolWsol" | "poolTokens" | "pool" | "metadata" | "nft0" | "nft1" | "poolVaultToken" | "poolVaultWsol" | "nftAccount0" | "nftAccount1" | "position0" | "position1";
type WalletKind = "bid" | "ata" | "ata2022" | "nftAta0" | "nftAta1";
const LAUNCH_KINDS: readonly LaunchKind[] = ["record", "histogram", "pool", "metadata", "vault", "tokenVault", "poolCreator", "poolWsol", "poolTokens", "nft0", "nft1", "poolVaultToken", "poolVaultWsol", "nftAccount0", "nftAccount1", "position0", "position1"];
/* The wallet's bid, its token account for the launch's mint under either token program, its position NFT accounts. */
const WALLET_KINDS: readonly WalletKind[] = ["bid", "ata", "ata2022", "nftAta0", "nftAta1"];

const derived = new Map<string, string>();
/* Addresses proven to be a launch's or a wallet-and-launch's account: Bouncer data whoever asks next. */
const resolved = new Set<string>();
const walletAtas = new Map<string, string>();

function bounded<K, V>(m: Map<K, V>, max: number): void {
  if (m.size <= max) return;
  const drop = Math.ceil(max / 10);
  let i = 0;
  for (const k of m.keys()) {
    if (i++ >= drop) break;
    m.delete(k);
  }
}

function deriveLaunchKind(kind: LaunchKind, launchId: string, mintId: string): string {
  const key = `${kind}|${launchId}`;
  const hit = derived.get(key);
  if (hit) return hit;
  const launch = new PublicKey(launchId);
  const mint = new PublicKey(mintId);
  let out: PublicKey;
  switch (kind) {
    case "record":
      out = settlementPda(launch);
      break;
    /* 0.29: the per-tick deposits, read by the settlement page, written by the drive's reveal and settle. */
    case "histogram":
      out = histogramPda(launch);
      break;
    case "vault":
      out = vaultPda(launch);
      break;
    case "tokenVault":
      out = tokenVaultPda(launch);
      break;
    case "poolCreator":
      out = poolCreatorPda(launch);
      break;
    case "poolWsol":
      out = poolWsolPda(launch);
      break;
    case "poolTokens":
      out = poolTokensPda(launch);
      break;
    case "pool":
      out = meteoraPoolPda(mint);
      break;
    case "metadata":
      out = metadataPda(mint);
      break;
    case "nft0":
      out = positionNftMintPda(launch, 0);
      break;
    case "nft1":
      out = positionNftMintPda(launch, 1);
      break;
    case "poolVaultToken":
      out = meteoraVaultPda(mint, new PublicKey(deriveLaunchKind("pool", launchId, mintId)));
      break;
    case "poolVaultWsol":
      out = meteoraVaultPda(WSOL_MINT, new PublicKey(deriveLaunchKind("pool", launchId, mintId)));
      break;
    case "nftAccount0":
      out = positionNftAccountPda(new PublicKey(deriveLaunchKind("nft0", launchId, mintId)));
      break;
    case "nftAccount1":
      out = positionNftAccountPda(new PublicKey(deriveLaunchKind("nft1", launchId, mintId)));
      break;
    case "position0":
      out = positionPda(new PublicKey(deriveLaunchKind("nft0", launchId, mintId)));
      break;
    case "position1":
      out = positionPda(new PublicKey(deriveLaunchKind("nft1", launchId, mintId)));
      break;
  }
  const s = out.toBase58();
  derived.set(key, s);
  bounded(derived, MAX_DERIVED);
  return s;
}

function deriveWalletKind(kind: WalletKind, launchId: string, mintId: string, walletId: string): string {
  const key = `${kind}|${launchId}|${walletId}`;
  const hit = derived.get(key);
  if (hit) return hit;
  const launch = new PublicKey(launchId);
  const wallet = new PublicKey(walletId);
  let out: PublicKey;
  switch (kind) {
    case "bid":
      out = bidPda(launch, wallet);
      break;
    case "ata":
      out = ataFor(wallet, new PublicKey(mintId), TOKEN_PROGRAM);
      break;
    case "ata2022":
      out = ataFor(wallet, new PublicKey(mintId), TOKEN_2022_PROGRAM);
      break;
    case "nftAta0":
      out = ataFor(wallet, new PublicKey(deriveLaunchKind("nft0", launchId, mintId)), TOKEN_2022_PROGRAM);
      break;
    case "nftAta1":
      out = ataFor(wallet, new PublicKey(deriveLaunchKind("nft1", launchId, mintId)), TOKEN_2022_PROGRAM);
      break;
  }
  const s = out.toBase58();
  derived.set(key, s);
  bounded(derived, MAX_DERIVED);
  return s;
}

function walletWsolAta(wallet: string): string {
  const hit = walletAtas.get(wallet);
  if (hit) return hit;
  const s = ataFor(new PublicKey(wallet), WSOL_MINT, TOKEN_PROGRAM).toBase58();
  walletAtas.set(wallet, s);
  bounded(walletAtas, MAX_WALLETS);
  return s;
}

function resolve(address: string): true {
  resolved.add(address);
  return true;
}

/* The request's context: the wallet and the launches whose derived accounts may be asked. */
export interface ScopeContext {
  wallet: string | null;
  candidates: string[];
}

/* The launches a request names, each checked: the hinted ids that are known (a scan when one is due), the derivations proven, and known launches among the request's own keys. */
export async function contextOf(hints: ScopeHints, keysInRequest: readonly string[] = []): Promise<ScopeContext> {
  const candidates = new Set<string>();
  for (const id of proveDerivations(hints)) candidates.add(id);
  let scanned = false;
  for (const id of hints.launches) {
    if (!isKnownLaunch(id) && !scanned) {
      await scanIfDue();
      scanned = true;
    }
    if (isKnownLaunch(id)) candidates.add(id);
  }
  for (const k of keysInRequest) if (isKnownLaunch(k)) candidates.add(k);
  return { wallet: hints.wallet, candidates: [...candidates] };
}

/* For each kind, the launches already derived into `resolved`; for each wallet, the same per wallet kind. */
const sweptByKind = new Map<LaunchKind, Set<string>>();
const sweptByWallet = new Map<string, Map<WalletKind, Set<string>>>();

/* One kind over every known launch into the resolved set, the launches not yet derived for it (about 0.7 ms each; 146 devnet launches are a tenth of a second a kind). */
function sweepKind(kind: LaunchKind): void {
  let done = sweptByKind.get(kind);
  if (!done) {
    done = new Set<string>();
    sweptByKind.set(kind, done);
  }
  for (const [launch, mint] of [...known, ...proven]) {
    if (done.has(launch)) continue;
    resolve(deriveLaunchKind(kind, launch, mint));
    done.add(launch);
  }
}

/* One wallet kind over every known launch for the context wallet. */
function sweepWalletKind(wallet: string, kind: WalletKind): void {
  let byKind = sweptByWallet.get(wallet);
  if (!byKind) {
    byKind = new Map<WalletKind, Set<string>>();
    sweptByWallet.set(wallet, byKind);
    bounded(sweptByWallet, MAX_WALLETS);
  }
  let done = byKind.get(kind);
  if (!done) {
    done = new Set<string>();
    byKind.set(kind, done);
  }
  for (const [launch, mint] of [...known, ...proven]) {
    if (done.has(launch)) continue;
    resolve(deriveWalletKind(kind, launch, mint, wallet));
    done.add(launch);
  }
}

/*
  An address derived from a launch (or from the context wallet and a
  launch), over every launch the program created: kind by kind, the kinds
  the pages read most first, stopping at the first that holds the address.
  A stranger costs every kind once per instance; after that a lookup.
*/
function derivedAllowed(address: string, ctx: ScopeContext): boolean {
  if (resolved.has(address)) return true;
  for (const kind of LAUNCH_KINDS) {
    sweepKind(kind);
    if (resolved.has(address)) return true;
  }
  if (ctx.wallet) {
    for (const kind of WALLET_KINDS) {
      sweepWalletKind(ctx.wallet, kind);
      if (resolved.has(address)) return true;
    }
  }
  return false;
}

/*
  Whether an account may be read: fixed, a launch, a mint, derived, or the
  context's wallet and its wrapped-SOL account. `forSignatures`: a signature
  list is read for launches and derived accounts only, never for a wallet
  or a fixed account. A miss asks for a scan when one is due and looks
  again.
*/
export async function addressAllowed(address: string, ctx: ScopeContext, forSignatures = false): Promise<boolean> {
  if (!isPubkey(address)) return false;
  const look = (): boolean => {
    if (isKnownLaunch(address)) return true;
    if (!forSignatures) {
      if (FIXED.has(address) || mints.has(address)) return true;
      if (ctx.wallet && (address === ctx.wallet || address === walletWsolAta(ctx.wallet))) return true;
    }
    return derivedAllowed(address, ctx);
  };
  if (look()) return true;
  if (await scanIfDue()) return look();
  return false;
}

/* ---- signatures ---- */

const handed = new Set<string>();
const sigsReadAt = new Map<string, number>();

export function learnSignatures(list: readonly unknown[]): void {
  for (const s of list) {
    if (!isSignature(s)) continue;
    handed.delete(s);
    handed.add(s);
  }
  if (handed.size > MAX_HANDED) {
    let i = 0;
    for (const k of handed) {
      if (i++ >= MAX_HANDED / 10) break;
      handed.delete(k);
    }
  }
}

/* What an upstream answer handed out: a send's signature, a signature list's entries. The answer is parsed for these two shapes and nothing else is kept. */
export function learnFromAnswer(text: string, methodOfId: (id: string) => string | undefined): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return;
  }
  const replies = Array.isArray(parsed) ? parsed : [parsed];
  for (const r of replies) {
    if (!r || typeof r !== "object") continue;
    const { id, result } = r as { id?: unknown; result?: unknown };
    const method = methodOfId(String(id));
    if (method === "sendTransaction" && isSignature(result)) learnSignatures([result]);
    else if (method === "getSignaturesForAddress" && Array.isArray(result)) learnSignatures(result.map((x) => (x as { signature?: unknown } | null)?.signature));
  }
}

/* Re-learn an allowed address's newest signatures (a Bouncer read, 1 credit), once per floor per address. */
async function refreshSignaturesOf(address: string): Promise<void> {
  const url = upstreamUrl();
  const now = clock();
  if (!url || now - (sigsReadAt.get(address) ?? 0) < SIGS_FLOOR_MS) return;
  sigsReadAt.set(address, now);
  bounded(sigsReadAt, 1_000);
  const body = { jsonrpc: "2.0", id: 1, method: "getSignaturesForAddress", params: [address, { limit: 1000, commitment: "confirmed" }] };
  let json: unknown = null;
  try {
    const res = await meteredFetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), cache: "no-store", signal: AbortSignal.timeout(UPSTREAM_MS) });
    if (!res.ok) return;
    json = await res.json();
  } catch (e) {
    if (isBudgetExhausted(e)) throw e;
    return;
  }
  const list = (json as { result?: unknown } | null)?.result;
  if (Array.isArray(list)) learnSignatures(list.map((x) => (x as { signature?: unknown } | null)?.signature));
}

const SPKI_ED25519 = Buffer.from("302a300506032b6570032100", "hex");

/* The proof: the asked signature is the transaction's first, the instructions are ones the site sends, and the signature verifies under the fee payer. */
function proofOk(signature: string, bytes: string, ctx: ScopeContext): boolean {
  const tx = decodeTransaction(bytes);
  if (!tx || tx.signatures.length === 0 || tx.numRequiredSignatures < 1) return false;
  if (bs58.encode(tx.signatures[0]) !== signature) return false;
  if (!instructionsAllowed(tx, ctx)) return false;
  try {
    const key = createPublicKey({ key: Buffer.concat([SPKI_ED25519, Buffer.from(tx.payer.toBytes())]), format: "der", type: "spki" });
    return verifySignature(null, Buffer.from(tx.messageBytes), key, Buffer.from(tx.signatures[0]));
  } catch {
    return false;
  }
}

/* Whether a signature's status or transaction may be read: handed out here, proven by its signed transaction, or in the newest list of the allowed address the caller names. */
export async function signatureAllowed(signature: string, hints: ScopeHints, ctx: ScopeContext): Promise<boolean> {
  if (!isSignature(signature)) return false;
  if (handed.has(signature)) return true;
  for (const p of hints.sent) {
    if (p.signature !== signature) continue;
    if (proofOk(signature, p.bytes, ctx)) {
      learnSignatures([signature]);
      return true;
    }
  }
  if (hints.from && (await addressAllowed(hints.from, ctx, true))) {
    await refreshSignaturesOf(hints.from);
    return handed.has(signature);
  }
  return false;
}

/* ---- transactions ---- */

/* A transaction the site sends: every program called is one of the allowed, and one instruction is the program's or the pool program's on an account derived from a launch. A version 0 message resolves only against the site's own table (chain/txScope.ts). */
function instructionsAllowed(tx: DecodedTransaction, ctx: ScopeContext): boolean {
  if (tx.instructions.length === 0) return false;
  let bouncer = false;
  const poolAccounts: string[] = [];
  for (const ix of tx.instructions) {
    if (!ALLOWED_PROGRAMS.has(ix.program)) return false;
    if (ix.program === PROGRAM_ID) bouncer = true;
    else if (ix.program === CP_AMM_PROGRAM.toBase58()) poolAccounts.push(...ix.accounts);
  }
  if (bouncer) return true;
  return poolAccounts.some((a) => derivedAllowed(a, ctx));
}

export function transactionAllowed(bytes: unknown, ctx: ScopeContext): boolean {
  const tx = decodeTransaction(bytes);
  return tx !== null && instructionsAllowed(tx, ctx);
}

/* ---- the route's question ---- */

type Call = { method?: unknown; params?: unknown };
const paramsOf = (c: Call): unknown[] => (Array.isArray(c.params) ? c.params : []);

/* The launch keys a batch names itself, for the context: a getMultipleAccounts page of launches and records. */
export function keysNamed(calls: readonly Call[]): string[] {
  const out: string[] = [];
  for (const c of calls) {
    const p = paramsOf(c);
    if (c.method === "getMultipleAccounts" && Array.isArray(p[0])) {
      for (const k of p[0]) if (typeof k === "string") out.push(k);
    } else if ((c.method === "getAccountInfo" || c.method === "getBalance") && typeof p[0] === "string") out.push(p[0]);
  }
  return out;
}

/* Whether one checked call (the route's shape check passed) asks for Bouncer data only. Methods without an account or signature are allowed. */
export async function callAllowed(c: Call, hints: ScopeHints, ctx: ScopeContext): Promise<boolean> {
  const p = paramsOf(c);
  switch (c.method) {
    case "getAccountInfo":
    case "getBalance":
    case "getTokenAccountBalance":
      return typeof p[0] === "string" && addressAllowed(p[0], ctx);
    case "getMultipleAccounts": {
      if (!Array.isArray(p[0])) return false;
      for (const k of p[0]) if (typeof k !== "string" || !(await addressAllowed(k, ctx))) return false;
      return true;
    }
    case "getSignaturesForAddress":
      return typeof p[0] === "string" && addressAllowed(p[0], ctx, true);
    case "getSignatureStatuses": {
      if (!Array.isArray(p[0])) return false;
      for (const s of p[0]) if (typeof s !== "string" || !(await signatureAllowed(s, hints, ctx))) return false;
      return true;
    }
    case "getTransaction":
      return typeof p[0] === "string" && signatureAllowed(p[0], hints, ctx);
    case "sendTransaction":
    case "simulateTransaction":
      return transactionAllowed(p[0], ctx);
    case "getProgramAccounts":
      /* The route admits the Bouncer program only. */
      return p[0] === PROGRAM_ID;
    default:
      return true;
  }
}

/* ---- for the checks ---- */

/* Known launches (with their mints) and handed-out signatures a check plants; a primed launch stays known across scans. */
export function primeScope(input: { launches?: { id: string; mint: string }[]; signatures?: string[] } = {}): void {
  for (const l of input.launches ?? []) remember(proven, l.id, l.mint);
  learnSignatures(input.signatures ?? []);
}
export function resetScope(opts: { now?: () => number } = {}): void {
  known.clear();
  proven.clear();
  mints.clear();
  derived.clear();
  resolved.clear();
  sweptByKind.clear();
  sweptByWallet.clear();
  walletAtas.clear();
  handed.clear();
  sigsReadAt.clear();
  lastScanAt = 0;
  listed = false;
  scanning = null;
  clock = opts.now ?? Date.now;
}
export function scopeStatus(): { launches: number; proven: number; resolved: number; handed: number; lastScanAt: number } {
  return { launches: known.size, proven: proven.size, resolved: resolved.size, handed: handed.size, lastScanAt };
}
