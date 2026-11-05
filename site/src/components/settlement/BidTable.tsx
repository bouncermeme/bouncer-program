import { memo, useMemo, useRef, useState } from "react";
import { PublicKey } from "@solana/web3.js";
import { CreatorBidPill } from "@/components/ui/CreatorBid";
import { SHOW_STEP, ShowMore } from "@/components/ui/ShowMore";
import { bidPda } from "@/lib/bouncer/chain/pda";
import { fmtPct, fmtSol, fmtTokens, shortAddr } from "@/lib/bouncer/format";
import type { CapRate, RateStatus } from "@/lib/bouncer/solPrice";
import { noRateText } from "@/components/ui/Cap";
import { fmtCap } from "@/lib/bouncer/usdCap";
import { explorerUrl } from "@/lib/bouncer/chain/rpc";
import { MAX_TICK } from "@/lib/bouncer/grid";
import { byHighestMax, closedWon, type OrderKey } from "@/lib/bouncer/book";
import { fmtFee } from "@/lib/bouncer/product";
import { isCreatorBid, type ClosedBid, type Delivery, type Launch } from "@/lib/bouncer/types";
import { mcapAtTick, shareOfSupply, type SettledRow } from "@/lib/bouncer/view";

/* Every outcome is ordinary, so nothing here is red. Labels per the checklist (C-10). */
function Status({ s }: { s: SettledRow["status"] | "delivered" | "refunded-closed" }) {
  if (s === "filled") return <span className="pill pill-good">Filled</span>;
  if (s === "marginal") return <span className="pill pill-good">Filled at the margin, pro rata</span>;
  if (s === "outbid") return <span className="pill pill-muted">Outbid, refunded</span>;
  if (s === "unrevealed") return <span className="pill pill-muted">Unopened, refunded</span>;
  if (s === "delivered") return <span className="pill pill-good">Delivered</span>;
  return <span className="pill pill-muted">Refunded</span>;
}

/* A paid row's result opens the transaction that paid it. */
function Paid({ s, signature }: { s: "delivered" | "refunded-closed"; signature: string }) {
  return (
    <a href={explorerUrl("tx", signature)} target="_blank" rel="noreferrer" data-payout-tx={signature} className="link">
      <Status s={s} />
    </a>
  );
}

const NONE: ReadonlySet<string> = new Set();
const EMPTY: ClosedBid[] = [];
/* Whole class names only: Tailwind finds classes by reading the source, so a variant built at runtime ("md:" + a
   variable) is never generated, and the desktop table fell back to stacked rows (promo captures, 2026-10-22). */
const ROW = "md:grid md:grid-cols-[1.1fr_0.9fr_0.8fr_2fr_1.1fr] md:gap-3 md:items-center";
const HEAD = "hidden md:grid grid-cols-[1.1fr_0.9fr_0.8fr_2fr_1.1fr] gap-3 text-text-3 pb-2";
/* Astra's frontend review of 2026-10-21, F2: a 4,958-bid book drew a page a million pixels tall. Fifty rows a page, and a search by wallet. */
export const BID_PAGE = 50;

type Entry = { kind: "open"; r: SettledRow } | { kind: "closed"; c: ClosedBid };
const bidderOf = (e: Entry) => (e.kind === "open" ? e.r.bid.bidder : e.c.bidder);
const keyOf = (e: Entry): OrderKey => (e.kind === "open" ? { tick: e.r.tick, deposit: e.r.bid.deposit, bidder: e.r.bid.bidder, bid: e.r.bid.address } : { tick: e.c.tick, deposit: e.c.deposit, bidder: e.c.bidder, bid: e.c.bid });
const count = (n: number) => n.toLocaleString("en-US");

/*
  One row per bid. A bid whose account is still open shows the fill the
  program will pay, computed from the record the way deliver computes it
  (label "Fill", before the push fee). A bid that has been delivered shows
  what actually left the vault, read from its transaction: tokens less the
  fee the pusher took, plus the SOL back (label "Received"). the founder's ruling
  1.4. Bid accounts close on delivery, so closed rows come from the launch's
  history: the payout from its transaction (never from a log line), the tick
  from the program's BidRevealed line.
*/
/* Memoised: the page around it redraws every few seconds while a history is read, and a busy launch has a thousand rows here. */
export const BidTable = memo(function BidTable({
  launch,
  rows,
  closed = EMPTY,
  deliveries,
  largest,
  linked = NONE,
  rate,
  rateStatus,
}: {
  launch: Launch;
  rows: SettledRow[];
  closed?: ClosedBid[];
  deliveries?: Map<string, Delivery> | null;
  largest: string | null;
  linked?: ReadonlySet<string>;
  /* The settlement-minute rate: every max in the table is a dollar figure at it. */
  rate: CapRate | null;
  /* Why there is no rate yet ("Please wait" while the settle minute is pending, item 6). */
  rateStatus?: RateStatus;
}) {
  const a = launch.account;
  const d = launch.token.decimals;
  const sym = launch.token.symbol;
  const deliveredCount = closed.filter((c) => c.delivered).length + rows.filter((r) => deliveries?.has(r.bid.address)).length;
  const header = deliveredCount > 0 ? "Received" : "Fill";
  /* The creator's bid account by the program's own field (Launch.creator_has_bid, set at that commit and never cleared): labels a closed row whose BidCommitted line this RPC did not return. */
  const creatorBid = useMemo(() => (a.creatorHasBid ? bidPda(new PublicKey(launch.id), new PublicKey(a.creator)).toBase58() : null), [a.creatorHasBid, a.creator, launch.id]);
  const [query, setQuery] = useState("");
  /* A window of the found rows: SHOW_STEP from `start`, then SHOW_STEP more up to BID_PAGE. Next starts at the first
     row not yet shown, Previous SHOW_STEP back, and either one or a search starts at SHOW_STEP again. */
  const [start, setStartAt] = useState(0);
  const [upTo, setUpTo] = useState(SHOW_STEP);
  const setStart = (n: number) => {
    setStartAt(n);
    setUpTo(SHOW_STEP);
  };
  const list = useRef<HTMLUListElement>(null);
  /* Highest max first across open and closed rows, before the search and the pages (book.ts byHighestMax). 2B (the founder, 2026-10-27): the creator's bid first, by the program's labels only. */
  const entries = useMemo<Entry[]>(() => {
    const creatorOf = (e: Entry) => (e.kind === "open" ? isCreatorBid(e.r.bid) || e.r.bid.address === creatorBid : e.c.creator || e.c.bid === creatorBid);
    return [...rows.map((r) => ({ kind: "open" as const, r })), ...closed.map((c) => ({ kind: "closed" as const, c }))].sort((x, y) => Number(creatorOf(y)) - Number(creatorOf(x)) || byHighestMax(keyOf(x), keyOf(y)));
  }, [rows, closed, creatorBid]);
  /* Any part of the wallet address, letter case ignored (a pasted fragment of what a wallet shows). */
  const q = query.trim().toLowerCase();
  const found = useMemo(() => (q ? entries.filter((e) => bidderOf(e).toLowerCase().includes(q)) : entries), [entries, q]);
  const pages = Math.max(1, Math.ceil(found.length / BID_PAGE));
  const from = Math.min(start, Math.max(0, found.length - 1));
  const shown = found.slice(from, from + upTo);
  const left = Math.min(BID_PAGE - shown.length, found.length - from - shown.length);
  const total = entries.length;

  const Max = ({ tick, won }: { tick: number | null; won: boolean }) => (
    <span className={`tab ${won ? "" : "text-text-3"}`}>{tick == null ? "sealed" : tick === MAX_TICK ? "no limit" : rate ? fmtCap(mcapAtTick(a, tick), rate.usdPerSol) : noRateText(rateStatus ?? "unavailable")}</span>
  );

  const Received = ({ dl }: { dl: Delivery }) => {
    /* The payout is certain from its instruction; the amounts are what the node returned around it. */
    if (!dl.settled) return <span className="text-text-3">paid; the amounts were not returned by this RPC</span>;
    const got = dl.tokens - dl.feeTokens;
    /* 2B (the founder, 2026-10-27, revised shot approved): the tokens that arrived and their share, nothing else; a winner's unspent SOL is in the payout transaction "Delivered" links. A row with no tokens keeps its amount (the founder: "0.018 SOL refunded"). */
    return got > 0n ? (
      <>
        {fmtTokens(got, d)}
        <span className="text-text-3"> ({fmtPct(shareOfSupply(a, got), 1)})</span>
      </>
    ) : (
      <span className="text-text-3">{fmtSol(dl.refund)} refunded</span>
    );
  };

  const openRow = (r: SettledRow) => {
    const dl = deliveries?.get(r.bid.address) ?? null;
    const isLargest = largest != null && r.bid.bidder === largest && r.fill.tokens > 0n;
    const won = r.fill.tokens > 0n;
    return (
      <li key={r.bid.address} className={`border-t border-line py-3 ${isLargest ? "bg-accent-soft -mx-4 px-4 md:-mx-5 md:px-5" : ""}`}>
        <div className={ROW}>
          <div className="flex items-center justify-between md:block">
            <span className="mono">
              {shortAddr(r.bid.bidder, 5, 4)}
              {isLargest && <span className="ml-2 pill pill-live">largest</span>}
              {isCreatorBid(r.bid) && <CreatorBidPill />}
              {linked.has(r.bid.bidder) && <span className="ml-2 pill pill-muted">funding link</span>}
            </span>
            <span className="md:hidden">
              {dl ? <Paid s="delivered" signature={dl.signature} /> : <Status s={r.status} />}
            </span>
          </div>
          <div className="flex items-baseline justify-between mt-1 md:mt-0 md:block md:text-right">
            <span className="text-text-3 md:hidden">Max mcap</span>
            <Max tick={r.tick} won={won} />
          </div>
          <div className="flex items-baseline justify-between md:block md:text-right">
            <span className="text-text-3 md:hidden">Deposit</span>
            <span className="tab">{fmtSol(r.bid.deposit)}</span>
          </div>
          <div className="flex items-baseline justify-between gap-4 md:block md:text-right">
            <span className="text-text-3 md:hidden shrink-0">{dl ? "Received" : "Fill"}</span>
            <span className="tab text-right min-w-0">
              {dl ? (
                <Received dl={dl} />
              ) : won ? (
                <>
                  {fmtTokens(r.fill.tokens, d)} {sym}
                  <span className="text-text-3">
                    {" "}
                    ({fmtPct(shareOfSupply(a, r.fill.tokens), 1)} of supply{a.deliveryTerms === 1 ? "" : `, before a ${fmtFee(a.deliveryFeeBps)} push fee`})
                  </span>
                  {r.fill.refund > 0n && <span className="text-text-3"> + {fmtSol(r.fill.refund)} back</span>}
                </>
              ) : (
                <span className="text-text-3">{fmtSol(r.fill.refund)} back</span>
              )}
            </span>
          </div>
          <div className="hidden md:block text-right">
            {dl ? <Paid s="delivered" signature={dl.signature} /> : <Status s={r.status} />}
          </div>
        </div>
      </li>
    );
  };
  const closedRow = (c: ClosedBid) => {
    const won = closedWon(c);
    const isLargest = largest != null && c.bidder === largest && won;
    const s = c.delivered ? "delivered" : "refunded-closed";
    const signature = c.delivered?.signature ?? c.refunded?.signature;
    const result = signature ? <Paid s={s} signature={signature} /> : <Status s={s} />;
    return (
      <li key={c.bid} className={`border-t border-line py-3 ${isLargest ? "bg-accent-soft -mx-4 px-4 md:-mx-5 md:px-5" : ""}`}>
        <div className={ROW}>
          <div className="flex items-center justify-between md:block">
            <span className="mono">
              {shortAddr(c.bidder, 5, 4)}
              {isLargest && <span className="ml-2 pill pill-live">largest</span>}
              {(c.creator || c.bid === creatorBid) && <CreatorBidPill />}
              {linked.has(c.bidder) && <span className="ml-2 pill pill-muted">funding link</span>}
            </span>
            <span className="md:hidden">
              {result}
            </span>
          </div>
          <div className="flex items-baseline justify-between mt-1 md:mt-0 md:block md:text-right">
            <span className="text-text-3 md:hidden">Max mcap</span>
            {c.tick != null ? <Max tick={c.tick} won={won} /> : <span className="tab text-text-3">{c.invalid ? "never opened" : "not in the log"}</span>}
          </div>
          <div className="flex items-baseline justify-between md:block md:text-right">
            <span className="text-text-3 md:hidden">Deposit</span>
            {/* A bid cannot deposit nothing: zero here means neither the commit nor the reveal of this bid is in the history read. */}
            {c.deposit > 0n ? <span className="tab">{fmtSol(c.deposit)}</span> : <span className="tab text-text-3">not in the history</span>}
          </div>
          <div className="flex items-baseline justify-between gap-4 md:block md:text-right">
            <span className="text-text-3 md:hidden shrink-0">Received</span>
            <span className="tab text-right min-w-0">
              {c.delivered ? <Received dl={c.delivered} /> : c.refunded && !c.refunded.settled ? <span className="text-text-3">refunded; the amount was not returned by this RPC</span> : <span className="text-text-3">{fmtSol(c.refunded?.amount ?? c.deposit)} refunded</span>}
            </span>
          </div>
          <div className="hidden md:block text-right">
            {result}
          </div>
        </div>
      </li>
    );
  };

  return (
    <div>
      {total > BID_PAGE && (
        <div className="mb-3">
          <label htmlFor="bid-search" className="text-text-3">
            Find a wallet
          </label>
          <input
            id="bid-search"
            type="search"
            className="field mt-1 mono"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setStart(0);
            }}
            placeholder="Any part of the address"
            autoComplete="off"
            spellCheck={false}
            aria-describedby="bid-search-count"
          />
          <p id="bid-search-count" className="text-text-3 mt-1 num" role="status">
            {q ? `${count(found.length)} of ${count(total)} bids match.` : `${count(total)} bids.`}
          </p>
        </div>
      )}
      <div className={HEAD}>
        <span>Bidder</span>
        <span className="text-right">Max mcap</span>
        <span className="text-right">Deposit</span>
        <span className="text-right">{header}</span>
        <span className="text-right">Result</span>
      </div>
      <ul ref={list} data-bid-rows={shown.length}>{shown.map((e) => (e.kind === "open" ? openRow(e.r) : closedRow(e.c)))}</ul>
      <ShowMore left={left} onMore={() => setUpTo((n) => n + SHOW_STEP)} list={list} describedBy="every-bid-heading" />
      {total === 0 && <p className="text-text-2 py-3 border-t border-line">No bid accounts are open and no delivery or refund was found in this launch&apos;s transactions.</p>}
      {total > 0 && found.length === 0 && <p className="text-text-2 py-3 border-t border-line">No bid from a wallet matching &ldquo;{query.trim()}&rdquo;.</p>}
      {pages > 1 && (
        <nav className="flex items-center justify-between gap-3 pt-3 border-t border-line" aria-label="Bid pages" data-bid-pages={pages}>
          <button type="button" className="btn btn-secondary" disabled={from === 0} onClick={() => setStart(Math.max(0, from - SHOW_STEP))}>
            Previous
          </button>
          <span className="text-text-3 num" aria-live="polite">
            {count(from + 1)} to {count(from + shown.length)} of {count(found.length)}
          </span>
          <button type="button" className="btn btn-secondary" disabled={from + shown.length >= found.length} onClick={() => setStart(from + shown.length)}>
            Next
          </button>
        </nav>
      )}
    </div>
  );
});
