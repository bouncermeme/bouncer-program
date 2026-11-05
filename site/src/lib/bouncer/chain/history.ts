/*
  A launch's history, read from its transactions (2026-10-02).

  A transaction's log is cut by the node that serves it: the validator keeps
  at most --log-messages-bytes-limit bytes of program log per transaction,
  10,000 by default, and ends a cut log with "Log truncated". A batch of five
  or more deliveries writes more than that, so the fifth winner's Delivered
  line is not there, although the delivery landed. On 2026-10-02 the public
  devnet node returned such logs whole and the keyed one cut them; by
  2026-10-05 the public node cut them too. No endpoint can be relied on for
  a log line, so nothing a page shows about money comes from one. Commits, deliveries,
  claims and refunds are read from the transaction itself, which no log limit
  touches (v0.32: collect_parked and push_parked are payouts too, the parked
  bid's; park_bid sends the bidder nothing and the bid stays open until one
  of them closes it, the final E2E's S2 of 2026-10-30):
    - the instruction names the bid, the bidder and their token account;
    - the token transfers out of the launch's token vault, made under that
      instruction, give the tokens to the bidder and to whoever pushed;
    - the lamport balances before and after give the SOL back (on a launch
      created by 0.26 the bid account's rent is split: the pusher is repaid
      the token account rent it fronted plus the launch's reward, the winner
      gets the rest, so those two are added back before the bid account's
      balance is taken off the bidder's gain; hints.deliveryTerms says which);
    - the commit's instruction data carries the deposit.
  A node that returns no inner instructions is read from its token balances;
  one that returns neither still yields the payout, with its amounts marked
  unknown, because a successful deliver, claim or refund instruction is the
  payout, whatever the node left out around it. No account records a payout
  per bid (the Bid is wiped at delivery, the record keeps a count and a sum),
  so the transaction is the source.

  Each fact comes out in the shape of the program's own event (BidCommitted,
  Delivered, Refunded), so the pages read one list. The program's own lines
  for these are not read, not even where the node kept them; the check
  scripts compare the two. The log is read for what no instruction states:
  the step a bid opened at (BidRevealed, BidInvalid; a reveal carries no
  step, the program opens the sealed bid) and the lifecycle rows. A landable
  reveal writes at most about 5,000 bytes of log (35 bids at about 145 bytes
  a line), under the default limit.

  The list of signatures is paged on its cursor until the node returns an
  empty page: a short page is not the end (a throttled or partial answer
  looks the same), only an empty one is. A launch's history is complete when
  the transaction that created it was read; a bid account's, when its commit
  was. A node whose ledger starts later than that says so (stats.complete).
*/
import bs58 from "bs58";
import { type Connection, type PublicKey } from "@solana/web3.js";
import { INSTRUCTIONS } from "@contract/constants";
import { readU64 } from "./borsh";
import { decodeEventsFromLogs, logWasCut, type DecodedEvent, type EventValue } from "./events";
import { ASSOCIATED_TOKEN_PROGRAM, PROGRAM, SYSTEM_PROGRAM, TOKEN_2022_PROGRAM, TOKEN_PROGRAM } from "./pda";
import { siteFetch } from "./rpc";
import { UpstreamError } from "./upstreamError";

/*
  v0.30 removed claim (SPEC 3.3), but the claims that landed before the upgrade stay in a launch's history, so their
  receipts still read: the 0.29 pin's discriminator and account order, kept here for reading only. Nothing builds it.
*/
const RETIRED = {
  claim: { discriminator: [62, 198, 214, 193, 213, 159, 108, 210], accounts: ["launch", "vault", "settlement", "token_mint", "token_vault", "bid", "bidder", "bidder_token", "token_program", "associated_token_program", "system_program"] },
} as const;
type IxName = keyof typeof INSTRUCTIONS | keyof typeof RETIRED;
const TABLE: Record<IxName, { discriminator: readonly number[]; accounts: readonly string[] }> = { ...INSTRUCTIONS, ...RETIRED };
const BY_DISCRIMINATOR = new Map<string, IxName>(Object.entries(TABLE).map(([name, v]) => [v.discriminator.join(","), name as IxName]));
/* Where an account sits in an instruction, by its name in the pin (or the retired table). */
const slot = (name: IxName, account: string): number => TABLE[name].accounts.indexOf(account);
const nameOf = (data: Uint8Array): IxName | null => (data.length >= 8 ? BY_DISCRIMINATOR.get(Array.from(data.subarray(0, 8)).join(",")) ?? null : null);

interface Inner {
  program: string;
  accounts: string[];
  data: Uint8Array;
  /* Depth of the call, as the node reports it; null on a node that does not. */
  height: number | null;
}
/* One call of this program, at the top level of a transaction or from another program, with the calls made under it (null when the node did not say). */
interface Call {
  name: IxName;
  accounts: string[];
  data: Uint8Array;
  children: Inner[] | null;
}

/*
  A transaction as the node's JSON gives it, read without the library. The
  library's getTransactions accepts versions "legacy" and 0 only: asked for a
  version 1 transaction it fails the whole request, and 549 of the 2,329
  transactions on this program's devnet launches are version 1 (2026-10-02;
  the program lane's harness sends them, and they are ordinary reveals,
  deliveries and finalizes). One such transaction made a launch's whole
  history unreadable. In JSON the three versions have the same shape where
  this reader looks: the message's account keys and instructions, and the
  meta's balances, inner instructions, log and loaded addresses.
*/
interface RawInstruction {
  programIdIndex: number;
  accounts: number[];
  /* Base 58. */
  data: string;
  stackHeight?: number | null;
}
export interface RawTransaction {
  slot: number;
  blockTime?: number | null;
  version?: number | "legacy";
  transaction: { signatures: string[]; message: { header: { numRequiredSignatures: number }; accountKeys: string[]; instructions: RawInstruction[] } };
  meta: {
    err: unknown;
    preBalances: number[];
    postBalances: number[];
    preTokenBalances?: { accountIndex: number; uiTokenAmount: { amount: string } }[] | null;
    postTokenBalances?: { accountIndex: number; uiTokenAmount: { amount: string } }[] | null;
    innerInstructions?: { index: number; instructions: RawInstruction[] }[] | null;
    logMessages?: string[] | null;
    loadedAddresses?: { writable: string[]; readonly: string[] } | null;
  } | null;
}

function accountKeys(tx: RawTransaction): string[] {
  const loaded = tx.meta?.loadedAddresses;
  return [...tx.transaction.message.accountKeys, ...(loaded?.writable ?? []), ...(loaded?.readonly ?? [])];
}

function programCalls(tx: RawTransaction, keys: string[]): Call[] {
  const program = PROGRAM.toBase58();
  const groups = tx.meta?.innerInstructions ?? null;
  const calls: Call[] = [];
  tx.transaction.message.instructions.forEach((ix, i) => {
    const group: Inner[] | null = groups
      ? (groups.find((g) => g.index === i)?.instructions ?? []).map((c) => ({
          program: keys[c.programIdIndex],
          accounts: c.accounts.map((a) => keys[a]),
          data: bs58.decode(c.data),
          height: c.stackHeight ?? null,
        }))
      : null;
    if (keys[ix.programIdIndex] === program) {
      const data = bs58.decode(ix.data);
      const name = nameOf(data);
      if (name) calls.push({ name, accounts: ix.accounts.map((a) => keys[a]), data, children: group });
    }
    /* Reached through another program (a pusher's own wrapper): what it called in turn is whatever follows it at a greater depth. */
    group?.forEach((c, p) => {
      if (c.program !== program) return;
      const name = nameOf(c.data);
      if (!name) return;
      let children: Inner[] | null = null;
      if (c.height != null) {
        children = [];
        for (let q = p + 1; q < group.length; q++) {
          const h = group[q].height;
          if (h == null || h <= c.height) break;
          children.push(group[q]);
        }
      }
      calls.push({ name, accounts: c.accounts, data: c.data, children });
    });
  });
  return calls;
}

/* SPL token transfers out of one account among a call's children, in order: Transfer (3) and TransferChecked (12), amount in the eight bytes after the tag. */
function transfersFrom(children: Inner[], source: string): { dest: string; amount: bigint }[] {
  const token = TOKEN_PROGRAM.toBase58();
  const token22 = TOKEN_2022_PROGRAM.toBase58();
  const out: { dest: string; amount: bigint }[] = [];
  for (const c of children) {
    if ((c.program !== token && c.program !== token22) || c.data.length < 9 || c.accounts[0] !== source) continue;
    if (c.data[0] === 3) out.push({ dest: c.accounts[1], amount: readU64(c.data, 1) });
    else if (c.data[0] === 12) out.push({ dest: c.accounts[2], amount: readU64(c.data, 1) });
  }
  return out;
}

/*
  The fill a pushed delivery was worth, from what reached the bidder: the
  smallest whole amount that leaves `net` after the fee (the fee is
  floor(tokens x bps / 10,000)). Where the fee steps up, the amount one atom
  larger leaves the same `net`, so `orOneMore` says the answer may be that
  one; the pusher's own balance decides (found on round fills, 2026-10-02).
  Only used when the node returned no inner instructions.
*/
function grossFromNet(net: bigint, bps: number): { gross: bigint; orOneMore: boolean } {
  if (bps <= 0) return { gross: net, orOneMore: false };
  const b = BigInt(bps);
  const left = (g: bigint) => g - (g * b) / 10_000n;
  const start = (net * 10_000n) / (10_000n - b);
  for (let g = start > 2n ? start - 2n : 0n; g <= start + 2n; g++) if (left(g) === net) return { gross: g, orOneMore: left(g + 1n) === net };
  return { gross: start, orOneMore: false };
}

interface Payout {
  /* collect: collect_parked, the bidder signs and names the destinations; push: push_parked, anyone sends it to the bidder's own accounts (v0.32). */
  kind: "deliver" | "claim" | "refund" | "collect" | "push";
  call: Call;
  launch: string;
  vault: string;
  tokenVault: string | null;
  bid: string;
  bidder: string;
  bidderToken: string | null;
  callerToken: string | null;
}

function payoutOf(call: Call): Payout | null {
  const program = PROGRAM.toBase58();
  /* An optional account that does not exist is the program id in its slot. */
  const optional = (name: IxName, account: string) => {
    const v = call.accounts[slot(name, account)];
    return v && v !== program ? v : null;
  };
  if (call.name === "deliver") {
    const at = (n: string) => call.accounts[slot("deliver", n)];
    return { kind: "deliver", call, launch: at("launch"), vault: at("vault"), tokenVault: at("token_vault"), bid: at("bid"), bidder: at("bidder"), bidderToken: at("bidder_token"), callerToken: at("caller_token") };
  }
  if (call.name === "claim") {
    const at = (n: string) => call.accounts[slot("claim", n)];
    return { kind: "claim", call, launch: at("launch"), vault: at("vault"), tokenVault: optional("claim", "token_vault"), bid: at("bid"), bidder: at("bidder"), bidderToken: at("bidder_token") ?? null, callerToken: null };
  }
  if (call.name === "refund") {
    const at = (n: string) => call.accounts[slot("refund", n)];
    return { kind: "refund", call, launch: at("launch"), vault: at("vault"), tokenVault: null, bid: at("bid"), bidder: at("bidder"), bidderToken: null, callerToken: null };
  }
  /* v0.32: a parked payout leaving. A lamport-only one (a loser's) passes the program id for the token accounts. collect_parked sends the tokens to the account the bidder names. */
  if (call.name === "collect_parked") {
    const at = (n: string) => call.accounts[slot("collect_parked", n)];
    return { kind: "collect", call, launch: at("launch"), vault: at("vault"), tokenVault: optional("collect_parked", "token_vault"), bid: at("bid"), bidder: at("bidder"), bidderToken: optional("collect_parked", "token_destination"), callerToken: null };
  }
  if (call.name === "push_parked") {
    const at = (n: string) => call.accounts[slot("push_parked", n)];
    return { kind: "push", call, launch: at("launch"), vault: at("vault"), tokenVault: optional("push_parked", "token_vault"), bid: at("bid"), bidder: at("bidder"), bidderToken: optional("push_parked", "bidder_token"), callerToken: null };
  }
  return null;
}

export interface TransactionFacts {
  /* from: "tx" for commits and payouts (the instructions and balances), "log" for everything else (the program's own lines). */
  events: { name: string; data: Record<string, EventValue>; from: "log" | "tx" }[];
  /* The node cut this transaction's log. */
  cut: boolean;
  /* Payouts whose amounts the node's answer did not settle (no inner instructions and no token balances, or an unexpected set). Shown as paid, amounts unknown. */
  unsettled: number;
  /* This transaction created the launch. */
  genesis: boolean;
}

export interface HistoryHints {
  /* The launch's creator, to mark its bid; null when not known. */
  creator?: string | null;
  /* The launch's delivery fee, used only when the node returned no inner instructions. Ignored (0) under delivery terms 1. */
  feeBps?: number | null;
  /*
    0.26: Launch.delivery_terms and Launch.delivery_reward. 1 means a pushed delivery takes no tokens and the bid account repays the
    pusher the token account rent it fronted plus the reward; 0 (every launch created before 0.26) means the whole bid account goes
    to the bidder. Null when the launch is not known: then a pushed delivery's SOL back is read the 0.25 way.
  */
  deliveryTerms?: number | null;
  deliveryReward?: bigint | null;
}

/* The kinds a page's money comes from. Never taken from a log line. */
const FROM_TRANSACTION: ReadonlySet<string> = new Set(["BidCommitted", "Delivered", "Refunded", "DeliveryRepaid"]);

/*
  What one landed transaction says about a launch. Commits, deliveries, claims
  and refunds from the instructions and the balances, nothing else; every
  other event from the program's own log lines.
*/
export function factsOfTransaction(tx: RawTransaction, launch: string, hints: HistoryHints = {}): TransactionFacts {
  const out: TransactionFacts = { events: [], cut: false, unsettled: 0, genesis: false };
  const meta = tx.meta;
  if (!meta || meta.err) return out;
  const keys = accountKeys(tx);
  const index = new Map(keys.map((k, i) => [k, i]));
  const logs = meta.logMessages ?? [];
  out.cut = logWasCut(logs);
  /* An event names its launch; one transaction can pay bids of two launches. Events without a launch (the config's) are not a launch's history. */
  const logged = decodeEventsFromLogs(logs).filter((e) => e.data.launch === launch && !FROM_TRANSACTION.has(e.name));

  const lamports = (k: string): bigint => {
    const i = index.get(k);
    return i === undefined ? 0n : BigInt(meta.postBalances[i]) - BigInt(meta.preBalances[i]);
  };
  const tokenBalances = meta.preTokenBalances && meta.postTokenBalances ? { pre: meta.preTokenBalances, post: meta.postTokenBalances } : null;
  const tokens = (k: string): bigint | null => {
    const i = index.get(k);
    if (!tokenBalances || i === undefined) return null;
    const amount = (list: typeof tokenBalances.pre) => BigInt(list.find((b) => b.accountIndex === i)?.uiTokenAmount.amount ?? "0");
    return amount(tokenBalances.post) - amount(tokenBalances.pre);
  };

  const calls = programCalls(tx, keys);
  const derived: { name: string; data: Record<string, EventValue> }[] = [];

  for (const c of calls) {
    if (c.name === "create_launch" && c.accounts[slot("create_launch", "launch")] === launch) out.genesis = true;
    if (c.name !== "commit" || c.accounts[slot("commit", "launch")] !== launch || c.data.length < 16) continue;
    const bid = c.accounts[slot("commit", "bid")];
    const bidder = c.accounts[slot("commit", "bidder")];
    const i = index.get(bid);
    /* A commit that found the book closeable closes it, takes nothing and hands the bid account straight back: no bid was placed. */
    if (i === undefined || meta.postBalances[i] === 0) continue;
    const data: Record<string, EventValue> = { launch, bid, bidder, deposit: readU64(c.data, 8) };
    if (hints.creator) data.creator = bidder === hints.creator;
    derived.push({ name: "BidCommitted", data });
  }

  const payouts = calls.map(payoutOf).filter((p): p is Payout => p !== null);
  const mine = payouts.filter((p) => p.launch === launch);
  if (mine.length) {
    const signers = new Set(keys.slice(0, tx.transaction.message.header.numRequiredSignatures));
    const count = <T,>(list: T[], pick: (x: T) => boolean) => list.filter(pick).length;

    /* SOL back to each bidder. The vault pays it by moving lamports, which leaves no instruction behind, so it is read from balances. */
    const vault = mine[0].vault;
    /* Any other call of this program on the same vault (a reveal pays the revealer from it, finalize sweeps it) makes the vault's own change say nothing about the payouts. */
    const vaultOut = calls.some((c) => !payoutOf(c) && c.accounts.includes(vault)) ? null : -lamports(vault);
    const back = new Map<Payout, bigint>();
    const newTerms = hints.deliveryTerms === 1;
    /*
      0.26, a pushed delivery on a launch with the new terms: out of the bid account, the pusher is repaid the token account rent it
      fronted (what the bidder's token account gained when this call created it; nothing when it already existed) plus the launch's
      reward, and the bidder gets the rest. Both are added back so the bid account's balance can be taken off the bidder's gain as
      before. With inner instructions the creation is seen under this call; without them the token account's own gain stands in.
    */
    /* v0.32: push_parked repays the token account rent the same way, on every launch, and pays no reward (lib.rs push_parked). */
    const repaidToPusher = (p: Payout): bigint => {
      const pushed = p.kind === "push";
      if ((!pushed && (!newTerms || p.kind !== "deliver")) || !p.bidderToken) return 0n;
      const ata = ASSOCIATED_TOKEN_PROGRAM.toBase58();
      const system = SYSTEM_PROGRAM.toBase58();
      const createdHere = p.call.children ? p.call.children.some((c) => (c.program === ata || c.program === system) && c.accounts.includes(p.bidderToken!)) : lamports(p.bidderToken) > 0n;
      const rent = createdHere ? lamports(p.bidderToken) : 0n;
      return (rent > 0n ? rent : 0n) + (pushed ? 0n : (hints.deliveryReward ?? 0n));
    };
    const candidate = (p: Payout): bigint | null => {
      const i = index.get(p.bid);
      /* The bidder's balance speaks for this payout alone only when the bidder did nothing else here: not a signer (no fee, no rent paid), named by one payout, in no other call of this program. */
      if (i === undefined || meta.postBalances[i] !== 0 || signers.has(p.bidder)) return null;
      if (count(payouts, (q) => q.bidder === p.bidder) !== 1 || count(calls, (c) => c.accounts.includes(p.bidder)) !== 1) return null;
      /* A pushed delivery's split depends on the launch's terms: without them the bidder's balance is not read (the vault's own outflow may still settle a lone payout), never the 0.25 arithmetic. */
      if (p.kind === "deliver" && hints.deliveryTerms == null) return null;
      /* The bid account closes to the bidder: its whole balance arrives with the refund (less what it repaid the pusher, 0.26). */
      const c = lamports(p.bidder) + repaidToPusher(p) - BigInt(meta.preBalances[i]);
      return c >= 0n ? c : null;
    };
    const passive: [Payout, bigint][] = [];
    const active: Payout[] = [];
    for (const p of mine) {
      const c = candidate(p);
      if (c === null) active.push(p);
      else passive.push([p, c]);
    }
    const sum = passive.reduce((s, [, c]) => s + c, 0n);
    if (vaultOut === null) {
      for (const [p, c] of passive) back.set(p, c);
    } else if (active.length === 0) {
      /* Every payout read from its own bidder: together they must be what left the vault. */
      if (sum === vaultOut) for (const [p, c] of passive) back.set(p, c);
    } else if (active.length === 1 && vaultOut - sum >= 0n) {
      /* One bidder signed or paid here (a claim, or a pusher delivering to themselves): theirs is what the vault paid beyond the others. */
      for (const [p, c] of passive) back.set(p, c);
      back.set(active[0], vaultOut - sum);
    } else {
      for (const [p, c] of passive) back.set(p, c);
    }

    /* Tokens: the transfers out of the token vault made under each call. deliver sends the bidder's first and the pusher's fee second; a winner's claim sends one; a loser's claim sends none. */
    type Tokens = { toBidder: bigint; fee: bigint } | "none" | null;
    const paid = new Map<Payout, Tokens>();
    /* Deliveries read from balances alone, whose fee has two possible values an atom apart. */
    const unsure: Payout[] = [];
    for (const p of mine) {
      let out3: Tokens = null;
      if (p.kind === "refund" || !p.tokenVault || !p.bidderToken) out3 = "none";
      else if (p.call.children) {
        const t = transfersFrom(p.call.children, p.tokenVault);
        if (t.length === 0 && p.kind !== "deliver") out3 = "none";
        else if (t.length >= 1 && t[0].dest === p.bidderToken && (t.length === 1 || (t.length === 2 && p.kind === "deliver" && t[1].dest === p.callerToken))) out3 = { toBidder: t[0].amount, fee: t[1]?.amount ?? 0n };
      }
      if (out3 === null && p.bidderToken) {
        /* The node returned no inner instructions (or an unexpected set): the bidder's own token balance, when nothing else in this transaction moved it. */
        const alone = count(payouts, (q) => q.bidderToken === p.bidderToken) === 1 && count(payouts, (q) => q.callerToken === p.bidderToken) === 0;
        const net = alone ? tokens(p.bidderToken) : null;
        if (net !== null && net >= 0n) {
          /* A claim and a parked payout take no fee. */
          if (p.kind !== "deliver") out3 = net > 0n ? { toBidder: net, fee: 0n } : "none";
          else if (hints.feeBps != null) {
            const g = grossFromNet(net, newTerms ? 0 : hints.feeBps);
            out3 = { toBidder: net, fee: g.gross - net };
            if (g.orOneMore) unsure.push(p);
          } else if (p.callerToken && count(payouts, (q) => q.callerToken === p.callerToken) === 1) {
            const fee = tokens(p.callerToken);
            if (fee !== null && fee >= 0n) out3 = { toBidder: net, fee };
          }
        }
      }
      paid.set(p, out3);
    }
    /* The pusher's own token account settles the atoms: what it gained in this transaction is the sum of the fees, when it received nothing else here. */
    for (const account of new Set(unsure.map((p) => p.callerToken))) {
      if (!account || count(payouts, (q) => q.bidderToken === account) > 0) continue;
      const fed = mine.filter((p) => p.kind === "deliver" && p.callerToken === account);
      const gained = tokens(account);
      if (gained === null || fed.some((p) => !paid.get(p) || paid.get(p) === "none")) continue;
      let short = gained - fed.reduce((s, p) => s + (paid.get(p) as { fee: bigint }).fee, 0n);
      for (const p of unsure) {
        if (short <= 0n) break;
        if (p.callerToken !== account) continue;
        (paid.get(p) as { fee: bigint }).fee += 1n;
        short -= 1n;
      }
    }

    for (const p of mine) {
      const sol = back.get(p) ?? null;
      const out3 = paid.get(p) ?? null;
      /*
        The instruction is the payout. A refund, and a claim that names no
        token vault (a loser's), return SOL; a deliver, and a claim naming
        the token vault, send tokens. Amounts the node's answer did not
        settle are marked unknown, not left out and not shown as zero.
      */
      const sendsTokens = p.kind === "deliver" || ((p.kind === "claim" || p.kind === "collect" || p.kind === "push") && p.tokenVault !== null && out3 !== "none");
      /* A parked payout is marked so: its SOL back is what park_bid held, net of the parker's reward (INTERFACE-v0.32-NOTE, park_bid). */
      const parked: Record<string, EventValue> = p.kind === "collect" || p.kind === "push" ? { parked: true } : {};
      if (!sendsTokens) {
        const settled = sol !== null;
        if (!settled) out.unsettled++;
        derived.push({ name: "Refunded", data: { launch, bid: p.bid, bidder: p.bidder, amount: sol ?? 0n, settled, ...parked } });
        continue;
      }
      const settled = sol !== null && out3 !== null && out3 !== "none";
      if (!settled) out.unsettled++;
      const t = settled ? (out3 as { toBidder: bigint; fee: bigint }) : { toBidder: 0n, fee: 0n };
      /*
        cost is the deposit less the refund; the deposit is in the commit,
        another transaction (fillCosts). The SOL back is known from the
        lamport balances even when the tokens are not (refund_known); a
        claim whose SOL back equals the deposit bought nothing and was a
        loser's, which fillCosts marks, since without inner instructions and
        token balances a loser's claim looks like a winner's here.
      */
      derived.push({ name: "Delivered", data: { launch, bid: p.bid, bidder: p.bidder, tokens: t.toBidder + t.fee, refund: sol ?? 0n, fee_tokens: t.fee, settled, refund_known: sol !== null, claimed: p.kind === "claim", ...parked } });
    }
  }

  /* One list: the program's lines for what no instruction states, in the log's order, then the commits and payouts in the transaction's order. */
  for (const e of logged) out.events.push({ ...e, from: "log" });
  for (const d of derived) out.events.push({ name: d.name, data: d.data, from: "tx" });
  return out;
}

/*
  A delivery read from its transaction alone has no cost: the cost is the
  deposit less what came back, and the deposit is in the bid's commit. Filled
  in over the whole list, in place; a delivery whose commit is not in the
  history keeps no cost, and the pages say the deposit is not known.
*/
export function fillCosts(events: DecodedEvent[]): void {
  const deposits = new Map<string, bigint>();
  for (const e of events) {
    if ((e.name === "BidCommitted" || e.name === "BidRevealed" || e.name === "BidInvalid") && typeof e.data.deposit === "bigint") deposits.set(String(e.data.bid), e.data.deposit);
  }
  for (const e of events) {
    if (e.name !== "Delivered" || e.data.cost !== undefined || e.data.refund_known === false) continue;
    const deposit = deposits.get(String(e.data.bid));
    if (deposit === undefined || deposit < BigInt(e.data.refund)) continue;
    e.data.cost = deposit - BigInt(e.data.refund);
    /* A claim that gave the whole deposit back bought nothing: a loser's claim, told apart here when the node left the tokens out. */
    if (e.data.settled === false && e.data.claimed === true && e.data.cost === 0n) e.data.loser = true;
  }
}

export interface HistoryStats {
  /* Signatures the node listed, and how many of them failed (a failed transaction changed nothing and is not fetched). */
  signatures: number;
  failed: number;
  /* Transactions fetched in this read. */
  transactions: number;
  signatureRequests: number;
  transactionRequests: number;
  /* Requests the node turned away for rate, each sent again after a pause. */
  refused: number;
  ms: number;
  /* Transactions whose log the node cut. */
  cutLogs: number;
  /* Payouts whose amounts the node's answers did not settle; listed as paid, amounts unknown. */
  unsettled: number;
  /* Transactions the node listed and then did not return, after retries. */
  missing: string[];
  /* Transactions of a version newer than this reader knows. */
  unreadable: number;
  /* The paging reached the transaction that created the launch. */
  genesis: boolean;
  /*
    Whether the node's list reached the address's first transaction: the
    launch's creation, or a bid account's commit. False means the node
    returned an empty page before it (a ledger that starts later), and the
    history shown is the newer part. Null when only newer transactions were
    asked for (until).
  */
  complete: boolean | null;
  /* The oldest signature listed, to continue paging from. */
  oldest: string | null;
  /* The oldest slot this node serves at all (asked only when the history is incomplete). */
  floorSlot: number | null;
}

export interface HistoryOptions extends HistoryHints {
  /* The launch whose events are kept, when the address read is not the launch itself (a bid account). */
  launch?: PublicKey;
  /* Stop at this signature: only newer transactions are listed. */
  until?: string;
  /* Start past this signature: only older transactions are listed (continuing an incomplete read). */
  before?: string;
  /* Transactions already read, by signature, and their events. Filled as the read goes, so a read that fails midway resumes instead of starting over. */
  have?: Map<string, DecodedEvent[]>;
  onProgress?: (read: number, total: number) => void;
  /* Transactions per request and the pause between requests: 8 every 400 ms is 20 transactions a second, under the 50 requests a second a keyed endpoint allows even if it counts each transaction of a batch. Public RPCs limit by method and lower (the lane). */
  chunk?: number;
  pauseMs?: number;
  /* The fetch for the transaction batches: the server passes its metered one (server/budget.ts); the browser passes nothing. */
  fetchImpl?: typeof fetch;
}

/* The newest transaction version this reader knows the JSON shape of. */
const MAX_VERSION = 1;

export interface FetchedTransactions {
  found: Map<string, RawTransaction>;
  /* Listed by the node and not returned. */
  absent: string[];
  /* Turned away for rate. */
  refused: string[];
  /* Of a version above MAX_VERSION. */
  unreadable: string[];
}

/*
  Several transactions in one request, straight from the node's JSON. Each
  reply is matched to its signature by its id, and checked against the
  signature inside the transaction: a node may answer a request of several
  in any order (the keyed devnet endpoint does), and until 2026-10-02 the
  replies were paired with the signatures by position, so an event could
  carry another transaction's signature, slot and time. A reply that is an
  error does not spoil the others.
*/
/* `fetchImpl` is the server's metered fetch when the volume job reads (server/budget.ts); the browser passes nothing. */
export async function fetchTransactions(endpoint: string, signatures: string[], fetchImpl: typeof fetch = siteFetch): Promise<FetchedTransactions> {
  const out: FetchedTransactions = { found: new Map(), absent: [], refused: [], unreadable: [] };
  const body = signatures.map((s, id) => ({ jsonrpc: "2.0", id, method: "getTransaction", params: [s, { encoding: "json", maxSupportedTransactionVersion: MAX_VERSION, commitment: "confirmed" }] }));
  const res = await fetchImpl(endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), cache: "no-store" });
  if (res.status === 429) {
    out.refused = signatures.slice();
    return out;
  }
  if (!res.ok) throw new UpstreamError("http", res.status);
  const json: unknown = await res.json();
  const replies = (Array.isArray(json) ? json : [json]) as { id?: unknown; result?: RawTransaction | null; error?: { code?: number; message?: string } }[];
  const seen = new Set<number>();
  for (const r of replies) {
    const id = r?.id;
    if (typeof id !== "number" || signatures[id] === undefined || seen.has(id)) continue;
    seen.add(id);
    const signature = signatures[id];
    if (r.error) {
      const text = `${r.error.code} ${r.error.message}`;
      if (isRateLimitText(text)) out.refused.push(signature);
      else if (r.error.code === -32015 || /transaction version .* is not supported/i.test(text)) out.unreadable.push(signature);
      else throw new UpstreamError("refused");
    } else if (r.result && r.result.transaction?.signatures?.[0] === signature) out.found.set(signature, r.result);
    else out.absent.push(signature);
  }
  signatures.forEach((s, id) => {
    if (!seen.has(id)) out.absent.push(s);
  });
  return out;
}

const PAGE = 1000;
/* A refusal for rate, however the node words it: HTTP 429, JSON-RPC code 429 or -32005 (the keyed devnet endpoint), or the words. */
const isRateLimitText = (text: string) => /(^|\s|[^\d-])(429|-32005)(\s|$|[^\d])|too many requests|rate limit/i.test(text);
const isRateLimit = (e: unknown) => isRateLimitText(e instanceof Error ? `${(e as { code?: unknown }).code ?? ""} ${e.message}` : String(e));
/* After a refusal for rate: the wait the public endpoint asks for (ten seconds, plus one), then one transaction every 1.1 seconds, which it answered 52 times of 52. */
const LIMITED_WAIT_MS = 11_000;
const LIMITED_GAP_MS = 1_100;
/* A refused endpoint is read at the slow pace for this long after its last refusal. */
const LIMITED_FOR_MS = 60_000;
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

/*
  One line per endpoint for every history read in the page. A launch page
  with a wallet connected reads two histories at once, the launch's and the
  bidder's own bid's; each pacing itself, the two together ask twice what the
  public endpoint accepts and both are refused. Requests take turns instead,
  and a refusal slows the endpoint down for every read on it.
*/
interface Lane {
  tail: Promise<void>;
  nextAt: number;
  limitedUntil: number;
}
const PUBLIC_ENDPOINT = /^https?:\/\/api\.(devnet|testnet|mainnet-beta)\.solana\.com\/?$/;
const lanes = new Map<string, Lane>();
function laneOf(endpoint: string): Lane {
  let lane = lanes.get(endpoint);
  if (!lane) {
    /*
      Solana's public endpoints are read at the slow pace from the first
      request. Measured on devnet 2026-10-02: a first request of eight is
      refused whole and so is the next one eleven seconds later, 22 s lost on
      every page load before the same pace is reached anyway.
    */
    lane = { tail: Promise.resolve(), nextAt: 0, limitedUntil: PUBLIC_ENDPOINT.test(endpoint) ? Infinity : 0 };
    lanes.set(endpoint, lane);
  }
  return lane;
}
/* Runs one request when its turn comes; the request says how long the endpoint is left alone after it. */
async function turn<T>(lane: Lane, request: (limited: boolean) => Promise<{ value: T; restMs: number }>): Promise<T> {
  const before = lane.tail;
  let done!: () => void;
  lane.tail = new Promise<void>((r) => (done = r));
  await before;
  try {
    const wait = lane.nextAt - Date.now();
    if (wait > 0) await pause(wait);
    const { value, restMs } = await request(Date.now() < lane.limitedUntil);
    lane.nextAt = Date.now() + restMs;
    return value;
  } catch (e) {
    lane.nextAt = Math.max(lane.nextAt, Date.now() + 600);
    throw e;
  } finally {
    done();
  }
}

/*
  A turn in the same line for the other reader of transactions on an
  endpoint, the funding trace, which reads them parsed through the library.
  It is told whether the endpoint is being read at the slow pace (it then
  asks for one transaction) and says how many it asked for. A refusal for
  rate thrown by its request slows the endpoint down for every read, as one
  met by the history reader does.
*/
export function takeTurn<T>(endpoint: string, request: (limited: boolean) => Promise<{ value: T; asked: number }>, pauseMs = 250): Promise<T> {
  const lane = laneOf(endpoint);
  return turn(lane, async (limited) => {
    try {
      const { value, asked } = await request(limited);
      return { value, restMs: limited ? Math.max(pauseMs, LIMITED_GAP_MS * asked) : pauseMs };
    } catch (e) {
      if (isRateLimit(e)) {
        lane.limitedUntil = Math.max(lane.limitedUntil, Date.now() + LIMITED_FOR_MS);
        lane.nextAt = Date.now() + LIMITED_WAIT_MS;
      }
      throw e;
    }
  });
}

async function retrying<T>(what: () => Promise<T>, attempts = 4): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await what();
    } catch (e) {
      if (attempt >= attempts - 1) throw e;
      await pause(600 * (attempt + 1));
    }
  }
}

/*
  Every event in every landed transaction that touched an address, newest
  first. The signature list is paged on its cursor until the node returns an
  empty page: a short page is not taken as the end, since a throttled or
  partial answer looks the same (every provider caps a page at 1,000).
  stats.complete says whether the list reached the address's first
  transaction.
*/
export async function readHistory(connection: Connection, address: PublicKey, opts: HistoryOptions = {}): Promise<{ events: DecodedEvent[]; newest: string | null; oldest: string | null; stats: HistoryStats }> {
  const started = Date.now();
  const self = address.toBase58();
  const launch = (opts.launch ?? address).toBase58();
  const have = opts.have ?? new Map<string, DecodedEvent[]>();
  const chunk = opts.chunk ?? 8;
  const pauseMs = opts.pauseMs ?? 400;
  const stats: HistoryStats = { signatures: 0, failed: 0, transactions: 0, signatureRequests: 0, transactionRequests: 0, refused: 0, ms: 0, cutLogs: 0, unsettled: 0, missing: [], unreadable: 0, genesis: false, complete: null, oldest: null, floorSlot: null };
  /*
    Pacing. A keyed endpoint is asked for eight transactions every 400 ms, 20
    a second. The public devnet endpoint answers about ten getTransaction
    calls in ten seconds, counts each transaction of a request, tells a
    refused caller to wait ten seconds, and counts refused calls too (all
    measured 2026-10-02). So a refusal is not a failure: the endpoint is left
    alone for the window once, then read one transaction at a time at the
    pace it accepts, by every read on it (the lane above). A read gives up
    only after six refusals in a row, and what it has read is kept for the
    next call. A dropped connection or any other error is retried with a
    backoff and never taken as the end of anything.
  */
  const lane = laneOf(connection.rpcEndpoint);
  const refusedBy = (where: string) => {
    stats.refused++;
    lane.limitedUntil = Math.max(lane.limitedUntil, Date.now() + LIMITED_FOR_MS);
    lane.nextAt = Date.now() + LIMITED_WAIT_MS;
    return new Error(`429 Too many requests: the RPC refused six ${where} in a row.`);
  };

  const pageOf = async (before: string | undefined) => {
    for (let refusals = 0, errors = 0; ; ) {
      try {
        return await turn(lane, async (limited) => {
          const value = await connection.getSignaturesForAddress(address, { limit: PAGE, before, until: opts.until }, "confirmed");
          return { value, restMs: limited ? LIMITED_GAP_MS : pauseMs };
        });
      } catch (e) {
        if (isRateLimit(e)) {
          const err = refusedBy("signature pages");
          if (++refusals >= 6) throw err;
        } else {
          if (++errors >= 4) throw e;
          await pause(600 * errors);
        }
      }
    }
  };
  const sigs: { signature: string; err: unknown; slot: number }[] = [];
  let before = opts.before;
  for (;;) {
    const page = await pageOf(before);
    stats.signatureRequests++;
    if (page.length === 0) break;
    sigs.push(...page);
    before = page[page.length - 1].signature;
  }
  stats.signatures = sigs.length;
  stats.oldest = sigs.length ? sigs[sigs.length - 1].signature : (opts.before ?? null);
  const landed = sigs.filter((s) => !s.err);
  stats.failed = sigs.length - landed.length;

  const todo = landed.filter((s) => !have.has(s.signature)).map((s) => s.signature);
  const total = landed.length;
  const report = () => opts.onProgress?.(total - todo.length + stats.transactions, total);
  report();
  let refusals = 0;
  let errors = 0;
  const run = async (queue: string[]): Promise<string[]> => {
    const absent: string[] = [];
    while (queue.length) {
      let list: string[] = [];
      let got: FetchedTransactions;
      try {
        got = await turn(lane, async (limited) => {
          list = queue.slice(0, limited ? 1 : chunk);
          const value = await fetchTransactions(connection.rpcEndpoint, list, opts.fetchImpl ?? siteFetch);
          if (value.refused.length) lane.limitedUntil = Math.max(lane.limitedUntil, Date.now() + LIMITED_FOR_MS);
          return { value, restMs: value.refused.length ? LIMITED_WAIT_MS : limited ? Math.max(pauseMs, LIMITED_GAP_MS) : pauseMs };
        });
      } catch (e) {
        if (++errors >= 3) throw e;
        await pause(600 * errors);
        continue;
      }
      errors = 0;
      stats.transactionRequests++;
      /* The refused ones go back to the head of the queue; the rest of the reply is used. */
      queue.splice(0, list.length, ...got.refused);
      for (const [signature, tx] of got.found) {
        const facts = factsOfTransaction(tx, launch, opts);
        if (facts.cut) stats.cutLogs++;
        if (facts.genesis) stats.genesis = true;
        stats.unsettled += facts.unsettled;
        stats.transactions++;
        have.set(signature, facts.events.map((e) => ({ ...e, signature, slot: tx.slot, blockTime: tx.blockTime ?? null })));
      }
      /* A format newer than this reader knows: counted, never shown as something it is not, and not asked for again. */
      for (const s of got.unreadable) {
        stats.unreadable++;
        stats.transactions++;
        have.set(s, []);
      }
      absent.push(...got.absent);
      report();
      if (got.refused.length) {
        stats.refused++;
        refusals = got.found.size ? 0 : refusals + 1;
        if (refusals >= 6) throw new Error("429 Too many requests: the RPC refused six history reads in a row.");
      } else refusals = 0;
    }
    return absent;
  };
  /* Newest first: the payouts, then the reveals, then the commits. */
  let absent = await run(todo.slice());
  /* A node can list a signature a moment before it serves the transaction. Asked again, twice, before it is called missing. */
  for (let round = 0; round < 2 && absent.length; round++) {
    await pause(1500);
    absent = await run(absent);
  }
  stats.missing = absent;

  const events: DecodedEvent[] = [];
  for (const s of landed) events.push(...(have.get(s.signature) ?? []));

  /* Complete when the first transaction was read: the launch's creation, or the bid account's commit. Not judged on a read of newer transactions only. */
  if (opts.until === undefined) {
    const first = opts.launch ? events.some((e) => e.name === "BidCommitted" && e.data.bid === self) : stats.genesis;
    stats.complete = first;
    if (!first) {
      try {
        stats.floorSlot = await retrying(() => connection.getFirstAvailableBlock());
      } catch {
        stats.floorSlot = null;
      }
    }
  }
  stats.ms = Date.now() - started;
  return { events, newest: sigs[0]?.signature ?? null, oldest: stats.oldest, stats };
}
