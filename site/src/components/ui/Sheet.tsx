"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), iframe, [tabindex]:not([tabindex="-1"])';

/* What Tab can reach inside the dialog, in order; hidden elements (display none, the handle) left out. */
function focusables(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => el.getClientRects().length > 0);
}

/*
  Bottom sheet on phones, centered dialog on wider screens. Astra's frontend
  review of 2026-10-21, F1: while open, keyboard focus stays inside (focus
  moves in on open, Tab and Shift+Tab wrap) and returns to whatever opened
  it on close. Focus inside something else, such as a wallet's own modal
  injected beside this one, is left alone.

  Rendered into document.body (2026-10-29, the founder's phone test: the wallet
  menu opened half off screen and would not close). The header's
  backdrop-blur makes it the containing block of every position: fixed
  element inside it, so a sheet opened from the header's wallet pill was
  placed against the header's box, not the screen, and its scrim covered
  only the header. The server, with no document, renders it in place.
*/
export function Sheet({
  open,
  onClose,
  title,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title?: string;
  children: ReactNode;
}) {
  const box = useRef<HTMLDivElement>(null);
  /* Every caller passes a fresh closure; kept in a ref so a redraw does not re-run the open effect (which would take focus back to the first control). */
  const close = useRef(onClose);
  useEffect(() => {
    close.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (!open) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const root = box.current;
    if (root) (focusables(root)[0] ?? root).focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        close.current();
        return;
      }
      if (e.key !== "Tab" || !root) return;
      const at = document.activeElement;
      if (at && at !== document.body && at !== opener && !root.contains(at)) return;
      const list = focusables(root);
      if (list.length === 0) {
        e.preventDefault();
        root.focus();
        return;
      }
      const first = list[0];
      const last = list[list.length - 1];
      if (e.shiftKey && (at === first || at === root || !root.contains(at))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (at === last || !root.contains(at))) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener("keydown", onKey);
      if (opener && opener.isConnected) opener.focus();
    };
  }, [open]);

  if (!open) return null;

  const dialog = (
    <>
      <div className="sheet-backdrop" onClick={onClose} aria-hidden="true" />
      <div ref={box} className="sheet" role="dialog" aria-modal="true" aria-label={title} tabIndex={-1}>
        <div className="sheet-handle" />
        {title && (
          <div className="flex items-center justify-between mb-3">
            <h2 className="display text-[1.5rem]">{title}</h2>
            <button
              type="button"
              onClick={onClose}
              className="w-10 h-10 rounded-[10px] flex items-center justify-center text-text-2 hover:bg-panel-2 hover:text-text"
              aria-label="Close"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <path d="M6 6l12 12M18 6L6 18" />
              </svg>
            </button>
          </div>
        )}
        {children}
      </div>
    </>
  );
  return typeof document === "undefined" ? dialog : createPortal(dialog, document.body);
}
