//! Window rules, the floor and the opportunistic close.
//!
//! Decided on 2026-09-24: the window is fixed. The creator picks a
//! length between 5 and 60 minutes (default 30) and the book closes when it
//! ends. There is no early close on deposits and no separate hard maximum.
//! Bids are sealed to the first beacon round shortly after the window ends
//! (see `beacon.rs`), which is why the close moment must be known at genesis.
//!
//! Everything else in `WindowParams` is a protocol parameter copied from the
//! config at genesis, never a creator input and never a constant: the floor
//! value the grid hangs off (which is also the least a launch can raise) and
//! the minimum bid.
//!
//! There is no raise cap and no limit of any kind on deposits (decided
//! 2026-09-24: nothing is limited). Deposits are never refused
//! for size and nothing about deposits closes the book. The history: a deposit
//! gate that refused bids past a cap let one bidder shut everyone out for the
//! floor value (removed in v12); a cap as a ceiling on proceeds at settlement
//! let a whale take the float at the cap price against a diluted book and
//! resell to the refunded demand (removed in v15). What bounds a whale now is
//! the price his own deposit sets: see `clearing.rs`.
//!
//! Opportunistic close: the bid instruction itself checks
//! whether the auction is closeable. If it already is, the transaction closes
//! the auction instead of taking the deposit. If it is not, the bid is taken
//! and the check runs again with the new total. A busy auction therefore never
//! needs a bot to close it.
//!
//! Cold auction fallback: any transaction after the window closes it, and the
//! operator's cranker calls close one minute after the window ends if nothing
//! else has. `cold_close_due_ts` is that cranker deadline. Nothing downstream
//! depends on the close having been called: reveal checks the window itself.
//!
//! Floor at close: if total deposits are below the floor when the window
//! ends, the launch fails right there (see `below_floor`) and never touches
//! the beacon or decryption. The same threshold is applied again at
//! settlement against revealed deposits (`clearing.rs`).

use crate::error::Error;

/// Shortest window the creator may pick: 5 minutes.
pub const MIN_WINDOW_SECS: i64 = 5 * 60;
/// v0.31: the approval grace under the shortest window at landing. `create_launch` takes an absolute close time;
/// the window it lands with is the close less the landing slot's clock, and a wallet approval that took up to this
/// long past the client's own build lands a window this much under `MIN_WINDOW_SECS` without being refused.
pub const LANDING_GRACE_SECS: i64 = 60;
/// v0.31: the shortest window `create_launch` accepts at landing (240 s).
pub const MIN_WINDOW_AT_LANDING_SECS: i64 = MIN_WINDOW_SECS - LANDING_GRACE_SECS;
/// Longest window the creator may pick: 60 minutes.
pub const MAX_WINDOW_SECS: i64 = 60 * 60;
/// Default window: 30 minutes.
pub const DEFAULT_WINDOW_SECS: i64 = 30 * 60;
/// Cranker policy: close a cold auction this long after the window ends if no
/// transaction has done it already.
pub const COLD_CLOSE_GRACE_SECS: i64 = 60;

/// Immutable launch parameters, fixed at genesis. Only `open_ts` and
/// `window_secs` come from the creator; the rest is copied from the config.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WindowParams {
    /// Unix timestamp the auction opened (genesis transaction).
    pub open_ts: i64,
    /// Window length in seconds, 300..=3600. The creator's one number.
    pub window_secs: i64,
    /// Lamport value of the whole float at tick 0, and the least a launch can
    /// raise: below it the launch fails and refunds. One number, two roles.
    pub floor_value: u64,
    /// Smallest deposit accepted.
    pub min_bid: u64,
}

/// Why an auction is closeable now.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CloseReason {
    /// The window ended. The only reason: nothing about deposits closes the book.
    WindowElapsed,
}

/// Why a bid is refused. The deposit is never taken for a refused bid.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RejectReason {
    /// Transaction timestamp is before the open timestamp.
    NotOpenYet,
    /// Deposit below the minimum bid.
    BelowMinimum,
}

/// What the bid instruction should do for an arriving bid.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BidOutcome {
    /// Take the deposit. If `closes_after` is set, close in the same transaction.
    Accepted {
        /// Set when this bid made the auction closeable.
        closes_after: Option<CloseReason>,
    },
    /// The auction was already closeable. Close it, take nothing, succeed.
    ClosedInstead(CloseReason),
    /// Refuse the bid, take nothing, fail the transaction with this reason.
    Rejected(RejectReason),
}

impl WindowParams {
    /// Check the parameters against the decided bounds (the window the client may choose, `MIN_WINDOW_SECS` to
    /// `MAX_WINDOW_SECS`).
    pub fn validate(&self) -> Result<(), Error> {
        self.validate_with_min_window(MIN_WINDOW_SECS)
    }

    /// v0.31: the check `create_launch` runs at landing, where the window is the creator's absolute close less the
    /// landing clock: `MIN_WINDOW_AT_LANDING_SECS` is the floor (the approval grace), the ceiling unchanged.
    pub fn validate_at_landing(&self) -> Result<(), Error> {
        self.validate_with_min_window(MIN_WINDOW_AT_LANDING_SECS)
    }

    fn validate_with_min_window(&self, min_window_secs: i64) -> Result<(), Error> {
        if !(min_window_secs..=MAX_WINDOW_SECS).contains(&self.window_secs) {
            return Err(Error::InvalidWindow);
        }
        crate::grid::validate_floor_value(self.floor_value)?;
        if self.min_bid == 0 || self.min_bid > self.floor_value {
            // A minimum bid above the least a launch can raise would make a
            // single bid at the floor impossible.
            return Err(Error::InvalidConfig);
        }
        self.open_ts.checked_add(self.window_secs).ok_or(Error::Overflow)?;
        Ok(())
    }

    /// Timestamp the window ends. Bids are accepted strictly before it.
    pub fn close_ts(&self) -> i64 {
        self.open_ts + self.window_secs
    }

    /// When the operator's cranker must have closed a cold auction.
    pub fn cold_close_due_ts(&self) -> i64 {
        self.close_ts() + COLD_CLOSE_GRACE_SECS
    }

    /// True when the launch cannot cover the float at the floor even if every
    /// bid opens. The program checks this at close and fails the launch on the spot.
    pub fn below_floor(&self, total_deposits: u128) -> bool {
        total_deposits < self.floor_value as u128
    }
}

/// Is the auction closeable at `now` with `total_deposits` in the vault?
pub fn close_reason(p: &WindowParams, now: i64, total_deposits: u128) -> Option<CloseReason> {
    let _ = total_deposits; // deposits never close the book
    if now >= p.close_ts() {
        return Some(CloseReason::WindowElapsed);
    }
    None
}

/// Decide what the bid instruction does for a bid of `deposit` arriving at `now`.
///
/// `total_deposits` is the vault total before this bid.
pub fn process_bid(p: &WindowParams, now: i64, total_deposits: u128, deposit: u64) -> BidOutcome {
    if let Some(reason) = close_reason(p, now, total_deposits) {
        return BidOutcome::ClosedInstead(reason);
    }
    if now < p.open_ts {
        return BidOutcome::Rejected(RejectReason::NotOpenYet);
    }
    if deposit < p.min_bid {
        return BidOutcome::Rejected(RejectReason::BelowMinimum);
    }
    // Any size above the minimum is taken: nothing bounds deposits. The book
    // closes only when the window ends.
    let new_total = total_deposits + deposit as u128;
    BidOutcome::Accepted { closes_after: close_reason(p, now, new_total) }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SOL: u64 = 1_000_000_000;

    /// The decided protocol parameters with a 30 minute window.
    fn params() -> WindowParams {
        WindowParams {
            open_ts: 1_790_000_000,
            window_secs: DEFAULT_WINDOW_SECS,
            floor_value: 5 * SOL,
            min_bid: SOL / 50, // 0.02 SOL
        }
    }

    #[test]
    fn validate_accepts_defaults_and_rejects_bad_windows() {
        let p = params();
        assert_eq!(p.validate(), Ok(()));
        assert_eq!(WindowParams { window_secs: MIN_WINDOW_SECS - 1, ..p }.validate(), Err(Error::InvalidWindow));
        assert_eq!(WindowParams { window_secs: MAX_WINDOW_SECS + 1, ..p }.validate(), Err(Error::InvalidWindow));
        assert_eq!(WindowParams { window_secs: MIN_WINDOW_SECS, ..p }.validate(), Ok(()));
        assert_eq!(WindowParams { window_secs: MAX_WINDOW_SECS, ..p }.validate(), Ok(()));
    }

    #[test]
    fn validate_rejects_inconsistent_protocol_parameters() {
        let p = params();
        assert_eq!(WindowParams { min_bid: 0, ..p }.validate(), Err(Error::InvalidConfig));
        assert_eq!(WindowParams { min_bid: 501 * SOL, ..p }.validate(), Err(Error::InvalidConfig));
        assert_eq!(WindowParams { floor_value: 1, ..p }.validate(), Err(Error::FloorValueOutOfRange));
        // The minimum bid may equal the floor (one bid at the floor clears) but not exceed it.
        assert_eq!(WindowParams { min_bid: 5 * SOL, ..p }.validate(), Ok(()));
        assert_eq!(WindowParams { min_bid: 5 * SOL + 1, ..p }.validate(), Err(Error::InvalidConfig));
    }

    #[test]
    fn timeline_constants() {
        let p = params();
        assert_eq!(p.close_ts(), p.open_ts + 1800);
        assert_eq!(p.cold_close_due_ts(), p.open_ts + 1860);
    }

    #[test]
    fn nothing_closes_before_the_window_ends_whatever_the_deposits() {
        let p = params();
        assert_eq!(close_reason(&p, p.open_ts + 60, 50 * SOL as u128), None);
        assert_eq!(close_reason(&p, p.close_ts() - 1, 500 * SOL as u128), None);
        assert_eq!(close_reason(&p, p.close_ts() - 1, 5_000 * SOL as u128), None);
        assert_eq!(close_reason(&p, p.close_ts() - 1, u64::MAX as u128), None);
    }

    #[test]
    fn window_end_closes_regardless_of_deposits() {
        let p = params();
        assert_eq!(close_reason(&p, p.close_ts(), 0), Some(CloseReason::WindowElapsed));
        assert_eq!(close_reason(&p, p.close_ts() + 86_400, 0), Some(CloseReason::WindowElapsed));
        assert_eq!(close_reason(&p, p.close_ts(), 500 * SOL as u128), Some(CloseReason::WindowElapsed));
    }

    #[test]
    fn arriving_bid_closes_an_ended_window_without_taking_the_deposit() {
        let p = params();
        assert_eq!(process_bid(&p, p.close_ts(), 3 * SOL as u128, SOL), BidOutcome::ClosedInstead(CloseReason::WindowElapsed));
        assert_eq!(process_bid(&p, p.close_ts() + 5, 3 * SOL as u128, SOL), BidOutcome::ClosedInstead(CloseReason::WindowElapsed));
    }

    #[test]
    fn last_second_bid_is_accepted_and_does_not_close() {
        let p = params();
        assert_eq!(process_bid(&p, p.close_ts() - 1, 3 * SOL as u128, SOL), BidOutcome::Accepted { closes_after: None });
    }

    #[test]
    fn large_deposits_are_accepted_and_nothing_closes() {
        // Nothing bounds deposits: not a cap, not the floor, not the total.
        let p = params();
        let t = p.open_ts + 60;
        assert_eq!(process_bid(&p, t, 495 * SOL as u128, 5 * SOL), BidOutcome::Accepted { closes_after: None });
        assert_eq!(process_bid(&p, t, 495 * SOL as u128, 5 * SOL + 1), BidOutcome::Accepted { closes_after: None });
        assert_eq!(process_bid(&p, t, 500 * SOL as u128, SOL), BidOutcome::Accepted { closes_after: None });
        assert_eq!(process_bid(&p, t, 500 * SOL as u128, 5_000 * SOL), BidOutcome::Accepted { closes_after: None });
        assert_eq!(close_reason(&p, t, 5_500 * SOL as u128), None);
    }

    #[test]
    fn below_minimum_and_before_open_are_refused() {
        let p = params();
        assert_eq!(process_bid(&p, p.open_ts + 1, 0, p.min_bid - 1), BidOutcome::Rejected(RejectReason::BelowMinimum));
        assert_eq!(process_bid(&p, p.open_ts + 1, 0, p.min_bid), BidOutcome::Accepted { closes_after: None });
        assert_eq!(process_bid(&p, p.open_ts - 1, 0, SOL), BidOutcome::Rejected(RejectReason::NotOpenYet));
    }

    #[test]
    fn floor_at_close_is_a_plain_threshold_on_total_deposits() {
        let p = params();
        assert!(p.below_floor(0));
        assert!(p.below_floor(5 * SOL as u128 - 1));
        assert!(!p.below_floor(5 * SOL as u128));
        assert!(!p.below_floor(500 * SOL as u128));
    }

    #[test]
    fn cold_auction_walkthrough() {
        // A slow launch: bids trickle in for the whole window, nothing closes early.
        let p = params();
        let mut total: u128 = 0;
        for minute in [1, 10, 20, 29] {
            let t = p.open_ts + minute * 60;
            match process_bid(&p, t, total, SOL) {
                BidOutcome::Accepted { closes_after: None } => total += SOL as u128,
                other => panic!("minute {minute}: {other:?}"),
            }
        }
        assert_eq!(total, 4 * SOL as u128);
        // At 30 minutes the next transaction closes it, and the cranker's deadline is one minute later.
        assert_eq!(process_bid(&p, p.close_ts(), total, SOL), BidOutcome::ClosedInstead(CloseReason::WindowElapsed));
        assert_eq!(p.cold_close_due_ts(), p.close_ts() + 60);
        // Four SOL is under the five SOL floor: the launch fails at close, every
        // deposit is refundable, and the beacon is never needed.
        assert!(p.below_floor(total));
    }

    #[test]
    fn hot_auction_walkthrough() {
        // A hot launch: deposits blow past the floor value in
        // the first minute and the book still stays open until the window ends, so
        // nobody is shut out and the clearing price is free to rise.
        let p = params();
        let mut total: u128 = 0;
        for (minute, dep) in [(1, 100 * SOL), (2, 100 * SOL), (5, 100 * SOL), (15, 100 * SOL), (29, 50 * SOL)] {
            let t = p.open_ts + minute * 60;
            match process_bid(&p, t, total, dep) {
                BidOutcome::Accepted { closes_after: None } => total += dep as u128,
                other => panic!("minute {minute}: {other:?}"),
            }
        }
        assert_eq!(total, 450 * SOL as u128);
        assert_eq!(close_reason(&p, p.close_ts() - 1, total), None);
        assert_eq!(close_reason(&p, p.close_ts(), total), Some(CloseReason::WindowElapsed));
        assert!(!p.below_floor(total));
    }
}
