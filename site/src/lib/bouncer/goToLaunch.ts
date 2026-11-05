/*
  After a create confirms, the page goes to the new launch, always (2026-10-25: the founder, Phantom's in-app browser on an
  iPhone, stayed on /create after signing; on refresh the launch was live). The client router is asked first; if the
  page has not left `from` within FALLBACK_MS, the browser loads the launch page itself. 24g (the founder's pick A,
  2026-10-25, review/2026-10-25-founder-issues/redirect-line-mock): at that same moment `stuck` runs, and the create page
  shows "Your launch is live. Open it" under its button, for a browser that ignores both.

  2026-10-29 (the founder's RFOR in Phantom's in-app browser): the browser loads the launch page itself, first. After a
  router push the page showed the new launch while Phantom's address bar still showed the page before it (R2's trade
  page), and the page cannot see that bar: window.location had moved. A page load moves both. The router is asked only
  if the load throws, or when the page is still on `from` at FALLBACK_MS.
*/
export const FALLBACK_MS = 3_000;

export interface Nav {
  push: (href: string) => void;
  path: () => string;
  assign: (href: string) => void;
  later: (fn: () => void, ms: number) => unknown;
}

export function goToLaunch(nav: Nav, href: string, from: string, stuck: () => void = () => {}): void {
  const push = () => {
    try {
      nav.push(href);
    } catch {}
  };
  try {
    nav.assign(href);
  } catch {
    push();
  }
  nav.later(() => {
    if (nav.path() !== from) return;
    push();
    stuck();
  }, FALLBACK_MS);
}

/* A read that may help the next page but must never hold this one up: settles within ms, a failure or a timeout is null. */
export function within<T>(p: Promise<T>, ms: number, later: (fn: () => void, ms: number) => unknown = setTimeout): Promise<T | null> {
  return new Promise((resolve) => {
    later(() => resolve(null), ms);
    p.then(resolve, () => resolve(null));
  });
}
