/*
  Funding graph: the provable version of "could this wallet be the creator's?"

  For every winning bidder the walk follows SOL funding history backwards a
  bounded number of hops and looks for an address that also funded the
  creator. What comes out is a fact with its evidence attached: this wallet
  was funded by X, which also funded the creator, N hops apart, and here are
  the signatures. Anyone can check every hop on an explorer. It is never a
  score and never a verdict, and nothing here ranks wallets by how suspicious
  they look. the founder's rule (2026-09-24): present evidence, never a verdict.

  Shared funding sources are common and innocent. Exchanges and faucets fund
  thousands of wallets, so a path that reaches a known exchange hot wallet
  stops there and is not reported, or the whole feature is noise.

  What a hop is: an incoming native SOL transfer into a wallet, recorded as
  the sender, the receiver, the lamports, the signature and the block time.
  Token transfers, wrapped SOL and program owned accounts are not hops.

  Cost model, so the limit is known before this ships (measured numbers are
  in STATUS-frontend.md):
  - a wallet's funders come from getSignaturesForAddress, paged from the
    newest signature backwards, then one parsed fetch per candidate
    transaction. Funding transfers are the oldest transactions, so the whole
    history has to be paged to reach them. A fresh bidder wallet costs one
    page and a handful of fetches. A wallet with thousands of transactions
    costs a page per thousand before the first useful byte, and an exchange
    hot wallet has millions: the second reason known exchanges are excluded
    by address before anything is expanded.
  - a provider returns null for a wallet it cannot resolve within its own
    page budget. The walk records that branch as unresolved and never
    guesses.
  - depth 1 for every winner is affordable on a plain RPC. Depth 2 is
    affordable only where the depth 1 funders are themselves short history
    wallets. Depth 3, or any wallet with a long history, needs an indexer
    that serves transfers by address. The walk is written against the
    provider interface below so an indexer slots in without touching it.
*/

export interface FundingHop {
  from: string;
  to: string;
  lamports: bigint;
  signature: string;
  /* Unix seconds, or null when the RPC did not return a block time. */
  blockTime: number | null;
}

/* What a provider knows about who funded one wallet. */
export interface FunderPage {
  /* Incoming native SOL transfers, oldest first. */
  hops: FundingHop[];
  /* False when the provider stopped before it had read the wallet's whole history. */
  complete: boolean;
}

/* How far back the provider can see at all. An RPC purges old blocks; nothing before firstSlot is visible to any lookup, so a funding transfer older than that cannot be found. */
export interface HistoryReach {
  firstSlot: number;
  /* Unix seconds of that slot, or null when the RPC could not say. */
  firstBlockTime: number | null;
}

export interface FundingProvider {
  /* Null when the wallet's history is too long to resolve within the provider's budget. Every call is one lookup against the walk's budget. */
  fundersOf(address: string): Promise<FunderPage | null>;
  /* The oldest point the provider can read. Optional: an indexer with full history may omit it. */
  reach?(): Promise<HistoryReach | null>;
}

/* A wallet that funds thousands of others. A path that reaches one stops there and is not reported. */
export interface KnownWallet {
  address: string;
  label: string;
  kind: "exchange" | "faucet" | "bridge";
}

export interface WalkLimits {
  /* How far back from each wallet, in transfers. */
  maxHops: number;
  /* Funders followed per wallet. A wallet with more is marked partial. */
  maxFundersPerWallet: number;
  /* Provider calls for the whole report, the creator's side included. */
  maxLookups: number;
}

export const DEFAULT_LIMITS: WalkLimits = { maxHops: 3, maxFundersPerWallet: 8, maxLookups: 400 };

/*
  creator: the creator's own bid, labelled by the program, not walked.
  linked: a shared funding source was found; the evidence is in `link`.
  unresolved: no link found, but some branch could not be read to the limit.
  exchange: no link found; at least one branch ended at a known exchange or faucet.
  none: no link found within the limit and every branch was read.
*/
export type TraceStatus = "creator" | "linked" | "unresolved" | "exchange" | "none";

/* Why a walk stopped short of maxHops: a history too long to page, the lookup budget, too many funders to follow, or a provider call that failed. */
export type TraceLimit = "history" | "lookups" | "fanout" | "error" | null;

export interface FundingLink {
  /* The address that funded both sides. The creator's wallet when it funded the bidder directly; the bidder's wallet when the bidder funded the creator. */
  source: string;
  /* Transfers from the source down to the bidder, in order. Empty when the source is the bidder. */
  toBidder: FundingHop[];
  /* Transfers from the source down to the creator, in order. Empty when the source is the creator. */
  toCreator: FundingHop[];
  /* toBidder.length + toCreator.length: the distance between the two wallets through the source. */
  hops: number;
}

export interface StoppedAt {
  address: string;
  label: string;
  hops: number;
}

export interface FundingTrace {
  bidder: string;
  status: TraceStatus;
  link: FundingLink | null;
  /* First known exchange or faucet met on the way back. That branch was not expanded. */
  stoppedAt: StoppedAt | null;
  /* Deepest hop that was read in full for this wallet. */
  resolvedHops: number;
  limit: TraceLimit;
  /* The oldest incoming SOL transfer read into this wallet, within the history the provider serves. What a walk that
     stopped at its limits still found (2026-11-04); absent on a report written before then. */
  firstFunder?: FundingHop | null;
}

export interface FundingReport {
  launchId: string;
  creator: string;
  creatorTrace: { resolvedHops: number; limit: TraceLimit; stoppedAt: StoppedAt | null };
  traces: FundingTrace[];
  limits: WalkLimits;
  lookups: number;
  /* Provider calls that failed (rate limit exhausted, network). Each one left a wallet unresolved. */
  providerErrors: number;
  /* Labels of the known wallets that ended a branch anywhere in the report. */
  exclusionsMet: string[];
  resolvedAt: number;
  source: "rpc" | "indexer";
  /* The oldest point the provider could read, stated with the result so the reader knows what the trace could not see. Null when the provider does not say. */
  historyFrom: HistoryReach | null;
}

/* A wallet reached on the way back, with the transfers from it down to the root. */
export interface Ancestor {
  path: FundingHop[];
  hops: number;
}

export interface Exploration {
  ancestors: Map<string, Ancestor>;
  resolvedHops: number;
  limit: TraceLimit;
  stoppedAt: StoppedAt | null;
  link: FundingLink | null;
  firstFunder: FundingHop | null;
}

/* Memoised, budgeted access to a provider. One instance per report, so a funder shared by many bidders is read once. */
export class LookupBudget {
  private cache = new Map<string, FunderPage | null>();
  lookups = 0;
  readonly exclusionsMet = new Set<string>();
  /* Wallets whose provider call threw. Treated as unresolved, never guessed. */
  readonly failed = new Set<string>();
  lastError: string | null = null;

  constructor(
    private provider: FundingProvider,
    readonly limits: WalkLimits,
  ) {}

  async fundersOf(address: string): Promise<FunderPage | null | "budget"> {
    const hit = this.cache.get(address);
    if (hit !== undefined) return hit;
    if (this.lookups >= this.limits.maxLookups) return "budget";
    this.lookups += 1;
    let page: FunderPage | null;
    try {
      page = await this.provider.fundersOf(address);
    } catch (e) {
      this.failed.add(address);
      this.lastError = e instanceof Error ? e.message : String(e);
      page = null;
    }
    this.cache.set(address, page);
    return page;
  }
}

/*
  Breadth first, backwards through funders, at most limits.maxHops deep.
  Known wallets are never entered or expanded. `match` looks each newly
  reached wallet up in the other side's ancestry; the shortest combined path
  wins, and the search continues one level only while a shorter total is
  still possible.
*/
export async function explore(root: string, budget: LookupBudget, known: ReadonlyMap<string, KnownWallet>, match?: (address: string) => Ancestor | undefined): Promise<Exploration> {
  const limits = budget.limits;
  const ancestors = new Map<string, Ancestor>([[root, { path: [], hops: 0 }]]);
  let frontier = [root];
  let resolvedHops = 0;
  let fullyRead = true;
  let limit: TraceLimit = null;
  let stoppedAt: StoppedAt | null = null;
  let link: FundingLink | null = null;
  let firstFunder: FundingHop | null = null;

  for (let depth = 1; depth <= limits.maxHops && frontier.length > 0; depth++) {
    const next: string[] = [];
    let outOfBudget = false;
    for (const wallet of frontier) {
      const page = await budget.fundersOf(wallet);
      if (page === "budget") {
        limit = limit ?? "lookups";
        outOfBudget = true;
        break;
      }
      if (page === null) {
        limit = limit ?? (budget.failed.has(wallet) ? "error" : "history");
        fullyRead = false;
        continue;
      }
      if (!page.complete || page.hops.length > limits.maxFundersPerWallet) {
        limit = limit ?? "fanout";
        fullyRead = false;
      }
      if (wallet === root) firstFunder = page.hops[0] ?? null;
      const below = ancestors.get(wallet)!.path;
      for (const hop of page.hops.slice(0, limits.maxFundersPerWallet)) {
        if (ancestors.has(hop.from)) continue;
        const k = known.get(hop.from);
        if (k) {
          budget.exclusionsMet.add(k.label);
          if (!stoppedAt) stoppedAt = { address: hop.from, label: k.label, hops: depth };
          continue;
        }
        const ancestor: Ancestor = { path: [hop, ...below], hops: depth };
        ancestors.set(hop.from, ancestor);
        const other = match?.(hop.from);
        if (other) {
          const total = depth + other.hops;
          if (!link || total < link.hops) link = { source: hop.from, toBidder: ancestor.path, toCreator: other.path, hops: total };
        }
        next.push(hop.from);
      }
    }
    if (outOfBudget) {
      fullyRead = false;
      break;
    }
    if (fullyRead) resolvedHops = depth;
    if (link && depth + 1 >= link.hops) break;
    frontier = next;
  }
  if (fullyRead && frontier.length === 0) resolvedHops = limits.maxHops;
  return { ancestors, resolvedHops, limit, stoppedAt, link, firstFunder };
}

export interface WalkInput {
  launchId: string;
  creator: string;
  /* Winning bidders. The creator's own wallet may be among them and is reported as such, never walked. */
  bidders: string[];
  provider: FundingProvider;
  known: KnownWallet[];
  limits?: Partial<WalkLimits>;
  source: FundingReport["source"];
  now?: number;
}

export async function walkFunding(input: WalkInput): Promise<FundingReport> {
  const limits: WalkLimits = { ...DEFAULT_LIMITS, ...input.limits };
  const known = new Map(input.known.map((k) => [k.address, k] as const));
  const budget = new LookupBudget(input.provider, limits);
  const historyFrom = input.provider.reach ? await input.provider.reach().catch(() => null) : null;
  const creatorSide = await explore(input.creator, budget, known);

  const traces: FundingTrace[] = [];
  for (const bidder of input.bidders) {
    if (bidder === input.creator) {
      traces.push({ bidder, status: "creator", link: null, stoppedAt: null, resolvedHops: 0, limit: null });
      continue;
    }
    const e = await explore(bidder, budget, known, (address) => creatorSide.ancestors.get(address));
    let link = e.link;
    /* The bidder's own wallet sitting in the creator's ancestry means the bidder funded the creator. */
    const self = creatorSide.ancestors.get(bidder);
    if (self && self.hops > 0 && (!link || self.hops < link.hops)) link = { source: bidder, toBidder: [], toCreator: self.path, hops: self.hops };
    const status: TraceStatus = link ? "linked" : e.limit ? "unresolved" : e.stoppedAt ? "exchange" : "none";
    traces.push({ bidder, status, link, stoppedAt: e.stoppedAt, resolvedHops: e.resolvedHops, limit: e.limit, firstFunder: e.firstFunder });
  }

  return {
    launchId: input.launchId,
    creator: input.creator,
    creatorTrace: { resolvedHops: creatorSide.resolvedHops, limit: creatorSide.limit, stoppedAt: creatorSide.stoppedAt },
    traces,
    limits,
    lookups: budget.lookups,
    providerErrors: budget.failed.size,
    exclusionsMet: [...budget.exclusionsMet].sort(),
    resolvedAt: input.now ?? Math.floor(Date.now() / 1000),
    source: input.source,
    historyFrom,
  };
}

const HOP_WORDS = ["zero", "one", "two", "three", "four", "five", "six"];

export function hopWords(n: number): string {
  return `${HOP_WORDS[n] ?? n} ${n === 1 ? "hop" : "hops"}`;
}

/* The one line a reader judges for themselves. A fact about transfers, nothing more. */
export function describeLink(link: FundingLink, bidder: string, creator: string): string {
  if (link.source === creator) return `Funded by the creator's wallet, ${hopWords(link.hops)}`;
  if (link.source === bidder) return `Funded the creator's wallet, ${hopWords(link.hops)}`;
  return `Funded from the same source as the creator, ${hopWords(link.hops)}`;
}
