/*
  The creator's own bid, as the program labels it (the founder, 2026-10-20): set
  apart from every other label wherever bids show. Shown only from the
  program's fields: Bid.flags bit 1 (set by commit when the signer is the
  launch's creator), Launch.creator_has_bid (set by that same commit, never
  cleared) with the bid's address, BidCommitted's creator flag, or the
  settlement record's creator_bid_state. Never by comparing a bidder with
  the creator.
*/
export function CreatorBidPill({ className = "ml-2" }: { className?: string }) {
  return (
    <span className={`pill pill-creator ${className}`} data-creator-bid>
      Creator&apos;s bid
    </span>
  );
}
