/*
  24o (F4, step 1): how old a live snapshot was when it left the server, for the launch page's measured run. Server-Timing
  carries two entries and no data: `snap;dur=<ms>` is the time since the server read the chain for this answer, and
  `pc;desc=hit|miss` says whether the 1 s process cache (snapshot.ts once()) answered it, i.e. the read began before
  this request did. A CDN copy carries the header it was stored with; its own Age header gives the time since then.

  The bid list's held copy (snapshot.ts readBids) is restamped at each read, so for /bids `snap` is the age of the
  answer, not of the scan; the list's slot beside launchSlot in the body says which launch read it was built on.
*/
export function snapshotTiming(readAt: number, startedAt: number, now: number = Date.now()): string {
  const age = Math.max(0, Math.round(now - readAt));
  return `snap;dur=${age}, pc;desc=${readAt < startedAt ? "hit" : "miss"}`;
}
