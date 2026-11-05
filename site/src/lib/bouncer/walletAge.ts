/*
  A wallet's age, for the creator panel on a launch page (the founder, 2026-10-20):
  the time of its first transaction, as far back as this RPC's history
  reaches. getSignaturesForAddress pages from the newest signature
  backwards, 1,000 at a time; a page shorter than that is the end of the
  history and its last entry is the first transaction. A wallet busier than
  AGE_MAX_PAGES pages is not walked to its start: the answer then says the
  wallet is at least as old as the oldest signature read (complete false).

  One reader for both sides: the server's route (server/walletAge.ts, which
  caches it per creator) and the client when there is no site route (the
  local board).
*/

export const AGE_PAGE = 1_000;
export const AGE_MAX_PAGES = 3;

export interface WalletAge {
  address: string;
  /* Unix seconds of the oldest transaction read; null when the wallet has none, or none of the oldest page carried a time. */
  firstTs: number | null;
  /* True when the history ended within the pages read, so firstTs is the wallet's first transaction (as this RPC serves it). */
  complete: boolean;
  /* Signatures read. */
  transactions: number;
}

export type SignaturePage = (before: string | undefined) => Promise<readonly { signature: string; blockTime?: number | null }[]>;

export async function readWalletAge(address: string, page: SignaturePage, maxPages: number = AGE_MAX_PAGES): Promise<WalletAge> {
  let before: string | undefined;
  let transactions = 0;
  let firstTs: number | null = null;
  for (let p = 0; p < maxPages; p++) {
    const list = await page(before);
    transactions += list.length;
    /* The oldest entry with a time: a signature's blockTime can be missing on an old ledger. */
    for (let i = list.length - 1; i >= 0; i--) {
      const t = list[i].blockTime;
      if (typeof t === "number" && t > 0) {
        firstTs = t;
        break;
      }
    }
    if (list.length < AGE_PAGE) return { address, firstTs, complete: true, transactions };
    before = list[list.length - 1].signature;
  }
  return { address, firstTs, complete: false, transactions };
}
