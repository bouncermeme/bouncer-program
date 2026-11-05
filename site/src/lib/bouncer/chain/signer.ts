/*
  The one seam between the client and whatever signs: a wallet in the
  browser, a keypair in a script, or the dev key. The client builds a
  transaction, the signer signs it, the client broadcasts it through the
  site's own RPC and confirms it there over HTTP (no websocket, 2026-10-15).
  The site never holds a key of its
  own except the dev key, which is off unless NEXT_PUBLIC_DEV_WALLET=1 and
  exists for devnet only.

  Why the site broadcasts rather than the wallet: the page then knows the
  signature before anything is sent, runs the RPC's preflight (a refusal
  there means the transaction was never forwarded), and can read the chain
  afterwards to say what happened. A wallet that can only sign and send
  (some mobile and embedded wallets) takes the second path, signAndSend,
  and the site resolves the outcome from the chain instead.

  Every failure is a TxFailure with one of three kinds, because the person
  reading it needs one fact above all: did money move.
  - nothingSent: certain. No transaction reached the network; nothing left
    the wallet. The wallet declined, disconnected or switched account, the
    simulation or the preflight refused, or the transaction expired before
    it was sent.
  - landedFailed: the transaction landed and the program refused it. The
    network fee was paid; nothing else moved. The signature is given.
  - unknown: the site could not determine it within the time it waited.
    The signature is given when the site has it. This kind is reached only
    after the chain was polled past the transaction's own expiry, so it
    should be rare, and the page says what to check.

  A batch (sendBatch, 2026-10-07) is several transactions signed in one
  wallet prompt and sent one after another, each confirmed before the next.
  Its failure names the ones that landed before it (detail.sentBefore), so
  the kind still answers for the transaction that failed and the page can
  say what landed.

  In the browser the program's deploy slot is read before every wallet
  prompt and again before the site puts each transaction on the network, and
  the send is refused, nothing sent, unless it is the one the page's last
  passed check saw (cluster.ts, fails closed, 2026-10-09; the second read,
  after the wallet answers, 2026-10-10). A wallet that sends for itself
  (signAndSend) is read before its prompt only. Scripts in node skip these
  reads: they do not run the page's check.

  24e (the founder's capacity decisions): the page can hand the signer shared reads
  (SendContext) for the pin, the blockhash, the height and the status, read
  once for everyone by the site's server and its CDN, so a bid's own RPC
  calls are its simulation and its outcome read. Each falls back to the RPC.
*/
import { Connection, Keypair, PublicKey, Transaction, VersionedTransaction } from "@solana/web3.js";
import { ed25519 } from "@noble/curves/ed25519.js";
import bs58 from "bs58";
import { errorName } from "@contract/constants";
import { confirmPinBeforeSend, hostOf, shortError } from "./cluster";
import { mayHaveReached, rememberSent } from "./rpc";
import { explainError, programErrorCode } from "./errors";
import { DAMM_V2_PROGRAM } from "./pool";

export type SignerKind = "wallet" | "devkey" | "keypair";

export type AnyTx = Transaction | VersionedTransaction;

export interface TxSigner {
  address: string;
  kind: SignerKind;
  walletName?: string;
  /* Signs and returns the signed transaction; the client broadcasts it through its RPC (the site's route). The fallback for a single send, and the path of a batch. */
  signTransaction?<T extends AnyTx>(tx: T): Promise<T>;
  /* Signs several in one prompt, in order. Without it the client asks once per transaction. */
  signAllTransactions?<T extends AnyTx>(txs: T[]): Promise<T[]>;
  /* The wallet signs and broadcasts through its own RPC, on the pin's chain, and returns the signature; the client confirms from it over HTTP. Preferred for a single send when offered (the founder, 2026-10-15). */
  signAndSend?(tx: AnyTx, connection: Connection, extraSigners: Keypair[]): Promise<string>;
  /* 23c: signs a plain message (the creator sign-in, server/session.ts); absent when the wallet offers no message signing. */
  signMessage?(message: Uint8Array): Promise<Uint8Array>;
  /* B22 (2026-11-04): the same, with the bytes the wallet says it signed (Wallet Standard solana:signMessage); a Ledger signs an off-chain envelope around the message. */
  signMessageWithBytes?(message: Uint8Array): Promise<{ signature: Uint8Array; signedMessage: Uint8Array }>;
  /* Whether the signer takes version 0 transactions (an address lookup table). Legacy only when absent. */
  supportsV0?: boolean;
  /* 24e: whether signAndSend can take this transaction (the selected account's features, the pinned chain, the transaction's version), decided before any send. When false the client signs here and sends instead. Absent means yes. */
  canSignAndSend?(tx: AnyTx): boolean;
  /* Whether the wallet still holds this address as its active account. Read when a signing call fails, to name what happened. */
  stillActive?(): "yes" | "switched" | "disconnected";
}

function signWith<T extends AnyTx>(tx: T, kp: Keypair): T {
  if (tx instanceof VersionedTransaction) tx.sign([kp]);
  else tx.partialSign(kp);
  return tx;
}

export function keypairSigner(kp: Keypair): TxSigner {
  return {
    address: kp.publicKey.toBase58(),
    kind: "keypair",
    supportsV0: true,
    async signTransaction(tx) {
      return signWith(tx, kp);
    },
    async signAllTransactions(txs) {
      return txs.map((t) => signWith(t, kp));
    },
  };
}

/* Where a transaction is, from the page's point of view. `since` is Date.now() when the step began, for an elapsed counter. In a batch, `index` of `total` names the transaction being sent. */
export type TxStage =
  | { step: "building" }
  | { step: "simulating" }
  | { step: "wallet"; since: number; count?: number; again?: boolean }
  | { step: "sending"; index?: number; total?: number }
  | { step: "confirming"; signature: string; since: number; index?: number; total?: number }
  | { step: "resolving"; signature: string | null; since: number };

export type OnStage = (stage: TxStage) => void;

export type FailureKind = "nothingSent" | "landedFailed" | "unknown";

export type FailureReason =
  | "walletDeclined"
  | "walletDisconnected"
  | "walletSwitched"
  | "walletUnsupported"
  | "walletError"
  | "expired"
  | "refused"
  /* 0.29: the bot check refused or could not be reached before anything was built (lib/bouncer/attest.ts). */
  | "botCheck"
  | "insufficientFunds"
  | "rpcUnreachable"
  | "pinUnconfirmed"
  | "unresolved"
  | "siteBug";

export interface FailureDetail {
  signature?: string | null;
  /* The program's error code and its name from the pin, when the refusal was the program's. */
  code?: number | null;
  codeName?: string | null;
  /* Set when another program refused (Meteora's, for a swap or a fee claim): its name for the sentence. The code and codeName are then that program's, never looked up in the pin. */
  program?: string | null;
  /* walletSwitched: the account the wallet signed as, when it could be read, and the one the page expected. */
  signedAs?: string | null;
  expected?: string | null;
  /* In a batch: the transactions that landed before the one this failure is about, and how many the batch had. */
  sentBefore?: { label: string; signature: string }[];
  batchTotal?: number;
  cause?: unknown;
}

export class TxFailure extends Error {
  constructor(
    public readonly kind: FailureKind,
    public readonly reason: FailureReason,
    message: string,
    public readonly detail: FailureDetail = {},
  ) {
    super(message);
    this.name = "TxFailure";
  }
}

export interface Sent {
  signature: string;
  logs: string[];
  /* 24e: the slot the status read saw it land in, when the status said (not when only the effect did). */
  slot?: number;
}

/*
  What the client can check on chain after an ambiguous send: whether the transaction's effect exists, and the signature
  that produced it when it can be found. 24k (the founder's final rule for wallet-owned sends): settle asks for the read at or
  after the slot where expiry was seen (minContextSlot); an effect that answers "not landed" with the slot it read at
  (contextSlot) proves nothing landed only when that slot is at or past it. An effect that cannot say so (no
  contextSlot) can prove a landing, never an absence.
*/
export type Effect = (at?: { minContextSlot: number }) => Promise<{ landed: boolean; signature?: string | null; contextSlot?: number; account?: string }>;

/*
  24e (the founder's capacity decisions, item 2): shared reads in place of the signer's own RPC calls, for the site's page
  (chain/chainClient.ts, the launch's send context and the shared status read). Each is optional; one that fails falls
  back to the RPC, so the shared reads can only save calls, never stop a send.
*/
export interface SendContext {
  /* The program's deploy slot as a shared read saw it, for the pin's last word before a prompt (cluster.ts). */
  programSlot?: () => Promise<number | null>;
  blockhash?: () => Promise<Blockhash>;
  height?: () => Promise<number | null>;
  status?: (signature: string) => Promise<{ confirmationStatus: string | null; err: unknown; slot: number } | null>;
}

/*
  2026-10-25 (the founder: no redirect after create, Phantom on an iPhone): the shared status read for every flow, not only a
  bid's. A wallet that sends itself (signAndSend) hands back a signature the site's RPC route never saw, so the route's
  scope refuses its status (server/scope.ts signatureAllowed), and the loop used to wait for the blockhash to expire
  (60 to 90 s) before the effect told it the create had landed. The site's status route answers any signature
  (app/api/tx/[signature]); the client registers it here once (chainClient.ts), and a flow's own SendContext still wins.
*/
let defaultStatus: SendContext["status"] | undefined;
export function setDefaultStatus(read: SendContext["status"] | undefined): void {
  defaultStatus = read;
}

export interface SendOptions {
  onStage?: OnStage;
  effect?: Effect;
  context?: SendContext;
  /* Whether to read the landed transaction's logs (one getTransaction). A bid reads its outcome from its account instead (24e): false. */
  logs?: boolean;
}

/* What the confirmation loop carries: how to tell it landed, the shared reads, and whether to read logs. */
interface Flow {
  effect?: Effect;
  ctx?: SendContext;
  logs: boolean;
  /* 24l (Claude N-1): after a wallet-owned send, the message the wallet was given and the account that pays, so a failed transaction in the effect account's history can be recognised as this one. */
  own?: { message: Uint8Array; payer: PublicKey };
}
const flowOf = (opts: SendOptions, effect: Effect | undefined = opts.effect): Flow => ({ effect, ctx: opts.context, logs: opts.logs !== false });

/* Blocks past the blockhash's last valid height before the transaction is treated as dead, on top of the runtime's own rule. */
const EXPIRY_MARGIN_BLOCKS = 8;
/* The longest the resolver polls after a send, in ms. A blockhash lives about 60 to 90 s; this leaves room for a slow RPC. */
const RESOLVE_LIMIT_MS = 180_000;
/* 24l (Astra R11-M2): the longest one read in the resolver may take; every read is also cut at the resolver's deadline. */
const READ_LIMIT_MS = 10_000;
/* 24l (Claude N-1): how many of the effect account's newest signatures are looked through for a failed one of ours. */
const HISTORY_SCAN = 20;
/* 24m (Astra R12-L1, Claude L-3): pages of HISTORY_SCAN read, newest first, before the scan gives up (unknown). */
const HISTORY_PAGES = 5;
/*
  Between two status reads while a sent transaction is awaited, and how many of those reads apart the block height is
  read (expiry is judged by it; a blockhash lives a minute or more, so it need not be read every time). After an
  ambiguous send with no signature the height is read every time. 24e (item 2): the wait grows, 1 s, then 1.5 s, 2 s,
  2.5 s and 3 s from then on, so a transaction slow to land costs fewer reads; most land within the first two.
*/
const CONFIRM_POLL_MS = [1_000, 1_500, 2_000, 2_500, 3_000];
const pollWait = (polls: number): number => CONFIRM_POLL_MS[Math.min(polls, CONFIRM_POLL_MS.length - 1)];
const HEIGHT_EVERY = 3;

export type Blockhash = { blockhash: string; lastValidBlockHeight: number };

/*
  24e (the founder, 2026-10-25): a refusal for rate is waited out, never shown at once. The site's fetch already retries a 429
  three times after a random, growing wait (chain/rpc.ts fetchWithBackoff), over the route's own retries; on top of that
  the steps before the prompt (the pin, the blockhash, the simulation) are tried RATE_ROUNDS more times, after 2 to 4 s,
  then 4 to 8 s, and a send through the route resends the same signed bytes (the same signature, so it can land once at
  most). Only then is the refusal said, as "nothing was sent" before a send.
*/
const RATE_ROUNDS = 2;
const RATE = /\b429\b|Too Many Requests|-32005|busy/i;
export const isRateRefusal = (e: unknown): boolean => RATE.test(messageOf(e)) || RATE.test(messageOf((e as { cause?: unknown } | null)?.cause ?? ""));
const rateWait = (round: number): number => 2_000 * 2 ** round * (1 + Math.random());
async function patiently<T>(run: () => Promise<T>, retry: (e: unknown) => boolean = isRateRefusal): Promise<T> {
  for (let round = 0; ; round++) {
    try {
      return await run();
    } catch (e) {
      if (round >= RATE_ROUNDS || !retry(e)) throw e;
      await sleep(rateWait(round));
    }
  }
}

async function latestBlockhash(connection: Connection, ctx?: SendContext): Promise<Blockhash> {
  if (ctx?.blockhash) {
    const shared = await ctx.blockhash().catch(() => null);
    if (shared) return shared;
  }
  try {
    return await patiently(() => connection.getLatestBlockhash("confirmed"));
  } catch (e) {
    throw rpcDown(e, connection);
  }
}

/* The pin's last word before anything is built or signed: in the browser only, where the page's check ran. 24e: from the shared read when there is one. */
async function pinOrThrow(connection: Connection, ctx?: SendContext): Promise<void> {
  if (typeof window === "undefined") return;
  try {
    /* A read that did not answer (a refusal for rate among them) is tried again; an upgrade is said at once. */
    await patiently(() => confirmPinBeforeSend(connection, undefined, ctx?.programSlot), (e) => /did not answer|could not be read/.test(messageOf(e)));
  } catch (e) {
    throw new TxFailure("nothingSent", "pinUnconfirmed", messageOf(e), { cause: e });
  }
}

/* Simulated unsigned (no sigVerify), so the program's own refusal is read before any wallet prompt. */
async function simulateOrThrow(connection: Connection, tx: AnyTx): Promise<void> {
  let sim: Awaited<ReturnType<Connection["simulateTransaction"]>>;
  try {
    sim = await patiently(() => (tx instanceof VersionedTransaction ? connection.simulateTransaction(tx, { sigVerify: false }) : connection.simulateTransaction(tx)));
  } catch (e) {
    throw rpcDown(e, connection);
  }
  if (sim.value.err) throw refusal("nothingSent", sim.value.err, sim.value.logs ?? [], null);
}

/* The signature the expected account put on a signed transaction, or null when it did not sign. */
function signatureBy(signed: AnyTx, expected: PublicKey): Uint8Array | null {
  if (signed instanceof VersionedTransaction) {
    const keys = signed.message.staticAccountKeys;
    const n = signed.message.header.numRequiredSignatures;
    for (let i = 0; i < n && i < keys.length; i++) {
      if (keys[i].equals(expected)) {
        const s = signed.signatures[i];
        return s && s.some((b) => b !== 0) ? s : null;
      }
    }
    return null;
  }
  const mine = signed.signatures.find((s) => s.publicKey.equals(expected));
  return mine?.signature ?? null;
}

/* Who else signed, for the walletSwitched sentence. */
function otherSigner(signed: AnyTx, expected: PublicKey, extraSigners: Keypair[]): string | null {
  if (signed instanceof VersionedTransaction) {
    const keys = signed.message.staticAccountKeys;
    const n = signed.message.header.numRequiredSignatures;
    for (let i = 0; i < n && i < keys.length; i++) {
      const s = signed.signatures[i];
      if (s && s.some((b) => b !== 0) && !keys[i].equals(expected) && !extraSigners.some((k) => k.publicKey.equals(keys[i]))) return keys[i].toBase58();
    }
    return null;
  }
  const other = signed.signatures.find((s) => s.signature && !s.publicKey.equals(expected) && !extraSigners.some((k) => k.publicKey.equals(s.publicKey)));
  return other?.publicKey.toBase58() ?? null;
}

/*
  The wallet must have signed as the account this page is using. A wallet
  whose active account changed while the prompt was open signs as someone
  else, or not at all. Returns the base58 signature. A legacy transaction's
  signatures are verified here; a version 0 one's by the RPC's preflight,
  which refuses a bad signature before forwarding.
*/
function checkSigned(signed: AnyTx, signer: TxSigner, expected: PublicKey, extraSigners: Keypair[]): string {
  const mine = signatureBy(signed, expected);
  if (!mine) {
    const active = signer.stillActive?.() ?? "yes";
    throw new TxFailure(
      "nothingSent",
      active === "disconnected" ? "walletDisconnected" : "walletSwitched",
      active === "disconnected" ? "Your wallet disconnected before it signed." : "Your wallet did not sign as the account this page is using.",
      { signedAs: otherSigner(signed, expected, extraSigners), expected: expected.toBase58() },
    );
  }
  if (!(signed instanceof VersionedTransaction) && !signed.verifySignatures(true)) {
    throw new TxFailure("nothingSent", "walletError", "The wallet returned a transaction whose signatures do not verify, so it was not sent.", { expected: expected.toBase58() });
  }
  return bs58.encode(mine);
}

function serialized(signed: AnyTx): Uint8Array {
  return signed instanceof VersionedTransaction ? signed.serialize() : new Uint8Array(signed.serialize());
}

/*
  Send a signed transaction and confirm it. Preflight on: a refusal here
  means the RPC never forwarded the transaction. Throws "expiredAtSend" as
  an Error subclass the batch sender can catch to rebuild.
*/
class ExpiredAtSend extends Error {
  constructor(public readonly signature: string, public readonly cause: unknown) {
    super("expired before it was sent");
  }
}

/*
  24g (Astra 24f F3): the site's RPC route marks a refusal it made before forwarding anything (its send bucket, its own
  busy queue, the day's budget before the first try) with "notForwarded" in the JSON-RPC error's data (server/output.ts).
  Only when every try of a send was refused that way is nothing sent for certain; one try that reached the node, or
  any other error, still reads the chain.
*/
const NOT_FORWARDED = /"notForwarded"\s*:\s*true/;
export const notForwarded = (e: unknown): boolean => NOT_FORWARDED.test(messageOf(e)) || NOT_FORWARDED.test(messageOf((e as { cause?: unknown } | null)?.cause ?? ""));

async function broadcast(connection: Connection, signed: AnyTx, signature: string, bh: Blockhash, stage: OnStage, flow: Flow, progress?: { index: number; total: number }): Promise<Sent> {
  stage({ step: "sending", ...progress });
  /* The signed bytes, for the site's route to prove this signature is this Bouncer transaction's on any instance (chain/rpc.ts, server/scope.ts). */
  rememberSent(signature, serialized(signed));
  /*
    24i (Astra R8-M1, Claude M1): whether any try of these bytes may have reached the node, at every retry layer: this
    loop's rounds (each error seen here), the site fetch's own 429 retries inside each round (chain/rpc.ts
    mayHaveReached), and the route's window (it marks only a refusal made before forwarding these bytes).
  */
  const bytes = Buffer.from(serialized(signed)).toString("base64");
  let forwarded = false;
  try {
    /* A refusal for rate: the same bytes again (the same signature), after a random, growing wait. */
    await patiently(async () => {
      try {
        return await connection.sendRawTransaction(serialized(signed), { skipPreflight: false, preflightCommitment: "confirmed" });
      } catch (e) {
        if (!notForwarded(e) || mayHaveReached(bytes)) forwarded = true;
        throw e;
      }
    });
  } catch (e) {
    /*
      24j (the founder's final rule; Astra R9-M1, R9-L1): once these signed bytes have left the page, nothing here is proof that
      they did not land: an earlier try may have reached the node, and a refusal now (busy, a preflight refusal, an
      expired blockhash) says nothing about it. So every such end goes through the chain: the status read with history
      past the expiry anchor, and the effect read where there is one (settle). Only that proof gives the refusal ("nothing
      sent", or a rebuild after an expiry); otherwise it is unknown, in the existing words. The provenance above
      (forwarded, mayHaveReached, the route's mark) only lets settle skip the status polls before expiry when no try can
      have reached the node; it is never proof.
    */
    const reached = forwarded || mayHaveReached(bytes) || !notForwarded(e);
    const msg = messageOf(e);
    let refused: Error | null = null;
    if (!reached) refused = new TxFailure("nothingSent", "rpcUnreachable", "The RPC is busy. Try again in a moment.", { signature, cause: e });
    else if (/Blockhash not found/i.test(msg)) refused = new ExpiredAtSend(signature, e);
    else if (programErrorCode(e) !== null || /insufficient (funds|lamports)|prior credit|simulation failed|Transaction simulation/i.test(msg)) refused = refusal("nothingSent", e, [], signature);
    /* The request itself failed, or was refused: the node may or may not have received the transaction. Read the chain. */
    return resolve(connection, signature, bh, stage, flow, e, refused, !reached);
  }
  return confirm(connection, signature, bh, stage, flow, progress);
}

/*
  Over HTTP only (2026-10-15): the signature's status is read every 1.5 s
  until it is confirmed or the blockhash has expired. web3.js's own
  confirmTransaction waits for a websocket subscription before it reads a
  status once, and the site's route has no websocket, so through it a send
  would have waited for the blockhash to expire (about a minute) before the
  resolver below started. The same loop serves every RPC, so devnet proves
  what mainnet runs.
*/
async function confirm(connection: Connection, signature: string, bh: Blockhash, stage: OnStage, flow: Flow, progress?: { index: number; total: number }): Promise<Sent> {
  stage({ step: "confirming", signature, since: Date.now(), ...progress });
  return settle(connection, signature, bh, flow, null, "confirming");
}

/*
  Blockhash, simulation, wallet, send, confirm. Throws TxFailure; never a
  bare Error for anything the wallet or the chain did.
*/
export async function sendAndConfirm(connection: Connection, tx: Transaction, signer: TxSigner, extraSigners: Keypair[] = [], opts: SendOptions = {}): Promise<Sent> {
  try {
    return await sendAndConfirmOnce(connection, tx, signer, extraSigners, opts);
  } catch (e) {
    throw namedByInstruction(e, tx);
  }
}

/*
  A refusal whose logs did not say which program made it (a landed failure
  whose logs the node did not return in time, a preflight that carried none):
  the error's instruction index names the program from the transaction
  itself, no RPC needed. Only another program's refusal is renamed; Bouncer's
  keep the pin's names.
*/
function namedByInstruction(e: unknown, tx: Transaction): unknown {
  if (!(e instanceof TxFailure) || e.reason !== "refused" || e.detail.program) return e;
  const text = `${messageOf(e.detail.cause)} ${JSON.stringify(e.detail.cause ?? null)}`;
  const at = /"InstructionError":\[(\d+)/.exec(text) ?? /Error processing Instruction (\d+)/.exec(text);
  const ix = at ? tx.instructions[Number(at[1])] : undefined;
  const program = ix ? FOREIGN_PROGRAMS[ix.programId.toBase58()] : undefined;
  if (!program) return e;
  const code = e.detail.code ?? null;
  const name = code !== null ? (FOREIGN_CODE_NAME[program]?.[code] ?? null) : null;
  const meaning = name ? FOREIGN_MEANING[name] : undefined;
  return new TxFailure(e.kind, "refused", `${meaning ? meaning + " " : ""}(${name ?? "code"}${code !== null ? `${name ? ", " : " "}${code}` : ""})`, { ...e.detail, codeName: name, program });
}

async function sendAndConfirmOnce(connection: Connection, tx: Transaction, signer: TxSigner, extraSigners: Keypair[], opts: SendOptions): Promise<Sent> {
  const stage = opts.onStage ?? (() => {});
  const expected = tx.feePayer ?? new PublicKey(signer.address);
  tx.feePayer = expected;

  const ctx = opts.context;
  const flow = flowOf(opts);
  await pinOrThrow(connection, ctx);
  const bh = await latestBlockhash(connection, ctx);
  tx.recentBlockhash = bh.blockhash;
  /* The extra keypairs (the mint at genesis) sign here so the message compiles with them and the wallet sees the finished message. */
  if (extraSigners.length) tx.partialSign(...extraSigners);

  stage({ step: "simulating" });
  await simulateOrThrow(connection, tx);

  stage({ step: "wallet", since: Date.now() });
  let signature: string;

  /*
    The wallet's own send first (the founder, 2026-10-15): it signs and broadcasts
    through its RPC and hands back the signature; the pin was read just
    before the prompt (above), and the status loop that confirms runs over
    HTTP through the site's route as for any send. A wallet without that
    feature signs here and the client broadcasts through the route, with
    the pin read once more between the prompt and the send.
  */
  /* 24e: the wallet's own send only where it can take this transaction (the account, the chain, the version), decided before anything is sent; otherwise signed here and sent through the route. */
  if (signer.signAndSend && (!signer.signTransaction || (signer.canSignAndSend?.(tx) ?? true))) {
    try {
      signature = await signer.signAndSend(tx, connection, extraSigners);
    } catch (e) {
      /*
        24k (the founder's final rule; Astra R10-M1, Claude L-1): a wallet that sends for itself may have broadcast before its
        answer was lost. Only a refusal made by the page before the wallet was asked is certain; the page's account
        state now, an error's words or its code says nothing about what the wallet already did. 24o (Astra's 24n E2E
        F1): a wallet broadcast b3's bid and then answered 4001, so a decline from an asked wallet is read too.
        Anything else is read from the chain: the signature, when the error carries one that verifies for this
        transaction; otherwise the effect, anchored past expiry (settle).
      */
      const f = beforeWalletSent(e, expected.toBase58());
      if (f) throw f;
      return resolve(connection, recoveredSignature(e, tx, expected), bh, stage, { ...flow, own: ownOf(tx, expected) }, e);
    }
    return confirm(connection, signature, bh, stage, flow);
  } else if (signer.signTransaction) {
    let signed: Transaction;
    try {
      signed = await signer.signTransaction(tx);
    } catch (e) {
      throw walletFailure(e, signer, expected.toBase58());
    }
    signature = checkSigned(signed, signer, expected, extraSigners);
    /* The prompt may have stayed open while the program changed: read again before it goes on the network. */
    await pinOrThrow(connection, ctx);
    try {
      return await broadcast(connection, signed, signature, bh, stage, flow);
    } catch (e) {
      if (e instanceof ExpiredAtSend) throw new TxFailure("nothingSent", "expired", "Your wallet answered after the transaction had expired, so it was not sent.", { signature: e.signature, cause: e.cause });
      throw e;
    }
  }
  throw new TxFailure("nothingSent", "siteBug", "This signer can neither sign nor send. That is a bug in the site.");
}

/* One transaction of a batch: built for a blockhash, with what it does (for the page) and how to tell afterwards whether it landed. */
export interface BatchTx {
  tx: AnyTx;
  label: string;
  effect?: Effect;
}

export interface BatchResult {
  sent: { label: string; signature: string; confirmedAt: number }[];
  /* Wallet prompts the batch took: one when the signer signs all at once, else one a transaction, plus one for each rebuild after an expiry. */
  prompts: number;
}

/* Rebuilds after an expiry before the batch gives up; each costs a prompt. */
const REBUILD_LIMIT = 2;

/*
  Several transactions, one prompt. `build` makes them for a blockhash, in
  the order they must land; the first is simulated before the wallet opens
  (the later ones cannot be, each needs the one before it landed), then all
  are signed at once where the signer allows and sent one after another, each
  confirmed before the next. If one expires before it is sent (the prompt sat
  open past the blockhash's life), the rest are rebuilt on a new blockhash
  and signed again, which is a second prompt the result counts.
*/
export async function sendBatch(connection: Connection, build: (blockhash: string) => Promise<BatchTx[]> | BatchTx[], signer: TxSigner, opts: SendOptions = {}): Promise<BatchResult> {
  const stage = opts.onStage ?? (() => {});
  const expected = new PublicKey(signer.address);
  const sent: BatchResult["sent"] = [];
  let prompts = 0;

  await pinOrThrow(connection, opts.context);
  let bh = await latestBlockhash(connection, opts.context);
  let batch = await build(bh.blockhash);
  if (batch.length === 0) throw new TxFailure("nothingSent", "siteBug", "Nothing to send. That is a bug in the site.");
  const total = batch.length;

  stage({ step: "simulating" });
  await simulateOrThrow(connection, batch[0].tx);

  const partial = (f: TxFailure): TxFailure => (sent.length ? new TxFailure(f.kind, f.reason, f.message, { ...f.detail, sentBefore: sent.map((s) => ({ label: s.label, signature: s.signature })), batchTotal: total }) : f);

  /* Sign a run of transactions in one prompt where the signer allows, else one by one. */
  const sign = async (txs: AnyTx[], again: boolean): Promise<AnyTx[]> => {
    stage({ step: "wallet", since: Date.now(), count: txs.length, again });
    try {
      if (txs.length > 1 && signer.signAllTransactions) {
        prompts += 1;
        return await signer.signAllTransactions(txs);
      }
      if (!signer.signTransaction) throw new TxFailure("nothingSent", "siteBug", "This signer cannot sign. That is a bug in the site.");
      const out: AnyTx[] = [];
      for (let k = 0; k < txs.length; k++) {
        /* One prompt each: every prompt after the first reads the pin again (the first was read just before this run). */
        if (k > 0) await pinOrThrow(connection, opts.context);
        prompts += 1;
        out.push(await signer.signTransaction(txs[k]));
      }
      return out;
    } catch (e) {
      if (e instanceof TxFailure) throw partial(e);
      throw partial(walletFailure(e, signer, expected.toBase58()));
    }
  };

  if (!signer.signTransaction && signer.signAndSend) {
    /* A wallet that signs and sends itself: one prompt a transaction, each after the one before it confirmed. */
    for (let i = 0; i < batch.length; i++) {
      const b = batch[i];
      /* Each of these is its own prompt, so each is its own send: the pin is read again before every one after the first. */
      if (i > 0) {
        try {
          await pinOrThrow(connection, opts.context);
        } catch (e) {
          throw partial(e as TxFailure);
        }
      }
      stage({ step: "wallet", since: Date.now(), count: 1 });
      let signature: string | null = null;
      let r: Sent | null = null;
      try {
        prompts += 1;
        signature = await signer.signAndSend(b.tx, connection, []);
      } catch (e) {
        /* 24k: as for one send (sendAndConfirmOnce): only the page's own refusal before the wallet was asked is certain (24o: not a 4001). */
        const f = beforeWalletSent(e, expected.toBase58());
        if (f) throw partial(f);
        try {
          r = await resolve(connection, recoveredSignature(e, b.tx, expected), bh, stage, { ...flowOf(opts, b.effect), own: ownOf(b.tx, expected) }, e);
        } catch (e2) {
          throw partial(e2 as TxFailure);
        }
      }
      if (r === null) {
        try {
          r = await confirm(connection, signature as string, bh, stage, flowOf(opts, b.effect), { index: i + 1, total });
        } catch (e2) {
          throw partial(e2 as TxFailure);
        }
      }
      sent.push({ label: b.label, signature: r.signature, confirmedAt: Date.now() });
      /* 24l (Astra R11-L1): a recovered item and a confirmed one go on the same way: the rest are rebuilt on a fresh blockhash (the recovered one is never sent again). */
      if (i + 1 < batch.length) {
        /* 24m (Claude F-1): the ones before have landed, so a read or build that fails here says so (sentBefore). */
        try {
          bh = await latestBlockhash(connection, opts.context);
          const rest = await build(bh.blockhash);
          batch = [...batch.slice(0, i + 1), ...rest.slice(i + 1)];
        } catch (e) {
          throw partial(asNotSent(e));
        }
      }
    }
    return { sent, prompts };
  }

  let signed = await sign(
    batch.map((b) => b.tx),
    false,
  );
  for (const s of signed) checkSigned(s, signer, expected, []);

  let rebuilds = 0;
  for (let i = 0; i < batch.length; i++) {
    const b = batch[i];
    const signature = checkSigned(signed[i], signer, expected, []);
    /* Each transaction is its own send: the pin is read again before it goes on the network (the prompt may have stayed open, and the ones before it took time). */
    try {
      await pinOrThrow(connection, opts.context);
    } catch (e) {
      throw partial(e as TxFailure);
    }
    try {
      const r = await broadcast(connection, signed[i], signature, bh, stage, flowOf(opts, b.effect), { index: i + 1, total });
      sent.push({ label: b.label, signature: r.signature, confirmedAt: Date.now() });
    } catch (e) {
      if (e instanceof ExpiredAtSend) {
        if (rebuilds >= REBUILD_LIMIT) {
          throw partial(new TxFailure("nothingSent", "expired", i === 0 ? "Your wallet answered after the transaction had expired, so it was not sent." : "The remaining transactions expired before they could be sent.", { signature: e.signature, cause: e.cause }));
        }
        rebuilds += 1;
        /* The ones already landed stay; the rest are rebuilt on a fresh blockhash and signed again, after the pin is read again (a new prompt is a new send). */
        try {
          await pinOrThrow(connection, opts.context);
        } catch (e2) {
          throw partial(e2 as TxFailure);
        }
        /* 24m (Claude F-1): as above, a failure here keeps the ones already landed (sentBefore). */
        let fresh: Awaited<ReturnType<typeof build>>;
        try {
          bh = await latestBlockhash(connection, opts.context);
          fresh = await build(bh.blockhash);
        } catch (e3) {
          throw partial(asNotSent(e3));
        }
        const rest = fresh.slice(i);
        if (rest.length !== batch.length - i) throw partial(new TxFailure("nothingSent", "siteBug", "The rebuilt batch has a different shape. That is a bug in the site.", {}));
        const resigned = await sign(
          rest.map((b) => b.tx),
          true,
        );
        batch = [...batch.slice(0, i), ...rest];
        signed = [...signed.slice(0, i), ...resigned];
        i -= 1;
        continue;
      }
      throw partial(e as TxFailure);
    }
  }
  return { sent, prompts };
}

/*
  After an ambiguous send: the send call failed, or a wallet that broadcasts
  itself threw. The same loop as confirm, with the "resolving" stage and its
  own words. Without a signature (a wallet that broadcasts itself and then
  threw), the client's effect check decides.
*/
async function resolve(connection: Connection, signature: string | null, bh: Blockhash, stage: OnStage, flow: Flow, cause: unknown, refused: Error | null = null, quiet = false): Promise<Sent> {
  stage({ step: "resolving", signature, since: Date.now() });
  return settle(connection, signature, bh, flow, cause, "resolving", refused, quiet);
}

/*
  Polls the signature's status and the block height over HTTP. Once the
  height is past the blockhash's last valid height, a transaction that has
  no status can never land, so the answer is certain either way.
  24e: the status and the height from the shared reads when the page gives
  them (SendContext), the RPC otherwise or when one fails; the last look
  after expiry is the RPC's, with its history. After an ambiguous wallet
  send (no signature), the effect is checked at every poll after the first,
  not only after expiry (item 6): a bid that landed is answered as soon as
  its account shows, and nothing is rebuilt while it might have landed.
  That path is rare (a wallet error after a possible broadcast).
  24j (the founder's final rule): `refused` is what the send was told (busy, a preflight refusal, an expired blockhash). It is
  thrown only once the reads below prove the transaction did not land; `quiet` (no try can have reached the node, by
  the page's and the route's own records) skips the status polls before expiry, never the reads after it.
*/
async function settle(connection: Connection, signature: string | null, bh: Blockhash, flow: Flow, cause: unknown, mode: "confirming" | "resolving", refused: Error | null = null, quiet = false): Promise<Sent> {
  const { effect, ctx } = flow;
  const deadline = Date.now() + RESOLVE_LIMIT_MS;
  /* 24l (Astra R11-M2): every read here is bounded, each by READ_LIMIT_MS and all by the deadline. A read that does not answer in time is a read that failed (null), never an answer. */
  const read = <T,>(p: Promise<T>): Promise<T | null> => bounded(p, Math.min(READ_LIMIT_MS, Math.max(0, deadline - Date.now())));
  let expiredChecks = 0;
  const statusOf = async (sig: string, history: boolean) => {
    const sharedStatus = ctx?.status ?? defaultStatus;
    if (sharedStatus && !history) {
      const shared = await read(sharedStatus(sig).then((s) => ({ s })));
      if (shared) return shared.s;
    }
    const st = await read(connection.getSignatureStatuses([sig], { searchTransactionHistory: true }));
    const s = st?.value[0] ?? null;
    return s ? { confirmationStatus: s.confirmationStatus ?? null, err: s.err, slot: s.slot } : null;
  };
  const heightNow = async (): Promise<number | null> => {
    if (ctx?.height) {
      const h = await read(ctx.height());
      if (h !== null) return h;
    }
    return read(connection.getBlockHeight("confirmed"));
  };
  const logsBounded = async (sig: string): Promise<string[]> => (sig && flow.logs ? ((await read(logsOf(connection, sig))) ?? []) : []);
  const landed = async (sig: string, slot?: number): Promise<Sent> => ({ signature: sig, logs: await logsBounded(sig), ...(slot !== undefined ? { slot } : {}) });
  /* 24m (Astra R12-L2): the logs that name a proven refusal are waited for within the deadline too; without them the refusal is still said. */
  const namingLogs = async (sig: string): Promise<string[]> => (await read(logsSoon(connection, sig))) ?? [];
  for (let polls = 0; Date.now() < deadline; polls++) {
    if (signature) {
      const s = quiet && expiredChecks === 0 ? null : await statusOf(signature, expiredChecks > 0);
      if (s && (s.confirmationStatus === "confirmed" || s.confirmationStatus === "finalized")) {
        /* The landed transaction's logs, briefly, so a refusal is named for the program that made it (the error object alone gives only an instruction index and a code). */
        if (s.err) throw refusal("landedFailed", s.err, await namingLogs(signature), signature);
        return landed(signature, s.slot);
      }
      if (polls % HEIGHT_EVERY !== 0 && expiredChecks === 0) {
        await sleep(pollWait(polls));
        continue;
      }
    } else if (effect && polls > 0 && expiredChecks === 0) {
      const eff = await read(effect());
      /* 24l: a proven landing is the answer with or without a signature (the history read behind it is optional). */
      if (eff?.landed) return landed(eff.signature ?? "");
    }
    const height = await heightNow();
    if (height !== null && height > bh.lastValidBlockHeight + EXPIRY_MARGIN_BLOCKS) {
      /* One more look at the status after expiry, then the effect, then the verdict. */
      if (expiredChecks++ < 1) {
        await sleep(pollWait(polls));
        continue;
      }
      /*
        24g (Astra 24f F2): past the height a transaction can no longer land, but that alone does not say it did not
        land before. "Nothing was taken" needs the signature's status read through the RPC's history, answered with no
        status by a node at or past the slot where expiry was seen, and the effect read answered too. A read that
        fails, a node behind that slot, or a status still short of confirmed leaves the outcome unknown.
      */
      /*
        24i (Claude L1, Astra R7-L1): the expiry and the slot it was seen at come from one read (getEpochInfo: one node's
        height and slot), so the status read is compared with the slot where that node saw expiry, never with a slot
        read from another node. A node not yet past expiry is waited for; a read that fails leaves the outcome unknown.
      */
      /* 24k: the anchor for every verdict, with or without a signature: one node's height and slot, from one read. */
      const epoch = await read(connection.getEpochInfo("confirmed"));
      const epochHeight = typeof epoch?.blockHeight === "number" ? epoch.blockHeight : null;
      if (epoch && epochHeight !== null && !(epochHeight > bh.lastValidBlockHeight + EXPIRY_MARGIN_BLOCKS)) {
        await sleep(pollWait(polls));
        continue;
      }
      const seenAt = epoch && epochHeight !== null ? epoch.absoluteSlot : null;
      let absent = false;
      if (signature) {
        const st = await read(connection.getSignatureStatuses([signature], { searchTransactionHistory: true }));
        const s = st?.value[0] ?? null;
        if (s && (s.confirmationStatus === "confirmed" || s.confirmationStatus === "finalized")) {
          if (s.err) throw refusal("landedFailed", s.err, await namingLogs(signature), signature);
          return landed(signature, s.slot);
        }
        absent = st !== null && s === null && seenAt !== null && typeof st.context?.slot === "number" && st.context.slot >= seenAt;
      }
      const eff = effect ? await read(effect(seenAt !== null ? { minContextSlot: seenAt } : undefined)) : null;
      if (eff?.landed) return { signature: eff.signature ?? signature ?? "", logs: eff.signature ? await logsBounded(eff.signature) : [] };
      /* 24k: without a signature, only an effect read at or past the anchor that shows no effect proves nothing landed. */
      const effAbsent = eff !== null && !eff.landed && seenAt !== null && typeof eff.contextSlot === "number" && eff.contextSlot >= seenAt;
      if (signature && !(absent && (!effect || eff !== null))) throw new TxFailure("unknown", "unresolved", "The RPC did not answer for long enough to tell whether this landed.", { signature, cause });
      if (signature || effAbsent) {
        /*
          24l (Claude N-1): without a signature, an absent effect does not rule out a transaction of ours that landed and
          failed (its fee taken, no effect). The effect account's history at or past the anchor is read: a failed
          transaction of ours there is said as landed and failed; a read that fails, or a failed one that cannot be told
          apart, leaves the outcome unknown.
        */
        if (!signature && seenAt !== null) {
          const failed = await failedOfOurs(connection, eff?.account, seenAt, flow.own, bh, read);
          if (failed === null) throw new TxFailure("unknown", "unresolved", "The wallet reported an error after it may have sent the transaction, and the site has no signature to look up.", { signature: null, cause });
          if (failed !== "none") throw refusal("landedFailed", failed.err, await namingLogs(failed.signature), failed.signature);
        }
        if (refused) throw refused;
        const why = mode === "confirming" ? "The RPC accepted it, but no block took it before its blockhash expired." : "The connection to the RPC dropped while it was being sent.";
        throw new TxFailure("nothingSent", "expired", `The transaction expired without landing, so nothing was taken. ${why}`, { signature, cause });
      }
      throw new TxFailure("unknown", "unresolved", "The wallet reported an error after it may have sent the transaction, and the site has no signature to look up.", { signature: null, cause });
    }
    await sleep(pollWait(polls));
  }
  throw new TxFailure("unknown", "unresolved", "The RPC did not answer for long enough to tell whether this landed.", { signature, cause });
}

/* 24l (Astra R11-M2): a read that settles within ms; a failure or a timeout is null, never an answer. */
function bounded<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((done) => {
    const t = setTimeout(() => done(null), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        done(v);
      },
      () => {
        clearTimeout(t);
        done(null);
      },
    );
  });
}

/*
  24l (Claude N-1): a failed transaction of ours in the effect account's history, read at or past the anchor (a failed
  transaction lists every account it names). Ours: its signature verifies over the message the wallet was given, or,
  for a wallet that changed the transaction, it carries our blockhash and our fee payer. "none" when the history holds
  no failed transaction of ours; null when it cannot be told (no account or message to look with, a read that fails).
  24m (Astra R12-L1, Claude L-3): "none" only once the history is read to its end (a page shorter than asked for); a
  full page is followed by the next, older one, up to HISTORY_PAGES, and a history longer than that is unknown.
*/
async function failedOfOurs(connection: Connection, account: string | undefined, seenAt: number, own: Flow["own"], bh: Blockhash, read: <T>(p: Promise<T>) => Promise<T | null>): Promise<{ signature: string; err: unknown } | "none" | null> {
  if (!account || !own) return null;
  let key: PublicKey;
  try {
    key = new PublicKey(account);
  } catch {
    return null;
  }
  let before: string | undefined;
  for (let page = 0; page < HISTORY_PAGES; page++) {
    const list = await read(connection.getSignaturesForAddress(key, { limit: HISTORY_SCAN, minContextSlot: seenAt, ...(before ? { before } : {}) }, "confirmed"));
    if (!list) return null;
    for (const entry of list) {
      if (!entry.err) continue;
      let mine = false;
      try {
        mine = ed25519.verify(bs58.decode(entry.signature), own.message, own.payer.toBytes());
      } catch {
        mine = false;
      }
      if (!mine) {
        const tr = await read(connection.getTransaction(entry.signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 }));
        if (!tr) return null;
        const m = tr.transaction.message;
        const payer = m.staticAccountKeys[0];
        mine = m.recentBlockhash === bh.blockhash && !!payer && payer.equals(own.payer);
      }
      if (mine) return { signature: entry.signature, err: entry.err };
    }
    if (list.length < HISTORY_SCAN) return "none";
    before = list[list.length - 1].signature;
  }
  return null;
}

async function logsOf(connection: Connection, signature: string): Promise<string[]> {
  const tr = await connection.getTransaction(signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 }).catch(() => null);
  return tr?.meta?.logMessages ?? [];
}

/* The logs for naming a refusal only, never for an amount; nothing when the node is slow to list them. */
const LOGS_FOR_NAMING_MS = 5_000;
function logsSoon(connection: Connection, signature: string): Promise<string[]> {
  return Promise.race([logsOf(connection, signature), sleep(LOGS_FOR_NAMING_MS).then(() => [] as string[])]);
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : typeof e === "string" ? e : JSON.stringify(e);
}

/* 24m (Claude F-1): a failure while the next transaction of a batch is read or built, before it is signed: it was not sent. */
function asNotSent(e: unknown): TxFailure {
  return e instanceof TxFailure ? e : new TxFailure("nothingSent", "siteBug", messageOf(e), { cause: e });
}

function rpcDown(e: unknown, connection: Connection): TxFailure {
  return new TxFailure("nothingSent", "rpcUnreachable", `The RPC at ${hostOf(connection.rpcEndpoint)} did not answer (${shortError(e)}). Nothing was built, signed or sent.`, { cause: e });
}

/*
  Programs other than Bouncer whose refusals the site meets, by name. A code
  from one of them is not looked up in the pin's error table: Meteora's
  InvalidAuthority (6053) read there as Bouncer's PoolReadbackMismatch
  (2026-10-14, the creator fee claim). The innermost program that failed with
  a custom error is the one whose code it is.
*/
const FOREIGN_PROGRAMS: Readonly<Record<string, string>> = { [DAMM_V2_PROGRAM]: "Meteora" };
const FOREIGN_MEANING: Readonly<Record<string, string>> = {
  InvalidAuthority: "This wallet does not hold the position's NFT.",
};
/* For a refusal named without its logs: the codes the site's Meteora paths have met (cp_amm's error table). */
const FOREIGN_CODE_NAME: Readonly<Record<string, Readonly<Record<number, string>>>> = { Meteora: { 6053: "InvalidAuthority" } };

function foreignRefusal(kind: FailureKind, err: unknown, text: string, signature: string | null): TxFailure | null {
  const failed = /Program (\w{32,44}) failed: custom program error/.exec(text);
  const program = failed ? FOREIGN_PROGRAMS[failed[1]] : undefined;
  if (!program) return null;
  const code = programErrorCode(text);
  const name = /Error Code: (\w+)/.exec(text)?.[1] ?? null;
  const account = /caused by account: (\w+)/.exec(text)?.[1] ?? null;
  const label = name ? `${name}${account ? ` on ${account}` : ""}` : "an error";
  /* A wrong position NFT account fails Anchor's constraint on it rather than Meteora's own check. */
  const meaning = (name ? FOREIGN_MEANING[name] : undefined) ?? (account === "position_nft_account" ? FOREIGN_MEANING.InvalidAuthority : undefined);
  const message = `${meaning ? meaning + " " : ""}(${label}${code !== null ? `, ${code}` : ""})`;
  return new TxFailure(kind, "refused", message, { signature, code, codeName: name, program, cause: err });
}

/* A refusal by the program or the runtime, in a simulation, a preflight, or after landing. */
function refusal(kind: FailureKind, err: unknown, logs: string[], signature: string | null): TxFailure {
  const raw = typeof err === "string" ? err : err instanceof Error ? err.message : JSON.stringify(err);
  const foreign = foreignRefusal(kind, err, `${raw}\n${logs.join("\n")}`, signature);
  if (foreign) return foreign;
  const detail = logs.filter((l) => /Error|failed|Program log:/.test(l)).slice(-4).join(" | ");
  const text = `${raw}${detail ? " " + detail : ""}`;
  const code = programErrorCode(text);
  const message = explainError(text);
  const funds = /insufficient (funds|lamports)|prior credit|InsufficientFundsFor/i.test(text);
  return new TxFailure(kind, funds ? "insufficientFunds" : "refused", message, { signature, code, codeName: code !== null ? (errorName(code) ?? null) : null, cause: err });
}

/*
  24k: a wallet-owned send's error that proves the wallet never sent: thrown by the page before the wallet was asked
  (beforeWallet, AccountProvider.tsx). Null for anything else: the wallet may have broadcast. 24o (Astra's 24n E2E
  F1): that includes the wallet's own rejection code (4001), direct or wrapped by the adapter; a wallet that signs and
  sends may answer it after broadcasting (b3's bid landed at slot 515378511, then 4001), so it goes to the chain like
  any other answer. A sign-only wallet's 4001 is still certain (walletFailure): it returned no signed transaction.
*/
function beforeWalletSent(e: unknown, expected: string): TxFailure | null {
  const err = e as { beforeWallet?: unknown; name?: unknown } | null;
  if (err?.beforeWallet === true) {
    return err.name === "WalletConfigError"
      ? new TxFailure("nothingSent", "walletUnsupported", "This wallet does not offer the cluster this site is on, so it could not sign for it.", { expected, cause: e })
      : new TxFailure("nothingSent", "walletError", messageOf(e) || "The wallet returned an error and no signed transaction.", { expected, cause: e });
  }
  return null;
}

/* The bytes a wallet signs for a transaction, or null when it cannot be serialized. */
function messageBytes(tx: AnyTx): Uint8Array | null {
  try {
    return tx instanceof VersionedTransaction ? tx.message.serialize() : new Uint8Array(tx.serializeMessage());
  } catch {
    return null;
  }
}

/* 24l (Claude N-1): what a wallet-owned send was given, for recognising it in an account's history. */
function ownOf(tx: AnyTx, payer: PublicKey): Flow["own"] {
  const message = messageBytes(tx);
  return message ? { message, payer } : undefined;
}

/*
  24k: a signature a wallet's error carries (some put it on the error, its cause or its data), used only when it is a
  valid ed25519 signature by this account over this transaction's message, so it is this send's and nothing else's.
*/
function recoveredSignature(e: unknown, tx: AnyTx, expected: PublicKey): string | null {
  const o = e as { signature?: unknown; cause?: { signature?: unknown }; data?: { signature?: unknown }; error?: { signature?: unknown } } | null;
  const candidates = [o?.signature, o?.cause?.signature, o?.data?.signature, o?.error?.signature];
  const message = messageBytes(tx);
  if (!message) return null;
  for (const c of candidates) {
    let sig: Uint8Array | null = null;
    try {
      sig = typeof c === "string" ? bs58.decode(c) : c instanceof Uint8Array ? c : null;
    } catch {
      sig = null;
    }
    if (!sig || sig.length !== 64) continue;
    try {
      if (ed25519.verify(sig, message, expected.toBytes())) return bs58.encode(sig);
    } catch {
      /* Not a signature over this message. */
    }
  }
  return null;
}

function walletFailure(e: unknown, signer: TxSigner, expected: string): TxFailure {
  const msg = messageOf(e);
  const name = e instanceof Error ? e.name : "";
  const active = signer.stillActive?.() ?? "yes";
  if (/reject|declin|denied|cancel/i.test(msg)) return new TxFailure("nothingSent", "walletDeclined", "You declined in your wallet.", { expected, cause: e });
  if (active === "disconnected" || name === "WalletNotConnectedError" || /not connected|disconnected/i.test(msg)) {
    return new TxFailure("nothingSent", "walletDisconnected", "Your wallet disconnected before it signed.", { expected, cause: e });
  }
  if (active === "switched") return new TxFailure("nothingSent", "walletSwitched", "Your wallet switched to a different account before it signed.", { expected, cause: e });
  if (name === "WalletConfigError" || name === "WalletAccountError" || (name === "WalletSendTransactionError" && !msg)) {
    return new TxFailure("nothingSent", "walletUnsupported", "This wallet does not offer the cluster this site is on, so it could not sign for it.", { expected, cause: e });
  }
  return new TxFailure("nothingSent", "walletError", msg || "The wallet returned an error and no signed transaction.", { expected, cause: e });
}
