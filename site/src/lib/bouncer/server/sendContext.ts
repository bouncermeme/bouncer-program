/*
  24e (the founder's capacity decisions, items 2 and 3): what a bid's send needs from the chain, read once for everyone instead
  of by each bidder's browser through the RPC route.

  - The chain context (app/api/launch/[id]/send): the program's deploy slot (the pin's last word before a wallet prompt,
    chain/cluster.ts), the latest blockhash with its last valid height, and the block height (expiry is judged by it).
    Three reads an instance a second at most, kept 1 s, and the CDN keeps the answer 1 s, so a final minute of 100 bids
    a second costs the RPC about three reads a second per region, not three hundred.
  - The priority price for one launch, only in its last FINAL_WINDOW_SECS (terms.ts priorityPrice): recent fees paid by
    transactions that wrote the launch and its vault, kept 2 s per launch. Zero earlier, with no read.
  - A signature's status (app/api/tx/[signature]): every status asked for within 150 ms on an instance is one
    getSignatureStatuses (server/coalesce.ts, up to 256 at once), so a crowd confirming costs a few reads a second.
  - The cluster's clock (app/api/time; round 28c, Opus M1, under the founder's caching rule of 2026-10-24): the block time
    of a recent confirmed slot, read at most once every CLOCK_KEEP_MS an instance and carried by the server's elapsed
    time; the CDN keeps the answer 1 s. Every page's network clock (netClock.ts) offsets from it: no visitor reads the
    RPC for the time.

  Every read here is a send's surroundings, so it is charged as urgent (server/budget.ts): past the soft line it still
  goes through, past the budget nothing does. Nothing here signs or holds a key.
*/
import { Connection, PublicKey, type TransactionConfirmationStatus } from "@solana/web3.js";
import { DEPLOYMENT as deployment } from "@contract/active";
import { decodeLaunch } from "../chain/decode";
import { vaultPda } from "../chain/pda";
import { getConnection } from "../chain/rpc";
import { closeAtTs } from "../view";
import { FINAL_WINDOW_SECS, priorityPrice } from "../terms";
import { meteredFetchFor } from "./budget";
import { coalesce } from "./coalesce";
import { safeTxError, type Json } from "./output";
import { readSnapshot } from "./snapshot";

/* Where the deploy slot sits in the program data account (UpgradeableLoaderState::ProgramData: a 4-byte tag, then the slot). */
const PD_SLOT_OFFSET = 4;
const CHAIN_KEEP_MS = 1_000;
const PRICE_KEEP_MS = 2_000;
const STATUS_WINDOW_MS = 150;
const STATUS_MAX = 256;
/* The cluster clock's anchor is read again after this long on an instance. */
export const CLOCK_KEEP_MS = 5_000;

export interface ChainContext {
  /* The slot the blockhash was read at, and when, by the server's clock. */
  slot: number;
  readAt: number;
  /* The program's deploy slot, or null when its data account could not be read. */
  programSlot: number | null;
  blockhash: string;
  lastValidBlockHeight: number;
  blockHeight: number;
}

export interface SendContext extends ChainContext {
  id: string;
  /* The priority price for a commit on this launch now, micro-lamports a compute unit: zero outside the last FINAL_WINDOW_SECS. */
  priorityMicroLamports: number;
  /* Seconds to the book's close by the server's clock when this was read (negative once past). */
  secondsLeft: number;
}

export interface StatusAnswer {
  slot: number;
  /* Null when the node has no status for the signature (not seen yet, or never sent). */
  status: { slot: number; confirmationStatus: TransactionConfirmationStatus | null; err: Json } | null;
}

let urgentConn: Connection | null = null;
/* The server's RPC with the send's urgency: charged past the soft line (server/budget.ts meteredFetchFor). */
export function urgentConnection(): Connection {
  if (!urgentConn) urgentConn = new Connection(getConnection().rpcEndpoint, { commitment: "confirmed", fetch: meteredFetchFor(true), disableRetryOnRateLimit: true });
  return urgentConn;
}
/* For the checks: a stub connection in place of the server's, and nothing kept. */
export function setUrgentConnection(c: Connection | null): void {
  urgentConn = c;
  chainKept = null;
  clockKept = null;
  prices.clear();
  statusOf = null;
}

let chainKept: { at: number; value: Promise<ChainContext> } | null = null;
export function readChainContext(now: () => number = Date.now): Promise<ChainContext> {
  if (chainKept && now() - chainKept.at < CHAIN_KEEP_MS) return chainKept.value;
  const value = (async (): Promise<ChainContext> => {
    const c = urgentConnection();
    const [pd, bh, height] = await Promise.all([
      c.getAccountInfo(new PublicKey(deployment.program_data_account), { commitment: "confirmed", dataSlice: { offset: PD_SLOT_OFFSET, length: 8 } }).catch(() => null),
      c.getLatestBlockhashAndContext("confirmed"),
      c.getBlockHeight("confirmed"),
    ]);
    const data = pd ? Uint8Array.from(pd.data) : null;
    const programSlot = data && data.length >= 8 ? Number(new DataView(data.buffer, data.byteOffset, 8).getBigUint64(0, true)) : null;
    return { slot: bh.context.slot, readAt: now(), programSlot, blockhash: bh.value.blockhash, lastValidBlockHeight: bh.value.lastValidBlockHeight, blockHeight: height };
  })();
  const kept = { at: now(), value };
  chainKept = kept;
  value.catch(() => {
    if (chainKept === kept) chainKept = null;
  });
  return value;
}

const prices = new Map<string, { at: number; value: Promise<number> }>();
function readPrice(id: string, secondsLeft: number, now: () => number): Promise<number> {
  const hit = prices.get(id);
  if (hit && now() - hit.at < PRICE_KEEP_MS) return hit.value;
  const launch = new PublicKey(id);
  const value = urgentConnection()
    .getRecentPrioritizationFees({ lockedWritableAccounts: [launch, vaultPda(launch)] })
    .then((fees) => priorityPrice(fees.map((f) => f.prioritizationFee), secondsLeft))
    /* No fee read is no fee: the bid still goes, at the base fee. */
    .catch(() => 0);
  if (prices.size >= 200) prices.delete(prices.keys().next().value as string);
  prices.set(id, { at: now(), value });
  return value;
}

/* One launch's send context: the shared chain context, and the priority price only while the book is open in its last FINAL_WINDOW_SECS (terms.ts). Null when the launch cannot be decoded. */
export async function readSendContext(id: string, now: () => number = Date.now): Promise<SendContext | null> {
  const [chain, snap] = await Promise.all([readChainContext(now), readSnapshot(id)]);
  const launch = snap.launch ? decodeLaunch(id, Uint8Array.from(Buffer.from(snap.launch.data, "base64"))) : null;
  if (!launch) return null;
  const secondsLeft = closeAtTs(launch) - Math.floor(now() / 1000);
  const late = launch.state === "open" && secondsLeft <= FINAL_WINDOW_SECS;
  const priorityMicroLamports = late ? await readPrice(id, secondsLeft, now) : 0;
  return { ...chain, id, priorityMicroLamports, secondsLeft };
}

/* The cluster clock's anchor: the block time of the confirmed slot read, and the server's clock when the slot was read. */
export interface ClusterAnchor {
  slot: number;
  blockTimeSec: number;
  readAt: number;
}

let clockKept: { at: number; value: Promise<ClusterAnchor> } | null = null;
/* The anchor, shared by every request on this instance for CLOCK_KEEP_MS. A block time that is not a positive number is a failed read. */
export function readClusterAnchor(now: () => number = Date.now): Promise<ClusterAnchor> {
  if (clockKept && now() - clockKept.at < CLOCK_KEEP_MS) return clockKept.value;
  const value = (async (): Promise<ClusterAnchor> => {
    const c = urgentConnection();
    const slot = await c.getSlot("confirmed");
    const readAt = now();
    if (!Number.isSafeInteger(slot) || slot < 1) throw new Error("no slot");
    for (const s of [slot, slot - 1]) {
      const t = await c.getBlockTime(s).catch(() => null);
      /* A slot is 400 ms: the slot before's time carried to this one. */
      if (typeof t === "number" && Number.isFinite(t) && t > 0) return { slot, blockTimeSec: t + (slot - s) * 0.4, readAt };
    }
    throw new Error("no block time");
  })();
  const kept = { at: now(), value };
  clockKept = kept;
  value.catch(() => {
    if (clockKept === kept) clockKept = null;
  });
  return value;
}

/*
  The cluster's clock now, in ms, from an anchor: its block time (whole seconds, so half a second is added) carried by
  the server's time since the slot was read.
*/
export function clusterNowMs(a: ClusterAnchor, nowMs: number = Date.now()): number {
  return Math.round(a.blockTimeSec * 1000 + 500 + Math.max(0, nowMs - a.readAt));
}

let statusOf: ((signature: string) => Promise<StatusAnswer>) | null = null;
/* A signature's status through the instance's shared read. Recent statuses only (the node's status cache): a send is polled while its blockhash lives. */
export function readStatus(signature: string): Promise<StatusAnswer> {
  if (!statusOf) {
    statusOf = coalesce<string, StatusAnswer>(
      async (sigs) => {
        const r = await urgentConnection().getSignatureStatuses(sigs, { searchTransactionHistory: false });
        return sigs.map((_, i) => {
          const s = r.value[i];
          if (!s) return { slot: r.context.slot, status: null };
          const raw = (s.err ?? null) as Json;
          /* The node's error leaves typed (server/output.ts safeTxError), or as one fixed word: never its own text. */
          const err: Json = raw === null ? null : (safeTxError(raw) ?? "unrecognized");
          return { slot: r.context.slot, status: { slot: s.slot, confirmationStatus: s.confirmationStatus ?? null, err } };
        });
      },
      STATUS_WINDOW_MS,
      STATUS_MAX,
    );
  }
  return statusOf(signature);
}
