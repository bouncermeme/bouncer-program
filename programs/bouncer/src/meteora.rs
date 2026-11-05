//! Meteora DAMM v2 (program `cp-amm`), hand encoded from MeteoraAg/damm-v2
//! release 0.2.4 (commit a85c926, read 2026-09-26). The program id and the
//! config are the same on devnet and mainnet; both were read on both clusters.
//!
//! Accounts derive from the cp-amm program id with these seeds: pool
//! ["pool", config, max(mint_a, mint_b), min(mint_a, mint_b)], position
//! ["position", nft_mint], position NFT account ["position_nft_account",
//! nft_mint], token vault ["token_vault", mint, pool], pool authority
//! ["pool_authority"], event authority ["__event_authority"]. Every
//! instruction used here is `#[event_cpi]`, so its account list ends with the
//! event authority and the program itself.
//!
//! Position NFTs are Token-2022 mints (metadata pointer, close authority,
//! token metadata), created by cp-amm; this is the only Token-2022 in Bouncer.
//! The launch token stays a classic SPL mint and is passed with the classic
//! token program.

use anchor_lang::prelude::*;
use num_bigint::BigUint;
use solana_instruction::{AccountMeta, Instruction};

pub const PROGRAM_ID: Pubkey = pubkey!("cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG");
/// The one config `create_pool` accepts: public (creator authority is the
/// default key), 2 percent flat (v0.30, 2026-10-27; 1 percent, AeLtDKgw..., from v19 to 0.29), no dynamic
/// fee, OnlyB (fees in token B, SOL), full price range, activation by timestamp, Meteora's protocol share 20
/// (checked since v0.30). Byte for byte the same account on devnet and mainnet (read 2026-10-27).
pub const CONFIG: Pubkey = pubkey!("HQ6vW45Kug23h2A4LkyUqB4UFfGx4LqY1uZLLfQemEjU");
/// ["pool_authority"] under cp-amm, bump 254.
pub const POOL_AUTHORITY: Pubkey = pubkey!("HLnpSz9h2S4hiLQ43rnSD9XkcUThA7B8hQMKmDaiTLcC");
/// ["__event_authority"] under cp-amm, bump 255.
pub const EVENT_AUTHORITY: Pubkey = pubkey!("3rmHSu74h1ZcmAisVcWerTCiRDQbUrBKmcwptYGjHfet");
pub const TOKEN_2022_PROGRAM_ID: Pubkey = pubkey!("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");

/// cp-amm `constants.rs`: the absolute price bounds, Q64.64 square roots.
pub const MIN_SQRT_PRICE: u128 = 4_295_048_016;
pub const MAX_SQRT_PRICE: u128 = 79_226_673_521_066_979_257_578_248_091;
/// Split numerators are out of 1e9 (`SPLIT_POSITION_DENOMINATOR`).
pub const SPLIT_DENOMINATOR: u64 = 1_000_000_000;

pub const POSITION_SEED: &[u8] = b"position";
pub const POSITION_NFT_ACCOUNT_SEED: &[u8] = b"position_nft_account";

/// Config account (state/config.rs), 328 bytes with the discriminator.
pub mod config {
    pub const DISCRIMINATOR: [u8; 8] = [0x9b, 0x0c, 0xaa, 0xe0, 0x1e, 0xfa, 0xcc, 0x82];
    pub const LEN: usize = 328;
    /// The alpha vault's config (0.20): must be the default key, or an alpha vault may swap before activation.
    pub const VAULT_CONFIG_KEY: usize = 8;
    pub const POOL_CREATOR_AUTHORITY: usize = 40;
    /// Base fee cliff numerator, out of 1e9: 10,000,000 is 1 percent.
    pub const CLIFF_FEE_NUMERATOR: usize = 72;
    pub const BASE_FEE_MODE: usize = 80;
    /// Number of fee periods; 0 means the cliff fee never changes (flat).
    pub const NUMBER_OF_PERIOD: usize = 86;
    /// Dynamic fee initialized flag; 0 means no dynamic fee.
    pub const DYNAMIC_FEE_INITIALIZED: usize = 104;
    /// v0.30: Meteora's protocol share of the fee, percent (20 on every public config), and the referral share taken
    /// out of it (20). The split the platform and creator positions share is what these leave.
    pub const PROTOCOL_FEE_PERCENT: usize = 152;
    pub const REFERRAL_FEE_PERCENT: usize = 154;
    pub const ACTIVATION_TYPE: usize = 200;
    pub const COLLECT_FEE_MODE: usize = 201;
    /// 0 Static (a pool on this config is `initialize_pool`), 1 Dynamic.
    pub const CONFIG_TYPE: usize = 202;
    pub const SQRT_MIN_PRICE: usize = 216;
    pub const SQRT_MAX_PRICE: usize = 232;
}

/// Pool account (state/pool.rs), 1112 bytes with the discriminator.
pub mod pool {
    pub const DISCRIMINATOR: [u8; 8] = [0xf1, 0x9a, 0x6d, 0x04, 0x11, 0xb1, 0x6d, 0xbc];
    pub const LEN: usize = 1112;
    pub const TOKEN_A_MINT: usize = 168;
    pub const TOKEN_B_MINT: usize = 200;
    pub const TOKEN_A_VAULT: usize = 232;
    pub const TOKEN_B_VAULT: usize = 264;
    /// The one vault allowed to swap before activation (0.20): must be the default key.
    pub const WHITELISTED_VAULT: usize = 296;
    pub const LIQUIDITY: usize = 360;
    pub const SQRT_MIN_PRICE: usize = 424;
    pub const SQRT_MAX_PRICE: usize = 440;
    pub const SQRT_PRICE: usize = 456;
    /// Seconds, since the config activates by timestamp (0.20): must equal the creating instruction's clock.
    pub const ACTIVATION_POINT: usize = 472;
    /// 0 enabled, 1 disabled (a Meteora operator's `set_pool_status`) (0.20).
    pub const POOL_STATUS: usize = 481;
    pub const COLLECT_FEE_MODE: usize = 484;
    pub const PERMANENT_LOCK_LIQUIDITY: usize = 552;
    pub const CREATOR: usize = 648;
}

/// Position account (state/position.rs), 408 bytes with the discriminator.
pub mod position {
    pub const DISCRIMINATOR: [u8; 8] = [0xaa, 0xbc, 0x8f, 0xe4, 0x7a, 0x40, 0xf7, 0xd0];
    pub const LEN: usize = 408;
    pub const POOL: usize = 8;
    pub const NFT_MINT: usize = 40;
    pub const UNLOCKED_LIQUIDITY: usize = 152;
    pub const VESTED_LIQUIDITY: usize = 168;
    pub const PERMANENT_LOCKED_LIQUIDITY: usize = 184;
    /// Bitmask of what the NFT account's SPL delegate may do (0.20): must stay 0 for the platform position.
    pub const DELEGATE_PERMISSION: usize = 392;
}

/// `collect_fee_mode` 1: every fee is taken in token B.
pub const COLLECT_FEE_MODE_ONLY_B: u8 = 1;
/// `activation_type` 1: timestamp.
pub const ACTIVATION_TIMESTAMP: u8 = 1;
/// v0.30: 2 percent (`cliff_fee_numerator` out of 1e9); 10,000,000 (1 percent) until 0.29.
pub const POOL_FEE_NUMERATOR: u64 = 20_000_000;
/// v0.30: the protocol and referral shares the pinned config must carry, percent.
pub const PROTOCOL_FEE_PERCENT: u8 = 20;
pub const REFERRAL_FEE_PERCENT: u8 = 20;

const INITIALIZE_POOL: [u8; 8] = [0x5f, 0xb4, 0x0a, 0xac, 0x54, 0xae, 0xe8, 0x28];
const CREATE_POSITION: [u8; 8] = [0x30, 0xd7, 0xc5, 0x99, 0x60, 0xcb, 0xb4, 0x85];
const PERMANENT_LOCK_POSITION: [u8; 8] = [0xa5, 0xb0, 0x7d, 0x06, 0xe7, 0xab, 0xba, 0xd5];
const SPLIT_POSITION2: [u8; 8] = [0xdd, 0x93, 0xe4, 0xcf, 0x8c, 0xd4, 0x11, 0x77];
const CLAIM_POSITION_FEE: [u8; 8] = [0xb4, 0x26, 0x9a, 0x11, 0x85, 0x21, 0xa2, 0xd3];
/// v0.30 (the fold-in): `swap(amount_in, minimum_amount_out)`, sha256("global:swap")[..8].
const SWAP: [u8; 8] = [0xf8, 0xc6, 0x9e, 0x91, 0xe1, 0x75, 0x87, 0xc8];

pub fn u128_at(d: &[u8], o: usize) -> u128 {
    u128::from_le_bytes(d[o..o + 16].try_into().unwrap())
}

pub fn position_address(nft_mint: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[POSITION_SEED, nft_mint.as_ref()], &PROGRAM_ID).0
}

pub fn position_nft_account_address(nft_mint: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[POSITION_NFT_ACCOUNT_SEED, nft_mint.as_ref()], &PROGRAM_ID).0
}

/// What the pool opens with, computed from the auction's proceeds.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Opening {
    /// Q64.64 square root of the price in lamports per token atom: floor(sqrt(sol * 2^128 / tokens)).
    pub sqrt_price: u128,
    /// The largest liquidity whose deposit, rounded up the way cp-amm rounds it, fits both amounts.
    pub liquidity: u128,
    /// Token atoms cp-amm will take: ceil(L * (sqrt_max - sqrt_price) / (sqrt_price * sqrt_max)).
    pub token_amount: u64,
    /// Lamports cp-amm will take: ceil(L * (sqrt_price - sqrt_min) / 2^128).
    pub sol_amount: u64,
}

fn to_u128(x: &BigUint) -> Option<u128> {
    let b = x.to_bytes_le();
    if b.len() > 16 {
        return None;
    }
    let mut a = [0u8; 16];
    a[..b.len()].copy_from_slice(&b);
    Some(u128::from_le_bytes(a))
}

fn ceil_div(n: &BigUint, d: &BigUint) -> BigUint {
    (n + d - 1u32) / d
}

/// The full range opening for `sol` lamports against `tokens` atoms, the same
/// arithmetic cp-amm's `get_initial_pool_information` does (concentrated
/// liquidity, rounding up). The liquidity is the largest one whose rounded up
/// deposit fits both amounts, found in closed form: the token side fits while
/// L * (max - p) <= tokens * p * max, the SOL side while L * (p - min) <= sol * 2^128.
/// `None` when the price falls outside cp-amm's bounds or a value overflows.
pub fn opening(sol: u64, tokens: u64) -> Option<Opening> {
    if sol == 0 || tokens == 0 {
        return None;
    }
    let (s, t) = (BigUint::from(sol), BigUint::from(tokens));
    let (min, max) = (BigUint::from(MIN_SQRT_PRICE), BigUint::from(MAX_SQRT_PRICE));
    let q128 = BigUint::from(1u8) << 128u32;
    let p = ((&s << 128u32) / &t).sqrt();
    if p <= min || p >= max {
        return None;
    }
    let l_token = (&t * &p * &max) / (&max - &p);
    let l_sol = (&s * &q128) / (&p - &min);
    let l = if l_token < l_sol { l_token } else { l_sol };
    let token_amount = ceil_div(&(&l * (&max - &p)), &(&p * &max));
    let sol_amount = ceil_div(&(&l * (&p - &min)), &q128);
    let o = Opening {
        sqrt_price: to_u128(&p)?,
        liquidity: to_u128(&l)?,
        token_amount: u64::try_from(to_u128(&token_amount)?).ok()?,
        sol_amount: u64::try_from(to_u128(&sol_amount)?).ok()?,
    };
    if o.liquidity == 0 || o.token_amount > tokens || o.sol_amount > sol {
        return None;
    }
    Some(o)
}

fn metas(program_tail: bool, list: &[(Pubkey, bool, bool)]) -> Vec<AccountMeta> {
    let mut v: Vec<AccountMeta> = list
        .iter()
        .map(|&(k, signer, writable)| if writable { AccountMeta::new(k, signer) } else { AccountMeta::new_readonly(k, signer) })
        .collect();
    if program_tail {
        v.push(AccountMeta::new_readonly(EVENT_AUTHORITY, false));
        v.push(AccountMeta::new_readonly(PROGRAM_ID, false));
    }
    v
}

pub struct InitializePoolAccounts {
    pub creator: Pubkey,
    pub position_nft_mint: Pubkey,
    pub position_nft_account: Pubkey,
    pub payer: Pubkey,
    pub pool: Pubkey,
    pub position: Pubkey,
    pub token_a_mint: Pubkey,
    pub token_b_mint: Pubkey,
    pub token_a_vault: Pubkey,
    pub token_b_vault: Pubkey,
    pub payer_token_a: Pubkey,
    pub payer_token_b: Pubkey,
    pub token_a_program: Pubkey,
    pub token_b_program: Pubkey,
}

/// `initialize_pool(liquidity, sqrt_price, activation_point: None)` on `CONFIG`.
/// `payer` pays every rent and is the authority of both payer token accounts.
pub fn initialize_pool(a: &InitializePoolAccounts, liquidity: u128, sqrt_price: u128) -> Instruction {
    let mut data = Vec::with_capacity(8 + 16 + 16 + 1);
    data.extend_from_slice(&INITIALIZE_POOL);
    data.extend_from_slice(&liquidity.to_le_bytes());
    data.extend_from_slice(&sqrt_price.to_le_bytes());
    data.push(0); // activation_point: None, so trading opens at once
    Instruction {
        program_id: PROGRAM_ID,
        accounts: metas(
            true,
            &[
                (a.creator, false, false),
                (a.position_nft_mint, true, true),
                (a.position_nft_account, false, true),
                (a.payer, true, true),
                (CONFIG, false, false),
                (POOL_AUTHORITY, false, false),
                (a.pool, false, true),
                (a.position, false, true),
                (a.token_a_mint, false, false),
                (a.token_b_mint, false, false),
                (a.token_a_vault, false, true),
                (a.token_b_vault, false, true),
                (a.payer_token_a, false, true),
                (a.payer_token_b, false, true),
                (a.token_a_program, false, false),
                (a.token_b_program, false, false),
                (TOKEN_2022_PROGRAM_ID, false, false),
                (anchor_lang::system_program::ID, false, false),
            ],
        ),
        data,
    }
}

/// `create_position`: a new empty position on `pool` whose NFT goes to `owner`.
pub fn create_position(owner: Pubkey, nft_mint: Pubkey, nft_account: Pubkey, pool: Pubkey, position: Pubkey, payer: Pubkey) -> Instruction {
    Instruction {
        program_id: PROGRAM_ID,
        accounts: metas(
            true,
            &[
                (owner, false, false),
                (nft_mint, true, true),
                (nft_account, false, true),
                (pool, false, true),
                (position, false, true),
                (POOL_AUTHORITY, false, false),
                (payer, true, true),
                (TOKEN_2022_PROGRAM_ID, false, false),
                (anchor_lang::system_program::ID, false, false),
            ],
        ),
        data: CREATE_POSITION.to_vec(),
    }
}

/// `permanent_lock_position(liquidity)`: moves unlocked liquidity to the permanent bucket, forever.
pub fn permanent_lock_position(pool: Pubkey, position: Pubkey, nft_account: Pubkey, signer: Pubkey, liquidity: u128) -> Instruction {
    let mut data = PERMANENT_LOCK_POSITION.to_vec();
    data.extend_from_slice(&liquidity.to_le_bytes());
    Instruction {
        program_id: PROGRAM_ID,
        accounts: metas(true, &[(pool, false, true), (position, false, true), (nft_account, false, false), (signer, true, false)]),
        data,
    }
}

/// `split_position2(numerator)`: moves numerator / 1e9 of every bucket (unlocked,
/// permanent, pending fees, rewards) from the first position to the second.
/// Both NFT owners sign.
pub fn split_position2(
    pool: Pubkey,
    first_position: Pubkey,
    first_nft_account: Pubkey,
    second_position: Pubkey,
    second_nft_account: Pubkey,
    first_owner: Pubkey,
    second_owner: Pubkey,
    numerator: u32,
) -> Instruction {
    let mut data = SPLIT_POSITION2.to_vec();
    data.extend_from_slice(&numerator.to_le_bytes());
    Instruction {
        program_id: PROGRAM_ID,
        accounts: metas(
            true,
            &[
                (pool, false, true),
                (first_position, false, true),
                (first_nft_account, false, false),
                (second_position, false, true),
                (second_nft_account, false, false),
                (first_owner, true, false),
                (second_owner, true, false),
            ],
        ),
        data,
    }
}

pub struct ClaimPositionFeeAccounts {
    pub pool: Pubkey,
    pub position: Pubkey,
    pub token_a_account: Pubkey,
    pub token_b_account: Pubkey,
    pub token_a_vault: Pubkey,
    pub token_b_vault: Pubkey,
    pub token_a_mint: Pubkey,
    pub token_b_mint: Pubkey,
    pub position_nft_account: Pubkey,
    pub signer: Pubkey,
    pub token_a_program: Pubkey,
    pub token_b_program: Pubkey,
}

/// `claim_position_fee`: pays the position's pending fees to the two token accounts.
pub fn claim_position_fee(a: &ClaimPositionFeeAccounts) -> Instruction {
    Instruction {
        program_id: PROGRAM_ID,
        accounts: metas(
            true,
            &[
                (POOL_AUTHORITY, false, false),
                (a.pool, false, false),
                (a.position, false, true),
                (a.token_a_account, false, true),
                (a.token_b_account, false, true),
                (a.token_a_vault, false, true),
                (a.token_b_vault, false, true),
                (a.token_a_mint, false, false),
                (a.token_b_mint, false, false),
                (a.position_nft_account, false, false),
                (a.signer, true, false),
                (a.token_a_program, false, false),
                (a.token_b_program, false, false),
            ],
        ),
        data: CLAIM_POSITION_FEE.to_vec(),
    }
}

pub struct SwapAccounts {
    pub pool: Pubkey,
    pub input_token_account: Pubkey,
    pub output_token_account: Pubkey,
    pub token_a_vault: Pubkey,
    pub token_b_vault: Pubkey,
    pub token_a_mint: Pubkey,
    pub token_b_mint: Pubkey,
    /// The owner of the input account; signs.
    pub payer: Pubkey,
    pub token_a_program: Pubkey,
    pub token_b_program: Pubkey,
}

/// v0.30 (the fold-in): `swap(amount_in, minimum_amount_out)`, no referral (the program's id in the optional slot, as
/// the site sends it). cp-amm takes the direction from the input account's mint and refuses `ExceededSlippage` when
/// the output would be under the minimum: the price limit of `buy_and_burn`.
pub fn swap(a: &SwapAccounts, amount_in: u64, minimum_amount_out: u64) -> Instruction {
    let mut data = Vec::with_capacity(8 + 8 + 8);
    data.extend_from_slice(&SWAP);
    data.extend_from_slice(&amount_in.to_le_bytes());
    data.extend_from_slice(&minimum_amount_out.to_le_bytes());
    Instruction {
        program_id: PROGRAM_ID,
        accounts: metas(
            true,
            &[
                (POOL_AUTHORITY, false, false),
                (a.pool, false, true),
                (a.input_token_account, false, true),
                (a.output_token_account, false, true),
                (a.token_a_vault, false, true),
                (a.token_b_vault, false, true),
                (a.token_a_mint, false, false),
                (a.token_b_mint, false, false),
                (a.payer, true, false),
                (a.token_a_program, false, false),
                (a.token_b_program, false, false),
                (PROGRAM_ID, false, false),
            ],
        ),
        data,
    }
}

/// Token-2022 `TransferChecked` (instruction 12), laid out as in the classic program.
pub fn token_2022_transfer_checked(source: Pubkey, mint: Pubkey, destination: Pubkey, authority: Pubkey, amount: u64, decimals: u8) -> Instruction {
    let mut data = vec![12u8];
    data.extend_from_slice(&amount.to_le_bytes());
    data.push(decimals);
    Instruction {
        program_id: TOKEN_2022_PROGRAM_ID,
        accounts: metas(false, &[(source, false, true), (mint, false, false), (destination, false, true), (authority, true, false)]),
        data,
    }
}

/// Token-2022 `CloseAccount` (instruction 9).
pub fn token_2022_close_account(account: Pubkey, destination: Pubkey, owner: Pubkey) -> Instruction {
    Instruction {
        program_id: TOKEN_2022_PROGRAM_ID,
        accounts: metas(false, &[(account, false, true), (destination, false, true), (owner, true, false)]),
        data: vec![9u8],
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn disc(name: &str) -> [u8; 8] {
        let h = solana_sha256_hasher::hash(format!("global:{name}").as_bytes()).to_bytes();
        h[..8].try_into().unwrap()
    }

    #[test]
    fn discriminators_and_pdas() {
        assert_eq!(disc("initialize_pool"), INITIALIZE_POOL);
        assert_eq!(disc("create_position"), CREATE_POSITION);
        assert_eq!(disc("permanent_lock_position"), PERMANENT_LOCK_POSITION);
        assert_eq!(disc("split_position2"), SPLIT_POSITION2);
        assert_eq!(disc("claim_position_fee"), CLAIM_POSITION_FEE);
        assert_eq!(disc("swap"), SWAP);
        assert_eq!(Pubkey::find_program_address(&[b"pool_authority"], &PROGRAM_ID).0, POOL_AUTHORITY);
        assert_eq!(Pubkey::find_program_address(&[b"__event_authority"], &PROGRAM_ID).0, EVENT_AUTHORITY);
    }

    /// Phase 1 on devnet opened 500,000 tokens against 1 SOL at this square root (the v19 phase 1 devnet proof).
    #[test]
    fn opening_matches_phase_one_and_fits() {
        let o = opening(1_000_000_000, 500_000_000_000).unwrap();
        assert_eq!(o.sqrt_price, 824_963_474_247_118_971);
        assert!(o.token_amount <= 500_000_000_000 && o.sol_amount <= 1_000_000_000);
        // Maximal: one more unit of liquidity overflows one side.
        let (p, l) = (BigUint::from(o.sqrt_price), BigUint::from(o.liquidity + 1));
        let (min, max) = (BigUint::from(MIN_SQRT_PRICE), BigUint::from(MAX_SQRT_PRICE));
        let a = ceil_div(&(&l * (&max - &p)), &(&p * &max));
        let b = ceil_div(&(&l * (&p - &min)), &(BigUint::from(1u8) << 128u32));
        assert!(a > BigUint::from(500_000_000_000u64) || b > BigUint::from(1_000_000_000u64));
    }

    #[test]
    fn opening_over_the_float_range() {
        let reserve = 500_000_000_000_000u64; // 500,000,000 tokens in atoms
        for sol in [1u64, 1_000, 10_000_000, 1_000_000_000, 123_456_789_012, 50_000_000_000_000, u64::MAX / 2] {
            let o = opening(sol, reserve).unwrap();
            assert!(o.token_amount <= reserve && o.sol_amount <= sol, "{sol}");
        }
    }
}
