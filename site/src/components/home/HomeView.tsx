"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Countdown } from "@/components/launch/Countdown";
import { PauseBanner } from "@/components/launch/PauseBanner";
import { ShareSlot } from "@/components/launch/ShareSlot";
import { HomeHero } from "@/components/home/HomeHero";
import { SortControl } from "@/components/home/SortControl";
import { TokenAvatar, StatusPill } from "@/components/launch/TokenIdentity";
import { Cap } from "@/components/ui/Cap";
import { fmtBids, fmtCardAge, fmtSol, fmtWindowMin, shortAddr } from "@/lib/bouncer/format";
import { useAccount } from "@/components/wallet/AccountProvider";
import { BOARD_LIVE_MS, useConfig, useLaunchList, useMyBidsRead, useNowSec } from "@/lib/bouncer/hooks";
import { useHiddenPairs } from "@/lib/bouncer/hiddenPairs";
import { ReadFailed } from "@/components/ui/ReadFailed";
import { usePoolMcaps, useVolumes, volumeText, type PoolMcap, type Volume } from "@/lib/bouncer/market";
import { useCapRate, type CapRate, type RateStatus } from "@/lib/bouncer/solPrice";
import type { Launch } from "@/lib/bouncer/types";
import { bookOpen, closeAtTs, endedWithoutSale, hasRecord, isOver, recoverable, totalSupply } from "@/lib/bouncer/view";
import { tradingOpen } from "@/lib/bouncer/v030";
import { BOARD_SORT_DEFAULT, BOARD_SORT_KEY, boardFacts, cardFacts, createdBy, isBoardSort, isProcessing, liveOrder, searchGroups, searchText, sortClosed, splitDead, YOUR_LAUNCHES_ANCHOR, type BoardFacts, type BoardSort } from "@/lib/bouncer/boardSort";

/* the founder's item 14 (2026-10-16): a page of cards at a time on the cleared and the dead boards; the rest behind one button. */
const PAGE = 12;

/*
  The front page. Ruling D1 (the founder, 2026-09-27) made it wordless: the
  wordmark in the header and the board, nothing between them. the founder,
  2026-10-10 (the new look's second pass): one line and the door above the
  boards (HomeHero), which overrides D1 for that line only. A launch still
  taking bids is still not promoted into the hero (two open launches would
  make two heroes fighting a list); it sits on the Live board with its live
  pill, soonest to close first (the founder's two boards of 2026-10-01, below). How it works lives on its own page, linked
  from the header. Every number on a card is read from the launch account
  or its record; a card never infers.
*/

type RateState = RateStatus;

/* What every card on the board shares: the live SOL rate, the pools' market caps and Dexscreener's volumes, read once for the whole board. */
interface Market {
  rate: CapRate | null;
  status: RateState;
  mcaps: Map<string, PoolMcap> | null;
  volumes: Map<string, Volume>;
}

/*
  The Closed board's chosen order, kept in this browser (localStorage
  bouncer:board-sort) the way the bid page keeps its quick amounts: the
  store is read after hydration, so the server's and the browser's first
  paint agree on the default; a browser that refuses storage keeps the
  choice for the page.
*/
let chosenSort: BoardSort | null = null;
const sortListeners = new Set<() => void>();
function readSort(): BoardSort {
  if (chosenSort) return chosenSort;
  try {
    const saved = window.localStorage.getItem(BOARD_SORT_KEY);
    return isBoardSort(saved) ? saved : BOARD_SORT_DEFAULT;
  } catch {
    return BOARD_SORT_DEFAULT;
  }
}
function subscribeSort(cb: () => void) {
  sortListeners.add(cb);
  window.addEventListener("storage", cb);
  return () => {
    sortListeners.delete(cb);
    window.removeEventListener("storage", cb);
  };
}
function useBoardSort(): [BoardSort, (s: BoardSort) => void] {
  const sort = useSyncExternalStore(subscribeSort, readSort, () => BOARD_SORT_DEFAULT);
  const choose = useCallback((s: BoardSort) => {
    chosenSort = s;
    try {
      window.localStorage.setItem(BOARD_SORT_KEY, s);
    } catch {
      /* Storage refused: the choice lasts the page. */
    }
    for (const l of sortListeners) l();
  }, []);
  return [sort, choose];
}

export function HomeView() {
  /* 24n (the founder's notes): the board every 3 s while it is shown, one shared read that every card draws from. */
  const { list: launches, failed: boardFailed } = useLaunchList(BOARD_LIVE_MS);
  const [sort, chooseSort] = useBoardSort();
  /* Launch search (the founder, 2026-10-30, approved as mocked): the board's own list filtered in this browser; nothing is read and nothing is kept. */
  const [query, setQuery] = useState("");
  const config = useConfig();
  /* 24o (Astra's 24n F5): the one-second clock the launch page uses, so a card leaves Live now when its window ends, not up to 5 s later. A clock, not a read. */
  const nowSec = useNowSec(1000);
  const hidden = useHiddenPairs();
  const account = useAccount();
  const ids = useMemo(() => (launches ?? []).map((l) => l.id), [launches]);
  /* 24d: this wallet's bids are read again when a launch moves (a bid, a reveal, a payout, its state), not on every board read. */
  const bidsVersion = useMemo(() => (launches ?? []).map((l) => `${l.account.state}:${l.account.bidCount}:${l.account.distributedCount}`).join(","), [launches]);
  /* A failed read of this wallet's bids says so (F14): no "Your bids" board would read as no bids. */
  const { mine, failed: mineFailed, retry: retryMine } = useMyBidsRead(ids, account.address, bidsVersion);
  const { rate, status } = useCapRate(null);
  /* The settled coins' pools, one read for the board (market.ts). */
  const entries = useMemo(() => (launches ?? []).filter((l) => l.record?.pool).map((l) => ({ id: l.id, pool: l.record!.pool!, mint: l.token.mint, supply: totalSupply(l.account), closeTs: l.account.closeTs })), [launches]);
  const mcaps = usePoolMcaps(entries);
  const volumes = useVolumes(useMemo(() => entries.map((e) => e.pool), [entries]));
  const market: Market = { rate, status, mcaps, volumes };

  /*
    the founder, 2026-10-01 (replaces ruling D5's single list): two boards. Live is
    every launch still taking bids, by the clock (the book closes at open_ts
    plus the window whatever the state byte reads), soonest to close first.
    Closed is everything else, in the order chosen on the board (boardSort.ts;
    the founder, 2026-10-15): New, newest first by open_ts, the default; Highest
    market cap; Highest volume 24h. Launches still being processed come
    first in every order. Until then the settled ones went by what they
    raised, which buried every new small launch under the big old ones.
    Your bids, when a wallet is connected and has a bid account on any of
    them, comes first: that is where a participant's deposit is.

    the founder, 2026-10-16 (item 14): three boards. Live now is every launch still
    taking bids, soonest to close first, then the ones still being processed
    (bids opening, the clearing cap, the pool), newest first. Recently
    cleared is every launch with a settlement record, in the order chosen on
    the board, twelve at a time. The launches that did not clear (refunding,
    aborted, ended without a sale, past the recovery deadline) sit behind one
    button, newest first, twelve at a time, so a board of dead launches never
    buries the live ones.
  */
  const groups = useMemo(() => {
    const all = launches ?? [];
    const live = (l: Launch) => (nowSec != null ? bookOpen(l.account, nowSec) : l.account.state === "open");
    const expired = (l: Launch) => nowSec != null && recoverable(l.account, nowSec);
    const clearedOk = (l: Launch) => hasRecord(l.account.state) && l.recordExists && !expired(l);
    /* S2 (2026-10-20): the launches someone has bid on first, then the rest, each soonest to close first (boardSort.ts liveOrder). */
    const open = liveOrder(all.filter(live), (l) => closeAtTs(l.account));
    const processing = all.filter((l) => !live(l) && isProcessing(l, nowSec)).sort((x, y) => y.account.openTs - x.account.openTs);
    const rest = all.filter((l) => !live(l) && !isProcessing(l, nowSec));
    const cleared = sortClosed(rest.filter(clearedOk), sort, nowSec, { mcaps, volumes });
    const dead = rest.filter((l) => !clearedOk(l)).sort((x, y) => y.account.openTs - x.account.openTs);
    const my = mine ? all.filter((l) => mine.has(l.id)) : [];
    const created = createdBy(all, account.address);
    /* v0.30 item 8: the cards' same-name note reads the clock and the admin's hidden directions (boardSort.ts sameNameOthers). */
    /* The cards' creator counts and ticker notes stay the whole board's, whatever the query. */
    return searchGroups({ live: [...open, ...processing], cleared, dead, my, created, facts: { ...boardFacts(all), nowSec, hidden } }, all, query);
  }, [launches, nowSec, mine, sort, mcaps, volumes, account.address, hidden, query]);

  return (
    <div className="pt-4 md:pt-6">
      {/* C-07: the emergency update pause, disclosed wherever a launch can be created and on the front page. */}
      {config?.emergencyUpdatePause && (
        <div className="mb-6">
          <PauseBanner config={config} />
        </div>
      )}

      <HomeHero />

      <section className="relative mt-4 md:mt-6 flex flex-col gap-5 md:gap-10">
        {launches && launches.length > 0 && <LaunchSearch query={query} onQuery={setQuery} matched={groups.matched ?? 0} total={launches.length} />}
        <HomeBoards query={query} launches={launches} boardFailed={boardFailed} wallet={account.address} groups={groups} market={market} sort={sort} onSort={chooseSort} bidsFailed={!!account.address && mine === null && mineFailed} onRetryBids={retryMine} />
      </section>

    </div>
  );
}

/*
  Your launches (the founder, 2026-10-18): the connected wallet's own launches, from
  the board's own list (no read), shown only while a wallet is connected, like
  Your bids. Every card is the boards' own: a cleared launch opens its trade
  page, where the creator's Claim fees card is; the rest open the launch
  page. The How and create pages' "Claim fees" links land here by the
  anchor; the list loads after the page, so the hash is honoured when this
  board first draws. With no wallet (the founder, 2026-10-18) one plain line holds
  the place and the anchor, so a link followed without a wallet lands on it.
*/
function YourLaunches({ wallet, launches, from, market, facts, hidden = false }: { wallet: string | null; launches: Launch[]; from: number; market: Market; facts?: BoardFacts; hidden?: boolean }) {
  const connected = wallet !== null;
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    if (window.location.hash === `#${YOUR_LAUNCHES_ANCHOR}`) ref.current?.scrollIntoView({ block: "start" });
  }, []);
  if (!connected) return <span id={YOUR_LAUNCHES_ANCHOR} ref={ref} className="absolute top-0 left-0 scroll-mt-24" data-your-launches="connect" aria-hidden="true" />;
  /* Launch search: a query with no match hides this same div (the hidden attribute draws nothing and takes no gap), so
     the board inside keeps its pages and this effect does not run again mid-typing. */
  return (
    <div id={YOUR_LAUNCHES_ANCHOR} ref={ref as React.RefObject<HTMLDivElement>} className="scroll-mt-24" data-your-launches="" hidden={hidden}>
      {connected ? (
        /* Keyed by the wallet, so another wallet starts at one page again (Astra's review of 337bed2); its cards come from the list, with no subscription (F2). */
        <Board key={wallet} title="Your launches" tone="plain" launches={launches} from={from} market={market} empty={<p>No launches from this wallet.</p>} page={PAGE} fromList facts={facts} />
      ) : null}
    </div>
  );
}

export interface BoardGroups {
  live: Launch[];
  cleared: Launch[];
  dead: Launch[];
  my: Launch[];
  created: Launch[];
  /* Creators' and tickers' counts across the board (boardSort.ts, S2), for the cards' creator line and repeated-ticker note. */
  facts?: BoardFacts;
  /* Launch search: how many launches the query matches, across every board. */
  matched?: number;
}

/*
  Launch search (the founder, 2026-10-30, approved as mocked: review/2026-10-30-launch-search): one field above the boards,
  named for screen readers only (no visible label, his call); the line under it speaks only while a query is typed.
*/
export function LaunchSearch({ query, onQuery, matched, total }: { query: string; onQuery: (q: string) => void; matched: number; total: number }) {
  const q = query.trim();
  const n = (x: number) => x.toLocaleString("en-US");
  const on = searchText(query) !== "";
  return (
    <div className="md:max-w-[34rem]" data-launch-search>
      <input type="search" className="field" value={query} onChange={(e) => onQuery(e.target.value)} placeholder="Ticker, name or address" aria-label="Find a launch" aria-describedby="launch-search-count" autoComplete="off" spellCheck={false} maxLength={64} />
      <p id="launch-search-count" className="text-text-3 mt-1 num" role="status">
        {on ? matched > 0 ? `${n(matched)} of ${n(total)} launches match.` : <>No launch matching &ldquo;{q}&rdquo;.</> : null}
      </p>
    </div>
  );
}

/*
  The boards under the hero, from what HomeView read (exported for
  scripts/check-your-launches.tsx). Three states stay apart: a failed first
  read, loading, and a loaded list. Your launches (or, with no wallet, its
  connect line), with the your-launches anchor, shows on every loaded list,
  an empty one included (Astra's review of 337bed2, F4: an empty board had
  no anchor for the Claim fees links), and never while loading or after a
  failed read, where it would read as "no launches".
*/
export function HomeBoards({ launches, boardFailed, wallet, groups, market, sort, onSort, bidsFailed, onRetryBids, query = "" }: { query?: string; launches: Launch[] | null; boardFailed: boolean; wallet: string | null; groups: BoardGroups; market: Market; sort: BoardSort; onSort: (s: BoardSort) => void; bidsFailed: boolean; onRetryBids: () => void }) {
  if (launches === null && boardFailed) return <div className="panel-2 p-4 md:p-5 text-text-2">The launches could not be read from the network just now. Trying again every 30 seconds.</div>;
  if (launches === null)
    return (
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <div className="h-40 rounded-[8px] bg-panel-2 animate-pulse" />
        <div className="h-40 rounded-[8px] bg-panel-2 animate-pulse" />
        <div className="h-40 rounded-[8px] bg-panel-2 animate-pulse hidden lg:block" />
      </div>
    );
  /*
    Launch search: with matches, a board without one is left out; a query with no match draws no board, only the
    field's own line. The boards that page stay mounted through it (Live now and Recently cleared draw nothing while
    empty; Your launches and the did-not-clear board keep their own divs, hidden), so a keystroke never resets a
    board's pages or an opened list, or runs Your launches' anchor scroll again. Your bids has no pages.
  */
  const searching = searchText(query) !== "";
  const none = searching && !groups.matched;
  const yours = <YourLaunches wallet={wallet} launches={groups.created} from={groups.my.length} market={market} facts={groups.facts} hidden={none} />;
  if (launches.length === 0)
    return (
      <>
        {yours}
        <Board title="Live now" tone="live" launches={[]} from={0} empty={NO_LIVE} market={market} action={<CreateLaunchCta />} />
      </>
    );
  /* The boards' card index runs on through each board in turn (the reveal stagger). */
  const before = groups.my.length + (wallet ? Math.min(groups.created.length, PAGE) : 0);
  return (
    <>
      {groups.my.length > 0 && <Board title="Your bids" tone="plain" launches={groups.my} from={0} market={market} facts={groups.facts} />}
      {bidsFailed && !none && <ReadFailed what="Your bids" onRetry={onRetryBids} className="panel-2 p-4 md:p-5 mb-6" />}
      {yours}
      {/* A page at a time (S2), so a run of junk launches never fills the board. */}
      <Board title="Live now" tone="live" launches={groups.live} from={before} empty={searching ? undefined : NO_LIVE} market={market} page={PAGE} facts={groups.facts} action={<CreateLaunchCta />} />
      <Board title="Recently cleared" tone="plain" launches={groups.cleared} from={before + Math.min(groups.live.length, PAGE)} market={market} control={<SortControl sort={sort} onChoose={onSort} />} page={PAGE} facts={groups.facts} />
      <DeadBoard launches={groups.dead} from={before + Math.min(groups.live.length, PAGE) + Math.min(groups.cleared.length, PAGE)} market={market} facts={groups.facts} />
    </>
  );
}

/*
  Navigation only: the existing create page retains wallet, network and live-terms gates. 1A (the founder, 2026-10-27,
  revised shot approved, review/2026-10-27-v030/mocks-ui/revised): the same button and label, filled (primary), on the
  "Live now" heading row whether or not anything is live; the box under an empty row keeps only "No live launches."
*/
function CreateLaunchCta() {
  return (
    <Link href="/create" className="btn btn-primary shrink-0" data-create-launch-cta>
      Create launch
    </Link>
  );
}
const NO_LIVE = <p className="text-text font-semibold">No live launches.</p>;

/* One board: a heading and the cards (the line that explained each board's order went in the copy pass of 2026-10-02). A launch with a record, or one that ended without a sale, has an outcome to show; one still open or being processed has a clock. */
/*
  Pass 2 (2026-10-10), the boards' order of importance in the type: Live is
  the largest heading, with the live dot while anything is open and the rope
  run out beside it; Your bids is a plain heading; Closed steps back to the
  second text tone and a hairline.
*/
type Tone = "live" | "plain" | "quiet";

function Board({ title, tone, launches, from, empty, market, control, page, fromList, facts, action }: { title: string; tone: Tone; launches: Launch[]; from: number; empty?: React.ReactNode; market: Market; control?: React.ReactNode; page?: number; fromList?: boolean; facts?: BoardFacts; action?: React.ReactNode }) {
  /* With a page size, this many cards show; the button under them adds a page. */
  const [shown, setShown] = useState(page ?? 0);
  if (launches.length === 0 && !empty) return null;
  const visible = page ? launches.slice(0, shown) : launches;
  return (
    <div data-board={tone}>
      {/* 24o (the founder's approved mock): under 420 px a heading with the sort control sits a little tighter, so "Highest raise" stays on its line. */}
      <div className={`flex items-center min-w-0 ${control ? "gap-2 min-[420px]:gap-3" : "gap-3"}`}>
        <h2 className={tone === "live" ? "display text-[1.5rem] md:text-[1.75rem] flex items-center gap-2.5" : `display text-[1.25rem] ${tone === "quiet" ? "text-text-2" : ""}`}>
          {tone === "live" && launches.length > 0 && <span className="live-dot" aria-hidden="true" />}
          {title}
        </h2>
        <span className={`flex-1 min-w-0 ${tone === "live" ? "rope" : "hairline"}`} aria-hidden="true" />
        {/* 24n (the founder, 2026-10-26, the approved mock): the order control on the heading's line, right-aligned after the hairline. */}
        {control && launches.length > 1 && control}
        {/* 1A: the heading row's own button (Create launch on Live now), shown whatever the board holds. */}
        {action}
      </div>
      {launches.length === 0 ? (
        <div className="mt-2 panel-2 px-3 py-2 md:p-4 text-text-2 leading-snug" data-board-empty>
          {empty}
        </div>
      ) : (
        <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {/* 24n (plan fix 2): every live card draws from the board's own read (every 3 s), with no read of its own. */}
          {visible.map((l, i) => (isOver(l.account.state) || hasRecord(l.account.state) ? <ClosedCard key={l.id} launch={l} index={from + i} market={market} facts={facts} /> : <LiveCardView key={l.id} launch={l} index={from + i} facts={facts} />))}
        </div>
      )}
      {page && launches.length > visible.length ? (
        <div className="mt-3 flex justify-center">
          <button type="button" className="btn btn-secondary" onClick={() => setShown((n) => n + page)} data-board-more>
            Show {Math.min(page, launches.length - visible.length)} more
          </button>
        </div>
      ) : null}
    </div>
  );
}

/*
  The launches that did not clear, behind one button (the founder's item 14): a count until pressed, then a quiet board a page at a time.
  S2 (2026-10-20): the ones that ended with no bid at all (nothing to refund) are counted apart, behind a button of their own, so a run of junk launches never fills the list.
*/
function DeadBoard({ launches, from, market, facts }: { launches: Launch[]; from: number; market: Market; facts?: BoardFacts }) {
  const [open, setOpen] = useState(false);
  const [empty, setEmpty] = useState(false);
  const { withBids, noBids } = splitDead(launches);
  /* Mounted whatever the board holds (launch search): with no launch it is hidden, and an opened list with none of its
     own is hidden, not dropped, so its pages survive a query. */
  return (
    <div data-board="dead" hidden={launches.length === 0}>
      <div className="flex flex-wrap gap-2">
        {withBids.length > 0 && (
          <button type="button" className="chip" data-on={open ? "true" : "false"} aria-expanded={open} onClick={() => setOpen((o) => !o)} data-dead-toggle>
            {open ? "Hide" : "Show"} {withBids.length} that did not clear
          </button>
        )}
        {noBids.length > 0 && (
          <button type="button" className="chip" data-on={empty ? "true" : "false"} aria-expanded={empty} onClick={() => setEmpty((o) => !o)} data-dead-empty-toggle>
            {empty ? "Hide" : "Show"} {noBids.length} with no bids
          </button>
        )}
      </div>
      {open && (
        <div className="mt-4" hidden={withBids.length === 0}>
          <Board title="Did not clear" tone="quiet" launches={withBids} from={from} market={market} page={PAGE} facts={facts} />
        </div>
      )}
      {empty && (
        <div className="mt-4" hidden={noBids.length === 0}>
          <Board title="No bids" tone="quiet" launches={noBids} from={from} market={market} page={PAGE} facts={facts} />
        </div>
      )}
    </div>
  );
}

/*
  the founder, 2026-10-07: the cards are smaller (three to a row on a desktop, two
  on a tablet, one on a phone) and the three rule badges of ruling D2
  (Sealed, Same mcap, LP locked) are gone from them. The mechanics live on
  the How it works page and on the launch page.
*/

/*
  A card is a link over its whole face, with the share slot above it (copy
  the link, or the mint once the pool is open), so the anchor holds no
  interactive children.
*/
function CardLink({ href, label }: { href: string; label: string }) {
  return <Link href={href} className="absolute inset-0 rounded-[8px]" aria-label={label} />;
}

/*
  A live launch. Decision 1 of 2026-09-30 (the founder): the clock is the card's
  big figure, where every competitor puts a market cap, with one secondary
  line under it, "48.2 SOL deposited · 12 bids". "Deposited", never
  "raised": deposited SOL is not proceeds until the auction clears. This
  supersedes ruling D3's "no bid count"; the rest of D3 stands: no
  sparkline (deposited SOL is not price, and a chart's shape reads as
  demand), no largest share, no dollars. After the window the same place
  holds the stage: "3/12" while bids open, then the words of the stage.
*/
/*
  The live card's face, from a Launch already in hand: no subscription and
  no read of its own. Your launches renders this from the board's list
  (Astra's review of 337bed2, F2: an expired creator launch still in the
  open or closed state mounted LiveCard and polled, a read the board did
  not make before). 24n (plan fix 2): every board does, since the board's
  one read comes every 3 s and carries each launch's deposits and bids.
*/
function LiveCardView({ launch, index, facts }: { launch: Launch; index: number; facts?: BoardFacts }) {
  const nowSec = useNowSec(1000);
  const a = launch.account;
  /* This card also shows a launch on the Closed board that is still being processed (bids opening, the clearing cap); only a book still taking bids, by the board's own clock rule, wears the live surface (pass 2, 2026-10-10). */
  const live = nowSec != null ? bookOpen(a, nowSec) : a.state === "open";
  return (
    <article className={`panel card-navy door ${live ? "door-live" : ""} card p-4 md:p-5 relative min-w-0 reveal`} style={{ "--i": index + 1 } as React.CSSProperties} data-card-live={live ? "" : undefined}>
      <CardLink href={`/launch/${launch.id}`} label={`${launch.token.name} auction`} />
      <div className="flex items-center gap-3">
        <TokenAvatar launch={launch} size={44} />
        <div className="min-w-0 flex-1">
          <p className="display text-[1.25rem] font-bold leading-tight wrap-any">{launch.token.symbol}</p>
          {launch.token.name.trim().toLowerCase() !== launch.token.symbol.trim().toLowerCase() && <p className="text-text-2 leading-tight mt-0.5 wrap-any">{launch.token.name}</p>}
        </div>
        <StatusPill launch={launch} />
      </div>
      <CardFacts launch={launch} facts={facts} />
      <div className="mt-3 flex items-end justify-between gap-3">
        <Countdown launch={launch} size="sm" />
        <ShareSlot launch={launch} ticker={false} />
      </div>
      <p className="mt-2 text-text-2 num" data-card-secondary>
        <span className="text-text">{fmtSol(a.totalDeposits)}</span> deposited <span aria-hidden="true">·</span> {fmtBids(a.bidCount)}
      </p>
    </article>
  );
}

/*
  A launch that has stopped taking bids. the founder, 2026-10-06: no status pills
  at all; a coin that cleared shows its image, its ticker as the lead line
  (larger and bolder; the founder, 2026-10-07, the name under it in the second
  tone), the contract address with a copy button, the market cap now (the
  pool's own price, read from the chain), the 24-hour volume (market.ts: off
  mainnet the server's sum of the pool's own swaps, in SOL, polled so a swap
  shows within about a minute; on mainnet Dexscreener's dollars) and the
  premarket raise (float_value, what the winning bids
  paid), and a tap goes straight to its trading view. A launch
  that did not clear has no coin: its card says why in plain words and shows
  what was bid against what it needed, and leads to the launch page, where
  the refunds are. Every figure from the launch account, its record or its
  pool.
*/
function ClosedCard({ launch, index, market, facts }: { launch: Launch; index: number; market: Market; facts?: BoardFacts }) {
  /* The record came with the board's one batched read. Per-card reads were refused (429) on public devnet, leaving cards empty. */
  const record = launch.record;
  const a = launch.account;
  const nowSec = useNowSec(1000);
  /* 0.22: past the recovery deadline a launch that never reached its pool refunds everyone. */
  const expired = nowSec != null && recoverable(a, nowSec);
  const refunding = expired || endedWithoutSale(launch);
  const complete = a.state === "finalized" && !launch.recordExists;
  if (refunding) {
    const reason = expired ? "Missed its deadline, refunds open" : a.state === "failed" ? `Under ${fmtSol(a.floorValue)}, refunding` : complete ? "Refunded" : a.state === "aborted" ? "Aborted, refunding" : "Refunding";
    return (
      <article className="panel card-navy card card-quiet p-4 md:p-5 relative min-w-0 reveal" style={{ "--i": index + 1 } as React.CSSProperties}>
        <CardLink href={`/launch/${launch.id}`} label={`${launch.token.name} refunds`} />
        <div className="flex items-center gap-3">
          <TokenAvatar launch={launch} size={44} />
          <div className="min-w-0 flex-1">
            <p className="display text-[1.25rem] font-bold leading-tight wrap-any">{launch.token.symbol}</p>
            {launch.token.name.trim().toLowerCase() !== launch.token.symbol.trim().toLowerCase() && <p className="text-text-2 leading-tight mt-0.5 wrap-any">{launch.token.name}</p>}
          </div>
        </div>
        <CardFacts launch={launch} facts={facts} />
        <p className="text-text-3 mt-3 leading-snug" data-card-reason>
          {reason}
        </p>
        <dl className="mt-2 flex flex-col gap-1">
          <Row label="Bid" value={fmtSol(a.totalDeposits)} />
          <Row label="Needed" value={fmtSol(a.floorValue)} />
        </dl>
      </article>
    );
  }
  const pool = record?.pool ?? null;
  const mcap = market.mcaps?.get(launch.id);
  const vol = volumeText(pool ? market.volumes.get(pool) : undefined);
  /* 24o (the founder's approved mock and his anchor, 2026-10-26): the age since trading opened, from the pool account the board already read (market.ts tradingSince). Not known yet, or not to be trusted: no age, never another time in its place. */
  const since = mcap?.tradingSince ?? null;
  const age = since !== null && nowSec != null ? fmtCardAge(since, nowSec) : null;
  return (
    <article className="panel card p-4 md:p-5 relative min-w-0 reveal" style={{ "--i": index + 1 } as React.CSSProperties}>
      {/* v0.30: a launch still paying out leads to its launch page, never to trading. */}
      {tradingOpen(launch, pool) ? <CardLink href={`/launch/${launch.id}/trade`} label={`Trade ${launch.token.name}`} /> : <CardLink href={`/launch/${launch.id}`} label={`${launch.token.name} auction`} />}
      {age && (
        <span className="absolute right-4 top-4 md:right-5 md:top-5 leading-6 num text-text-3 pointer-events-none" data-card-age={since}>
          {age}
        </span>
      )}
      <div className={`flex flex-wrap items-center gap-3 ${age ? "pr-10" : ""}`}>
        <TokenAvatar launch={launch} size={44} />
        <div className="min-w-0 flex-1 basis-32">
          <p className="display text-[1.25rem] font-bold leading-tight wrap-any">{launch.token.symbol}</p>
          {launch.token.name.trim().toLowerCase() !== launch.token.symbol.trim().toLowerCase() && <p className="text-text-2 leading-tight mt-0.5 wrap-any">{launch.token.name}</p>}
        </div>
        {/* The contract address, truncated, with its copy button; the slot shows "Copy link" instead until the pool is open. */}
        <ShareSlot launch={launch} ticker={false} className="basis-full sm:basis-auto" />
      </div>
      <CardFacts launch={launch} facts={facts} />
      {/* Three figures as rows: a card is about 300 px wide on a phone and in a three-column grid on a desktop, too narrow for three columns of labels. */}
      <dl className="mt-3 flex flex-col gap-1">
        <Row
          label="Market cap"
          primary
          value={
            <span data-card-mcap={mcap?.mcapLamports?.toString() ?? ""}>
              {!pool ? <Muted>no pool yet</Muted> : mcap === undefined ? <Muted>…</Muted> : mcap.mcapLamports === null ? <Muted>unreadable</Muted> : <Cap lamports={mcap.mcapLamports} rate={market.rate} status={market.status} about={false} compact />}
            </span>
          }
        />
        <Row label="Volume 24h" value={vol.muted ? <Muted>{vol.text}</Muted> : vol.text} />
        {/* 24o (the founder's approved mock): the configured auction length beside Raised, from the launch account; never close minus open. */}
        <Row
          label={
            <span>
              Raised <span className="text-text-3 num whitespace-nowrap" data-card-window>· {fmtWindowMin(a.windowSecs)}</span>
            </span>
          }
          value={record ? fmtSol(record.floatValue) : <Muted>…</Muted>}
        />
      </dl>
      {/* the founder, 2026-10-07: the way to the trading page is said, not only implied by the tap. The whole card is the link; this is its label. */}
      {pool && (
        <p className="mt-3 flex justify-end">
          <span className="chip pointer-events-none" aria-hidden="true" data-card-cta>
            Trade {launch.token.symbol}
          </span>
        </p>
      )}
    </article>
  );
}

/*
  S2 (2026-10-20): who launched it and, past one, how many launches that
  creator has on the board; and a ticker that other launches on the board
  also use. Figures from the board's own list.
*/
function CardFacts({ launch, facts }: { launch: Launch; facts?: BoardFacts }) {
  const f = cardFacts(facts, launch, { nowSec: facts?.nowSec ?? null, hidden: facts?.hidden });
  /* P-T1 (the founder, 2026-10-27): the same words as the launch page's notice. */
  const others = (n: number) => `${n} other ${n === 1 ? "launch" : "launches"} used this ticker and failed.`;
  const repeat = f.sameTicker > 0 ? others(f.sameTicker) : null;
  return (
    <>
      <p className="mt-2 text-text-3 leading-snug" data-card-creator>
        by <span className="num">{shortAddr(launch.account.creator, 4, 4)}</span>
        {f.creatorLaunches > 1 && <> · {f.creatorLaunches} launches</>}
      </p>
      {repeat && (
        <p className="mt-1 text-text-2 leading-snug" data-card-repeat>
          {repeat}
        </p>
      )}
    </>
  );
}

function Row({ label, value, primary = false }: { label: React.ReactNode; value: React.ReactNode; primary?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3 min-w-0">
      <dt className="text-text-3 shrink-0">{label}</dt>
      <dd className={`figure text-right min-w-0 whitespace-nowrap ${primary ? "text-[1.5rem] text-text" : "text-[1rem] text-text-2"}`}>{value}</dd>
    </div>
  );
}

/* A state word where a figure would go, in the body face, not the figure face. */
function Muted({ children }: { children: React.ReactNode }) {
  return <span className="text-text-3 font-sans text-[1rem]">{children}</span>;
}

