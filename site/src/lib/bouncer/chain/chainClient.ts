/*
  The chain client: BouncerClient against the pinned program on the cluster
  the RPC serves. Real accounts, real transactions, real state. Every
  address comes from pda.ts, every byte from decode.ts, every instruction
  from ix.ts; nothing here knows an offset or a discriminator. What only a
  landed transaction proves is listed in STATUS-frontend.md, not assumed
  here.
*/
import { clearPendingSalt, newPendingSalt, pendingSalt } from "./createSalt";
import { ComputeBudgetProgram, Keypair, PublicKey, Transaction, TransactionInstruction, type AccountInfo, type AddressLookupTableAccount } from "@solana/web3.js";
import bs58 from "bs58";
import { ACCOUNTS } from "@contract/constants";
import { roundPointArgs } from "@contract/round-point";
import { bidsOpenAt, CREATE_TAKES_CLOSE_TS, DRAND, REVEAL_MARGIN_MAX_SECS, REVEAL_MARGIN_MIN_SECS, revealRoundFor, roundSignatureUrl, validRevealMargin } from "../beacon";
import { walkFunding, type FundingReport } from "../funding";
import { readWalletAge, type WalletAge } from "../walletAge";
import { KNOWN_WALLETS } from "../knownWallets";
import { rpcFundingProvider } from "../rpcFunding";
import { roundPointMatches, sealTick, tickInRange } from "../seal";
import type { BidAccount, BouncerClient, HistogramAccount, PushStep, CommitInput, CommitResult, ConfigAccount, CreateLaunchInput, Delivery, DrivePlan, DriveResult, HistoryProgress, Launch, LaunchAccount, PoolOpening, SettlementRecord } from "../types";
import { collectParkedTransaction, needsTokenAccount, readTokenTarget, type TokenTarget } from "./parked";
import { TOKEN_ACCOUNT_BYTES } from "./creatorFees";
import { boundedPrice, COMMIT_COMPUTE_UNIT_PRICE, commitComputeUnits, commitFee, CREATE_COMPUTE_UNIT_PRICE, CREATE_COMPUTE_UNITS, CREATE_FEE, CREATE_LOADED_ACCOUNTS_DATA_BYTES, priorityLamports } from "../terms";
import { AttestRefused, attestInstruction, attestReasonText, requestCreatePermit, TURNSTILE_SITE_KEY, type Permit } from "../attest";
import { GENESIS_OTHER_LAMPORTS, SETUP_ACCOUNT_BYTES, setupCost } from "../product";
import { bookOpen, closeAtTs, closeTsFor, poolTreasury, recoverable, WINDOW_MAX_SECS, WINDOW_MIN_SECS } from "../view";
import { assemble, pack, txFront, unitLimit } from "./bundles.mjs";
import { composeDrive, drivePlan, mintAuthorityHeld } from "./drive";
import { lookupTableFor } from "./lookupTables";
import { decodeBid, decodeConfig, decodeHistogram, decodeLaunch, decodeRecord } from "./decode";
import type { DecodedEvent } from "./events";
import { fillCosts, readHistory } from "./history";
import { abortIx, burnUnsoldIx, closeIx, commitIx, createLaunchIx, createPoolIx, deliverIx, finishMintIx, growHistogramIx, lockLiquidityIx, openTradingIx, postBeaconIx, refundIx, revealIx, settleIx } from "./ix";
import { fetchTokenMeta } from "./metadata";
import { ataAddress, ataFor, bidBumpMisses, bidPda, configPda, histogramPda, launchPda, meteoraPoolPda, meteoraVaultPda, metadataPda, mintPda, parsePubkey, poolCreatorPda, poolTokensPda, poolWsolPda, positionNftAccountPda, positionNftMintPda, positionPda, PROGRAM, settlementPda, TOKEN_2022_PROGRAM, tokenVaultPda, vaultPda, WSOL_MINT } from "./pda";
import { fetchWithBackoff, getConnection, getHistoryConnection, hintLaunch, hintLaunchDerivation, rpcHasWebsocket, SITE_ROUTES } from "./rpc";
import { fromJson } from "./json";
import { within } from "../goToLaunch";
import type { AccountBytes, BidsSnapshot, BoardEntry, BoardSnapshot, HistogramSnapshot, LaunchSnapshot, PoolsSnapshot } from "../server/snapshot";
import { readAllPages } from "../bidPages";
import type { LaunchHistory } from "../server/history";
import { sendAndConfirm, sendBatch, setDefaultStatus, TxFailure, type BatchTx, type Effect, type SendContext, type SendOptions, type Sent, type TxSigner } from "./signer";
import { fmtSol, fmtTime } from "../format";
import { balanceChange, commitVerdict } from "./balance";
import { networkNowSec, syncNetworkClock } from "../netClock";

/* The base fee of one signature, lamports, as the runtime charges it today. Only used to word the balance check; the simulation is what refuses. */
const SIGNATURE_FEE = 5_000n;

/* 0.29: grow_histogram alone (a half-made launch): a transfer, a resize to 19,272 bytes and a zero fill. */
const GROW_HISTOGRAM_COMPUTE_UNITS = 100_000;
/* How often a subscribed launch is re-read besides the account subscription: the record and the clock move without the account changing. */
const POLL_MS = 15_000;
/*
  24n (the founder's notes, review/2026-10-26-24n-PLAN.md fixes 1, 3 and 7): through the site a launch that is not final is
  read every 2 s (plus or minus 0.5 s, so a crowd does not ask together), a final one every 15 s (plus up to 3 s); a
  failed read is tried once more after 1 s. The snapshot behind it is shared at the CDN (app/api/launch, 1 s).
*/
export const LIVE_POLL_MS = 2_000;
export const LIVE_POLL_JITTER_MS = 500;
/* 24o (F4, step 2): the jitter only shortens the wait, so a poll is never more than LIVE_POLL_MS after the last. */
export const livePollWait = (random: () => number = Math.random): number => LIVE_POLL_MS - random() * LIVE_POLL_JITTER_MS;
export const RETRY_MS = 1_000;
/* After a payout this page sent: the launch is read again every second, at most this many times, until it shows it. */
export const REFRESH_TRIES = 5;
const TX_READ_TRIES = 5;
const TX_READ_GAP_MS = 1_100;
/* The board: launches read per getMultipleAccounts (with their records, so 100 keys), and how many reads apart the keys-only scan for new launches runs. */
const BOARD_PAGE = 50;
const BOARD_DISCOVER_EVERY = 4;
/* The one state no transaction moves a launch out of, so the board never re-reads one. A failed or aborted launch still moves to finalized once its refunds are out (2026-10-16, GPT-6's A3). */
const LAUNCH_FINAL: ReadonlySet<Launch["account"]["state"]> = new Set(["finalized"]);

interface Sub {
  /* Null tells a listener the RPC holds no launch at this address. */
  listeners: Set<(l: Launch | null) => void>;
  wsId: number | null;
  timer: ReturnType<typeof setInterval> | null;
  onShown?: () => void;
}

/* An account's bytes from the site's endpoints. */
const bytesOf = (a: AccountBytes): Uint8Array => Uint8Array.from(Buffer.from(a.data, "base64"));

/* One event of one transaction: a transaction emits an event of a kind once per bid, or once. */
const eventTag = (e: DecodedEvent) => `${e.signature}:${e.name}:${String(e.data.bid ?? "")}`;

function blankAccount(address: string): LaunchAccount {
  return {
    address,
    state: "finalized",
    settled: false,
    beaconPosted: false,
    creatorHasBid: false,
    creator: PROGRAM.toBase58(),
    tokenMint: PROGRAM.toBase58(),
    tokenVault: PROGRAM.toBase58(),
    float: 0n,
    floorValue: 0n,
    minBid: 0n,
    openTs: 0,
    windowSecs: 0,
    closeTs: 0,
    revealRound: 0n,
    roundPoint: new Uint8Array(48),
    beaconSignature: null,
    totalDeposits: 0n,
    bidCount: 0,
    revealedCount: 0,
    invalidCount: 0,
    distributedCount: 0,
    largestDeposit: 0n,
    lpOwner: PROGRAM.toBase58(),
    abortAfterSecs: 0,
    deliveryFeeBps: 0,
    creatorLpBps: 0,
    bondState: 0,
    crankBond: 0n,
    opsPaid: 0n,
    deliveryTerms: 0,
    deliveryReward: 0n,
    raiseFeeBps: 0,
    raiseFeeCreatorShareBps: 0,
    attestRequired: false,
    processingCharge: 0n,
    histogramRent: 0n,
    attestWaivedTs: 0,
    histogramGrown: false,
    metadataReserve: 0n,
    mintFinished: false,
    mintSalt: 0n,
    meta: null,
  };
}

/*
  The bid's transaction, exactly as sent (scripts/check-v29-site.ts measures
  it). the founder, 2026-10-08: the compute budget set explicitly, so the fee is
  exactly the signatures' (terms.ts, commitFee) and the bid page can take it
  out of what the bidder typed. 0.29: the bot check's Ed25519 instruction
  sits immediately before commit, which reads it at its own index minus one.
*/
export function commitTransaction(k: { launch: PublicKey; bidder: PublicKey; permit: Permit | null; deposit: bigint; sealed: Uint8Array; maxProcessingCharge: bigint; priceMicroLamports?: number }): Transaction {
  const tx = new Transaction().add(
    /* 2026-10-25: 30,000, more for the rare bid account whose bump is found late (terms.ts commitComputeUnits). */
    ComputeBudgetProgram.setComputeUnitLimit({ units: commitComputeUnits(bidBumpMisses(k.launch, k.bidder)) }),
    /* 24e: COMMIT_COMPUTE_UNIT_PRICE (nothing) unless the caller passes the final window's bounded price (terms.ts). */
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: k.priceMicroLamports ?? COMMIT_COMPUTE_UNIT_PRICE }),
    ...(k.permit ? [attestInstruction(k.permit)] : []),
    commitIx({ launch: k.launch, vault: vaultPda(k.launch), bid: bidPda(k.launch, k.bidder), bidder: k.bidder, config: configPda() }, { deposit: k.deposit, sealed: k.sealed, commitment: new Uint8Array(32), flags: 0 /* v0.30: bit 0 (claim) is refused, ClaimRemoved */, maxProcessingCharge: k.maxProcessingCharge }),
  );
  tx.feePayer = k.bidder;
  return tx;
}

/* 24e (bug A): reads of a confirmed commit's bid account before its outcome is left unknown, and the wait before each after the first: 1 s, then doubling, each with up to half again at random (2026-10-25: a refusal for rate is waited out; about 15 s in all before unknown). */
const OUTCOME_READS = 5;
/* 24m (Claude L-2): the longest one of those reads may take, as for the earlier-bid read. */
const OUTCOME_READ_MS = 10_000;
const OUTCOME_WAIT_MS = 1_000;
const outcomeWait = (attempt: number): number => OUTCOME_WAIT_MS * 2 ** (attempt - 1) * (1 + Math.random() / 2);
/* Round 28c (Opus M1): before a create is built, the network clock is read again when its last read is older than this. */
const CREATE_CLOCK_MAX_AGE_MS = 60_000;

/* The shared send context as the route answers it (server/sendContext.ts SendContext). */
interface SendContextAnswer {
  slot: number;
  programSlot: number | null;
  blockhash: string;
  lastValidBlockHeight: number;
  blockHeight: number;
  priorityMicroLamports: number;
  secondsLeft: number;
}

/*
  The create_launch instruction for this creator and salt: its data is what the creation permit is signed over (attest.ts), so it is built once and sent as built.
  revealMarginSecs is the live Config's (2026-10-28, the founder's fix A): the round is aimed with the margin create_launch checks.
  v0.31: the close is set here, at the build (closeTsFor), and sent as the absolute close_ts; the round is the earliest for it.
  Round 28c (Opus M1, Fable F4, Terra T12): on the network clock (netClock.ts), the device's only until the cluster answers.
*/
export function createLaunchInstruction(input: CreateLaunchInput, creator: PublicKey, mintSalt: bigint, revealMarginSecs: number, nowSec: number = networkNowSec()): { ix: TransactionInstruction; launch: PublicKey; closeTs: number } {
  const windowSecs = Math.round(input.windowSecs);
  if (windowSecs < WINDOW_MIN_SECS || windowSecs > WINDOW_MAX_SECS) throw new Error(`The window must be ${WINDOW_MIN_SECS / 60} to ${WINDOW_MAX_SECS / 60} minutes.`);
  if (!validRevealMargin(revealMarginSecs)) throw new Error(`The reveal margin must be ${REVEAL_MARGIN_MIN_SECS} to ${REVEAL_MARGIN_MAX_SECS} seconds (${revealMarginSecs}).`);
  const mint = mintPda(creator, mintSalt);
  const launch = launchPda(mint);
  const closeTs = CREATE_TAKES_CLOSE_TS ? closeTsFor(windowSecs, nowSec) : nowSec + windowSecs;
  const revealRound = revealRoundFor(closeTs, revealMarginSecs);
  const { roundPoint, roundHints } = roundPointArgs(revealRound);
  const ix = createLaunchIx(
    { config: configPda(), creator, tokenMint: mint, launch, vault: vaultPda(launch), histogram: histogramPda(launch) },
    /* 0.25: the terms the creator was shown, passed through untouched. The program compares them with the config when it executes. */
    { mintSalt, windowSecs, closeTs, revealRound, roundPoint, roundHints, name: input.name, symbol: input.symbol, uri: input.uri ?? "", expected: input.terms },
  );
  return { ix, launch, closeTs };
}

/*
  Genesis, exactly as sent (scripts/check-v29-site.ts measures it): the
  compute limit, the creation permit's Ed25519 instruction immediately
  before create_launch (the seventh candidate; the program reads it at its
  own index minus one), then grow_histogram. The histogram is made at 10,240
  bytes (a cross-program call cannot create more) and grown to its full size
  by the last instruction, all under the creator's one signature; a launch
  stays Initializing, taking no bid, until the grow lands, so they travel
  together.
*/
/* ComputeBudget SetLoadedAccountsDataSizeLimit (discriminator 4, u32 bytes); web3.js has no helper for it. */
export function loadedAccountsDataSizeLimit(bytes: number): TransactionInstruction {
  const data = Buffer.alloc(5);
  data[0] = 4;
  data.writeUInt32LE(bytes, 1);
  return new TransactionInstruction({ programId: ComputeBudgetProgram.programId, keys: [], data });
}

export function createTransaction(k: { ix: TransactionInstruction; launch: PublicKey; creator: PublicKey; permit: Permit }): Transaction {
  const grow = growHistogramIx({ launch: k.launch, histogram: histogramPda(k.launch), creator: k.creator });
  /* 2026-10-29: the price, the unit limit and the loaded data limit are all the site's (terms.ts), ahead of the permit; the program reads the permit at its own index less one. */
  const tx = new Transaction().add(
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: CREATE_COMPUTE_UNIT_PRICE }),
    ComputeBudgetProgram.setComputeUnitLimit({ units: CREATE_COMPUTE_UNITS }),
    loadedAccountsDataSizeLimit(CREATE_LOADED_ACCOUNTS_DATA_BYTES),
    attestInstruction(k.permit),
    k.ix,
    grow,
  );
  tx.feePayer = k.creator;
  return tx;
}

/* 24k: the effect reads (ChainClient.accountsAt): accounts at or after a slot, with the slot read at. */
export type AccountsAt = (keys: PublicKey[], at?: { minContextSlot: number }) => Promise<{ infos: ({ data: Uint8Array | Buffer } | null)[]; slot: number }>;

/* 24l (Astra R11-M2): the signature behind a proven effect is optional; its history read never holds the answer longer than this. */
export const EFFECT_HISTORY_MS = 1_500;

/*
  24k (the founder's final rule for wallet-owned sends): the effect of a send whose one account is made ("exists": a create's
  launch) or closed ("gone": a refund or claim). It answers with the slot read at, so settle can prove an absence past
  expiry, and names the account (settle reads its history for a landed failure, 24l).
  24l (Astra R11-M1): an account that is there proves a create at any slot, but an account that is not there proves a
  refund or claim only when read at or past the anchor settle asked for: a node behind it (or a read with no anchor)
  may answer from before the bid existed. Such an absence is no answer either way.
*/
export function accountEffect(read: AccountsAt, lastSignature: (k: PublicKey) => Promise<string | null>, key: PublicKey, landedWhen: "exists" | "gone"): Effect {
  return async (at) => {
    const { infos, slot } = await read([key], at);
    const account = key.toBase58();
    const signatureOf = async () => within(lastSignature(key), EFFECT_HISTORY_MS);
    if (landedWhen === "exists") return infos[0] ? { landed: true, signature: await signatureOf() } : { landed: false, contextSlot: slot, account };
    if (infos[0]) return { landed: false, contextSlot: slot, account };
    const fresh = at !== undefined && slot >= at.minContextSlot;
    return fresh ? { landed: true, signature: await signatureOf() } : { landed: false, account };
  };
}

/*
  A bid's effect: this wallet's bid account. A late commit that closed the book instead leaves none, and then only the
  signature's own status can say it landed. 24k: so no bid account proves nothing landed only while the book was still
  open at the slot read (a late commit closes it); the launch is read in the same call.
*/
export function bidEffect(read: AccountsAt, lastSignature: (k: PublicKey) => Promise<string | null>, bid: PublicKey, launchKey: PublicKey): Effect {
  return async (at) => {
    const { infos, slot } = await read([bid, launchKey], at);
    if (infos[0]) return { landed: true, signature: await within(lastSignature(bid), EFFECT_HISTORY_MS) };
    const book = infos[1] ? decodeLaunch(launchKey.toBase58(), Uint8Array.from(infos[1].data)) : null;
    const account = bid.toBase58();
    return book?.state === "open" ? { landed: false, contextSlot: slot, account } : { landed: false, account };
  };
}

export class ChainClient implements BouncerClient {
  private launches = new Map<string, Launch>();
  /*
    24n (fix 1, newest wins): the slot each launch above was read at. The launch's own snapshot and the board's both
    feed `launches`; a read at an older slot never replaces a newer one (an older board copy put a failed launch's page
    back on the closed screen), and a finalized launch never goes back to an earlier state.
  */
  private launchSlots = new Map<string, number>();
  /* The bytes each copy was built from (launch and record): a read that brings the same bytes keeps the same copy, so nothing re-renders for it. */
  private launchBytes = new Map<string, string>();
  /* Addresses the RPC answered for and holds no launch at, with the time of that answer. A page shows a skeleton until the address is in one map or the other. */
  private missing = new Map<string, number>();
  /* The board's launches so far and how many times it was read (listLaunches). */
  private board: { known: Map<string, Launch>; reads: number } | null = null;
  /* The site's shared endpoints (SITE_ROUTES): one snapshot read in flight per launch, reused for 2 s; the pool's bytes from the last snapshot, for the live market cap. */
  private snapshots = new Map<string, { at: number; value: Promise<LaunchSnapshot> }>();
  private pools = new Map<string, { data: Uint8Array | null; slot: number }>();
  private subs = new Map<string, Sub>();
  private rents = new Map<number, Promise<bigint>>();
  private fundingReports = new Map<string, Promise<FundingReport | null>>();
  private fundingBidders = new Map<string, Set<string>>();
  /* Creator wallet ages by creator, for the session; a failed read is forgotten so the next asks again. */
  private creatorAges = new Map<string, Promise<WalletAge>>();
  /* Histograms of settled launches by launch id: nothing writes one after settle. */
  private histograms = new Map<string, HistogramAccount>();
  /* By the address whose transactions were read: a launch, or one bid account. `have` holds a read in progress so a failure midway resumes. */
  private events = new Map<string, { newest: string | null; oldest: string | null; complete: boolean | null; olderAt: number; list: DecodedEvent[]; inflight: Promise<DecodedEvent[]> | null; readAt: number; have: Map<string, DecodedEvent[]>; progress: { read: number; total: number }; missing: number }>();
  private conn = () => getConnection();
  /* 24e (item 6): bids whose outcome the site could not tell (a TxFailure of kind unknown), by bid account: the next commit for one reads the account first, so a bid that did land is answered, not sent again. */
  private unresolvedBids = new Set<string>();

  /* A launch built from its decoded account, its token metadata and whether its record exists (read here unless the caller already knows). */
  /* recordData: the record account's bytes when the caller already read them (null: it does not exist); undefined reads it here. Either way the record is decoded once, so no card needs a read of its own. */
  /* slot: where the bytes were read (24n): an older read than the one held changes nothing; a newer one replaces it and tells the launch's subscribers. Undefined (a direct RPC read with no context) replaces as before. */
  private async assemble(address: PublicKey, data: Uint8Array, recordData?: Uint8Array | null, slot?: number): Promise<Launch> {
    const id = address.toBase58();
    const older = () => {
      const held = this.launches.get(id);
      const at = this.launchSlots.get(id);
      return held !== undefined && slot !== undefined && at !== undefined && slot < at ? held : null;
    };
    const before = older();
    if (before) return before;
    const sig = recordData === undefined ? null : `${Buffer.from(data).toString("base64")}|${recordData ? Buffer.from(recordData).toString("base64") : "-"}`;
    const same = this.launches.get(id);
    if (sig !== null && same && this.launchBytes.get(id) === sig) {
      if (slot !== undefined) this.launchSlots.set(id, Math.max(slot, this.launchSlots.get(id) ?? 0));
      return same;
    }
    const account = decodeLaunch(id, data);
    if (!account) {
      const stub: Launch = { id, token: { mint: id, name: "Unreadable launch", symbol: "?", decimals: 0, description: "", creator: "" }, account: blankAccount(id), recordExists: false, record: null, readable: false };
      this.launches.set(id, stub);
      return stub;
    }
    const [token, recordInfo] = await Promise.all([
      fetchTokenMeta(this.conn(), account.tokenMint, account.creator, account.meta),
      recordData === undefined ? this.conn().getAccountInfo(settlementPda(address), "confirmed").then((i) => (i ? Uint8Array.from(i.data) : null)) : Promise.resolve(recordData),
    ]);
    const record = recordInfo ? decodeRecord(settlementPda(address).toBase58(), recordInfo) : null;
    const launch: Launch = { id, token, account, recordExists: recordInfo !== null, record, readable: true };
    /* Another read may have landed while this one fetched the token's metadata. */
    const after = older();
    if (after) return after;
    const held = this.launches.get(id);
    if (held?.readable && held.account.state === "finalized" && account.state !== "finalized") return held;
    this.launches.set(id, launch);
    if (sig !== null) this.launchBytes.set(id, sig);
    else this.launchBytes.delete(id);
    if (slot !== undefined) this.launchSlots.set(id, Math.max(slot, this.launchSlots.get(id) ?? 0));
    this.publish(id, launch);
    return launch;
  }

  /* 24n (fix 1): a newer copy of a launch, from whichever read brought it, goes to every page and card watching it. */
  private publish(id: string, launch: Launch | null): void {
    this.subs.get(id)?.listeners.forEach((fn) => fn(launch));
  }

  /* The slot this client's copy of a launch was read at, or null (no copy, or one read with no slot). */
  peekLaunchSlot(id: string): number | null {
    return this.launchSlots.get(id) ?? null;
  }

  /*
    The site's shared endpoints, when the build reads through the site
    (2026-10-15): a launch's accounts, its bids, its history and the Config
    come from app/api/launch and app/api/config, read once per cache period
    for everyone, instead of from this browser's own RPC calls. The bytes
    are decoded here with the same code an RPC answer is. The browser only:
    a server render has no origin to resolve the path against.
  */
  private async endpoint<T>(path: string): Promise<T> {
    if (typeof window === "undefined") throw new Error("The site's endpoints are read in the browser only.");
    const res = await fetchWithBackoff(path, { cache: "no-store" });
    if (!res.ok) throw new Error(`The site's ${path} answered ${res.status}.`);
    return fromJson<T>(await res.text());
  }

  /*
    24d (the founder's caching directive): the board from the site's shared snapshot (app/api/launches, server/snapshot.ts
    readBoard), the same launches and records this client read from the RPC itself before: the live set each time, the
    finalized ones once, again only when the snapshot names a finalized id this client does not hold as finalized.
  */
  private async listFromBoard(): Promise<Launch[]> {
    const board = this.board ?? { known: new Map<string, Launch>(), reads: 0 };
    board.reads++;
    const live = await this.endpoint<BoardSnapshot>("/api/launches");
    /* 24n: each entry at the slot its page was read at (an older server falls back to the board's). */
    const take = async (entries: BoardEntry[], slot: number | undefined) => {
      const launches = await Promise.all(entries.map((e) => this.assemble(new PublicKey(e.launch.address), bytesOf(e.launch), e.record ? bytesOf(e.record) : null, e.slot ?? slot)));
      for (const l of launches) if (l) board.known.set(l.id, l);
    };
    await take(live.live, live.slot);
    const finals = new Set(live.finals);
    if (live.finals.some((id) => board.known.get(id)?.account.state !== "finalized")) await take((await this.endpoint<{ launches: BoardEntry[] }>("/api/launches?set=final")).launches, undefined);
    const named = new Set([...live.live.map((e) => e.launch.address), ...finals]);
    for (const id of [...board.known.keys()]) if (!named.has(id)) board.known.delete(id);
    this.board = board;
    /* 24n: the newest copy of each, which a launch page's own read may have brought since. */
    return [...board.known.keys()].map((id) => this.launches.get(id) ?? board.known.get(id)!).filter((l) => l.readable).sort((x, y) => y.account.openTs - x.account.openTs);
  }

  /* 24d: every pool the board's records name, by address, from the site's shared read (/api/launches?set=pools): the home cards' market caps. */
  async readBoardPools(): Promise<Map<string, Uint8Array>> {
    const s = await this.endpoint<PoolsSnapshot>("/api/launches?set=pools");
    return new Map(s.pools.map((p) => [p.address, bytesOf(p)]));
  }

  /* 24n: one read in flight per launch, reused for 1 s (the page polls every 2 s); `fresh` skips the reuse (a refresh after a payout). */
  private snapshot(id: string, fresh = false): Promise<LaunchSnapshot> {
    const hit = this.snapshots.get(id);
    if (!fresh && hit && Date.now() - hit.at < 1_000) return hit.value;
    const value = this.endpoint<LaunchSnapshot>(`/api/launch/${id}`);
    this.snapshots.set(id, { at: Date.now(), value });
    value.then(
      (s) => this.pools.set(id, { data: s.pool ? bytesOf(s.pool) : null, slot: s.slot }),
      () => {
        if (this.snapshots.get(id)?.value === value) this.snapshots.delete(id);
      },
    );
    return value;
  }

  /* The trading pool's bytes and the slot they were read at, from the launch's snapshot (the live market cap, through the site). */
  async readPool(launchId: string): Promise<{ data: Uint8Array | null; slot: number }> {
    await this.snapshot(launchId);
    return this.pools.get(launchId) ?? { data: null, slot: 0 };
  }

  async getConfig(): Promise<ConfigAccount> {
    const key = configPda();
    const data = SITE_ROUTES ? await this.endpoint<{ config: AccountBytes | null }>("/api/config").then((c) => (c.config ? bytesOf(c.config) : null)) : await this.conn().getAccountInfo(key, "confirmed").then((i) => (i ? Uint8Array.from(i.data) : null));
    if (!data) throw new Error(`No Config account at ${key.toBase58()} on this cluster.`);
    const cfg = decodeConfig(key.toBase58(), data);
    if (!cfg) throw new Error(`The Config account at ${key.toBase58()} is not the pinned layout (${data.length} bytes, ${ACCOUNTS.Config.len} expected).`);
    return cfg;
  }

  /*
    The board (2026-10-15; before, every read was a full scan of every Launch
    account, 9,568 bytes each, twice a minute). The first read lists the
    launches' addresses with a keys-only scan and reads them with their
    records 50 at a time (one getMultipleAccounts of 100 keys each), so no
    one answer outgrows a function's 4.5 MB. A later read re-reads only the
    launches that are not final, since a final one never changes again, and
    every fourth read (2 minutes at the board's 30 s) runs the keys-only scan
    again for launches created since. A launch the RPC no longer holds is
    dropped.
  */
  async listLaunches(): Promise<Launch[]> {
    if (SITE_ROUTES) return this.listFromBoard();
    const board = this.board ?? { known: new Map<string, Launch>(), reads: 0 };
    const discover = board.reads % BOARD_DISCOVER_EVERY === 0;
    board.reads++;
    const keys = [...board.known.values()].filter((l) => !LAUNCH_FINAL.has(l.account.state)).map((l) => new PublicKey(l.id));
    if (discover) {
      const found = await this.conn().getProgramAccounts(PROGRAM, {
        commitment: "confirmed",
        dataSlice: { offset: 0, length: 0 },
        filters: [{ dataSize: ACCOUNTS.Launch.len }, { memcmp: { offset: 0, bytes: bs58.encode(Uint8Array.from(ACCOUNTS.Launch.discriminator)) } }],
      });
      for (const a of found) if (!board.known.has(a.pubkey.toBase58())) keys.push(a.pubkey);
    }
    for (let i = 0; i < keys.length; i += BOARD_PAGE) {
      const page = keys.slice(i, i + BOARD_PAGE);
      const infos = await this.conn().getMultipleAccountsInfo([...page, ...page.map((k) => settlementPda(k))], "confirmed");
      const launches = await Promise.all(
        page.map((key, k) => {
          const launch = infos[k];
          const record = infos[page.length + k];
          if (!launch || !launch.owner.equals(PROGRAM)) return null;
          return this.assemble(key, Uint8Array.from(launch.data), record ? Uint8Array.from(record.data) : null);
        }),
      );
      page.forEach((key, k) => {
        const l = launches[k];
        if (l) board.known.set(l.id, l);
        else board.known.delete(key.toBase58());
      });
    }
    this.board = board;
    return [...board.known.values()].filter((l) => l.readable).sort((x, y) => y.account.openTs - x.account.openTs);
  }

  async getLaunch(id: string, fresh = false): Promise<Launch | null> {
    const key = parsePubkey(id);
    if (!key) {
      this.missing.set(id, Date.now());
      return null;
    }
    hintLaunch(id);
    if (SITE_ROUTES) {
      const s = await this.snapshot(id, fresh);
      if (!s.launch) {
        this.missing.set(id, Date.now());
        return null;
      }
      this.missing.delete(id);
      /* 24n: at the slot the launch account itself was read (the pool and mint read after it may be later). */
      return this.assemble(key, bytesOf(s.launch), s.record ? bytesOf(s.record) : null, s.launchSlot ?? s.slot);
    }
    const info = await this.conn().getAccountInfo(key, "confirmed");
    if (!info || !info.owner.equals(PROGRAM)) {
      this.missing.set(id, Date.now());
      return null;
    }
    this.missing.delete(id);
    return this.assemble(key, Uint8Array.from(info.data));
  }

  peekLaunch(id: string): Launch | null {
    return this.launches.get(id) ?? null;
  }

  peekMissing(id: string): number | null {
    return this.missing.get(id) ?? null;
  }

  subscribeLaunch(id: string, onChange: (launch: Launch | null) => void): () => void {
    let sub = this.subs.get(id);
    if (!sub) {
      const s: Sub = { listeners: new Set(), wsId: null, timer: null };
      this.subs.set(id, s);
      sub = s;
      const key = parsePubkey(id);
      const notify = (l: Launch | null) => s.listeners.forEach((fn) => fn(l));
      /*
        A read that fails (the RPC down) notifies nothing: the page keeps what it had, and the network banner names the
        RPC. 24n (fix 5): it is tried once more after 1 s. A launch read newer than the page's copy is told to the
        page by assemble (publish); an older one changes nothing.
      */
      let retry: ReturnType<typeof setTimeout> | null = null;
      const refresh = (again = true) => {
        this.getLaunch(id)
          .then((l) => {
            if (l === null) notify(null);
          })
          .catch(() => {
            if (!again || retry || !this.subs.has(id)) return;
            retry = setTimeout(() => {
              retry = null;
              if (this.subs.get(id) === s) refresh(false);
            }, RETRY_MS);
          });
      };
      refresh();
      /* An RPC with no websocket (the site's own route, the local board's proxy) polls only. */
      if (key && rpcHasWebsocket(this.conn().rpcEndpoint)) {
        try {
          s.wsId = this.conn().onAccountChange(
            key,
            (info, ctx) => {
              this.assemble(key, Uint8Array.from(info.data), undefined, ctx?.slot).catch(() => {});
            },
            "confirmed",
          );
        } catch {
          s.wsId = null;
        }
      }
      if (SITE_ROUTES) {
        /*
          Through the site: 24o (F4, step 2), every 1.5 to 2 s (livePollWait; 24n was 2 s plus or minus 0.5 s) until the
          launch is final, then every 15 s with a random
          offset of up to 3 s, so a crowd that opened the page together does not ask together; a page in a background
          tab waits, and reads at once when it is shown again.
        */
        const tick = () => {
          const final = this.launches.get(id)?.account.state === "finalized";
          const wait = final ? POLL_MS + Math.random() * 3_000 : livePollWait();
          s.timer = setTimeout(() => {
            if (typeof document === "undefined" || !document.hidden) refresh();
            tick();
          }, wait) as unknown as ReturnType<typeof setInterval>;
        };
        tick();
        if (typeof document !== "undefined") {
          s.onShown = () => {
            if (!document.hidden) refresh();
          };
          document.addEventListener("visibilitychange", s.onShown);
        }
      } else s.timer = setInterval(refresh, POLL_MS);
    }
    sub.listeners.add(onChange);
    return () => {
      const s = this.subs.get(id);
      if (!s) return;
      s.listeners.delete(onChange);
      if (s.listeners.size === 0) {
        if (s.wsId !== null) this.conn().removeAccountChangeListener(s.wsId).catch(() => {});
        if (s.timer) {
          clearInterval(s.timer);
          clearTimeout(s.timer as unknown as ReturnType<typeof setTimeout>);
        }
        if (s.onShown && typeof document !== "undefined") document.removeEventListener("visibilitychange", s.onShown);
        this.subs.delete(id);
      }
    };
  }

  /*
    24n (Astra's 24m E2E, L1; plan item 7): after a payout this page sent, the launch is read again at once, then every
    second, at most REFRESH_TRIES times, until a copy at or past `minSlot` (the slot it landed in) or one that passes
    `test` (a payout proven with no slot: the count moved past what the page held) arrives. Each copy reaches every
    subscriber through assemble, so the counts, the lists keyed on them and the page's own result agree.
  */
  async refreshLaunch(id: string, until: { minSlot?: number; test?: (l: Launch) => boolean } = {}): Promise<void> {
    const done = () => {
      const l = this.launches.get(id);
      if (!l) return false;
      if (until.minSlot !== undefined) return (this.launchSlots.get(id) ?? 0) >= until.minSlot;
      return until.test ? until.test(l) : true;
    };
    for (let i = 0; i < REFRESH_TRIES; i++) {
      if (i > 0) await new Promise((r) => setTimeout(r, RETRY_MS));
      try {
        await this.getLaunch(id, true);
      } catch {
        /* the next try, or the page's own poll */
      }
      if (done()) return;
    }
  }

  /*
    24n (plan fix 4): the newest `count` deposits of a launch, by placed_ts, for the deposit feed: about 3 KB from the
    site's shared list (app/api/launch/[id]/bids?recent=), where the whole list is about 300 KB at 1,000 bids. The
    answer says which launch read the list was built on (launchSlot); one older than this client's copy of the launch
    is read again after 1 s, at most 3 times, so a new bid is never left out until the next one.
  */
  async getRecentBids(id: string, count: number): Promise<BidAccount[]> {
    const key = parsePubkey(id);
    if (!key) return [];
    if (!SITE_ROUTES) return (await this.getBids(id)).sort((x, y) => y.placedTs - x.placedTs).slice(0, count);
    const want = this.launchSlots.get(id) ?? 0;
    let b: BidsSnapshot | null = null;
    for (let i = 0; i < 4; i++) {
      if (i > 0) await new Promise((r) => setTimeout(r, RETRY_MS));
      b = await this.endpoint<BidsSnapshot>(`/api/launch/${id}/bids?recent=${count}&v=${want}`);
      if (b.launchSlot >= want) break;
    }
    return b!.bids.map((a) => decodeBid(a.address, bytesOf(a))).filter((x): x is BidAccount => x !== null).sort((x, y) => y.placedTs - x.placedTs).slice(0, count);
  }

  async getBids(id: string): Promise<BidAccount[]> {
    const key = parsePubkey(id);
    if (!key) return [];
    if (SITE_ROUTES) {
      /* In pages (2026-10-20, S4): a book past about 8,600 bids no longer fits one answer. */
      const all = await readAllPages(async (after) => {
        const b = await this.endpoint<BidsSnapshot>(after === null ? `/api/launch/${id}/bids` : `/api/launch/${id}/bids?after=${after}`);
        return { items: b.bids, next: b.next ?? null };
      });
      return all.map((a) => decodeBid(a.address, bytesOf(a))).filter((x): x is BidAccount => x !== null);
    }
    const accounts = await this.conn().getProgramAccounts(PROGRAM, {
      commitment: "confirmed",
      filters: [{ dataSize: ACCOUNTS.Bid.len }, { memcmp: { offset: ACCOUNTS.Bid.fields.launch.offset, bytes: key.toBase58() } }],
    });
    return accounts.map((a) => decodeBid(a.pubkey.toBase58(), Uint8Array.from(a.account.data))).filter((b): b is BidAccount => b !== null);
  }

  async getSettlement(id: string): Promise<SettlementRecord | null> {
    const key = parsePubkey(id);
    if (!key) return null;
    const pda = settlementPda(key);
    if (SITE_ROUTES) {
      const s = await this.snapshot(id);
      return s.record ? decodeRecord(pda.toBase58(), bytesOf(s.record)) : null;
    }
    const info = await this.conn().getAccountInfo(pda, "confirmed");
    if (!info) return null;
    return decodeRecord(pda.toBase58(), Uint8Array.from(info.data));
  }

  getRent(bytes: number): Promise<bigint> {
    let p = this.rents.get(bytes);
    if (!p) {
      p = this.conn()
        .getMinimumBalanceForRentExemption(bytes, "confirmed")
        .then((n) => BigInt(n));
      this.rents.set(bytes, p);
      p.catch(() => this.rents.delete(bytes));
    }
    return p;
  }

  /*
    Every event on the launch, oldest first: its whole history, paged back to
    its creation, with what each bid was paid read from the transactions
    (history.ts). The first read of a busy launch is long (about one request
    per eight transactions), so it reports its progress and, if it fails
    midway, the next call resumes with what was already read. After that only
    signatures newer than the last read are fetched; a read is reused for
    three seconds.
  */
  getEvents(id: string): Promise<DecodedEvent[]> {
    return this.history(id, id, null);
  }

  /*
    One bid's own history: the transactions that touched its account (its
    commit, the reveal that opened it, its payout). A handful, whatever the
    size of the launch, so a bidder's own outcome does not wait for the whole
    book to be read.
  */
  async getBidEvents(launchId: string, bidder: string): Promise<DecodedEvent[]> {
    const launch = parsePubkey(launchId);
    const who = parsePubkey(bidder);
    if (!launch || !who) return [];
    const bid = bidPda(launch, who).toBase58();
    return (await this.history(bid, launchId, launch)).filter((e) => e.data.bid === bid);
  }

  historyProgress(id: string): HistoryProgress | null {
    const c = this.events.get(id);
    return c ? { ...c.progress, missing: c.missing, complete: c.complete } : null;
  }

  /* What a read still in progress has found so far, oldest first: the newest transactions are read first, so the payouts are here long before the read ends. */
  peekEvents(id: string): DecodedEvent[] {
    const c = this.events.get(id);
    if (!c) return [];
    if (c.have.size === 0) return c.list;
    const seen = new Set(c.list.map(eventTag));
    const partial = [...c.have.values()]
      .flat()
      .filter((e) => !seen.has(eventTag(e)))
      .map((e) => ({ ...e, data: { ...e.data } }));
    partial.sort((x, y) => x.slot - y.slot);
    const all = [...c.list, ...partial];
    fillCosts(all);
    return all;
  }

  private history(address: string, launchId: string, launch: PublicKey | null): Promise<DecodedEvent[]> {
    const key = parsePubkey(address);
    if (!key) return Promise.resolve([]);
    hintLaunch(launchId);
    /* Through the site, a bid's events come out of the launch's shared history (getBidEvents filters them); nothing is read per bid. */
    if (SITE_ROUTES && launch !== null) return this.history(launchId, launchId, null);
    let c = this.events.get(address);
    if (!c) {
      c = { newest: null, oldest: null, complete: null, olderAt: 0, list: [], inflight: null, readAt: 0, have: new Map(), progress: { read: 0, total: 0 }, missing: 0 };
      this.events.set(address, c);
    }
    if (c.inflight) return c.inflight;
    if (Date.now() - c.readAt < 3_000) return Promise.resolve(c.list);
    const cache = c;
    if (SITE_ROUTES) {
      /* The site's shared history: the whole list at once, read on the server for everyone (server/history.ts), the same events this reader makes. */
      cache.inflight = (async () => {
        const h = await this.endpoint<LaunchHistory>(`/api/launch/${launchId}/history`);
        cache.list = h.events;
        fillCosts(cache.list);
        cache.complete = h.complete;
        cache.newest = h.newest;
        cache.oldest = h.oldest;
        cache.missing = 0;
        cache.progress = { read: h.transactions, total: h.transactions };
        cache.have = new Map();
        cache.readAt = Date.now();
        cache.inflight = null;
        return cache.list;
      })();
      cache.inflight.catch(() => {
        cache.inflight = null;
      });
      return cache.inflight;
    }
    cache.inflight = (async () => {
      /* The launch first: its delivery terms decide how a pushed delivery's SOL back is read (history.ts). A settlement page opened directly starts this read before useLaunch has the account (F7 of the 0.26 review, 2026-10-06). */
      const known = this.launches.get(launchId) ?? (await this.getLaunch(launchId));
      const base = {
        launch: launch ?? undefined,
        have: cache.have,
        creator: known?.readable ? known.account.creator : null,
        feeBps: known?.readable ? known.account.deliveryFeeBps : null,
        deliveryTerms: known?.readable ? known.account.deliveryTerms : null,
        deliveryReward: known?.readable ? known.account.deliveryReward : null,
        onProgress: (read: number, total: number) => {
          cache.progress = { read, total };
        },
      };
      const merge = (r: Awaited<ReturnType<typeof readHistory>>) => {
        if (r.events.length) {
          /* readHistory returns newest first; the list is kept oldest first, one entry per event of a transaction. */
          const seen = new Set(cache.list.map(eventTag));
          const added = r.events.slice().reverse().filter((e) => !seen.has(eventTag(e)));
          cache.list = [...cache.list, ...added];
          fillCosts(cache.list);
        }
        cache.missing = r.stats.missing.length;
        if (r.stats.complete !== null) cache.complete = r.stats.complete;
        if (r.oldest && (cache.oldest === null || r.stats.complete !== null)) cache.oldest = r.oldest;
      };
      const r = await readHistory(getHistoryConnection(), key, { ...base, until: cache.newest ?? undefined });
      merge(r);
      /* A transaction the node listed and did not return is asked for again by the next read: the mark does not move past it, and what was read is kept. */
      if (r.stats.missing.length === 0) {
        cache.newest = r.newest ?? cache.newest;
        cache.have = new Map();
      }
      /*
        A list that ended before the launch's creation (the node's ledger
        starts later, or it answered short) is asked for again past its
        oldest signature, once a minute, so a gap is never taken as the end.
      */
      if (cache.complete === false && cache.oldest && Date.now() - cache.olderAt > 60_000) {
        cache.olderAt = Date.now();
        const older = await readHistory(getHistoryConnection(), key, { ...base, before: cache.oldest });
        merge(older);
        if (older.stats.missing.length === 0) cache.have = new Map();
      }
      cache.readAt = Date.now();
      cache.inflight = null;
      return cache.list;
    })();
    cache.inflight.catch(() => {
      cache.inflight = null;
    });
    return cache.inflight;
  }

  async getDeliveries(id: string): Promise<Map<string, Delivery>> {
    const out = new Map<string, Delivery>();
    for (const ev of await this.getEvents(id)) {
      if (ev.name !== "Delivered" || ev.data.loser === true) continue;
      const bid = String(ev.data.bid);
      out.set(bid, {
        bid,
        bidder: String(ev.data.bidder),
        tokens: BigInt(ev.data.tokens),
        cost: ev.data.cost === undefined ? null : BigInt(ev.data.cost),
        refund: BigInt(ev.data.refund),
        feeTokens: BigInt(ev.data.fee_tokens),
        settled: ev.data.settled !== false,
        claimed: ev.data.claimed === true,
        signature: ev.signature,
        blockTime: ev.blockTime,
      });
    }
    return out;
  }

  async getPoolCreated(id: string): Promise<PoolOpening | null> {
    const ev = (await this.getEvents(id)).find((e) => e.name === "PoolCreated");
    if (!ev) return null;
    return { pool: String(ev.data.pool), cranker: String(ev.data.cranker), crankBond: BigInt(ev.data.crank_bond), poolSolAtOpen: BigInt(ev.data.pool_sol_at_open), floatValue: BigInt(ev.data.float_value), signature: ev.signature, blockTime: ev.blockTime };
  }

  /* Refuses before any prompt when the wallet plainly cannot pay, with the numbers. The simulation would refuse too, without them. */
  private async requireBalance(who: PublicKey, need: bigint, what: string): Promise<void> {
    const held = BigInt(await this.conn().getBalance(who, "confirmed"));
    if (held < need) {
      throw new TxFailure("nothingSent", "insufficientFunds", `This wallet holds ${fmtSol(held)} and this needs about ${fmtSol(need)}: ${what}.`, { expected: who.toBase58() });
    }
  }

  /*
    24k (the founder's final rule for wallet-owned sends): accounts read at or after a slot (the slot where settle saw expiry),
    with the slot the node answered at, so an absence can be proved past expiry. Without a slot it is a plain read.
  */
  private async accountsAt(keys: PublicKey[], at?: { minContextSlot: number }): Promise<{ infos: (AccountInfo<Buffer> | null)[]; slot: number }> {
    const r = await this.conn().getMultipleAccountsInfoAndContext(keys, { commitment: "confirmed", ...(at ? { minContextSlot: at.minContextSlot } : {}) });
    return { infos: r.value, slot: r.context.slot };
  }

  /* The newest signature that touched an account, for an outcome the site had to read from the chain. */
  private async lastSignature(address: PublicKey): Promise<string | null> {
    const sigs = await this.conn().getSignaturesForAddress(address, { limit: 1 }, "confirmed").catch(() => []);
    return sigs[0]?.signature ?? null;
  }

  async commit(input: CommitInput, signer: TxSigner, opts: SendOptions = {}): Promise<CommitResult> {
    opts.onStage?.({ step: "building" });
    const launch = await this.getLaunch(input.launchId);
    if (!launch) throw new Error("This launch does not exist on this cluster.");
    if (!launch.readable) throw new Error("This launch was created under an older program version and cannot be used.");
    const a = launch.account;
    const nowSec = networkNowSec();
    /* 0.29: commit refuses HistogramNotReady (6071) until the second step of genesis lands (Initializing since the seventh candidate). */
    if (a.state === "initializing" || !a.histogramGrown) throw new Error("This launch is still finishing setup, so it takes no bids yet.");
    if (a.state !== "open" || !bookOpen(a, nowSec)) throw new Error("The book is closed.");
    /* 0.29: a gated launch takes a bid only with the bot check's signature in the same transaction (AttestationMissing 6077 otherwise). */
    const permit = a.attestRequired ? (input.permit ?? null) : null;
    if (a.attestRequired && (!permit || permit.expiry - nowSec < 30)) throw new TxFailure("nothingSent", "botCheck", permit ? "The bot check expired before your bid was built. Complete it again and bid." : "This launch requires the bot check. Complete it and bid.", {});
    if (input.deposit < a.minBid) throw new Error("The deposit is under the launch's minimum bid.");
    if (!tickInRange(input.tick)) throw new Error("That maximum is off the grid.");
    if (!roundPointMatches(a.roundPoint, a.revealRound)) throw new Error("This launch was set up wrong, so a sealed bid on it could never be opened. Nothing was sent; choose another launch.");
    const sealed = await sealTick(input.tick, a.revealRound);
    const launchKey = new PublicKey(launch.id);
    const bidder = new PublicKey(signer.address);
    const bid = bidPda(launchKey, bidder);
    /* 24e (item 6): an earlier bid from this wallet whose outcome was never told is looked for before anything new is built. */
    const earlierBid = await this.unresolvedBid(bid);
    if (earlierBid) return earlierBid;
    /* 24e (items 2 and 3): the launch's shared send context, read once for everyone (app/api/launch/[id]/send): the pin, the blockhash, the height, and the priority price, which is zero outside the last 90 seconds and capped inside them. */
    const shared = SITE_ROUTES ? await this.sendContext(launch.id).catch(() => null) : null;
    /* 24g: the price the page showed and took out of what is sent, when it gives one; otherwise the shared context's. */
    const price = input.priceMicroLamports !== undefined ? boundedPrice(input.priceMicroLamports, closeAtTs(a) - nowSec) : shared ? boundedPrice(shared.priorityMicroLamports, closeAtTs(a) - nowSec) : 0;
    const tx = commitTransaction({ launch: launchKey, bidder, permit, deposit: input.deposit, sealed, maxProcessingCharge: input.maxProcessingCharge, priceMicroLamports: price });
    const rent = await this.getRent(ACCOUNTS.Bid.len);
    /* 0.22: commit also moves the per-bid processing charge, paid to whoever opens the bid, or returned with the deposit if nobody does. 0.29: the launch's own charge, and two signatures' fees on a gated launch. */
    const charge = a.processingCharge;
    const units = commitComputeUnits(bidBumpMisses(launchKey, bidder));
    const need = input.deposit + charge + rent + commitFee(a) + priorityLamports(price, units);
    const needWhat = `the deposit, the ${charge.toLocaleString("en-US")} lamport processing charge, the bid account's rent (${fmtSol(rent)}, returned when the bid closes) and the fee`;
    /* 24e (item 2): no balance read before the prompt. The simulation refuses a wallet that cannot pay; only then is the balance read, for the sentence with the numbers. */
    let sent: Sent;
    try {
      sent = await sendAndConfirm(this.conn(), tx, signer, [], {
        ...opts,
        context: shared ? this.sharedSendContext(launch.id, shared) : undefined,
        /* The outcome is read from the bid account below, never from a log line. */
        logs: false,
        /*
          A bid account for this wallet is the effect; a late commit that closed the book instead leaves none, and then
          only the signature's own status can say it landed. 24k: so no bid account proves nothing landed only while the
          book was still open at the slot read (a late commit closes it); the launch is read in the same call.
        */
        effect: bidEffect((keys, at) => this.accountsAt(keys, at), (k) => this.lastSignature(k), bid, launchKey),
      });
    } catch (e) {
      if (e instanceof TxFailure && e.kind === "nothingSent" && e.reason === "insufficientFunds") await this.requireBalance(bidder, need, needWhat);
      if (e instanceof TxFailure && e.kind === "unknown") this.unresolvedBids.add(bid.toBase58());
      throw e;
    }
    return this.commitOutcome(bid, vaultPda(launchKey), sent, commitFee(a) + priorityLamports(price, units));
  }

  /*
    24e (item 6): an earlier bid from this wallet whose outcome was never told is looked for before anything new is
    built. 24g (Astra 24f F1): a read that fails or does not answer within 10 s is not taken for "no bid": the earlier
    outcome stays unknown and nothing new is built. Null: there was no earlier unknown bid, or the chain answered that
    there is no bid account.
  */
  private async unresolvedBid(bid: PublicKey): Promise<CommitResult | null> {
    if (!this.unresolvedBids.has(bid.toBase58())) return null;
    const read = await within(this.conn().getAccountInfo(bid, "confirmed").then((info) => ({ info })), 10_000);
    if (read === null) throw new TxFailure("unknown", "unresolved", "The RPC did not answer for long enough to tell whether this landed.", {});
    const found = read.info ? decodeBid(bid.toBase58(), Uint8Array.from(read.info.data)) : null;
    if (!found) return null;
    this.unresolvedBids.delete(bid.toBase58());
    return { kind: "placed", bid: found, signature: (await within(this.lastSignature(bid), 1_500)) ?? "" };
  }

  /*
    24e (Astra's bug A): what a confirmed commit did, from the bid account read at or after the slot it landed in. A bid
    account there means placed. A read that cannot reach that slot, or that the RPC does not answer, or bytes that do
    not decode, is never taken for a close: after a few tries the outcome stays unknown (the signature is given) and the
    next bid from this wallet looks for the account first.
    Round 28c (Astra A7): no bid account at or after the landing is not a close either, since a placed bid may already
    have been delivered or refunded and closed by then. The commit transaction's own balances decide (balance.ts
    commitVerdict): a close only when they prove nothing went into the vault; a placed bid since closed, or a
    transaction that cannot be read, leaves the outcome unknown.
  */
  private async commitOutcome(bid: PublicKey, vault: PublicKey, sent: Sent, networkFee: bigint): Promise<CommitResult> {
    for (let attempt = 0; attempt < OUTCOME_READS; attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, outcomeWait(attempt)));
      /* 24m (Claude L-2): each read bounded like unresolvedBid's; one that does not answer in time is a failed read. */
      const read = await within(this.conn().getAccountInfoAndContext(bid, { commitment: "confirmed", ...(sent.slot !== undefined ? { minContextSlot: sent.slot } : {}) }), OUTCOME_READ_MS);
      if (!read) continue;
      if (read.value) {
        const placed = decodeBid(bid.toBase58(), Uint8Array.from(read.value.data));
        if (placed) return { kind: "placed", bid: placed, signature: sent.signature };
        continue;
      }
      if (sent.slot !== undefined && read.context.slot >= sent.slot) {
        const tx = await this.landedTx(sent.signature);
        if (tx && commitVerdict(tx, bid.toBase58(), vault.toBase58()) === "closedInstead") return { kind: "closedInstead", reason: "windowElapsed", signature: sent.signature, networkFee };
        break;
      }
    }
    this.unresolvedBids.add(bid.toBase58());
    throw new TxFailure("unknown", "unresolved", "The RPC did not answer for long enough to tell whether this landed.", { signature: sent.signature });
  }

  /* 24e: the launch's send context from the site's shared route (app/api/launch/[id]/send), kept at the CDN for a second. */
  private async sendContext(id: string): Promise<SendContextAnswer> {
    return this.endpoint<SendContextAnswer>(`/api/launch/${id}/send`);
  }

  /* The signer's shared reads (chain/signer.ts SendContext): the first answer for the first ask of each, a fresh one after (the pin after a long prompt, the height while confirming). */
  private sharedSendContext(id: string, first: SendContextAnswer): SendContext {
    const used = new Set<string>();
    const read = async (what: string): Promise<SendContextAnswer> => {
      if (!used.has(what)) {
        used.add(what);
        return first;
      }
      return this.sendContext(id);
    };
    return {
      programSlot: async () => (await read("pin")).programSlot,
      blockhash: async () => {
        const c = await read("blockhash");
        return { blockhash: c.blockhash, lastValidBlockHeight: c.lastValidBlockHeight };
      },
      height: async () => (await read("height")).blockHeight,
      status: async (signature) => (await this.endpoint<{ slot: number; status: { slot: number; confirmationStatus: string | null; err: unknown } | null }>(`/api/tx/${signature}`)).status,
    };
  }

  /*
    What genesis will cost this creator, in lamports: the operating prepay in the terms, the three accounts' rent on this cluster (the launch, the vault, the full histogram: create_launch makes the first 10,240 bytes and grow_histogram pays the rest) and two signatures' fees. Since the seventh candidate a create cannot be simulated without a creation permit, which costs a bot check; nothing else is created or paid at genesis (lib.rs, CreateLaunch: the mint and its metadata wait for create_pool), so the sum is exact.
    the founder's item 17 (2026-10-16): a refusal is one fixed sentence; the RPC's error name never reaches a page.
  */
  async estimateCreateCost(input: CreateLaunchInput, creatorAddress: string): Promise<bigint> {
    if (!parsePubkey(creatorAddress)) throw new Error("Not a wallet address.");
    const setup = await this.getSetupCost();
    return input.terms.crankBond + setup.total + CREATE_FEE;
  }

  /* 0.29: the rent genesis leaves on chain for good (product.ts, setupCost), from this cluster's rent. */
  async getSetupCost() {
    const [histogram, launch, vault] = await Promise.all([this.getRent(SETUP_ACCOUNT_BYTES.histogram), this.getRent(SETUP_ACCOUNT_BYTES.launch), this.getRent(SETUP_ACCOUNT_BYTES.vault)]);
    return setupCost({ histogram, launch, vault });
  }

  /*
    0.29: the second step of genesis alone. The create page sends both steps
    in one transaction, so a half-made launch only comes from a create sent
    some other way; its creator finishes it here, paying the histogram's rent
    shortfall. Refused before any prompt for anyone but the creator, a launch
    that is not open, or one already finished.
  */
  async finishSetup(launchId: string, signer: TxSigner, opts: SendOptions = {}): Promise<{ signature: string }> {
    opts.onStage?.({ step: "building" });
    const launch = await this.getLaunch(launchId);
    if (!launch || !launch.readable) throw new Error("This launch cannot be read.");
    const a = launch.account;
    if (a.histogramGrown || a.state === "open") throw new TxFailure("nothingSent", "refused", "This launch's setup is already finished.", {});
    /* The seventh candidate: grow_histogram takes an Initializing launch to Open only before its window ends; after, it stays inert until abort at the recovery deadline returns the prepay. */
    if (a.state !== "initializing" || networkNowSec() >= closeAtTs(a)) throw new TxFailure("nothingSent", "refused", "This launch's window has ended, so its setup cannot be finished. Its prepay returns after the recovery deadline.", {});
    if (a.creator !== signer.address) throw new TxFailure("nothingSent", "refused", "Only this launch's creator can finish its setup.", { expected: a.creator });
    const key = new PublicKey(launchId);
    const creator = new PublicKey(signer.address);
    const histogram = histogramPda(key);
    const held = BigInt((await this.conn().getAccountInfo(histogram, "confirmed"))?.lamports ?? 0);
    const full = await this.getRent(SETUP_ACCOUNT_BYTES.histogram);
    const short = full > held ? full - held : 0n;
    await this.requireBalance(creator, short + SIGNATURE_FEE, `the rest of the launch cost (${fmtSol(short)}, kept on chain for good) and the fee`);
    const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: GROW_HISTOGRAM_COMPUTE_UNITS }), growHistogramIx({ launch: key, histogram, creator }));
    tx.feePayer = creator;
    const sent = await sendAndConfirm(this.conn(), tx, signer, [], {
      ...opts,
      effect: async () => {
        const info = await this.conn().getAccountInfo(key, "confirmed");
        const now = info ? decodeLaunch(launchId, Uint8Array.from(info.data)) : null;
        return now?.histogramGrown && now.state === "open" ? { landed: true, signature: await this.lastSignature(key) } : { landed: false };
      },
    });
    await this.getLaunch(launchId);
    return { signature: sent.signature };
  }

  async getBalanceLamports(address: string): Promise<bigint> {
    return BigInt(await this.conn().getBalance(new PublicKey(address), "confirmed"));
  }

  async createLaunch(input: CreateLaunchInput, signer: TxSigner, opts: SendOptions = {}): Promise<{ id: string; signature: string; earlier?: boolean }> {
    opts.onStage?.({ step: "building" });
    const creator = new PublicKey(signer.address);
    /*
      A retry reuses the salt of the attempt before it (createSalt.ts). If
      that attempt landed after all, its launch is this creator's launch:
      the page goes to it, and nothing is sent.
    */
    let mintSalt = pendingSalt(signer.address);
    if (mintSalt !== null) {
      /* The site's route knows this launch by its derivation before its next scan (chain/rpc.ts, server/scope.ts). */
      hintLaunchDerivation(signer.address, mintSalt);
      const earlier = launchPda(mintPda(creator, mintSalt));
      if (await this.conn().getAccountInfo(earlier, "confirmed")) {
        clearPendingSalt(signer.address);
        const id = earlier.toBase58();
        await within(this.getLaunch(id), 1_500);
        /* 24g (Astra 24f R7-M4): the signature is optional here; a history read that hangs never holds the page from its launch. */
        return { id, signature: (await within(this.lastSignature(earlier), 1_500)) ?? "", earlier: true };
      }
    } else {
      mintSalt = newPendingSalt(signer.address);
      hintLaunchDerivation(signer.address, mintSalt);
    }
    /*
      2026-10-28 (the founder's fix A): the round is aimed with the live Config's reveal margin, the value create_launch checks.
      A Config that cannot be read, or holds a margin outside the program's bounds, builds nothing: the pin's margin is
      never a fallback here, since a round aimed with the wrong margin is refused RevealRoundOutOfRange.
    */
    let config: ConfigAccount;
    try {
      config = await this.getConfig();
    } catch (e) {
      throw new TxFailure("nothingSent", "rpcUnreachable", "The RPC is busy. Try again in a moment.", { cause: e });
    }
    if (!validRevealMargin(config.revealMarginSecs)) throw new TxFailure("nothingSent", "siteBug", `the Config's reveal margin (${config.revealMarginSecs} s) is outside ${REVEAL_MARGIN_MIN_SECS} to ${REVEAL_MARGIN_MAX_SECS} seconds. Nothing was built, signed or sent.`, {});
    /* Round 28c (Opus M1): the close is set on the cluster's clock, read again if its last read is over a minute old; a read that fails leaves the device's. */
    await syncNetworkClock({ maxAgeMs: CREATE_CLOCK_MAX_AGE_MS });
    const { ix, launch } = createLaunchInstruction(input, creator, mintSalt, config.revealMarginSecs, networkNowSec());
    hintLaunch(launch.toBase58());
    /* The prepay in the terms being signed (0.25), the setup rent read from the cluster (0.29: the histogram, the launch and the vault, kept for good) and an allowance for the fees. Checked before the bot check, so a short wallet spends no permit. */
    const setup = await this.getSetupCost();
    await this.requireBalance(creator, input.terms.crankBond + setup.total + GENESIS_OTHER_LAMPORTS, `the operating prepay, the launch cost (${fmtSol(setup.total)}, kept on chain for good) and the fees`);
    /*
      0.29, the seventh candidate: the creation permit over this exact
      instruction, checked byte for byte (attest.ts). No waiver: a refusal is
      said here and nothing is sent. The service registers the launch before
      it signs.
    */
    if (!TURNSTILE_SITE_KEY) throw new TxFailure("nothingSent", "botCheck", attestReasonText("not-set-up", "create"), {});
    if (!input.botToken) throw new TxFailure("nothingSent", "botCheck", attestReasonText("turnstile", "create"), {});
    let permit: Permit;
    try {
      permit = await requestCreatePermit({ creator: creator.toBase58(), launch: launch.toBase58(), createData: Uint8Array.from(ix.data), token: input.botToken, attestors: config.attestors });
    } catch (e) {
      /* Rehearsal item 2: the tries for this launch address are used up; the next try starts at a fresh address (a new salt). */
      if (e instanceof AttestRefused && e.reason === "limit-wallet") clearPendingSalt(signer.address);
      throw new TxFailure("nothingSent", "botCheck", e instanceof AttestRefused ? e.message : attestReasonText("unreachable", "create"), { cause: e });
    }
    const tx = createTransaction({ ix, launch, creator, permit });
    const sent = await sendAndConfirm(this.conn(), tx, signer, [], {
      ...opts,
      /* The launch account (its address from the pending salt) is the effect; 24k: read with the slot, so its absence past expiry proves nothing landed. */
      effect: accountEffect((keys, at) => this.accountsAt(keys, at), (k) => this.lastSignature(k), launch, "exists"),
    });
    clearPendingSalt(signer.address);
    const id = launch.toBase58();
    /* 2026-10-25 (the founder: no redirect after create on a phone): the launch has landed, so the page goes to it now. Reading it here only warms the next page; it never holds this one up or turns a landed create into a failure. */
    await within(this.getLaunch(id), 1_500);
    return { id, signature: sent.signature };
  }

  async getMyBid(launchId: string, bidder: string): Promise<BidAccount | null> {
    hintLaunch(launchId);
    const launch = parsePubkey(launchId);
    const who = parsePubkey(bidder);
    if (!launch || !who) return null;
    const pda = bidPda(launch, who);
    const info = await this.conn().getAccountInfo(pda, "confirmed");
    return info ? decodeBid(pda.toBase58(), Uint8Array.from(info.data)) : null;
  }

  /* A bid account closes when the bid is paid out, so the launches where one exists are where this wallet's deposit still sits. */
  async getMyBids(launchIds: string[], bidder: string): Promise<Set<string>> {
    const who = parsePubkey(bidder);
    const out = new Set<string>();
    if (!who) return out;
    const keys = launchIds.map((id) => ({ id, key: parsePubkey(id) })).filter((x): x is { id: string; key: PublicKey } => x.key !== null);
    for (let i = 0; i < keys.length; i += 100) {
      const slice = keys.slice(i, i + 100);
      const infos = await this.conn().getMultipleAccountsInfo(
        slice.map((x) => bidPda(x.key, who)),
        "confirmed",
      );
      infos.forEach((info, j) => {
        if (info && info.data.length === ACCOUNTS.Bid.len) out.add(slice[j].id);
      });
    }
    return out;
  }

  /*
    The winners the page names (book.ts, fundingWinners: open fills and closed
    deliveries; the 0.28 triage's F6, where the open accounts alone gave "0 of
    0" once paid out). The set per launch only grows, since winners are fixed
    at settle: a page that missed one for a moment during payouts does not
    start a walk on the smaller set. One walk per set, kept unless it fails.
  */
  async getHistogram(launchId: string): Promise<HistogramAccount | null> {
    const kept = this.histograms.get(launchId);
    if (kept) return kept;
    if (SITE_ROUTES) {
      /* 24d: the settlement page's histogram from the site's shared read (app/api/launch/[id]/histogram), not this browser's RPC. */
      const s = await this.endpoint<HistogramSnapshot>(`/api/launch/${launchId}/histogram`);
      const h = s.histogram ? decodeHistogram(s.histogram.address, bytesOf(s.histogram)) : null;
      if (h && s.settled) this.histograms.set(launchId, h);
      return h;
    }
    const key = histogramPda(new PublicKey(launchId));
    const info = await this.conn().getAccountInfo(key, "confirmed");
    const h = info && info.owner.equals(PROGRAM) ? decodeHistogram(key.toBase58(), Uint8Array.from(info.data)) : null;
    if (h) {
      const launch = await this.getLaunch(launchId).catch(() => null);
      if (launch && launch.account.settled) this.histograms.set(launchId, h);
    }
    return h;
  }

  getCreatorAge(launchId: string, creator: string): Promise<WalletAge> {
    let p = this.creatorAges.get(creator);
    if (!p) {
      p = SITE_ROUTES
        ? this.endpoint<{ creator: string; firstTs: number | null; complete: boolean; transactions: number }>(`/api/launch/${launchId}/creator`).then((r) => ({ address: r.creator, firstTs: r.firstTs, complete: r.complete, transactions: r.transactions }))
        : readWalletAge(creator, (before) => this.conn().getSignaturesForAddress(new PublicKey(creator), { before, limit: 1000 }, "confirmed"));
      const mine = p;
      this.creatorAges.set(creator, mine);
      mine.catch(() => {
        if (this.creatorAges.get(creator) === mine) this.creatorAges.delete(creator);
      });
    }
    return p;
  }

  getFundingReport(id: string, bidders: readonly string[]): Promise<FundingReport | null> {
    let set = this.fundingBidders.get(id);
    if (!set) {
      set = new Set();
      this.fundingBidders.set(id, set);
    }
    for (const b of bidders) set.add(b);
    const list = [...set].sort();
    const key = `${id}:${list.join(",")}`;
    let p = this.fundingReports.get(key);
    if (!p) {
      p = (async () => {
        /* Through the site: the server walks the winners once for everyone (server/funding.ts). */
        if (SITE_ROUTES) return (await this.endpoint<{ report: FundingReport | null }>(`/api/launch/${id}/funding?bidders=${list.join(",")}`)).report;
        const launch = await this.getLaunch(id);
        const record = await this.getSettlement(id);
        if (!launch || !launch.readable || !record) return null;
        /* The connection that does not retry a refusal on its own: the trace waits its turn with the history reader instead (rpcFunding.ts). */
        const provider = rpcFundingProvider(getHistoryConnection());
        return walkFunding({ launchId: id, creator: launch.account.creator, bidders: list, provider, known: KNOWN_WALLETS, source: "rpc", now: Math.floor(Date.now() / 1000) });
      })();
      this.fundingReports.set(key, p);
      p.catch(() => this.fundingReports.delete(key));
    }
    return p;
  }

  /* The record goes in the slot exactly when it exists on chain (INTERFACE 0.17: required whenever the launch has one). */
  private async recordSlot(launch: PublicKey): Promise<PublicKey | null> {
    const pda = settlementPda(launch);
    const info = await this.conn().getAccountInfo(pda, "confirmed");
    return info ? pda : null;
  }

  async refund(launchId: string, signer: TxSigner, opts: SendOptions = {}): Promise<{ signature: string; slot?: number }> {
    opts.onStage?.({ step: "building" });
    const launch = parsePubkey(launchId);
    if (!launch) throw new Error("This launch does not exist on this cluster.");
    const bidder = new PublicKey(signer.address);
    const bid = bidPda(launch, bidder);
    const tx = new Transaction().add(refundIx({ launch, vault: vaultPda(launch), settlement: await this.recordSlot(launch), bid, bidder, caller: bidder }));
    tx.feePayer = bidder;
    await this.requireBalance(bidder, SIGNATURE_FEE, "the fee");
    const sent = await sendAndConfirm(this.conn(), tx, signer, [], {
      ...opts,
      /* The refund closes the bid account: gone means it landed. */
      effect: accountEffect((keys, at) => this.accountsAt(keys, at), (k) => this.lastSignature(k), bid, "gone"),
    });
    /* 24n: with the slot it landed in, when the status read said (the page's refresh waits for a launch read that far). */
    return { signature: sent.signature, ...(sent.slot !== undefined ? { slot: sent.slot } : {}) };
  }

  /*
    v0.32 (the founder approved the mocks 2026-10-29): the bidder's collect of a parked payout (chain/parked.ts). The bid and
    the token account it needs are read again here, at the click; nothing is built for a bid that is not parked. The
    bid account closes with the collect: gone means it landed.
  */
  async collectParked(launchId: string, signer: TxSigner, opts: SendOptions = {}): Promise<{ signature: string; slot?: number; tokens: bigint; lamports: bigint }> {
    opts.onStage?.({ step: "building" });
    const launch = await this.getLaunch(launchId);
    if (!launch || !launch.readable) throw new Error("This launch cannot be read.");
    const key = new PublicKey(launch.id);
    const bidder = new PublicKey(signer.address);
    const bid = bidPda(key, bidder);
    let held: { tokens: bigint; lamports: bigint };
    let target: TokenTarget;
    let rent = 0n;
    const mint = mintPda(new PublicKey(launch.account.creator), launch.account.mintSalt);
    try {
      const info = await this.conn().getAccountInfo(bid, "confirmed");
      const b = info ? decodeBid(bid.toBase58(), Uint8Array.from(info.data)) : null;
      if (!b || b.state !== "parked" || !b.parked) throw new TxFailure("nothingSent", "refused", "Nothing is held for this wallet on this launch now, so nothing was built.", {});
      held = b.parked;
      target = await readTokenTarget(this.conn(), bidder, mint, held.tokens);
      if (needsTokenAccount(target)) rent = BigInt(await this.conn().getMinimumBalanceForRentExemption(TOKEN_ACCOUNT_BYTES, "confirmed"));
    } catch (e) {
      if (e instanceof TxFailure) throw e;
      throw new TxFailure("nothingSent", "rpcUnreachable", "The RPC is busy. Try again in a moment.", { cause: e });
    }
    const fresh = target.kind === "fresh" ? Keypair.generate() : null;
    const tx = collectParkedTransaction({ launch: key, bidder, mint, target, rent, fresh });
    await this.requireBalance(bidder, SIGNATURE_FEE * (fresh ? 2n : 1n) + rent, rent > 0n ? "the fee and the token account's rent" : "the fee");
    const sent = await sendAndConfirm(this.conn(), tx, signer, fresh ? [fresh] : [], {
      ...opts,
      effect: accountEffect((keys, at) => this.accountsAt(keys, at), (k) => this.lastSignature(k), bid, "gone"),
    });
    return { signature: sent.signature, ...(sent.slot !== undefined ? { slot: sent.slot } : {}), tokens: held.tokens, lamports: held.lamports };
  }

  /* 9C: the wallet's balance change in a landed transaction. */
  async walletChange(signature: string, address: string): Promise<bigint | null> {
    const tx = await this.landedTx(signature);
    return tx ? balanceChange(tx, address) : null;
  }

  /* A landed transaction's account keys and balances. A just-landed one may not be served yet: read up to five times, 1.1 s apart (the public devnet answers about one getTransaction a second). */
  private async landedTx(signature: string): Promise<{ keys: string[]; preBalances: number[]; postBalances: number[]; err: unknown } | null> {
    for (let i = 0; i < TX_READ_TRIES; i++) {
      if (i > 0) await new Promise((r) => setTimeout(r, TX_READ_GAP_MS));
      try {
        const t = await this.conn().getTransaction(signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
        if (!t || !t.meta) continue;
        const loaded = t.meta.loadedAddresses;
        const keys = [...t.transaction.message.staticAccountKeys, ...(loaded?.writable ?? []), ...(loaded?.readonly ?? [])].map((k) => k.toBase58());
        return { keys, preBalances: t.meta.preBalances, postBalances: t.meta.postBalances, err: t.meta.err };
      } catch {
        /* the next try */
      }
    }
    return null;
  }

  /*
    The lifecycle by hand (the keeper runs it too; any wallet may). Each step is one
    instruction any wallet may send; the signer pays the fee and, for
    settle, create_pool and lock_liquidity, the rents INTERFACE v0.21 names.
    Account lists match the Rust smoke client that landed every step of the
    0.21 soak; the pool addresses are checked against a live pool by
    scripts/check-pool-keys.ts. Everything is simulated before the wallet opens,
    so the program's own refusal shows first.
  */
  async push(launchId: string, step: PushStep, signer: TxSigner, opts: SendOptions = {}, bidder?: string): Promise<{ signature: string }> {
    opts.onStage?.({ step: "building" });
    const key = parsePubkey(launchId);
    if (!key) throw new Error("This launch does not exist on this cluster.");
    const launch = await this.getLaunch(launchId);
    if (!launch || !launch.readable) throw new Error("This launch cannot be read.");
    const a = launch.account;
    const me = new PublicKey(signer.address);
    const creator = new PublicKey(a.creator);
    const mint = mintPda(creator, a.mintSalt);
    const settlement = settlementPda(key);
    const tx = new Transaction();
    const budget = (units: number) => tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units }));
    let need = SIGNATURE_FEE;
    let what = "the fee";

    if (step === "close") {
      tx.add(closeIx({ launch: key }));
    } else if (step === "beacon") {
      const res = await fetch(roundSignatureUrl(a.revealRound)).catch(() => null);
      if (!res || !res.ok) throw new TxFailure("nothingSent", "refused", "The bids cannot be unsealed yet. That happens about two minutes after the window ends; try again shortly.", {});
      const json = (await res.json()) as { signature: string };
      const sig = Uint8Array.from(json.signature.match(/../g)!.map((h) => parseInt(h, 16)));
      tx.add(postBeaconIx({ launch: key }, sig));
    } else if (step === "reveal") {
      /* About 40,000 units a bid: up to 24 per transaction under the 1.4M limit (0.29: 962,832 measured for 24), the keeper's REVEAL_MAX; the button runs again for the rest. */
      const sealed = (await this.getBids(launchId)).filter((b) => b.state === "sealed").slice(0, 24);
      if (sealed.length === 0) throw new TxFailure("nothingSent", "refused", "Every bid is already open.", {});
      budget(1_400_000);
      tx.add(revealIx({ launch: key, vault: vaultPda(key), processor: me, histogram: histogramPda(key) }, sealed.map((b) => new PublicKey(b.address))));
    } else if (step === "settle") {
      /* 0.29: settle scans the 2,407-tick histogram, up to about 273,000 units. */
      budget(600_000);
      tx.add(settleIx({ launch: key, settlement, payer: me, creatorBid: a.creatorHasBid ? bidPda(key, creator) : null, vault: vaultPda(key), histogram: histogramPda(key) }));
      need += await this.getRent(ACCOUNTS.SettlementRecord.len);
      what = "the fee and the settlement record's rent";
    } else if (step === "createPool") {
      const pool = meteoraPoolPda(mint);
      const platformNft = positionNftMintPda(key, 1);
      budget(400_000);
      tx.add(
        createPoolIx(
          {
            launch: key, settlement, vault: vaultPda(key), tokenMint: mint, tokenVault: tokenVaultPda(key),
            poolCreator: poolCreatorPda(key), poolWsol: poolWsolPda(key), poolTokens: poolTokensPda(key), payer: me,
            platformNftMint: platformNft, platformNftAccount: positionNftAccountPda(platformNft), platformPosition: positionPda(platformNft),
            pool, tokenAVault: meteoraVaultPda(mint, pool), tokenBVault: meteoraVaultPda(WSOL_MINT, pool),
            /* 0.28: the raise fee's destinations, the launch's own creator (WrongCreator 6050) and, v0.30, the treasury it recorded, or lp_owner on a launch from before 0.30 (WrongTreasury 6090). */
            creatorWallet: creator, treasury: new PublicKey(poolTreasury(a)),
          },
          { creator, mintSalt: a.mintSalt },
        ),
      );
      /*
        The payer fronts about 0.043 SOL of rents (derived; 0.04148 measured on
        devnet, 0.0072 of it set aside for the lock step) before the crank bond
        reaches it at the end of the instruction (docs/lap-steps.md, corrected
        2026-09-29). Asked for 0.05, so a wallet funded to what the page says
        does not fall short by a rounding.
      */
      need += 50_000_000n;
      what = "the fee and about 0.043 SOL of rents, which have to be on hand until the creator's operating prepay repays them at the end of the same transaction";
    } else if (step === "finishMint") {
      /* 0.29, the ninth candidate: the token's metadata and the mint authority's revocation, once, on a live pool; the eleventh: or a finalized launch, paid from its metadata reserve. */
      if (a.mintFinished || (await this.mintAuthorityHeld(launchId)) !== true) throw new TxFailure("nothingSent", "refused", "The token's name is already on chain.", {});
      budget(120_000);
      tx.add(finishMintIx({ launch: key, vault: vaultPda(key), tokenMint: mint, metadata: metadataPda(mint), payer: me, creator: new PublicKey(a.creator) }));
      need += 14_000_000n;
      what = "the fee and the token metadata's rent and fee, repaid from the operating prepay or its metadata reserve in the same transaction";
    } else if (step === "lock") {
      const record = await this.getSettlement(launchId);
      if (!record?.pool || !record.poolPayer) throw new TxFailure("nothingSent", "refused", "The pool is not open yet.", {});
      const creatorNft = positionNftMintPda(key, 0);
      const platformNft = positionNftMintPda(key, 1);
      budget(300_000);
      tx.add(
        lockLiquidityIx({
          launch: key, settlement, vault: vaultPda(key), poolCreator: poolCreatorPda(key), payer: me, creator,
          creatorNftMint: creatorNft, creatorNftAccount: positionNftAccountPda(creatorNft), creatorPosition: positionPda(creatorNft), creatorNftAta: ataFor(creator, creatorNft, TOKEN_2022_PROGRAM),
          platformNftMint: platformNft, platformPosition: positionPda(platformNft), platformNftAccount: positionNftAccountPda(platformNft),
          /* The twelfth candidate: after release_pool_cash the pass through is gone and the slot takes the program id. */
          pool: new PublicKey(record.pool), poolPayer: new PublicKey(record.poolPayer), poolWsol: record.cashReleased ? null : poolWsolPda(key),
        }),
      );
      if (record.cashReleased) {
        /* release_pool_cash returned the set-aside rent to the pool payer and the prepay to the creator, so this lock is the split and the NFT alone and nothing repays its signer: 7,249,160 lamports of position rent on the program lane's harness. */
        need += 8_000_000n;
        what = "the fee and about 0.0073 SOL of rent for the creator's position, which nothing repays: the pool's cash was already released";
      } else {
        /* The creator's position, its NFT mint and NFT account take 0.00725 SOL of rent, 0.0072 of it set aside by create_pool; the signer paid 0.00005 on devnet. Asked for 0.005 as a margin. */
        need += 5_000_000n;
        what = "the fee and the few thousand lamports of the creator's position's rent that opening the pool did not set aside, repaid from the operating prepay";
      }
    } else if (step === "deliver" || step === "refundFor") {
      if (!bidder) throw new Error("No bid named.");
      const who = new PublicKey(bidder);
      const bid = bidPda(key, who);
      if (step === "deliver") {
        tx.add(deliverIx({ launch: key, vault: vaultPda(key), settlement, tokenMint: mint, tokenVault: tokenVaultPda(key), bid, bidder: who, bidderToken: ataAddress(who, mint), caller: me, callerToken: ataAddress(me, mint) }));
        need += 2n * (await this.getRent(165));
        what = "the fee and up to two token accounts' rent";
      } else {
        tx.add(refundIx({ launch: key, vault: vaultPda(key), settlement: await this.recordSlot(key), bid, bidder: who, caller: me }));
      }
    } else if (step === "openTrading") {
      /* v0.30 (SPEC 3.4): once every bid is paid out (distributed_count = bid_count), anyone thaws the pool; TradingNotOpenable 6085 before that. */
      const record = await this.getSettlement(launchId);
      if (!record?.pool) throw new TxFailure("nothingSent", "refused", "The pool is not created yet.", {});
      const pool = new PublicKey(record.pool);
      tx.add(openTradingIx({ launch: key, settlement, vault: vaultPda(key), tokenMint: mint, pool, tokenAVault: meteoraVaultPda(mint, pool) }));
    } else if (step === "finalize") {
      /* The mint of a launch created under v0.18 exists without any pool, so the pool pass-throughs go in only when a pool was opened. */
      const mintInfo = await this.conn().getAccountInfo(new PublicKey(a.tokenMint), "confirmed");
      const tokenMint = mintInfo ? new PublicKey(a.tokenMint) : null;
      const record = await this.recordSlot(key);
      const pooled = record ? !!(await this.getSettlement(launchId))?.pool : false;
      tx.add(
        burnUnsoldIx({
          launch: key, vault: vaultPda(key), settlement: record, tokenMint, tokenVault: tokenMint ? tokenVaultPda(key) : null,
          caller: me, creator, poolTokens: pooled ? poolTokensPda(key) : null, poolCreator: pooled ? poolCreatorPda(key) : null,
        }),
      );
    }
    tx.feePayer = me;
    await this.requireBalance(me, need, what);
    const sent = await sendAndConfirm(this.conn(), tx, signer, [], opts);
    await this.getLaunch(launchId);
    return { signature: sent.signature };
  }

  drivePlan(launch: Launch, bids: BidAccount[], record: SettlementRecord | null, payer: string, signer: TxSigner | null, genesis: string | null, mintHeld = false): DrivePlan | null {
    return drivePlan(launch, bids, record, payer, signer, genesis, mintHeld);
  }

  /* 0.29, the ninth candidate: the mint read once, for finish_mint (drive.ts, mintAuthorityHeld). Null before create_pool made it, or when unreadable. */
  /* view (24d): a page's check, from the launch's shared snapshot through the site; the signer's own calls read fresh. */
  async mintAuthorityHeld(launchId: string, view = false): Promise<boolean | null> {
    if (SITE_ROUTES && view) {
      const s = await this.snapshot(launchId);
      return s.mint ? mintAuthorityHeld(bytesOf(s.mint)) : null;
    }
    const launch = await this.getLaunch(launchId);
    if (!launch || !launch.readable) return null;
    const info = await this.conn().getAccountInfo(new PublicKey(launch.account.tokenMint), "confirmed").catch(() => undefined);
    if (info === undefined) return null;
    return info ? mintAuthorityHeld(Uint8Array.from(info.data)) : null;
  }

  private genesisHash: Promise<string | null> | null = null;
  private genesis(): Promise<string | null> {
    if (!this.genesisHash) this.genesisHash = this.conn().getGenesisHash().catch(() => null);
    return this.genesisHash;
  }

  /* The round's signature from the drand relays, in order; a relay that has not served it yet answers 404. */
  private async fetchBeacon(round: bigint): Promise<Uint8Array> {
    let notYet = false;
    const failures: string[] = [];
    for (const api of DRAND.apis) {
      try {
        const res = await fetch(roundSignatureUrl(round, api), { signal: AbortSignal.timeout(6000) });
        if (res.status === 404) {
          notYet = true;
          continue;
        }
        if (!res.ok) {
          failures.push(`${api}: ${res.status}`);
          continue;
        }
        const json = (await res.json()) as { signature?: unknown };
        if (typeof json.signature === "string" && /^[0-9a-f]{96}$/.test(json.signature)) return Uint8Array.from(json.signature.match(/../g)!.map((h) => parseInt(h, 16)));
        failures.push(`${api}: no signature in the reply`);
      } catch (e) {
        failures.push(`${api}: ${e instanceof Error ? e.message.slice(0, 60) : String(e)}`);
      }
    }
    if (notYet) throw new TxFailure("nothingSent", "refused", `The bids cannot be unsealed until ${fmtTime(bidsOpenAt(round))}. Press again in a few seconds.`, {});
    /* The relays and their answers go in the detail, which no page shows: their addresses name the beacon service, which the page does not. */
    throw new TxFailure("nothingSent", "rpcUnreachable", "The service that unseals the bids did not answer. Nothing was built, signed or sent; try again in a minute.", { cause: failures });
  }

  /*
    Everything due after the window, in the fewest transactions (chain/drive.ts,
    bundles.mjs), signed in one prompt where the wallet allows and sent one
    after another, each confirmed before the next. The first transaction is
    simulated before the wallet opens; the later ones cannot be, each needs
    the one before it landed. create_pool and lock_liquidity go one each
    (bundles.mjs: the runtime's instruction trace limit refuses them
    together); the cluster's lookup table is read for a wallet that takes
    version 0, for any group the composer marks v0, none on 0.27.
  */
  async drive(launchId: string, signer: TxSigner, opts: SendOptions = {}): Promise<DriveResult> {
    opts.onStage?.({ step: "building" });
    const key = parsePubkey(launchId);
    if (!key) throw new Error("This launch does not exist on this cluster.");
    const launch = await this.getLaunch(launchId);
    if (!launch || !launch.readable) throw new Error("This launch cannot be read.");
    const a = launch.account;
    const nowSec = networkNowSec();
    if (recoverable(a, nowSec)) throw new TxFailure("nothingSent", "refused", "Past the recovery deadline: nothing moves this launch forward now; every deposit can be recovered instead.", {});
    const me = new PublicKey(signer.address);
    const bids = await this.getBids(launchId);

    let beacon: Uint8Array | null = null;
    if ((a.state === "open" || a.state === "closed") && !a.beaconPosted && a.totalDeposits >= a.floorValue) {
      const at = bidsOpenAt(a.revealRound);
      if (nowSec < at) throw new TxFailure("nothingSent", "refused", `The bids unseal at ${fmtTime(at)}; nothing can open before then.`, {});
      beacon = await this.fetchBeacon(a.revealRound);
    }
    /* The ninth candidate: on a live pool, finish_mint is due while the mint keeps its authority; the eleventh: on a finalized launch too, and never once the launch says it landed. */
    const mintHeld = (a.state === "poolLive" || a.state === "finalized") && !a.mintFinished ? (await this.mintAuthorityHeld(launchId)) === true : false;
    const composed = composeDrive(launch, bids, launch.record, me, beacon, mintHeld);
    if (!composed) throw new TxFailure("nothingSent", "refused", "Nothing is due on this launch right now.", {});

    /* The table as the chain holds it; without it, or for a legacy-only wallet, the pool steps go as two transactions. */
    let alt: AddressLookupTableAccount | null = null;
    const tableAddr = signer.supportsV0 ? lookupTableFor(await this.genesis()) : null;
    if (tableAddr) alt = (await this.conn().getAddressLookupTable(new PublicKey(tableAddr), { commitment: "confirmed" }).catch(() => null))?.value ?? null;
    const ctx = { payer: me, alt, price: 0 };

    const packed = composed.specs.flatMap((s) => pack(s, ctx));
    const items = composed.specs.flatMap((s) => s.items);
    const need = SIGNATURE_FEE * BigInt(packed.length) + BigInt(txFront(items));
    await this.requireBalance(me, need, "the fees and what the steps front (the settlement record's rent, the pool accounts' rents), which the creator's operating prepay repays in the same transactions");

    /* What the chain shows once each transaction has landed, for a send whose answer was lost. */
    const revealedBefore = a.revealedCount + a.invalidCount;
    let revealedSoFar = 0;
    const effects: Effect[] = packed.map((p) => {
      const names = p.items.map((i) => i.name);
      revealedSoFar += p.items.reduce((s, i) => s + (i.count ?? 0), 0);
      const expectRevealed = revealedBefore + revealedSoFar;
      return async () => {
        const l = await this.getLaunch(launchId);
        if (!l) return { landed: false };
        const landed = names.includes("lock_liquidity")
          ? l.record?.lpLockState === 3
          : names.includes("finish_mint")
            ? l.account.mintFinished || (await this.mintAuthorityHeld(launchId)) === false
          : names.includes("create_pool")
            ? !!l.record?.pool
            : names.includes("settle")
              ? l.recordExists
              : names.includes("reveal")
                ? l.account.revealedCount + l.account.invalidCount >= expectRevealed
                : l.account.beaconPosted;
        return landed ? { landed: true, signature: await this.lastSignature(key) } : { landed: false };
      };
    });
    const build = (blockhash: string): BatchTx[] => composed.specs.flatMap((s) => pack(s, ctx)).map((p, i) => ({ tx: assemble(p.items, p.v0, unitLimit(p.items), { ...ctx, blockhash }), label: p.label, effect: effects[i] }));

    const res = await sendBatch(this.conn(), build, signer, opts);
    await this.getLaunch(launchId);
    const poolTx = res.sent.find((s) => s.label.includes("create_pool"));
    return {
      transactions: res.sent,
      prompts: res.prompts,
      roundAt: composed.beaconDue ? bidsOpenAt(a.revealRound) : null,
      poolAt: poolTx?.confirmedAt ?? null,
      bundledPool: !!poolTx && poolTx.label.includes("lock_liquidity"),
    };
  }

  async abort(launchId: string, signer: TxSigner, opts: SendOptions = {}): Promise<{ signature: string }> {
    opts.onStage?.({ step: "building" });
    const launch = parsePubkey(launchId);
    if (!launch) throw new Error("This launch does not exist on this cluster.");
    const tx = new Transaction().add(abortIx({ launch, settlement: await this.recordSlot(launch) }));
    const payer = new PublicKey(signer.address);
    tx.feePayer = payer;
    await this.requireBalance(payer, SIGNATURE_FEE, "the fee");
    const sent = await sendAndConfirm(this.conn(), tx, signer, [], {
      ...opts,
      effect: async () => {
        const l = await this.getLaunch(launchId);
        return l?.account.state === "aborted" ? { landed: true, signature: await this.lastSignature(launch) } : { landed: false };
      },
    });
    return { signature: sent.signature };
  }
}

export const chainClient = new ChainClient();

/* Every flow's confirmation reads a status through the site's shared status route, in the browser (chain/signer.ts setDefaultStatus): a signature a wallet sent itself is never refused there. */
if (SITE_ROUTES && typeof window !== "undefined") {
  setDefaultStatus(async (signature) => {
    const res = await fetchWithBackoff(`/api/tx/${signature}`, { cache: "no-store" });
    if (!res.ok) throw new Error(`The site's status route answered ${res.status}.`);
    return fromJson<{ status: { slot: number; confirmationStatus: string | null; err: unknown } | null }>(await res.text()).status;
  });
}
