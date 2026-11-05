/*
  What a shared link to a launch says about it, read on the server when a
  page's metadata or its share card is built: the name and ticker, one
  status line (the close time while open, "Cleared at N SOL" once
  settled), and Deposited. Read through the same chain client the pages
  use, against the same RPC; nothing here is remembered. A read that
  fails or takes longer than a few seconds gives null, and the caller
  falls back to words with no figures and no address.

  The close time is a clock time, not "N minutes left": a preview is
  cached by whatever app shows it, and a countdown frozen into an image
  would go on claiming time that has run out.
*/
import { cache } from "react";
import { chainClient } from "@/lib/bouncer/chain/chainClient";
import { fmtSol } from "@/lib/bouncer/format";
import { bookOpen, closeAtTs, hasRecord } from "@/lib/bouncer/view";
import { tradingOpen } from "@/lib/bouncer/v030";
import { ownUrl } from "@/lib/bouncer/ownStore";

/* The only picture a share card shows: the site's own store's (ownStore.ts). */
const PICTURE_PATH = /^\/api\/token\/[0-9a-f]{32}$/;

export interface ShareFacts {
  name: string;
  symbol: string;
  mint: string;
  image: string | null;
  /* One line: "Closes 14:32 UTC", "Cleared at 39.95 SOL", "Below floor, all SOL returned". */
  status: string;
  deposited: string;
  /* The pool is open and the mint exists: the coin's URL lands on trading (app/launch/[id]/page.tsx). */
  tradable: boolean;
}

const TIMEOUT_MS = 4000;
type Late = { readonly late: true };
const LATE: Late = { late: true };

function within<T>(p: Promise<T>): Promise<T | Late> {
  const timer = new Promise<Late>((r) => setTimeout(() => r(LATE), TIMEOUT_MS));
  return Promise.race<T | Late>([p, timer]).catch((): Late => LATE);
}

function isLate(x: unknown): x is Late {
  return x === LATE;
}

function utcTime(sec: number): string {
  const d = new Date(sec * 1000);
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")} UTC`;
}

/* The facts, "missing" when the RPC answered that no launch is at this address, or null when it could not be read in time. */
async function readShareOnce(id: string): Promise<ShareFacts | "missing" | null> {
  const launch = await within(chainClient.getLaunch(id));
  if (isLate(launch)) return null;
  if (!launch) return "missing";
  if (!launch.readable) return null;
  const a = launch.account;
  const nowSec = Math.floor(Date.now() / 1000);
  let status: string;
  if (bookOpen(a, nowSec)) status = `Closes ${utcTime(closeAtTs(a))}`;
  else if (a.state === "finalized" && !launch.recordExists) status = "Ended, all SOL returned";
  /* No market cap on the share card, in either unit: it is a home card shared on its own, and pick 4 (dollar caps on cards) is held. */
  else if (hasRecord(a.state)) status = "Cleared";
  else if (a.state === "failed") status = `Didn't reach ${fmtSol(a.floorValue)}, all SOL returned`;
  else if (a.state === "aborted") status = "Aborted, all SOL returned";
  else status = "Closed, bids opening";
  const img = launch.token.image ?? null;
  return {
    name: launch.token.name,
    symbol: launch.token.symbol,
    mint: launch.token.mint,
    /* The site's own picture only (ownStore.ts, S3), made absolute for the card renderer. */
    image: img && PICTURE_PATH.test(img) ? ownUrl(img) : null,
    status,
    deposited: fmtSol(a.totalDeposits),
    /* v0.30: the redirect to trading waits for the open (v030.ts). */
    tradable: tradingOpen(launch, launch.record?.pool),
  };
}

/* One read per request: a page and its generateMetadata share it (React cache), so the redirect check on /launch/<id> costs no second read. */
export const readShare = cache(readShareOnce);
