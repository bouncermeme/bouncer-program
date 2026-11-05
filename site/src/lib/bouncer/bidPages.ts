/*
  The bid list in pages (2026-10-20, the adversarial pass's S4, docs/
  ADVERSARIAL-GRIEFING-2026-10-20.md 8a): /api/launch/<id>/bids answered
  every Bid account in one body, about 520 bytes a bid, so past about 8,600
  bids the body passed Vercel's 4.5 MB response limit and the launch page's
  book stopped loading. Now the route answers BID_PAGE bids at a time in
  address order, with the address to continue after; the browser reads the
  pages one after another and joins them.

  Address order holds across reads: a page asked for after an address
  starts there whatever was read before, so two instances that read the
  chain a moment apart hand out pages that neither skip nor repeat a bid
  that existed in both reads (one that closed between them is simply
  missing, as from any later read).
*/

/* 4,000 bids is about 2.1 MB of JSON, under half the limit. */
export const BID_PAGE = 4_000;
/* A million bids at most: past that the reader stops rather than loop. */
export const MAX_BID_PAGES = 250;

export interface BidPage<T> {
  items: T[];
  next: string | null;
  total: number;
}

/* One page of the list, in address order, after `after` (exclusive). */
export function pageOf<T extends { address: string }>(list: readonly T[], after: string | null, size: number = BID_PAGE): BidPage<T> {
  const sorted = [...list].sort((x, y) => (x.address < y.address ? -1 : x.address > y.address ? 1 : 0));
  const from = after === null ? 0 : sorted.findIndex((b) => b.address > after);
  const start = from < 0 ? sorted.length : from;
  const items = sorted.slice(start, start + size);
  const next = start + size < sorted.length ? items[items.length - 1].address : null;
  return { items, next, total: sorted.length };
}

/* Every page from the first, in order; `read(after)` fetches one. A page that does not move past its cursor ends the read rather than loop. */
export async function readAllPages<T extends { address: string }>(read: (after: string | null) => Promise<{ items: T[]; next: string | null }>): Promise<T[]> {
  const out: T[] = [];
  let after: string | null = null;
  for (let i = 0; i < MAX_BID_PAGES; i++) {
    const page: { items: T[]; next: string | null } = await read(after);
    out.push(...page.items);
    if (page.next === null || page.next === after) return out;
    after = page.next;
  }
  throw new Error(`The bid list is longer than ${MAX_BID_PAGES} pages.`);
}
