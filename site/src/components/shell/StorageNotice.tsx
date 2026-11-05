"use client";

/*
  The storage notice (launch candidate, 2026-10-22): a small card in the bottom-left
  corner (the founder, 2026-10-22: it sat too high on the phone, mid-screen; now it never
  blocks content, leaves the bottom-right corner to the quick guide's (i) button
  and sits above a page's sticky Bid bar) saying what the site keeps in the
  browser, a link to /cookies and a close button. No consent wall: the site sets no tracking or advertising storage (the
  /cookies page lists every item), so there is nothing to opt into; the line informs.
  Closing it is remembered in localStorage under STORAGE_NOTICE_KEY, read and written
  inside try/catch: without storage the notice shows on each visit and still closes.
  Hidden until mounted, so a server render and a returning visitor never flash it.
*/
import Link from "next/link";
import { useState, useSyncExternalStore } from "react";
import { STORAGE_NOTICE_KEY } from "./storageNoticeKey";

/* localStorage as an external store (as QuickAmounts does): seen on the client, "seen" on the server so nothing flashes. */
const subscribe = () => () => {};
function seenInStorage(): boolean {
  try {
    return window.localStorage.getItem(STORAGE_NOTICE_KEY) === "1";
  } catch {
    return false;
  }
}

export function StorageNotice() {
  const seen = useSyncExternalStore(subscribe, seenInStorage, () => true);
  const [closed, setClosed] = useState(false);
  if (seen || closed) return null;
  const close = () => {
    setClosed(true);
    try {
      window.localStorage.setItem(STORAGE_NOTICE_KEY, "1");
    } catch {
      /* no storage: closed for this visit */
    }
  };
  /* The bottom-left corner, narrower than the screen less the (i) button's corner; above a sticky Bid bar (globals.css .corner-control). */
  return (
    <div className="corner-control storage-card fixed left-4 z-40 w-[min(21rem,calc(100vw-6rem))] rounded-[8px] border border-line bg-panel pl-3 pr-1 py-1 flex items-center gap-2 shadow-lg" role="region" aria-label="Storage notice" data-storage-notice>
      <p className="text-base text-text-2 leading-snug py-1">
        No tracking.{" "}
        <Link href="/cookies" className="link">
          What we store
        </Link>
      </p>
      <button type="button" onClick={close} aria-label="Close the storage notice" className="btn btn-secondary min-h-11 min-w-11 px-3 shrink-0">
        OK
      </button>
    </div>
  );
}
