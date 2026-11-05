//! The tick grid: 2,407 ticks since 0.29, starting at the protocol floor: 0.25
//! percent steps to the band edge (tick 1,845, the first at or above 100 times
//! the floor's value, a 2,000 SOL market cap on the production floor), 1 percent
//! steps above it, the top pinned to the 0.28 grid's top (1.01^1023). Until 0.28
//! the grid was 1,024 ticks, each 1 percent above the previous.
//!
//! Decided on 2026-09-24: the creator does not set the reserve. Tick
//! 0 hangs off `floor_value`, the lamports the whole float is worth at the
//! floor, a protocol parameter held in the config and copied into each launch
//! at genesis. The same number is the least a launch can raise: deposits under
//! it fail the launch, deposits at or above it cover the float at tick 0 and
//! the launch sells out at the highest tick they cover. Decided value: 5 SOL,
//! raised to 10 SOL on 2026-09-29 (`params.rs` PRODUCTION; devnet
//! holds 0.05 SOL). At 10 SOL the smallest launch raises 10 SOL, a 20 SOL
//! clearing market cap; since 0.28 its pool holds 9.9 SOL (the raise less the
//! 1% raise fee) against 500 million tokens. At that floor the grid reaches
//! 263,490.75 SOL at tick 2,406 (the top tick is "any price"; 131,745 SOL at the
//! old 5 SOL floor; tick 1023 until 0.28, the same value). At 5 SOL, 512 ticks reached 807 SOL and the 500 SOL raise
//! cap bound at tick 462 until the cap was removed on 2026-09-24 (no cap of
//! any kind). Nothing bounds the price but
//! the grid, and the grid is wide enough that a book which saturates it holds
//! more SOL than exists at any floor a launch would use.
//!
//! The grid is expressed as multipliers on the value of the whole float, not on
//! a per token price. `MULT[k] = floor(1.01^k * 2^48)` was computed once with
//! exact rational arithmetic (see `grid_table.rs`); every caller applies one
//! multiply and one shift, so every node and every client gets the same number.

pub use crate::grid_table::{BAND_EDGE_MULTIPLE, FINE_TICKS, MULT, SCALE_BITS, TICK_COUNT};
use crate::error::Error;

/// Highest valid tick.
pub const MAX_TICK: u16 = (TICK_COUNT - 1) as u16;

/// Smallest floor value the config may hold (lamports for the whole float at tick 0).
///
/// Below this the 0.25 percent steps could round to the same integer and the grid
/// would stop being strictly increasing (2,500 lamports a step at this floor).
/// 1_000_000 lamports is 0.001 SOL.
pub const MIN_FLOOR_VALUE: u64 = 1_000_000;

/// Largest floor value the config may hold, about 562,950 SOL. Keeps
/// `value_at_tick` below 2^64 for every tick: 1.01^1023 is about 26,349, so
/// 2^49 * 26,349 is 1.48e19, under 2^64 (1.84e19), and 2^50 would not fit.
/// (With 512 ticks this was 2^56.) That in turn keeps every product in
/// `clearing` inside u128 without special casing.
pub const MAX_FLOOR_VALUE: u64 = 1 << 49;

/// Check a floor value against the allowed range.
pub fn validate_floor_value(floor_value: u64) -> Result<(), Error> {
    if !(MIN_FLOOR_VALUE..=MAX_FLOOR_VALUE).contains(&floor_value) {
        return Err(Error::FloorValueOutOfRange);
    }
    Ok(())
}

/// Lamport value of the whole float at `tick`, given its value at the floor.
///
/// `value_at_tick(f, 0) == f` exactly. For a validated floor value the result
/// is strictly increasing in `tick` and always fits in u64 (returned as u128 so
/// callers can sum without casting).
pub fn value_at_tick(floor_value: u64, tick: u16) -> Result<u128, Error> {
    if tick > MAX_TICK {
        return Err(Error::TickOutOfRange);
    }
    validate_floor_value(floor_value)?;
    let product = (floor_value as u128)
        .checked_mul(MULT[tick as usize] as u128)
        .ok_or(Error::Overflow)?;
    Ok(product >> SCALE_BITS)
}

/// Lamport value of the whole float at the top of the grid (tick 1023,
/// `MAX_TICK`): the largest proceeds any launch at this floor can have, the
/// floor times 1.01^1023 (about 26,349). There is no raise cap since 0.14.
pub fn grid_top(floor_value: u64) -> Result<u128, Error> {
    value_at_tick(floor_value, MAX_TICK)
}

/// Highest tick whose float value is at most `max_value`, or `None` if even
/// tick 0 is above it. This is how a client turns "the highest opening market
/// cap I accept" into a tick: `max_value` is half that market cap in lamports.
pub fn tick_for_max_value(floor_value: u64, max_value: u128) -> Result<Option<u16>, Error> {
    validate_floor_value(floor_value)?;
    if max_value < floor_value as u128 {
        return Ok(None);
    }
    let (mut lo, mut hi) = (0u16, MAX_TICK);
    while lo < hi {
        let mid = lo + (hi - lo + 1) / 2;
        if value_at_tick(floor_value, mid)? <= max_value {
            lo = mid;
        } else {
            hi = mid - 1;
        }
    }
    Ok(Some(lo))
}

#[cfg(test)]
mod tests {
    use super::*;
    use num_bigint::BigUint;
    use num_traits::{One, ToPrimitive};

    const SOL: u64 = 1_000_000_000;
    /// The floor these tests were written at, 5 SOL (production holds 10 SOL since 2026-09-29, `params.rs`).
    const FLOOR: u64 = 5 * SOL;

    #[test]
    fn table_matches_exact_recomputation() {
        // Independent recomputation of the 0.29 two-band grid with big integers: (401/400)^k for the fine band,
        // then (101/100) per step, the last entry pinned to (101/100)^1023 (the 0.28 top).
        let scale = BigUint::one() << SCALE_BITS;
        let (mut num, mut den) = (scale.clone(), BigUint::one());
        let top = (&scale * BigUint::from(101u32).pow(1023)) / BigUint::from(100u32).pow(1023);
        for k in 0..TICK_COUNT {
            let expected = if k == TICK_COUNT - 1 { top.clone() } else { &num / &den };
            assert_eq!(MULT[k], expected.to_u64().expect("fits u64"), "MULT[{k}] differs from exact value");
            if k < FINE_TICKS {
                num *= BigUint::from(401u32);
                den *= BigUint::from(400u32);
            } else {
                num *= BigUint::from(101u32);
                den *= BigUint::from(100u32);
            }
        }
        // The band edge: tick FINE_TICKS is the first at or above BAND_EDGE_MULTIPLE x the floor, the one before is under.
        assert!(MULT[FINE_TICKS] >= (BAND_EDGE_MULTIPLE << SCALE_BITS));
        assert!(MULT[FINE_TICKS - 1] < (BAND_EDGE_MULTIPLE << SCALE_BITS));
        // The entry before the pinned top is under it, and the unpinned next 1% step would pass it.
        assert!(MULT[TICK_COUNT - 2] < MULT[TICK_COUNT - 1]);
        assert!((MULT[TICK_COUNT - 2] as u128) * 101 / 100 > MULT[TICK_COUNT - 1] as u128);
    }

    #[test]
    fn table_is_strictly_increasing_and_bounded() {
        assert_eq!(TICK_COUNT, 2407);
        assert_eq!(FINE_TICKS, 1845);
        assert_eq!(MULT[0], 1u64 << SCALE_BITS);
        for k in 1..TICK_COUNT {
            assert!(MULT[k] > MULT[k - 1], "not increasing at {k}");
        }
        // 1.01^1023 is 26,349.0754 (exact: 7,416,605,374,335,865,187 / 2^48),
        // so the top entry is about 26,349 * 2^48 and still below 2^63.
        assert_eq!(MULT[TICK_COUNT - 1], 7_416_605_374_335_865_187);
        let top = MULT[TICK_COUNT - 1] as f64 / (1u64 << SCALE_BITS) as f64;
        assert!((top - 26_349.0754).abs() < 0.001, "top multiplier {top}");
    }

    #[test]
    fn each_step_is_its_band_within_rounding() {
        for k in 1..TICK_COUNT - 1 {
            // den * MULT[k] should equal num * MULT[k-1] up to the floor on both sides.
            // the step into tick k: fine while k is at or under the band edge (tick FINE_TICKS is reached by a fine step)
            let (num, den) = if k <= FINE_TICKS { (401u128, 400u128) } else { (101u128, 100u128) };
            let lhs = den * MULT[k] as u128;
            let rhs = num * MULT[k - 1] as u128;
            let diff = lhs.abs_diff(rhs);
            assert!(diff <= num, "step {k} off by {diff}");
        }
        // The pinned top is a short last step (about 0.026%), above the entry before it.
        assert!(MULT[TICK_COUNT - 1] > MULT[TICK_COUNT - 2]);
    }

    #[test]
    fn value_at_tick_zero_is_the_floor_exactly() {
        for f in [MIN_FLOOR_VALUE, 20_000_000, FLOOR, 100_000_000_000, MAX_FLOOR_VALUE] {
            assert_eq!(value_at_tick(f, 0).unwrap(), f as u128);
        }
    }

    #[test]
    fn value_at_tick_strictly_increasing_for_validated_floor() {
        for f in [
            MIN_FLOOR_VALUE,
            MIN_FLOOR_VALUE + 1,
            1_234_567,
            20_000_000,
            FLOOR,
            100_000_000_000,
            MAX_FLOOR_VALUE - 1,
            MAX_FLOOR_VALUE,
        ] {
            let mut prev = value_at_tick(f, 0).unwrap();
            for t in 1..=MAX_TICK {
                let v = value_at_tick(f, t).unwrap();
                assert!(v > prev, "floor {f} tick {t}: {v} <= {prev}");
                assert!(v < (1u128 << 64), "floor {f} tick {t} exceeds u64");
                prev = v;
            }
        }
    }

    #[test]
    fn value_at_tick_rejects_bad_inputs() {
        assert_eq!(value_at_tick(1_000_000, TICK_COUNT as u16), Err(Error::TickOutOfRange));
        assert_eq!(value_at_tick(1_000_000, MAX_TICK).is_ok(), true);
        assert_eq!(value_at_tick(MIN_FLOOR_VALUE - 1, 0), Err(Error::FloorValueOutOfRange));
        assert_eq!(value_at_tick(MAX_FLOOR_VALUE + 1, 0), Err(Error::FloorValueOutOfRange));
        assert_eq!(value_at_tick(0, 0), Err(Error::FloorValueOutOfRange));
        assert_eq!(grid_top(0), Err(Error::FloorValueOutOfRange));
    }

    #[test]
    fn whitepaper_floor_matches_exact_arithmetic() {
        // The whitepaper's 10 SOL floor, used by the worked examples. Values cross checked with exact integer
        // arithmetic on 2026-10-20 (the 0.29 fine band: 0.25% a tick, so tick 4k sits near the 1% grid's tick k).
        let f = 10 * SOL;
        assert_eq!(value_at_tick(f, 160).unwrap(), 14_910_802_119); // 1.0025^160 = 1.491080
        assert_eq!(value_at_tick(f, 164).unwrap(), 15_060_470_228); // 1.0025^164 = 1.506047
        assert_eq!(value_at_tick(f, 280).unwrap(), 20_119_943_731); // 1.0025^280 = 2.011994
        assert_eq!(value_at_tick(f, 368).unwrap(), 25_064_111_595); // 1.0025^368 = 2.506411
        assert_eq!(value_at_tick(f, 372).unwrap(), 25_315_694_183); // 1.0025^372 = 2.531569
    }

    #[test]
    fn decided_floor_grid_top_and_the_wide_grid() {
        // With the 5 SOL floor these tests use (production holds 10 SOL, whose grid tops out at 263,490.75 SOL)
        // the grid tops out at 131,745.38 SOL at the pinned top tick (unchanged from the 1% grid). 0.29: the band
        // edge is 100x the floor, 500 SOL here: tick 1844 (499.54 SOL) is the last 0.25% tick and tick 1845
        // (500.79 SOL) the first 1% tick. A 5,000 SOL any price bid alone clears at tick 2076 (4,987.59 SOL;
        // tick 2077 wants 5,037.47). Cross checked with exact integer arithmetic on 2026-10-20.
        assert_eq!(grid_top(FLOOR).unwrap(), 131_745_376_818_341);
        assert_eq!(value_at_tick(FLOOR, 1844).unwrap(), 499_538_663_066);
        assert_eq!(value_at_tick(FLOOR, 1845).unwrap(), 500_787_509_723);
        assert_eq!(FINE_TICKS, 1845);
        assert_eq!(tick_for_max_value(FLOOR, 500 * SOL as u128).unwrap(), Some(1844));
        assert_eq!(value_at_tick(FLOOR, 2076).unwrap(), 4_987_590_996_327);
        assert_eq!(value_at_tick(FLOOR, 2077).unwrap(), 5_037_466_906_290);
        assert_eq!(tick_for_max_value(FLOOR, 5_000 * SOL as u128).unwrap(), Some(2076));
    }

    #[test]
    fn the_top_of_the_grid_fits_u64_at_the_largest_floor_and_not_above() {
        // MAX_FLOOR_VALUE is the largest power of two whose grid top fits u64:
        // 2^49 * MULT[1023] >> 48 = 2 * MULT[1023] is 1.48e19; 2^50 doubles it past 2^64.
        assert_eq!(MULT[MAX_TICK as usize], 7_416_605_374_335_865_187);
        assert!(MULT[MAX_TICK as usize] < 1 << 63);
        let top = value_at_tick(MAX_FLOOR_VALUE, MAX_TICK).unwrap();
        assert_eq!(top, 14_833_210_748_671_730_374);
        assert!(top < 1u128 << 64);
        let above = ((MAX_FLOOR_VALUE as u128) << 1) * MULT[MAX_TICK as usize] as u128 >> SCALE_BITS;
        assert!(above >= 1u128 << 64, "2^50 would overflow the top tick");
        assert_eq!(value_at_tick(MAX_FLOOR_VALUE << 1, 0), Err(Error::FloorValueOutOfRange));
    }

    #[test]
    fn tick_for_max_value_is_the_highest_tick_at_or_below() {
        assert_eq!(tick_for_max_value(FLOOR, 0).unwrap(), None);
        assert_eq!(tick_for_max_value(FLOOR, 5 * SOL as u128 - 1).unwrap(), None);
        assert_eq!(tick_for_max_value(FLOOR, 5 * SOL as u128).unwrap(), Some(0));
        assert_eq!(tick_for_max_value(FLOOR, 10 * SOL as u128).unwrap(), Some(277)); // 1.0025^277 = 1.9966, 1.0025^278 = 2.0016
        assert_eq!(tick_for_max_value(FLOOR, 20 * SOL as u128).unwrap(), Some(555));
        assert_eq!(tick_for_max_value(FLOOR, 25 * SOL as u128).unwrap(), Some(644));
        assert_eq!(tick_for_max_value(FLOOR, 100 * SOL as u128).unwrap(), Some(1199));
        assert_eq!(tick_for_max_value(FLOOR, u128::MAX).unwrap(), Some(MAX_TICK));
        for t in 0..=MAX_TICK {
            let v = value_at_tick(FLOOR, t).unwrap();
            assert_eq!(tick_for_max_value(FLOOR, v).unwrap(), Some(t));
            if t < MAX_TICK {
                assert_eq!(tick_for_max_value(FLOOR, value_at_tick(FLOOR, t + 1).unwrap() - 1).unwrap(), Some(t));
            }
        }
    }

    #[test]
    fn value_at_tick_is_within_one_atom_of_exact_for_realistic_floors() {
        // value_at_tick applies a pre rounded multiplier, so it can sit below floor(floor_value x ratio_k) by at
        // most floor_value / 2^48, under one atom for any floor below 2^48 (about 281 thousand SOL). It is never
        // above it. 0.29: ratio_k is (401/400)^k in the fine band, then x(101/100) a tick; the top is (101/100)^1023.
        for f in [MIN_FLOOR_VALUE, 20_000_000u64, FLOOR, 10_000_000_000, 100_000_000_000] {
            let mut num = BigUint::from(f);
            let mut den = BigUint::one();
            let top = (BigUint::from(f) * BigUint::from(101u32).pow(1023)) / BigUint::from(100u32).pow(1023);
            for k in 0..TICK_COUNT {
                let exact = if k == TICK_COUNT - 1 { top.to_u128().unwrap() } else { (&num / &den).to_u128().unwrap() };
                let got = value_at_tick(f, k as u16).unwrap();
                assert!(got <= exact, "floor {f} tick {k}: got {got} above exact {exact}");
                assert!(exact - got <= 1, "floor {f} tick {k}: got {got} exact {exact}");
                if k < FINE_TICKS {
                    num *= 401u32;
                    den *= 400u32;
                } else {
                    num *= 101u32;
                    den *= 100u32;
                }
            }
        }
    }
}
