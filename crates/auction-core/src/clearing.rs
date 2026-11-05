//! Clearing price and fills.
//!
//! Decided on 2026-09-24: the floor and the minimum raise are one
//! number, and there is no partial clear. Either deposits at some tick cover
//! the whole float at that tick, and the launch clears there sold out, or they
//! do not cover it even at the floor, and the launch fails with every deposit
//! refunded in full. One path through settlement, the most safety critical
//! code in the program.
//!
//! Also decided on 2026-09-24, the README's fill rule: the lowest
//! priced bidders are filled last. Bids clearly above the clearing price fill
//! in full; only the bids at the margin are rationed pro rata among
//! themselves; everyone pays the one clearing price. Under the earlier pro
//! rata by deposit rule a whale bidding the floor was rationed exactly like an
//! aggressive bidder, so bidding low cost him nothing, which reopened the gap
//! the product exists to close.
//!
//! The input is the reveal histogram (deposits summed per tick), not the bid
//! list. The program keeps that histogram in the launch account and adds each
//! bid to it as the bid is decrypted, so settlement never iterates over bids.
//! Fills are then computed per bid from the clearing result, O(1) each.
//!
//! Rules, with `F` the float:
//! - The clearing tick `k*` is the highest tick where deposits at or above it
//!   are at least the value of the whole float at that tick. If no tick
//!   qualifies, not even tick 0 (the floor), the launch fails. `V` is the
//!   float's value at `k*`: the one price everyone pays.
//! - Bids are filled from the highest tick down until the float is gone. The
//!   marginal tick `m` is the lowest tick still needed: the lowest tick at or
//!   above `k*` whose strictly higher deposits `A` are under `V`. Usually
//!   `m == k*`; it is higher only when the bids above `k*` alone already cover
//!   `V` (they cannot cover the next tick's value, or `k*` would be higher).
//! - A bid above `m` fills in full at the clearing price:
//!   `tokens = floor(deposit * F / V)`, `cost = deposit`, no refund.
//! - Bids at `m` share what is left pro rata. With `T` the deposits at `m` and
//!   `R = F - ceil(A * F / V)` the remaining float (the full fills' aggregate
//!   rounds up, so the margin never receives the fractional atom the full fills
//!   left behind; that atom burns):
//!   `tokens = floor(deposit * R / T)`, `cost = ceil(deposit * (V - A) / T)`,
//!   `refund = deposit - cost`.
//! - A bid below `m` receives nothing and is refunded in full. That includes a
//!   bid at or above `k*` but below `m`: it bid the clearing price, and the
//!   bidders above it took the whole float first.
//!
//! The raise is exactly `V` lamports, known at settlement from the histogram
//! alone. Since 0.28 the pool does not receive all of it: `create_pool` pays the
//! raise fee out of `V` (1% on mainnet, 60% to the creator and 40% to Bouncer)
//! and pairs the rest with the reserve half of the supply, so the pool opens
//! about 1% under the clearing price (a fee part whose destination cannot take
//! it stays in the pool). The roundings make paying out `V` safe (each is
//! checked by the tests):
//! - `sum(tokens) <= F`, so fills never exceed the float; the unsold atoms,
//!   fewer than one per filled bid, burn at finalize.
//! - `sum(cost) >= V`, because full fills pay their whole deposit and each
//!   marginal cost rounds up its exact share of `V - A`, so after `V` leaves
//!   for the pool and the fee the vault always holds every refund. The excess, at most one
//!   lamport per marginal bidder, is dust swept at finalize.
//! - `cost <= deposit`, because `A < V` and `V - A <= T`, so no refund is ever
//!   negative.
//! - `cost * F >= tokens * V`, so every filled bid pays at least the clearing price.

use crate::error::Error;
use crate::grid::{validate_floor_value, value_at_tick, MAX_TICK, TICK_COUNT};

/// Result of clearing one auction. Everything a fill needs, nothing else.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Clearing {
    /// Clearing tick `k*`. Sets the price everyone pays.
    pub tick: u16,
    /// Marginal tick `m`, at least `tick`. Bids above it fill in full, bids at
    /// it are rationed, bids below it get nothing.
    pub marginal_tick: u16,
    /// Lamport value of the whole float at `k*`. The clearing price is
    /// `float_value / float`. This is exactly what the pool receives.
    pub float_value: u128,
    /// Sum of deposits at or above `k*`. At least `float_value`. Informational.
    pub winning_deposits: u128,
    /// Sum of deposits strictly above `m`. Under `float_value`. These fill in full.
    pub above_deposits: u128,
    /// Sum of deposits at `m`. Together with `above_deposits` at least `float_value`.
    pub at_deposits: u128,
    /// Float in token atoms, carried so `fill` cannot be called with a different one.
    pub float: u64,
}

/// What one bid receives.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Fill {
    /// Token atoms delivered to the bidder.
    pub tokens: u64,
    /// Lamports kept from the deposit.
    pub cost: u64,
    /// Lamports returned to the bidder. Always `deposit - cost`.
    pub refund: u64,
}

/// Outcome of settlement once every bid is decrypted or marked invalid.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Settlement {
    /// Revealed deposits do not cover the float at the floor. No pool, no
    /// tokens leave the vault, every deposit is refunded in full, all tokens burn.
    Failed {
        /// Sum of every revealed deposit, for the event and the page.
        revealed_deposits: u128,
    },
    /// The launch clears, sold out. Fills follow from the clearing.
    Cleared(Clearing),
}

/// Clear the histogram.
///
/// `deposits_at_tick[k]` is the sum of deposits of revealed bids at tick `k`.
/// Bids that did not open are not in the histogram and do not win.
///
/// There is no raise cap (decided 2026-09-24: no cap of any kind).
/// The price is bounded only by the grid: 2,407 ticks since 0.29 (0.25 percent
/// steps to the band edge, 1 percent above; 1,024 one-percent ticks until 0.28),
/// the top pinned at 131,745 SOL for the float at the 5 SOL floor. A whale who
/// wants the whole float pays the highest tick the book covers, and when his
/// deposit dominates the book that is the tick his own deposit reaches: a 5,000
/// SOL any price bid alone clears at tick 2,076 and pays 4,987.59 SOL (tick 694
/// and 4,988.88 SOL on the 0.28 grid). The cap (v11 to v14) let the same bid
/// take the float at 495.96 SOL against a diluted book and resell it to the
/// refunded demand; the adversarial pass's findings 1 and 2 die with it.
/// Deposits are never refused for size.
///
/// The program applies the same threshold earlier, at `close`, against total
/// deposits (`WindowParams::below_floor`): a launch that cannot cover the
/// floor even if every bid opens fails on the spot and never touches the
/// beacon or decryption. This is the settle time check, needed because invalid
/// bids leave the histogram.
/// Clear the launch from its histogram of lamport sums (the Histogram account, 0.29: one `u64` per tick, exact to
/// the lamport; full-size counters since the decision of 2026-10-20, no unit and no cap, since every deposit on
/// the chain summed is under 2^63 lamports).
pub fn settle(counts: &[u64; TICK_COUNT], floor_value: u64, float: u64) -> Result<Settlement, Error> {
    settle_by(|k| counts[k] as u128, floor_value, float)
}

/// Clear the launch from a histogram of lamport totals (the 0.28 layout; kept for the tests and the harness books).
pub fn settle_lamports(deposits_at_tick: &[u64; TICK_COUNT], floor_value: u64, float: u64) -> Result<Settlement, Error> {
    settle_by(|k| deposits_at_tick[k] as u128, floor_value, float)
}

fn settle_by(deposits_at: impl Fn(usize) -> u128, floor_value: u64, float: u64) -> Result<Settlement, Error> {
    validate_floor_value(floor_value)?;
    if float == 0 {
        return Err(Error::ZeroFloat);
    }
    let mut cum: u128 = 0;
    for k in (0..TICK_COUNT).rev() {
        cum = cum
            .checked_add(deposits_at(k))
            .ok_or(Error::Overflow)?;
        let v = value_at_tick(floor_value, k as u16)?;
        if cum < v {
            // The book must cover the tick's value.
            continue;
        }
        // k is the clearing tick.
        // Walk up from k* until the deposits strictly above the candidate
        // no longer cover V on their own. Terminates: above the top tick
        // there is nothing, and V is at least one lamport.
        let mut m = k;
        let mut above = cum - deposits_at(k);
        while above >= v {
            m += 1;
            above -= deposits_at(m);
        }
        return Ok(Settlement::Cleared(Clearing {
            tick: k as u16,
            marginal_tick: m as u16,
            float_value: v,
            winning_deposits: cum,
            above_deposits: above,
            at_deposits: deposits_at(m),
            float,
        }));
    }
    Ok(Settlement::Failed { revealed_deposits: cum })
}

/// Compute one bid's fill from the clearing result.
///
/// Precondition: the bid's deposit was included in the histogram that produced
/// `clearing`. The program guarantees this by only distributing to revealed bids.
pub fn fill(deposit: u64, tick: u16, clearing: &Clearing) -> Result<Fill, Error> {
    if tick > MAX_TICK {
        return Err(Error::TickOutOfRange);
    }
    let v = clearing.float_value;
    let a = clearing.above_deposits;
    let t = clearing.at_deposits;
    if v == 0
        || a >= v
        || clearing.marginal_tick < clearing.tick
        || a.checked_add(t).ok_or(Error::Overflow)? < v
        || clearing.winning_deposits < v
    {
        // Cannot happen for a clearing produced by `settle`; guard anyway.
        return Err(Error::Overflow);
    }
    if tick < clearing.marginal_tick {
        return Ok(Fill { tokens: 0, cost: 0, refund: deposit });
    }
    let float = clearing.float as u128;
    if tick > clearing.marginal_tick {
        // Full fill at the clearing price.
        let tokens_wide = (deposit as u128).checked_mul(float).ok_or(Error::Overflow)? / v;
        let tokens = u64::try_from(tokens_wide).map_err(|_| Error::Overflow)?;
        return Ok(Fill { tokens, cost: deposit, refund: 0 });
    }
    // At the margin: share what the full fills left.
    let taken = ceil_div(a.checked_mul(float).ok_or(Error::Overflow)?, v)?;
    let remaining = float.checked_sub(taken).ok_or(Error::Overflow)?;
    let tokens_wide = (deposit as u128).checked_mul(remaining).ok_or(Error::Overflow)? / t;
    let cost_wide = ceil_div((deposit as u128).checked_mul(v - a).ok_or(Error::Overflow)?, t)?;
    let tokens = u64::try_from(tokens_wide).map_err(|_| Error::Overflow)?;
    let cost = u64::try_from(cost_wide).map_err(|_| Error::Overflow)?;
    let refund = deposit.checked_sub(cost).ok_or(Error::Overflow)?;
    Ok(Fill { tokens, cost, refund })
}

fn ceil_div(numerator: u128, denominator: u128) -> Result<u128, Error> {
    if denominator == 0 {
        return Err(Error::Overflow);
    }
    let q = numerator / denominator;
    if numerator % denominator == 0 {
        Ok(q)
    } else {
        q.checked_add(1).ok_or(Error::Overflow)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::grid::{MAX_FLOOR_VALUE, MIN_FLOOR_VALUE};
    use crate::supply;
    use proptest::prelude::*;

    const SOL: u64 = 1_000_000_000;
    /// The protocol float: 500 million whole tokens.
    const FLOAT: u64 = supply::FLOAT;
    /// The decided floor: the float is worth 5 SOL at tick 0, and 5 SOL is the
    /// least a launch can raise.
    const FLOOR: u64 = 5 * SOL;
    /// The whitepaper's floor (10 SOL), used by the worked examples whose
    /// expected ticks were computed for it. The floor is a config parameter,
    /// so both are valid inputs.
    const WP_FLOOR: u64 = 10 * SOL;
    /// Decided minimum bid.
    const MIN_BID: u64 = 20_000_000;

    fn histogram(bids: &[(u16, u64)]) -> [u64; TICK_COUNT] {
        let mut hist = [0u64; TICK_COUNT];
        for &(t, d) in bids {
            hist[t as usize] = hist[t as usize].checked_add(d).expect("histogram overflow in test");
        }
        hist
    }

    /// Settle the book and, if it cleared, fill every bid and check every
    /// invariant. Returns the fills in input order alongside the outcome.
    fn run(bids: &[(u16, u64)], floor_value: u64, float: u64) -> (Settlement, Vec<Fill>) {
        let hist = histogram(bids);
        let outcome = settle_lamports(&hist, floor_value, float).expect("settle");
        match outcome {
            Settlement::Failed { revealed_deposits } => {
                let total: u128 = bids.iter().map(|(_, d)| *d as u128).sum();
                assert_eq!(revealed_deposits, total);
                assert!(total < floor_value as u128, "failed with {total} >= floor {floor_value}");
                (outcome, Vec::new())
            }
            Settlement::Cleared(c) => {
                let fills: Vec<Fill> = bids.iter().map(|&(t, d)| fill(d, t, &c).expect("fill")).collect();
                check_invariants(bids, &hist, floor_value, float, &c, &fills);
                (outcome, fills)
            }
        }
    }

    /// Like `run` but the book must clear.
    fn clear(bids: &[(u16, u64)], floor_value: u64, float: u64) -> (Clearing, Vec<Fill>) {
        match run(bids, floor_value, float) {
            (Settlement::Cleared(c), fills) => (c, fills),
            (other, _) => panic!("expected a clearing, got {other:?}"),
        }
    }

    fn check_invariants(
        bids: &[(u16, u64)],
        hist: &[u64; TICK_COUNT],
        floor_value: u64,
        float: u64,
        c: &Clearing,
        fills: &[Fill],
    ) {
        let total_tokens: u128 = fills.iter().map(|f| f.tokens as u128).sum();
        let total_cost: u128 = fills.iter().map(|f| f.cost as u128).sum();
        let sum_from = |lo: usize| -> u128 { (lo..TICK_COUNT).map(|k| hist[k] as u128).sum() };
        let m = c.marginal_tick as usize;
        let filled = bids.iter().filter(|(t, _)| *t >= c.marginal_tick).count() as u128;
        let marginal = bids.iter().filter(|(t, _)| *t == c.marginal_tick).count() as u128;
        let filled_deposits: u128 = bids.iter().filter(|(t, _)| *t >= c.marginal_tick).map(|(_, d)| *d as u128).sum();

        // 1. Sold out by definition, and the clearing recorded correctly.
        assert_eq!(c.winning_deposits, sum_from(c.tick as usize));
        assert!(c.winning_deposits >= c.float_value, "cleared without covering the float");
        assert_eq!(c.float_value, value_at_tick(floor_value, c.tick).unwrap());
        // 2. The margin: at or above k*, the deposits above it do not cover V on
        //    their own, the deposits at and above it do, and it is the lowest such tick.
        assert!(c.marginal_tick >= c.tick);
        assert_eq!(c.above_deposits, sum_from(m + 1));
        assert_eq!(c.at_deposits, hist[m] as u128);
        assert!(c.above_deposits < c.float_value, "above deposits cover V alone");
        assert!(c.above_deposits + c.at_deposits >= c.float_value, "margin does not cover V");
        if m > c.tick as usize {
            assert!(sum_from(m) >= c.float_value, "marginal tick {m} is not the lowest needed");
        }
        // 3. Fills never exceed the float, and rounding loses less than one atom per filled bid.
        assert!(total_tokens <= float as u128, "overfill: {total_tokens} > {float}");
        assert!(total_tokens + filled >= float as u128, "sold out but {total_tokens} + {filled} < {float}");
        // 4. Per bid: cost never exceeds deposit, refund is the exact remainder,
        //    bids below the margin get everything back, bids above it fill in
        //    full, and every filled bid pays at least the clearing price.
        for (&(t, d), f) in bids.iter().zip(fills) {
            assert!(f.cost <= d, "cost {} > deposit {d}", f.cost);
            assert_eq!(f.cost as u128 + f.refund as u128, d as u128, "cost + refund != deposit");
            if t < c.marginal_tick {
                assert_eq!(f.tokens, 0, "bid below the margin got tokens");
                assert_eq!(f.refund, d, "bid below the margin not fully refunded");
            } else {
                assert!(f.cost as u128 * float as u128 >= f.tokens as u128 * c.float_value, "filled bid paid under the clearing price");
                if t > c.marginal_tick {
                    assert_eq!(f.cost, d, "bid above the margin was not filled in full");
                    assert_eq!(f.tokens as u128, d as u128 * float as u128 / c.float_value);
                }
            }
            assert!(f.tokens as u128 <= float as u128);
        }
        // 5. Clearing tick is maximal: the next tick up would not sell out.
        if c.tick < MAX_TICK {
            let v_above = value_at_tick(floor_value, c.tick + 1).unwrap();
            assert!(sum_from(c.tick as usize + 1) < v_above, "tick {} is not maximal", c.tick);
        }
        // 6. The vault stays solvent after V goes to the pool: costs sum to at
        //    least V, and the dust above V is under one lamport per marginal bidder.
        assert!(total_cost >= c.float_value, "costs {total_cost} below the float value {}", c.float_value);
        assert!(total_cost <= c.float_value + marginal, "costs above V + marginal bidders");
        assert!(total_cost <= filled_deposits);
    }

    #[test]
    fn empty_book_fails() {
        let hist = [0u64; TICK_COUNT];
        assert_eq!(settle_lamports(&hist, FLOOR, FLOAT).unwrap(), Settlement::Failed { revealed_deposits: 0 });
    }

    #[test]
    fn below_the_floor_fails_and_reports_the_deposits() {
        // 4.999999999 SOL across three ticks against a 5 SOL floor. Ticks do not
        // matter: nothing covers the float anywhere, so everyone is refunded.
        let bids = [(300, 2 * SOL), (0, 2 * SOL), (50, SOL - 1)];
        let (outcome, fills) = run(&bids, FLOOR, FLOAT);
        assert_eq!(outcome, Settlement::Failed { revealed_deposits: 5 * SOL as u128 - 1 });
        assert!(fills.is_empty());
    }

    #[test]
    fn single_bid_below_the_floor_fails() {
        // One 4 SOL bid at tick 200 against a 10 SOL floor. It would have bought
        // 40 percent of the float under the old partial clear; now it fails.
        let (outcome, _) = run(&[(200, 4 * SOL)], WP_FLOOR, FLOAT);
        assert_eq!(outcome, Settlement::Failed { revealed_deposits: 4 * SOL as u128 });
    }

    #[test]
    fn everyone_at_the_same_tick_below_the_floor_fails() {
        let bids = [(7, SOL), (7, 2 * SOL), (7, 3 * SOL)];
        let (outcome, _) = run(&bids, WP_FLOOR, FLOAT);
        assert_eq!(outcome, Settlement::Failed { revealed_deposits: 6 * SOL as u128 });
    }

    #[test]
    fn exactly_the_floor_sells_out_at_tick_zero() {
        // 3 SOL at tick 400 and 2 SOL at tick 0 against the 5 SOL floor. Tick 400
        // needs 265 SOL, ticks 1 and up need more than the 3 SOL above them, so
        // it clears at tick 0. The 3 SOL above the margin fills in full (300
        // million tokens), the 2 SOL at the margin takes the remaining 200
        // million, everyone pays in full, nothing is refunded.
        let bids = [(400, 3 * SOL), (0, 2 * SOL)];
        let (c, fills) = clear(&bids, FLOOR, FLOAT);
        assert_eq!(c.tick, 0);
        assert_eq!(c.marginal_tick, 0);
        assert_eq!(c.float_value, 5 * SOL as u128);
        assert_eq!(c.winning_deposits, 5 * SOL as u128);
        assert_eq!(c.above_deposits, 3 * SOL as u128);
        assert_eq!(c.at_deposits, 2 * SOL as u128);
        assert_eq!(fills[0].tokens, 300_000_000_000_000);
        assert_eq!(fills[1].tokens, 200_000_000_000_000);
        assert_eq!(fills[0].cost, 3 * SOL);
        assert_eq!(fills[1].cost, 2 * SOL);
        assert_eq!(fills[0].refund + fills[1].refund, 0);
        // The pool opens with 5 SOL and the 500 million token reserve: a 10 SOL market cap.
        assert_eq!(fills[0].tokens + fills[1].tokens, FLOAT);
    }

    #[test]
    fn one_lamport_under_the_floor_fails_and_at_the_floor_clears() {
        let (outcome, _) = run(&[(511, FLOOR - 1)], FLOOR, FLOAT);
        assert_eq!(outcome, Settlement::Failed { revealed_deposits: FLOOR as u128 - 1 });
        let (c, fills) = clear(&[(511, FLOOR)], FLOOR, FLOAT);
        assert_eq!(c.tick, 0);
        assert_eq!(c.marginal_tick, 511);
        assert_eq!(fills[0].tokens, FLOAT);
        assert_eq!(fills[0].cost, FLOOR);
        assert_eq!(fills[0].refund, 0);
    }

    #[test]
    fn single_bid_covering_the_float_takes_it_all_at_the_highest_tick_it_covers() {
        // 25 SOL bid at tick 1200 against a 10 SOL floor. It covers the float at every tick whose value is
        // <= 25 SOL. 1.0025^366 = 2.4939, 1.0025^367 = 2.5002, so the highest such tick is 366. Alone, it covers
        // the float at tick 366 by itself, so the margin walks up to its own tick, 1200, where it is the only bid:
        // it gets the whole float and pays exactly the float value at tick 366.
        let (c, fills) = clear(&[(1200, 25 * SOL)], WP_FLOOR, FLOAT);
        assert_eq!(c.tick, 366);
        assert_eq!(c.marginal_tick, 1200);
        let v366 = value_at_tick(WP_FLOOR, 366).unwrap();
        assert_eq!(v366, 24_939_259_428);
        assert_eq!(c.float_value, v366);
        assert_eq!(fills[0].tokens, FLOAT);
        assert_eq!(fills[0].cost as u128, v366);
        assert_eq!(fills[0].refund as u128, 25 * SOL as u128 - v366);
    }

    #[test]
    fn bid_exactly_equal_to_float_value_clears_at_that_tick_with_zero_refund() {
        let v50 = value_at_tick(WP_FLOOR, 50).unwrap() as u64;
        let (c, fills) = clear(&[(50, v50)], WP_FLOOR, FLOAT);
        assert_eq!(c.tick, 50);
        assert_eq!(fills[0].tokens, FLOAT);
        assert_eq!(fills[0].cost, v50);
        assert_eq!(fills[0].refund, 0);
    }

    #[test]
    fn everyone_at_the_same_tick_oversubscribed_splits_pro_rata() {
        // Three bids at tick 10 totalling 30 SOL. Float value at tick 10 is
        // 10 * 1.01^10 = 11.046 SOL, so it is oversubscribed 2.7x at that tick.
        // Everyone sits at the margin, so everyone is rationed pro rata.
        let bids = [(10, 5 * SOL), (10, 10 * SOL), (10, 15 * SOL)];
        let (c, fills) = clear(&bids, WP_FLOOR, FLOAT);
        assert_eq!(c.tick, 10);
        assert_eq!(c.marginal_tick, 10);
        assert_eq!(c.above_deposits, 0);
        let w = 30 * SOL as u128;
        for (&(_, d), f) in bids.iter().zip(&fills) {
            assert_eq!(f.tokens as u128, d as u128 * FLOAT as u128 / w);
            assert!(f.refund > 0);
        }
        // Shares are exactly proportional: 1/6, 2/6, 3/6 of the float.
        assert_eq!(fills[0].tokens, FLOAT / 6);
        assert_eq!(fills[1].tokens, FLOAT / 3);
        assert_eq!(fills[2].tokens, FLOAT / 2);
        let sold: u64 = fills.iter().map(|f| f.tokens).sum();
        assert!(sold <= FLOAT && sold >= FLOAT - 3);
    }

    #[test]
    fn everyone_at_the_same_tick_but_short_of_it_clears_lower_and_all_win() {
        // Three bids at tick 400 totalling 15 SOL. Tick 400 needs 27.15 SOL, so the clearing tick drops to the
        // highest tick 15 SOL covers: 1.0025^162 = 1.4985, 1.0025^163 = 1.5023, so tick 162. The three bids alone
        // cover the float at tick 162, so the margin walks up to tick 400, where they share it.
        let bids = [(400, 5 * SOL), (400, 5 * SOL), (400, 5 * SOL)];
        let (c, fills) = clear(&bids, WP_FLOOR, FLOAT);
        assert_eq!(c.tick, 162);
        assert_eq!(c.marginal_tick, 400);
        assert_eq!(c.above_deposits, 0);
        assert_eq!(c.at_deposits, 15 * SOL as u128);
        for f in &fills {
            assert_eq!(f.tokens, FLOAT / 3);
            assert!(f.cost < 5 * SOL);
        }
    }

    #[test]
    fn mixed_book_losers_refunded_top_bid_filled_in_full_margin_takes_the_rest() {
        // Floor 10 SOL. Bids: 20 SOL at tick 480, 8 SOL at tick 320, 6 SOL at tick 120, 1 SOL at tick 0.
        // cum at 480 = 20 < 33.1 (1.0025^480 = 3.31); cum at 320 = 28 > 22.2 (1.0025^320 = 2.223)
        // so it clears somewhere between: highest k with cum(k) >= V_k. Ticks 321..479 have cum 20,
        // 1.0025^k*10 <= 20 up to k = 277, so those fail; tick 320 has cum 28 >= 22.23. Clearing tick 320.
        // The 20 SOL above the margin does not cover 22.23 alone, so the margin is 320: the
        // 20 SOL fills in full (449.8 million tokens for 20 SOL) and the 8 SOL bid takes the
        // remaining 50.2 million tokens for the remaining 2.23 SOL, getting 5.77 SOL back.
        let bids = [(480, 20 * SOL), (320, 8 * SOL), (120, 6 * SOL), (0, SOL)];
        let (c, fills) = clear(&bids, WP_FLOOR, FLOAT);
        assert_eq!(c.tick, 320);
        assert_eq!(c.marginal_tick, 320);
        assert_eq!(c.float_value, 22_233_201_985);
        assert_eq!(c.winning_deposits, 28 * SOL as u128);
        assert_eq!(c.above_deposits, 20 * SOL as u128);
        assert_eq!(c.at_deposits, 8 * SOL as u128);
        assert_eq!(fills[0].tokens, 449_777_769_605_415);
        assert_eq!(fills[0].cost, 20 * SOL);
        assert_eq!(fills[0].refund, 0);
        assert_eq!(fills[1].tokens, 50_222_230_394_584);
        assert_eq!(fills[1].cost, 2_233_201_985);
        assert_eq!(fills[1].refund, 5_766_798_015);
        assert_eq!(fills[2].tokens, 0);
        assert_eq!(fills[2].refund, 6 * SOL);
        assert_eq!(fills[3].tokens, 0);
        assert_eq!(fills[3].refund, SOL);
        // One atom, the fraction the full fill left behind, burns at finalize.
        assert_eq!(fills[0].tokens + fills[1].tokens, FLOAT - 1);
        assert_eq!(fills[0].cost as u128 + fills[1].cost as u128, c.float_value);
    }

    #[test]
    fn whitepaper_v3_worked_example_under_the_readme_fill_rule() {
        // Whitepaper v3 section 5 and plan v3 section 6, restated in lamports
        // with a 10 SOL floor and the protocol float of 500 million tokens.
        // Floor: cap 20 (float worth 10). Group A bids 15 at cap 60 (tick 440,
        // 3.001x). Group B bids 12 at cap 40 (tick 280, 2.012x). A whale bids 30 at
        // the floor. The clearing tick and price are the whitepaper's: tick 280,
        // the float worth 20.12 SOL (20.07 on the 1% grid). The whitepaper then filled A and B pro rata
        // at 74 percent each (278 million tokens for 11.1, 222 million for 8.9).
        // The decision of 2026-09-24 applies the README rule instead: A, above
        // the margin, fills in full (372.8 million tokens for all 15 SOL) and B,
        // at the margin, takes the remaining 127.2 million tokens for the
        // remaining 5.12 SOL and gets 6.88 SOL back. The whale gets nothing but
        // his money back. Everyone still pays the tick 280 price.
        let bids = [(440, 15 * SOL), (280, 12 * SOL), (0, 30 * SOL)];
        let (c, fills) = clear(&bids, WP_FLOOR, FLOAT);
        assert_eq!(c.tick, 280);
        assert_eq!(c.marginal_tick, 280);
        assert_eq!(c.float_value, 20_119_943_731); // 20.12 SOL, the grid's nearest tick to cap 40
        assert_eq!(c.winning_deposits, 27 * SOL as u128);
        assert_eq!(c.above_deposits, 15 * SOL as u128);
        assert_eq!(c.at_deposits, 12 * SOL as u128);
        assert_eq!(fills[0].tokens, 372_764_461_982_281); // 372.76 million whole tokens
        assert_eq!(fills[0].cost, 15 * SOL);
        assert_eq!(fills[0].refund, 0);
        assert_eq!(fills[1].tokens, 127_235_538_017_718); // 127.24 million whole tokens
        assert_eq!(fills[1].cost, 5_119_943_731); // 5.12 SOL
        assert_eq!(fills[1].refund, 6_880_056_269); // 6.88 SOL
        assert_eq!(fills[2].tokens, 0);
        assert_eq!(fills[2].refund, 30 * SOL);
        // A's fill dropped 0.6 of an atom; B does not get it; it burns at finalize.
        assert_eq!(fills[0].tokens + fills[1].tokens, FLOAT - 1);
        // The pool receives exactly 20.12 SOL and the costs sum to exactly that: no lamport dust here.
        assert_eq!(fills[0].cost as u128 + fills[1].cost as u128, c.float_value);
        // Every filled bid paid at least the clearing price, and within one atom of it.
        for f in &fills[..2] {
            assert!(f.cost as u128 * FLOAT as u128 >= f.tokens as u128 * c.float_value);
            assert!(f.cost as u128 * FLOAT as u128 <= (f.tokens as u128 + 1) * c.float_value);
        }
    }

    #[test]
    fn a_whale_at_the_floor_is_filled_last() {
        // The case the rule exists for. Floor 5 SOL. One bidder puts 4 SOL at
        // tick 200 (cap 36.6 SOL); a whale puts 100 SOL at the floor. Nothing
        // above tick 0 covers the float, so the price is the floor, 5 SOL. Under
        // pro rata by deposit the whale would have taken 480.8 million of the
        // 500 million tokens for bidding the lowest possible price. Under the
        // README rule the 4 SOL bid fills in full, 400 million tokens, and the
        // whale gets the remaining 100 million for 1 SOL with 99 SOL back.
        let bids = [(200, 4 * SOL), (0, 100 * SOL)];
        let (c, fills) = clear(&bids, FLOOR, FLOAT);
        assert_eq!(c.tick, 0);
        assert_eq!(c.marginal_tick, 0);
        assert_eq!(c.float_value, 5 * SOL as u128);
        assert_eq!(fills[0].tokens, 400_000_000_000_000);
        assert_eq!(fills[0].cost, 4 * SOL);
        assert_eq!(fills[1].tokens, 100_000_000_000_000);
        assert_eq!(fills[1].cost, SOL);
        assert_eq!(fills[1].refund, 99 * SOL);
        let old_rule_whale_tokens = 100u128 * FLOAT as u128 / 104;
        assert!(old_rule_whale_tokens > 480_000_000_000_000);
    }

    #[test]
    fn bids_above_the_clearing_tick_that_cover_it_alone_push_the_margin_up() {
        // Floor 5 SOL: 5.01 SOL at tick 1 and 1 SOL at tick 0. Tick 1 needs
        // 5.0125 SOL and has 5.01, so the clearing tick is 0 and the price 5 SOL.
        // The tick 1 bid alone covers 5 SOL, so the margin is tick 1: it takes
        // the whole float for 5 SOL with 0.01 SOL back, and the tick 0 bidder,
        // who bid the clearing price, gets nothing but a full refund.
        let bids = [(1, 5 * SOL + 10_000_000), (0, SOL)];
        let (c, fills) = clear(&bids, FLOOR, FLOAT);
        assert_eq!(c.tick, 0);
        assert_eq!(c.marginal_tick, 1);
        assert_eq!(c.float_value, 5 * SOL as u128);
        assert_eq!(c.above_deposits, 0);
        assert_eq!(c.at_deposits, 5 * SOL as u128 + 10_000_000);
        assert_eq!(fills[0].tokens, FLOAT);
        assert_eq!(fills[0].cost, 5 * SOL);
        assert_eq!(fills[0].refund, 10_000_000);
        assert_eq!(fills[1].tokens, 0);
        assert_eq!(fills[1].refund, SOL);
    }

    #[test]
    fn a_lone_whale_at_the_floor_still_buys_the_float_at_the_floor() {
        // Unchanged by the cap rule and stated so nobody mistakes it: with no
        // other bid in the book, one deposit at tick 0 clears at the floor and
        // takes the whole float for 5 SOL. Only the field of bidders can stop
        // it, which is the creator's launch announcement, not the program.
        let bids = [(0, 500 * SOL)];
        let (c, fills) = clear(&bids, FLOOR, FLOAT);
        assert_eq!((c.tick, c.marginal_tick), (0, 0));
        assert_eq!(fills[0].tokens, FLOAT);
        assert_eq!(fills[0].cost, 5 * SOL);
        assert_eq!(fills[0].refund, 495 * SOL);
    }

    #[test]
    fn a_whale_at_the_floor_no_longer_shuts_the_book_and_clears_out_with_nothing() {
        // The exploit the deposit gate had: 500 SOL at tick 0 used to refuse
        // every later bid. Now it is just a deposit: 20 SOL at tick 100 prices
        // the float at 13.52 SOL, the whale sits below the margin, gets zero
        // tokens and the full 500 SOL back.
        let bids = [(0, 500 * SOL), (100, 20 * SOL)];
        let (c, fills) = clear(&bids, FLOOR, FLOAT);
        assert_eq!((c.tick, c.marginal_tick), (100, 100));
        assert_eq!(c.float_value, value_at_tick(FLOOR, 100).unwrap());
        assert_eq!(fills[0].tokens, 0);
        assert_eq!(fills[0].refund, 500 * SOL);
        assert_eq!(fills[1].tokens, FLOAT);
        assert_eq!(fills[1].cost as u128, c.float_value);
    }

    #[test]
    fn an_any_price_bid_pays_what_its_own_deposit_reaches() {
        // No cap: 5,000 SOL at the top tick alone clears at tick 2076, the highest
        // tick 5,000 SOL covers (4,987.59 SOL; tick 2077 wants 5,037.47). The whale
        // pays 4,987.59 SOL for the whole float and gets 12.41 SOL back. Under the
        // old cap the same bid paid 495.96 SOL.
        let (c, fills) = clear(&[(MAX_TICK, 5_000 * SOL)], FLOOR, FLOAT);
        assert_eq!((c.tick, c.marginal_tick), (2076, MAX_TICK));
        assert_eq!(c.float_value, 4_987_590_996_327);
        assert_eq!(fills[0].tokens, FLOAT);
        assert_eq!(fills[0].cost, 4_987_590_996_327);
        assert_eq!(fills[0].refund, 5_000 * SOL - 4_987_590_996_327);
    }

    #[test]
    fn the_deposit_race_costs_what_it_looks_like() {
        // The cap pin of the adversarial pass, replayed without the cap: 500 SOL
        // at the top tick against 20 SOL of honest bids at tick 1844 (the last 0.25% tick). The book
        // covers tick 1844 (499.54 SOL) but not 1845 (500.79), so it clears at
        // 1844; the whale above the margin takes the whole float for 499.54 SOL
        // and the honest bidders at 1844 are refunded. To take the float the
        // whale had to cover the tick above every honest bid, and he paid it.
        // Under the old cap he paid 477 SOL for 96 percent of it against the same book.
        let bids = [(MAX_TICK, 500 * SOL), (1844, 20 * SOL)];
        let (c, fills) = clear(&bids, FLOOR, FLOAT);
        assert_eq!(c.tick, 1844);
        assert_eq!(c.marginal_tick, MAX_TICK);
        assert_eq!(c.float_value, 499_538_663_066);
        assert_eq!(fills[0].tokens, FLOAT);
        assert_eq!(fills[0].cost, 499_538_663_066);
        assert_eq!(fills[1], Fill { tokens: 0, cost: 0, refund: 20 * SOL });
        // With honest bids spread higher the whale pays more: 20 SOL at tick 2076
        // (about 4,988 SOL for the float) does not change the clearing tick,
        // because 520 SOL covers tick 1844 and nothing higher, but 5,000 SOL of
        // honest demand at tick 2076 does: the book then covers tick 2076.
        let bids = [(MAX_TICK, 500 * SOL), (2076, 5_000 * SOL)];
        let (c, fills) = clear(&bids, FLOOR, FLOAT);
        assert_eq!(c.tick, 2076);
        assert!(c.float_value > 1_900 * SOL as u128);
        assert_eq!(fills[0].cost, 500 * SOL, "the whale above the margin pays his whole deposit");
    }

    #[test]
    fn the_top_of_the_grid_is_reachable_and_nothing_above_it_exists() {
        // A book that covers the top tick clears there: 131,745.38 SOL at the
        // 5 SOL floor. Everyone at the top tick shares the float pro rata.
        let top = 131_745_376_818_341u64;
        let bids = [(MAX_TICK, top / 2 + 1), (MAX_TICK, top / 2 + 1)];
        let (c, fills) = clear(&bids, FLOOR, FLOAT);
        assert_eq!((c.tick, c.marginal_tick), (MAX_TICK, MAX_TICK));
        assert_eq!(c.float_value, top as u128);
        assert_eq!(fills[0].tokens + fills[1].tokens, FLOAT);
        // Each cost is a share of the float value rounded up, so the two of
        // them overshoot the top by at most one lamport each.
        let paid = fills[0].cost as u128 + fills[1].cost as u128;
        assert!(paid >= top as u128 && paid <= top as u128 + 2, "paid {paid}");
    }

    #[test]
    fn one_atom_float_charges_winners_for_nothing_and_is_unreachable() {
        // Degenerate on purpose, with a float the protocol never uses. With a
        // float of 1 atom no marginal share reaches a whole atom, so nobody
        // receives the token, yet costs are still shares of the float value
        // (they round up so the pool is always funded). The fixed float of
        // 500 million whole tokens and the 0.02 SOL minimum bid keep this
        // unreachable: the smallest legal float is the protocol's fixed one.
        let bids = [(5, 10 * SOL), (5, 1)];
        let (c, fills) = clear(&bids, 5 * SOL, 1);
        assert_eq!(c.tick, 5);
        assert_eq!(fills[0].tokens, 0);
        assert_eq!(fills[1].tokens, 0);
        assert_eq!(fills[0].cost, 5_062_813_282);
        assert_eq!(fills[1].cost, 1);
    }

    #[test]
    fn one_atom_bid_against_a_whale_gets_its_pro_rata_dust() {
        // Same book with a stress float of 1e18 atoms. Every number below was
        // cross checked with exact rational arithmetic on 2026-09-24.
        let float = 1_000_000_000_000_000_000u64;
        let bids = [(5, 10 * SOL), (5, 1)];
        let (c, fills) = clear(&bids, 5 * SOL, float);
        assert_eq!(c.tick, 5);
        assert_eq!(c.float_value, 5_062_813_282); // 5 SOL * 1.0025^5
        assert_eq!(fills[0].tokens, 999_999_999_900_000_000);
        assert_eq!(fills[0].cost, 5_062_813_282);
        assert_eq!(fills[0].refund, 4_937_186_718);
        assert_eq!(fills[1].tokens, 99_999_999);
        assert_eq!(fills[1].cost, 1);
        assert_eq!(fills[1].refund, 0);
    }

    #[test]
    fn extreme_magnitudes_do_not_overflow() {
        // Largest deposits, float and floor the validated ranges allow. Expected
        // ticks cross checked with exact rational arithmetic on 2026-09-24. With
        // the maximum floor (2^49) the float is worth 1.48e19 at the top tick, more
        // than the 9.22e18 the two top bids hold, so it clears at tick 2357,
        // the highest tick whose value fits under 2^63. The two top bids cover
        // that alone, so the margin walks up to the top tick.
        let q = u64::MAX / 4;
        let bids = [(MAX_TICK, q), (MAX_TICK, q), (0, q), (0, q)];
        let (c, _) = clear(&bids, MAX_FLOOR_VALUE, u64::MAX);
        assert_eq!(c.tick, 2357);
        assert_eq!(c.marginal_tick, MAX_TICK);
        let (c, _) = clear(&bids, MIN_FLOOR_VALUE, u64::MAX);
        assert_eq!(c.tick, MAX_TICK);
        let (c, _) = clear(&bids, MAX_FLOOR_VALUE, 1);
        assert_eq!(c.tick, 2357);
        // One max deposit against a max float and the smallest floor.
        let (c, fills) = clear(&[(0, u64::MAX)], MIN_FLOOR_VALUE, u64::MAX);
        assert_eq!(c.tick, 0);
        assert_eq!(fills[0].tokens, u64::MAX);
        assert_eq!(fills[0].cost, MIN_FLOOR_VALUE);
        // A full fill of the largest deposit at the largest float above a margin.
        let (c, fills) = clear(&[(MAX_TICK, u64::MAX / 2), (0, u64::MAX / 2)], MIN_FLOOR_VALUE, u64::MAX);
        assert_eq!(c.tick, MAX_TICK);
        assert_eq!(c.marginal_tick, MAX_TICK);
        assert_eq!(fills[1].tokens, 0);
    }

    #[test]
    fn rejects_invalid_inputs() {
        let hist = [0u64; TICK_COUNT];
        assert_eq!(settle_lamports(&hist, MIN_FLOOR_VALUE - 1, 1), Err(Error::FloorValueOutOfRange));
        assert_eq!(settle_lamports(&hist, MAX_FLOOR_VALUE + 1, 1), Err(Error::FloorValueOutOfRange));
        assert_eq!(settle_lamports(&hist, MIN_FLOOR_VALUE, 0), Err(Error::ZeroFloat));
        let c = Clearing {
            tick: 0,
            marginal_tick: 0,
            float_value: MIN_FLOOR_VALUE as u128,
            winning_deposits: MIN_FLOOR_VALUE as u128,
            above_deposits: 0,
            at_deposits: MIN_FLOOR_VALUE as u128,
            float: 1,
        };
        assert_eq!(fill(1, TICK_COUNT as u16, &c), Err(Error::TickOutOfRange));
        assert!(fill(1, MAX_TICK, &c).is_ok());
        // A clearing that does not cover the float, or whose bids above the
        // margin already cover it, is refused rather than trusted.
        let bad = Clearing { at_deposits: MIN_FLOOR_VALUE as u128 - 1, ..c };
        assert_eq!(fill(1, 0, &bad), Err(Error::Overflow));
        let bad = Clearing { above_deposits: MIN_FLOOR_VALUE as u128, ..c };
        assert_eq!(fill(1, 0, &bad), Err(Error::Overflow));
        let bad = Clearing { marginal_tick: 1, tick: 2, ..c };
        assert_eq!(fill(1, 0, &bad), Err(Error::Overflow));
    }

    #[test]
    fn raising_a_bid_never_lowers_the_clearing_tick_or_the_bidders_fill() {
        let base = [(120u16, 20 * SOL), (80, 8 * SOL), (30, 6 * SOL), (0, SOL)];
        let (c0, f0) = clear(&base, WP_FLOOR, FLOAT);
        for i in 0..base.len() {
            for bump in [1u16, 10, 100, 300] {
                let mut b = base;
                b[i].0 = (b[i].0 + bump).min(MAX_TICK);
                let (c1, f1) = clear(&b, WP_FLOOR, FLOAT);
                assert!(c1.tick >= c0.tick, "raising bid {i} by {bump} lowered clearing");
                assert!(f1[i].tokens >= f0[i].tokens, "raising bid {i} by {bump} lowered its own fill");
            }
        }
    }

    fn arb_bids(max_len: usize, max_deposit: u64) -> impl Strategy<Value = Vec<(u16, u64)>> {
        prop::collection::vec((0u16..TICK_COUNT as u16, 1u64..=max_deposit), 0..max_len)
    }

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(2000))]

        // Realistic ranges: up to 200 bids, deposits up to 500 SOL, floor
        // anywhere from the minimum to 100 SOL, float from 1 atom to 1e18 atoms.
        // `run` checks the invariants when the book clears and the threshold when it fails.
        #[test]
        fn invariants_hold_realistic(
            bids in arb_bids(200, 500 * SOL),
            floor in MIN_FLOOR_VALUE..=100 * SOL,
            float in 1u64..=1_000_000_000_000_000_000u64,
        ) {
            run(&bids, floor, float);
        }

        // Hostile ranges: deposits, floor and float at the edges of their types.
        #[test]
        fn invariants_hold_extreme(
            bids in arb_bids(64, u64::MAX / 64),
            floor in prop_oneof![Just(MIN_FLOOR_VALUE), Just(MAX_FLOOR_VALUE), MIN_FLOOR_VALUE..=MAX_FLOOR_VALUE],
            float in prop_oneof![Just(1u64), Just(u64::MAX), 1u64..=u64::MAX],
        ) {
            run(&bids, floor, float);
        }

        // Many bids piled on one tick with tiny and huge deposits mixed.
        #[test]
        fn invariants_hold_single_tick_pileup(
            tick in 0u16..TICK_COUNT as u16,
            deposits in prop::collection::vec(prop_oneof![Just(1u64), 1u64..=1_000, 1u64..=100 * SOL], 1..300),
            floor in MIN_FLOOR_VALUE..=100 * SOL,
            float in prop_oneof![Just(1u64), 1u64..=1_000_000_000_000_000_000u64],
        ) {
            let bids: Vec<(u16, u64)> = deposits.into_iter().map(|d| (tick, d)).collect();
            run(&bids, floor, float);
        }

        // Fill priority: a bid never receives fewer tokens than a bid with a
        // smaller deposit at a lower tick (the README rule, stated as an order).
        #[test]
        fn higher_ticks_are_never_filled_worse(
            bids in arb_bids(100, 100 * SOL),
            floor in MIN_FLOOR_VALUE..=100 * SOL,
        ) {
            if let (Settlement::Cleared(_), fills) = run(&bids, floor, FLOAT) {
                for i in 0..bids.len() {
                    for j in 0..bids.len() {
                        if bids[i].0 > bids[j].0 && bids[i].1 >= bids[j].1 {
                            prop_assert!(fills[i].tokens >= fills[j].tokens,
                                "bid {i} at tick {} with {} got {} but bid {j} at tick {} with {} got {}",
                                bids[i].0, bids[i].1, fills[i].tokens, bids[j].0, bids[j].1, fills[j].tokens);
                        }
                    }
                }
            }
        }

        // The protocol's own ranges: fixed float, 5 SOL floor, bids at or above
        // the minimum, up to 5 SOL each. Every bid above the margin receives
        // at least one whole token, and the launch fails exactly when deposits
        // are under the floor. A bid at the margin can receive less: it shares
        // only what the full fills left.
        #[test]
        fn protocol_ranges_full_fills_get_whole_tokens(
            bids in prop::collection::vec((0u16..TICK_COUNT as u16, MIN_BID..=5 * SOL), 0..100),
        ) {
            let total: u128 = bids.iter().map(|(_, d)| *d as u128).sum();
            match run(&bids, FLOOR, FLOAT) {
                (Settlement::Failed { .. }, _) => prop_assert!(total < FLOOR as u128),
                (Settlement::Cleared(c), fills) => {
                    prop_assert!(total >= FLOOR as u128);
                    for (&(t, _), f) in bids.iter().zip(&fills) {
                        if t > c.marginal_tick {
                            prop_assert!(f.tokens >= supply::ATOMS_PER_TOKEN, "full fill got {} atoms", f.tokens);
                        }
                    }
                }
            }
        }
    }
}
