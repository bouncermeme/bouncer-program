//! drand quicknet round arithmetic.
//!
//! Round `r` is published at `genesis + (r - 1) * period`. The launch stores the
//! round its bids are sealed to; the cranker fetches that round's signature once
//! it exists and submits it with each reveal. Nothing here is cryptographic.
//!
//! Constants were read from the live chain info endpoint on 2026-09-23:
//! `https://api.drand.sh/v2/chains/<chain hash>/info`.

use crate::error::Error;

/// quicknet chain hash (hex), used to select the chain on every relay.
pub const QUICKNET_CHAIN_HASH: &str = "52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971";
/// quicknet genesis time, unix seconds.
pub const QUICKNET_GENESIS: i64 = 1_692_803_367;
/// quicknet period, seconds between rounds.
pub const QUICKNET_PERIOD: i64 = 3;
/// Seconds added after the bid deadline before the reveal round, to cover
/// cluster clock drift against wall clock. The book closes on the cluster
/// clock and quicknet publishes on wall clock: if the cluster clock runs
/// behind by more than this margin, the round's signature is public while
/// bids are still accepted, and the last bidder sees every bid. Devnet was
/// measured 2 to 3 s ahead of wall clock on 2026-09-24; mainnet's clock has
/// run tens of seconds behind at times. 30 s until 2026-09-24 (adversarial
/// pass, finding 8); 120 s now, a decision to widen further.
///
/// In plain words (2026-10-27): drand publishes each round's key at a fixed
/// wall-clock second; the launch closes on the cluster's clock, a stake-weighted
/// median of validator-reported times clamped to within 25% of what the slot
/// count predicts since the epoch start. When slots run slow the cluster clock
/// falls behind the world. If it is behind by more than this margin, the key is
/// public while bids are still accepted and the last bidder can open every bid.
/// A cluster clock ahead of the world only makes everyone wait longer. Mainnet
/// ran about 30 minutes behind for 11 days in May 2022 (slots at about 746 ms),
/// which no fixed margin covers: the keeper measures the lag every tick and
/// pages at a third of the live margin; nothing blocks creation on lag (decided
/// 2026-10-27). The margin is only reduced on recorded evidence. Sources and
/// the evidence bar: the reveal margin design note.
/// v0.31 (2026-10-28): 15, the value a fresh config starts at (mainnet opens at 15); 120 until v0.30, 60 on
/// devnet's config since 2026-10-28. The Config value is what a launch reads; this is only the starting point.
pub const REVEAL_MARGIN_SECS: i64 = 15;

/// Latest round published at or before `ts`. Round 1 is published at genesis.
pub fn round_at(ts: i64) -> Result<u64, Error> {
    if ts < QUICKNET_GENESIS {
        return Err(Error::BeforeGenesis);
    }
    Ok(((ts - QUICKNET_GENESIS) / QUICKNET_PERIOD) as u64 + 1)
}

/// Unix timestamp round `round` is (or was) published at.
pub fn publish_time(round: u64) -> i64 {
    QUICKNET_GENESIS + (round as i64 - 1) * QUICKNET_PERIOD
}

/// The round bids are sealed to for a launch whose last bid is accepted strictly
/// before `bid_deadline_ts`: the first round published after the deadline plus
/// the margin.
pub fn reveal_round_for(bid_deadline_ts: i64) -> Result<u64, Error> {
    reveal_round_for_margin(bid_deadline_ts, REVEAL_MARGIN_SECS)
}

/// v0.30 (2026-10-27): as `reveal_round_for`, with the margin the launch's config holds at genesis
/// (`Config.reveal_margin_secs`, Squad-adjustable within the program's hard bounds; `REVEAL_MARGIN_SECS` above is
/// the starting value and what every build before 0.30 used).
pub fn reveal_round_for_margin(bid_deadline_ts: i64, margin_secs: i64) -> Result<u64, Error> {
    let safe_ts = bid_deadline_ts.checked_add(margin_secs).ok_or(Error::Overflow)?;
    Ok(round_at(safe_ts)? + 1)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_live_observation() {
        // Observed 2026-09-23: unix 1790218044, api.drand.sh latest round 32471560.
        assert_eq!(round_at(1_790_218_044).unwrap(), 32_471_560);
    }

    #[test]
    fn genesis_is_round_one() {
        assert_eq!(round_at(QUICKNET_GENESIS).unwrap(), 1);
        assert_eq!(round_at(QUICKNET_GENESIS + 2).unwrap(), 1);
        assert_eq!(round_at(QUICKNET_GENESIS + 3).unwrap(), 2);
        assert_eq!(round_at(QUICKNET_GENESIS - 1), Err(Error::BeforeGenesis));
        assert_eq!(publish_time(1), QUICKNET_GENESIS);
    }

    #[test]
    fn round_at_and_publish_time_are_consistent() {
        for ts in [QUICKNET_GENESIS, 1_700_000_000, 1_790_218_044, 1_800_000_001] {
            let r = round_at(ts).unwrap();
            assert!(publish_time(r) <= ts);
            assert!(publish_time(r + 1) > ts);
        }
    }

    #[test]
    fn reveal_round_is_strictly_after_deadline_plus_margin() {
        let deadline = 1_790_218_044;
        let r = reveal_round_for(deadline).unwrap();
        assert!(publish_time(r) > deadline + REVEAL_MARGIN_SECS);
        assert!(publish_time(r) <= deadline + REVEAL_MARGIN_SECS + QUICKNET_PERIOD);
        // A 30 minute window from a known open: reveal lands margin + 1 to margin + 3 s after close (120 to 123
        // until v0.30, 16 to 18 at the v0.31 default of 15).
        let open = 1_790_000_000;
        let close = open + 1800;
        let r = reveal_round_for(close).unwrap();
        let wait = publish_time(r) - close;
        assert!((REVEAL_MARGIN_SECS + 1..=REVEAL_MARGIN_SECS + 3).contains(&wait), "wait {wait}");
    }

    #[test]
    fn the_margin_argument_moves_the_round() {
        let close = 1_790_000_000 + 1800;
        assert_eq!(reveal_round_for_margin(close, REVEAL_MARGIN_SECS).unwrap(), reveal_round_for(close).unwrap());
        for m in [5, 15, 60, 90, 300] {
            let r = reveal_round_for_margin(close, m).unwrap();
            let wait = publish_time(r) - close;
            assert!((m + 1..=m + 3).contains(&wait), "margin {m}: wait {wait}");
        }
    }
}
