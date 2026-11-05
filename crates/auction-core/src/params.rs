//! The decided config values, in one place, so the generated contract and the
//! tests read the same numbers.
//!
//! These are the decisions of 2026-09-24 for production, and the devnet
//! test constants the deployed devnet config carries. They are values an
//! `init_config` or `admin_update_config` call writes, not program constants:
//! the program bounds them (`grid.rs`, `close.rs`, the program's own bounds)
//! and copies them into every launch at genesis.

use crate::close::WindowParams;
use crate::error::Error;
use crate::grid::validate_floor_value;

/// One lamport per SOL, spelled out.
pub const LAMPORTS_PER_SOL: u64 = 1_000_000_000;

/// The most a config may ask a creator to post as the crank bond: 1 SOL. The
/// bond reimburses what `create_pool` sinks and is sized to measured cost
/// (2026-09-25: the bond is not a source of profit), so a config above
/// this is a typo, not a decision.
pub const MAX_CRANK_BOND_LAMPORTS: u64 = LAMPORTS_PER_SOL;

/// The most a config may take of a cleared raise as the raise fee (0.28): 5 percent, a typo guard, not a
/// decision. The decision of 2026-10-08 is 1 percent (`raise_fee_bps` 100).
pub const MAX_RAISE_FEE_BPS: u16 = 500;

/// What the settlement path sinks for the crank on Meteora (0.19), at 5,080
/// lamports per byte (the Rent sysvar of mainnet and devnet read on 2026-09-25;
/// devnet re-read 2026-09-27, mainnet not re-read). Every account the crank pays
/// for and nobody can close: the settlement record (784 bytes) from `settle`;
/// the Meteora pool (1,112), both pool vaults (165 each), the platform position
/// (408), its Token-2022 NFT mint (465) and NFT account (165) and our token sink
/// (165) from `create_pool`, and since the mint deferral (0.19, 2026-09-27) also the launch
/// mint (82), the token vault (165), the Metaplex metadata (607) and Metaplex's 0.01 SOL
/// fee, which the creator paid at genesis until then; the creator position (408), its NFT mint (465) and
/// the creator's NFT account (170) from `lock_liquidity`; plus the signatures of
/// close, post_beacon, settle, create_pool, lock_liquidity and burn_unsold.
/// Measured on the local validator 2026-09-27 to the lamport at its own rate
/// (the v19 Meteora measurements). Reveal transactions (one per about 30
/// bids) and priority fees are not in it. Until 0.18 this was Raydium's model,
/// 180,774,560, whose 0.15 SOL pool fee Meteora does not charge; 29,900,400 before the mint
/// deferral.
pub const MAINNET_CRANK_SUNK_LAMPORTS: u64 = 46_189_440;

/// The eight numbers a config holds (six until 0.28).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ConfigValues {
    /// Lamports the whole float is worth at tick 0, and the least a launch can raise.
    pub floor_value: u64,
    /// Lamports; the smallest deposit `commit` accepts.
    pub min_bid: u64,
    /// Seconds after the window end before `abort` may run.
    pub abort_after_secs: u64,
    /// Basis points of a pushed delivery's tokens paid to the pusher. 0 since program 0.26, which
    /// repays a pushed delivery from the bid account's rent and refuses to create a launch with a
    /// token fee; launches created before 0.26 keep the 50 they recorded.
    pub delivery_fee_bps: u16,
    /// Basis points of the pool's LP locked for the creator.
    pub creator_lp_bps: u16,
    /// Lamports the creator posts at genesis as the crank bond: the measured
    /// cost of landing `create_pool`, reimbursed to whoever lands it, returned
    /// to the creator if the launch fails or is aborted. Not a reward.
    pub crank_bond: u64,
    /// 0.28: basis points of the cleared raise taken as the raise fee when the pool opens, in SOL, out of the
    /// proceeds before they reach the pool (2026-10-08: 1 percent). Bounded by the program to `MAX_RAISE_FEE_BPS`.
    pub raise_fee_bps: u16,
    /// 0.28: the creator's share of that fee, basis points of the fee (2026-10-08: 60 percent to the
    /// creator, 40 to Bouncer). Bounded to 10,000.
    pub raise_fee_creator_share_bps: u16,
    /// 0.29: the processing charge each bid pays, lamports; at most `MAX_PROCESSING_CHARGE`.
    pub processing_charge: u64,
    /// 0.29: 1 when new launches require a Bouncer attestation on every bid (section 4 of the 0.29 design of 2026-10-20).
    pub attest_bids: u8,
    /// v0.30 (2026-10-27): the three Squad-adjustable operating values. The reveal margin, seconds (60 to 300;
    /// starts at `beacon::REVEAL_MARGIN_SECS`), the delivery reward and the metadata reserve, lamports.
    pub reveal_margin_secs: u32,
    /// v0.30: lamports a pushed delivery pays its caller on top of the token account rent; at most `MAX_DELIVERY_REWARD_LAMPORTS`.
    pub delivery_reward: u64,
    /// v0.30: lamports of the prepay held for `finish_mint` when the prepay is returned first; within the reserve bounds.
    pub metadata_reserve: u64,
}

/// v0.30 (2026-10-27): the fee terms are program constants. The creator's share of the pool's LP, basis points
/// (21.875 percent: 0.35 percent of volume out of the 1.6 percent the 2 percent Meteora pool fee leaves after
/// Meteora's fifth, rounded up in the creator's favour), the raise fee (1 percent of the cleared raise) and the
/// creator's share of it (half). A config must carry exactly these; the program refuses any other value.
pub const CREATOR_LP_BPS: u16 = 2_188;
/// v0.30: the raise fee, basis points of the cleared raise (1 percent), a program constant.
pub const RAISE_FEE_BPS: u16 = 100;
/// v0.30: the creator's share of the raise fee, basis points of the fee (half), a program constant.
pub const RAISE_FEE_CREATOR_SHARE_BPS: u16 = 5_000;
/// v0.30: the floor of the reveal margin a config may hold, seconds. v0.31 (2026-10-28): 5, down from 60;
/// the Squad sets the live value on the keeper's lag evidence (the reveal margin design note).
pub const REVEAL_MARGIN_MIN_SECS: u32 = 5;
/// v0.30: the ceiling of the reveal margin a config may hold, seconds.
pub const REVEAL_MARGIN_MAX_SECS: u32 = 300;
/// v0.30: the most a config may pay a pusher per delivery on top of the rent, lamports (0.0005 SOL).
pub const MAX_DELIVERY_REWARD_LAMPORTS: u64 = 500_000;
/// v0.30: the least a config may hold back for `finish_mint`, lamports (0.01 SOL; the metadata costs about 0.0155).
pub const MIN_METADATA_RESERVE_LAMPORTS: u64 = 10_000_000;
/// v0.30: the most a config may hold back for `finish_mint`, lamports (0.05 SOL).
pub const MAX_METADATA_RESERVE_LAMPORTS: u64 = 50_000_000;

/// 0.29: the most a config may charge a bid for processing, lamports (0.001 SOL). A typo cannot make bidding dear.
pub const MAX_PROCESSING_CHARGE: u64 = 100_000;

/// Production: floor 10 SOL (5 SOL until it was raised on 2026-09-29, on the
/// evidence that running a launch costs the creator about 0.2 SOL, 4 percent of a
/// just-clearing 5 SOL raise), minimum bid 0.02 SOL, valve 12 hours, no token delivery
/// fee (50 basis points until the decision of 2026-10-05: a pushed delivery is repaid
/// from the bid account's rent, program 0.26), 60 percent of the LP to the creator (the 60/40 split). No cap
/// (2026-09-24). Operating prepay (the crank bond) 0.06 SOL (2026-10-05;
/// 0.181 SOL until then, sized to Raydium's model in 0.16): the Meteora path costs
/// `MAINNET_CRANK_SUNK_LAMPORTS`, the steps are repaid at cost and the rest returns to
/// the creator (the prepay sizing note of 2026-10-05).
pub const PRODUCTION: ConfigValues = ConfigValues {
    floor_value: 10 * LAMPORTS_PER_SOL,
    min_bid: LAMPORTS_PER_SOL / 50,
    abort_after_secs: 12 * 3600,
    delivery_fee_bps: 0,
    creator_lp_bps: CREATOR_LP_BPS,
    crank_bond: 60_000_000,
    raise_fee_bps: RAISE_FEE_BPS,
    raise_fee_creator_share_bps: RAISE_FEE_CREATOR_SHARE_BPS,
    processing_charge: 10_000,
    attest_bids: 1,
    reveal_margin_secs: crate::beacon::REVEAL_MARGIN_SECS as u32,
    delivery_reward: 25_000,
    metadata_reserve: 14_000_000,
};

/// Devnet test constants: every number a hundredth of production except the
/// valve (10 minutes), the two basis point values (the same) and the crank bond
/// (the same; devnet's rent rate was the same as mainnet's when both were read on
/// 2026-09-25). The devnet config was set to creator_lp_bps 6000 on 2026-09-27.
/// The devnet config account itself holds a delivery fee of 50 until it is updated
/// with the 0.26 deploy; under 0.26 no launch can be created until it is 0. It holds a
/// prepay of 181,000,000 until the same update sets 60,000,000.
pub const DEVNET: ConfigValues = ConfigValues {
    floor_value: LAMPORTS_PER_SOL / 20,
    min_bid: LAMPORTS_PER_SOL / 1000,
    abort_after_secs: 600,
    delivery_fee_bps: 0,
    creator_lp_bps: CREATOR_LP_BPS,
    crank_bond: 60_000_000,
    raise_fee_bps: RAISE_FEE_BPS,
    raise_fee_creator_share_bps: RAISE_FEE_CREATOR_SHARE_BPS,
    processing_charge: 10_000,
    attest_bids: 0,
    reveal_margin_secs: crate::beacon::REVEAL_MARGIN_SECS as u32,
    delivery_reward: 25_000,
    metadata_reserve: 14_000_000,
};

impl ConfigValues {
    /// The checks the program applies to a config, so a decided set of values
    /// that the program would refuse fails here first.
    pub fn validate(&self) -> Result<(), Error> {
        validate_floor_value(self.floor_value)?;
        if self.min_bid == 0 || self.min_bid > self.floor_value {
            return Err(Error::InvalidConfig);
        }
        // v0.30: the fee terms are constants.
        if self.creator_lp_bps != CREATOR_LP_BPS || self.raise_fee_bps != RAISE_FEE_BPS || self.raise_fee_creator_share_bps != RAISE_FEE_CREATOR_SHARE_BPS {
            return Err(Error::InvalidConfig);
        }
        if !(REVEAL_MARGIN_MIN_SECS..=REVEAL_MARGIN_MAX_SECS).contains(&self.reveal_margin_secs)
            || self.delivery_reward > MAX_DELIVERY_REWARD_LAMPORTS
            || !(MIN_METADATA_RESERVE_LAMPORTS..=MAX_METADATA_RESERVE_LAMPORTS).contains(&self.metadata_reserve)
        {
            return Err(Error::InvalidConfig);
        }
        if self.crank_bond > MAX_CRANK_BOND_LAMPORTS {
            return Err(Error::InvalidConfig);
        }
        if self.raise_fee_bps > MAX_RAISE_FEE_BPS || self.raise_fee_creator_share_bps > 10_000 {
            return Err(Error::InvalidConfig);
        }
        if self.processing_charge > MAX_PROCESSING_CHARGE || self.attest_bids > 1 {
            return Err(Error::InvalidConfig);
        }
        Ok(())
    }

    /// Window parameters for a launch created under these values.
    pub fn window(&self, open_ts: i64, window_secs: i64) -> WindowParams {
        WindowParams { open_ts, window_secs, floor_value: self.floor_value, min_bid: self.min_bid }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::grid::{grid_top, tick_for_max_value, value_at_tick};

    #[test]
    fn both_decided_sets_pass_the_program_checks() {
        PRODUCTION.validate().unwrap();
        DEVNET.validate().unwrap();
    }

    #[test]
    fn the_grid_top_at_both_scales() {
        // 2,407 ticks (0.29), the top pinned to the 1% grid's tick 1023: the float at the top tick is worth
        // 263,490.75 SOL in production (131,745.38 at the 5 SOL floor) and 1,317.45 SOL on devnet, and a 5,000 SOL
        // any price bid alone clears at tick 2006 in production (2076 at 5 SOL); 50 SOL clears at tick 2076 on devnet.
        assert_eq!(grid_top(PRODUCTION.floor_value).unwrap(), 263_490_753_636_683);
        assert_eq!(grid_top(DEVNET.floor_value).unwrap(), 1_317_453_768_183);
        assert_eq!(tick_for_max_value(PRODUCTION.floor_value, 5_000 * LAMPORTS_PER_SOL as u128).unwrap(), Some(2006));
        assert_eq!(tick_for_max_value(DEVNET.floor_value, 50 * LAMPORTS_PER_SOL as u128).unwrap(), Some(2076));
        assert_eq!(value_at_tick(DEVNET.floor_value, 2076).unwrap(), 49_875_909_963);
    }

    #[test]
    fn devnet_is_production_scaled_down() {
        // A hundredth until the production floor went to 10 SOL (2026-09-29); the
        // devnet config stays 0.05 SOL until the frontend's laps against it are
        // done, so the floor is a two-hundredth for now.
        assert_eq!(DEVNET.floor_value * 200, PRODUCTION.floor_value);
        assert_eq!(DEVNET.delivery_fee_bps, PRODUCTION.delivery_fee_bps);
        assert_eq!(DEVNET.creator_lp_bps, PRODUCTION.creator_lp_bps);
        assert_eq!(DEVNET.crank_bond, PRODUCTION.crank_bond);
        // 0.28: the raise fee is the same on both, the decided 1 percent at 60/40 (2026-10-08).
        assert_eq!((DEVNET.raise_fee_bps, DEVNET.raise_fee_creator_share_bps), (100, 5_000));
        assert_eq!((PRODUCTION.raise_fee_bps, PRODUCTION.raise_fee_creator_share_bps), (100, 5_000));
        assert_eq!(PRODUCTION.creator_lp_bps, 2_188);
        assert!(PRODUCTION.raise_fee_bps <= MAX_RAISE_FEE_BPS);
    }
}

#[cfg(test)]
mod crank_bond_tests {
    use super::*;

    /// The Meteora cost model, line by line: rent is (bytes + 128) * 5,080. At the
    /// local validator's 6,960 the same bytes gave 40,924,800 of rent, which the
    /// measured run matched to the lamport (the v19 Meteora measurements).
    #[test]
    fn the_meteora_crank_cost_model() {
        let rent = |bytes: u64| (bytes + 128) * 5_080;
        let settle = rent(784);
        let create_pool = rent(1_112) + 2 * rent(165) + rent(408) + rent(465) + rent(165) + rent(165);
        // The mint deferral (0.19): the token genesis moved from create_launch into create_pool.
        let metaplex_fee = 10_000_000u64;
        let token_genesis = rent(82) + rent(165) + rent(607) + metaplex_fee;
        assert_eq!(token_genesis, 16_289_040);
        let lock = rent(465) + rent(408) + rent(170);
        let signatures = 6 * 5_000u64;
        assert_eq!(settle + create_pool + lock, 29_870_400);
        assert_eq!(settle + create_pool + token_genesis + lock + signatures, MAINNET_CRANK_SUNK_LAMPORTS);
        let local = |bytes: u64| (bytes + 128) * 6_960;
        assert_eq!(local(784) + local(1_112) + 4 * local(165) + 2 * local(408) + 2 * local(465) + local(170), 40_924_800);
        // The prepay set on 2026-10-05 covers the path with 13,810,560 lamports over
        // (134,810,560 over at the 181,000,000 it replaced). It is spent at cost and the
        // rest returns to the creator, so the margin is room for rent or Metaplex's fee
        // to rise inside one launch's life, not a payment to anyone.
        assert_eq!(PRODUCTION.crank_bond, 60_000_000);
        assert!(PRODUCTION.crank_bond >= MAINNET_CRANK_SUNK_LAMPORTS);
        assert_eq!(PRODUCTION.crank_bond - MAINNET_CRANK_SUNK_LAMPORTS, 13_810_560);
    }

    /// Raydium's model (until 0.18), kept as history: its 0.15 SOL pool fee is
    /// why the bond was 0.181 SOL until 0.06 SOL was set on 2026-10-05.
    #[test]
    fn the_raydium_bond_was_exact_cost_within_rounding() {
        let rent = |bytes: u64| (bytes + 128) * 5_080;
        let raydium_pool_fee = 150_000_000u64; // AmmConfig 0 create_pool_fee, both clusters
        // What Raydium charges the pool's creator at initialize and never returns:
        // PoolState 637, LP mint 82, two token vaults 165 each, ObservationState 4075.
        // The creator's LP token account is closed back to the payer by create_pool.
        let raydium_rents = rent(637) + rent(82) + 2 * rent(165) + rent(4_075);
        // The vault's LP token account, created by create_pool and never closed.
        let vault_lp_token_account = rent(165);
        let signature = 5_000u64;
        let sunk = raydium_pool_fee + raydium_rents + vault_lp_token_account + signature;
        assert_eq!(raydium_rents, 29_281_120);
        assert_eq!(sunk, 180_774_560);
        // Exact cost: the decided production value covers the model and exceeds it
        // by less than 0.001 SOL (the rounding up to the next thousandth, which also
        // covers a priority fee of up to about 160,000 micro lamports per unit on
        // the 1,400,000 unit budget). Nobody profits; a stranger who rescues a
        // stuck launch is not out of pocket.
        let raydium_era_bond = 181_000_000u64;
        assert!(raydium_era_bond >= sunk);
        assert!(raydium_era_bond - sunk < LAMPORTS_PER_SOL / 1_000);
        assert!(raydium_era_bond <= MAX_CRANK_BOND_LAMPORTS);
        // No longer the decided value: the pool is Meteora's and its path costs a quarter of this.
        assert!(PRODUCTION.crank_bond < raydium_era_bond);
        assert!(PRODUCTION.crank_bond <= MAX_CRANK_BOND_LAMPORTS);
    }
}
