/*
  Rehearsal item 5 (the founder's iPhone, Phantom's in-app browser, 2026-10-28): tapping Disconnect left the wallet menu open
  and the wallet connected. The menu closed only after the wallet's own disconnect returned, and Phantom's in-app
  provider never returned it; the adapter's in-progress flag then turned every later tap into a no-op.

  The page now closes the menu first and gives the wallet this long to disconnect. Past that, it forgets the wallet
  itself (the adapter's select(null): the saved wallet name and the adapter go, so the page shows Connect, and the
  next visit does not connect it again on its own).
*/
export const DISCONNECT_WAIT_MS = 3_000;

/* The wallet's own disconnect, or `forget` once it has taken `ms` (or failed). Answers how it ended. */
export async function disconnectWithin(disconnect: () => Promise<void>, forget: () => void, ms: number = DISCONNECT_WAIT_MS): Promise<"wallet" | "forgot"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<"late">((resolve) => {
    timer = setTimeout(() => resolve("late"), ms);
  });
  const done = disconnect().then(
    () => "done" as const,
    () => "failed" as const,
  );
  const first = await Promise.race([done, late]);
  clearTimeout(timer);
  if (first === "done") return "wallet";
  forget();
  return "forgot";
}
