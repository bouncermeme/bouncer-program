//! Fixed supply and fixed float.
//!
//! Decided on 2026-09-24: every launch sells exactly half of its
//! supply. The float is derived from the supply, never entered by the creator,
//! and the creator receives no allocation. The supply itself is also fixed by
//! the protocol, because the creator's launch form has no field for it (name,
//! ticker, image, window length, nothing else).
//!
//! Why half is the ceiling and a smaller float is only a burn: the pool reserve
//! mirrors the float token for token, so float plus reserve is the whole supply
//! and the float cannot exceed half. With zero creator allocation, a smaller
//! float would only shrink the pool by the same amount, which is what burning
//! does. The nominal supply only scales the per token price and the token
//! counts; the raise and the market cap do not move.
//!
//! Decided on 2026-09-24: one billion tokens with six decimals, the
//! layout the whitepaper example already uses. In whole tokens: supply
//! 1,000,000,000, float 500,000,000, pool reserve 500,000,000.

/// Decimals of every token minted by the program.
pub const TOKEN_DECIMALS: u8 = 6;
/// Atoms in one whole token.
pub const ATOMS_PER_TOKEN: u64 = 1_000_000;
/// Total supply in whole tokens.
pub const TOTAL_SUPPLY_TOKENS: u64 = 1_000_000_000;
/// Total supply in atoms, minted once at genesis.
pub const TOTAL_SUPPLY: u64 = TOTAL_SUPPLY_TOKENS * ATOMS_PER_TOKEN;
/// Token atoms offered to bidders: exactly half the supply.
pub const FLOAT: u64 = TOTAL_SUPPLY / 2;
/// Token atoms held back to pair with proceeds in the pool: the other half.
pub const POOL_RESERVE: u64 = TOTAL_SUPPLY - FLOAT;

/// Whole tokens in `atoms`, rounded down. For anything a person reads.
pub fn whole_tokens(atoms: u64) -> u64 {
    atoms / ATOMS_PER_TOKEN
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn float_is_exactly_half_and_reserve_is_the_other_half() {
        assert_eq!(FLOAT * 2, TOTAL_SUPPLY);
        assert_eq!(FLOAT, POOL_RESERVE);
        assert_eq!(FLOAT + POOL_RESERVE, TOTAL_SUPPLY);
    }

    #[test]
    fn numbers_in_whole_tokens() {
        assert_eq!(ATOMS_PER_TOKEN, 10u64.pow(TOKEN_DECIMALS as u32));
        assert_eq!(whole_tokens(TOTAL_SUPPLY), 1_000_000_000);
        assert_eq!(whole_tokens(FLOAT), 500_000_000);
        assert_eq!(whole_tokens(POOL_RESERVE), 500_000_000);
        assert_eq!(FLOAT, 500_000_000_000_000);
    }

    #[test]
    fn float_is_far_above_the_rounding_floor() {
        // The clearing rounding loses under one atom per winner. With this float a
        // launch of ten thousand winners loses under one hundredth of a token in total.
        assert!(FLOAT > 1_000_000 * ATOMS_PER_TOKEN);
    }
}
