"use client";

/*
  The quick guide (the founder, 2026-10-22): the three steps, as a dialog. It opens by
  itself once, on the first visit (remembered in localStorage under
  QUICK_GUIDE_KEY, listed on /cookies), and again from the (i) button in the bottom
  corner of every page. The words are in src/content/quickGuide.ts.

  Accessible: a native <dialog> opened with showModal(), so focus moves into it, the
  page behind is inert, Escape closes it and focus returns to what opened it. The
  (i) button is a real button with a name, 44 px for a thumb. Storage is read and
  written inside try/catch: without it the guide opens on each visit and still
  closes. Nothing opens by itself on the legal pages or the review packet, where
  the reader came to read something else. Hidden until mounted, so nothing flashes.
*/
import Link from "next/link";
import { usePathname } from "next/navigation";
import { isBid } from "@/components/shell/AppHeader";
import { useEffect, useRef, useSyncExternalStore } from "react";
import { QUICK_GUIDE } from "@/content/quickGuide";
import { QUICK_GUIDE_KEY } from "./storageNoticeKey";

const subscribe = () => () => {};
function seenInStorage(): boolean {
  try {
    return window.localStorage.getItem(QUICK_GUIDE_KEY) === "1";
  } catch {
    return false;
  }
}
const mounted = () => true;
/* Pages where the guide never opens by itself (the (i) button still works there). */
const QUIET = ["/terms", "/privacy", "/cookies", "/risk", "/review"];

export function QuickGuide() {
  const isClient = useSyncExternalStore(subscribe, mounted, () => false);
  const seen = useSyncExternalStore(subscribe, seenInStorage, () => true);
  const pathname = usePathname() || "/";
  const dialog = useRef<HTMLDialogElement>(null);
  /* Opened by itself at most once a page load. */
  const autoDone = useRef(false);

  const remember = () => {
    try {
      window.localStorage.setItem(QUICK_GUIDE_KEY, "1");
    } catch {
      /* no storage: it opens again on the next visit */
    }
  };
  const show = () => {
    const d = dialog.current;
    if (d && !d.open) {
      d.showModal();
      /* Focus on "Got it", not the guide link (the browser would take the first control). */
      d.querySelector<HTMLButtonElement>("[data-quick-guide-close]")?.focus();
    }
  };

  useEffect(() => {
    const open = () => show();
    window.addEventListener("bouncer:quick-guide", open);
    return () => window.removeEventListener("bouncer:quick-guide", open);
  }, []);

  useEffect(() => {
    if (!isClient || autoDone.current || seen || QUIET.some((p) => pathname === p || pathname.startsWith(`${p}/`))) return;
    autoDone.current = true;
    show();
  }, [isClient, seen, pathname]);

  if (!isClient) return null;
  return (
    <>
      <button type="button" onClick={show} aria-haspopup="dialog" aria-label={QUICK_GUIDE.open} title={QUICK_GUIDE.open} className={`corner-control quick-guide-button fixed right-4 z-40 h-10 w-10 rounded-full border-2 border-accent bg-accent text-accent-ink shadow-lg place-items-center ${isBid(pathname) ? "hidden" : "grid"}`} data-quick-guide-button>
        <span aria-hidden="true" className="font-semibold text-[1.0625rem] leading-none" style={{ fontFamily: "Georgia, serif", fontStyle: "italic" }}>
          i
        </span>
      </button>
      <dialog ref={dialog} onClose={remember} aria-labelledby="quick-guide-title" className="quick-guide m-auto w-[min(34rem,calc(100vw-2rem))] max-h-[calc(100dvh-2rem)] overflow-y-auto rounded-[12px] border border-line bg-bg text-text p-0" data-quick-guide>
        <QuickGuideBody onClose={() => dialog.current?.close()} />
      </dialog>
    </>
  );
}

/* The guide's content, server-renderable (the check scripts render it): the title, the three steps, the link and the close button. */
export function QuickGuideBody({ onClose }: { onClose?: () => void }) {
  return (
    <div className="px-5 py-5">
      <h2 id="quick-guide-title" className="display text-[1.5rem] leading-tight text-text">
        {QUICK_GUIDE.title}
      </h2>
      <ol className="mt-4 grid gap-3">
        {QUICK_GUIDE.steps.map(([title, body], i) => (
          <li key={title} className="rounded-[8px] border border-line bg-panel px-4 py-3 grid grid-cols-[2rem_1fr] gap-2 items-start">
            <span className="display text-[1.5rem] leading-none text-brand-text" aria-hidden="true">
              {i + 1}
            </span>
            <div className="min-w-0">
              <h3 className="text-text font-semibold text-base">{title}</h3>
              <p className="text-text-2 text-base leading-snug mt-1">{body}</p>
            </div>
          </li>
        ))}
      </ol>
      <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
        <Link href="/guide" className="link-accent inline-flex items-center min-h-11" onClick={onClose}>
          {QUICK_GUIDE.guideLink}
        </Link>
        <button type="button" className="btn btn-primary min-h-11 px-5" onClick={onClose} data-quick-guide-close>
          {QUICK_GUIDE.close}
        </button>
      </div>
    </div>
  );
}
