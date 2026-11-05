//! Host side only (never compiled into the program): every constant a client
//! needs, emitted as JSON for `idl/gen.mjs`, which merges it with the Anchor IDL
//! into `idl/constants.json` and `idl/constants.ts`.
//!
//! The numbers come from the compiled crate and program, not from a document,
//! so a change here is a change everywhere the moment the contract is
//! regenerated, and `cargo test -p bouncer` fails while `idl/source.json` is
//! stale (see `tests/contract_current.rs`).

use crate::state::PlatformVault;
use crate::{metadata, meteora};
use anchor_lang::prelude::Pubkey;
use auction_core::accounts::{Bid, Config, Histogram, Launch, SettlementRecord, Vault, COMMITMENT_LEN, DISCRIMINATOR, G1_COMPRESSED, PUBKEY, SEALED_BID_LEN};
use auction_core::beacon::{QUICKNET_CHAIN_HASH, QUICKNET_GENESIS, QUICKNET_PERIOD, REVEAL_MARGIN_SECS};
use auction_core::close::{COLD_CLOSE_GRACE_SECS, DEFAULT_WINDOW_SECS, LANDING_GRACE_SECS, MAX_WINDOW_SECS, MIN_WINDOW_AT_LANDING_SECS, MIN_WINDOW_SECS};
use auction_core::grid::{BAND_EDGE_MULTIPLE, FINE_TICKS, MAX_FLOOR_VALUE, MAX_TICK, MIN_FLOOR_VALUE, MULT, SCALE_BITS, TICK_COUNT};
use auction_core::params::{ConfigValues, DEVNET, LAMPORTS_PER_SOL, PRODUCTION};
use auction_core::supply::{ATOMS_PER_TOKEN, FLOAT, POOL_RESERVE, TOKEN_DECIMALS, TOTAL_SUPPLY, TOTAL_SUPPLY_TOKENS};
use std::fmt::Write;

/// The cluster this build targets, fixed by the `mainnet` cargo feature.
pub const CLUSTER: &str = if cfg!(feature = "mainnet") { "mainnet-beta" } else { "devnet" };

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn seed(s: &[u8]) -> String {
    String::from_utf8(s.to_vec()).expect("seeds are ascii")
}

fn key(k: &Pubkey) -> String {
    k.to_string()
}

fn config_values(out: &mut String, name: &str, c: &ConfigValues) {
    write!(
        out,
        "\"{name}\":{{\"floor_value\":\"{}\",\"min_bid\":\"{}\",\"abort_after_secs\":{},\"delivery_fee_bps\":{},\"creator_lp_bps\":{},\"crank_bond\":\"{}\",\"raise_fee_bps\":{},\"raise_fee_creator_share_bps\":{},\"processing_charge\":\"{}\",\"attest_bids\":{},\"reveal_margin_secs\":{},\"delivery_reward\":\"{}\",\"metadata_reserve\":\"{}\"}}",
        c.floor_value, c.min_bid, c.abort_after_secs, c.delivery_fee_bps, c.creator_lp_bps, c.crank_bond, c.raise_fee_bps, c.raise_fee_creator_share_bps, c.processing_charge, c.attest_bids, c.reveal_margin_secs, c.delivery_reward, c.metadata_reserve
    )
    .unwrap();
}

/// The whole table as one JSON document. Every u64 that can exceed 2^53 is a
/// decimal string so JavaScript reads it exactly (`BigInt`).
pub fn emit_json() -> String {
    let mut o = String::with_capacity(32 * 1024);
    o.push('{');
    write!(o, "\"program_id\":\"{}\",\"cluster\":\"{}\",\"layout_version\":{},", key(&crate::ID), CLUSTER, crate::LAYOUT_VERSION).unwrap();
    write!(
        o,
        "\"seeds\":{{\"config\":\"{}\",\"launch\":\"{}\",\"mint\":\"{}\",\"vault\":\"{}\",\"token_vault\":\"{}\",\"bid\":\"{}\",\"settlement\":\"{}\",\"pool_wsol\":\"{}\",\"pool_tokens\":\"{}\",\"pool_creator\":\"{}\",\"position_nft\":\"{}\",\"hist\":\"{}\",\"fee_vault\":\"{}\",\"burn_vault\":\"{}\"}},",
        seed(crate::CONFIG_SEED),
        seed(crate::LAUNCH_SEED),
        seed(crate::MINT_SEED),
        seed(crate::VAULT_SEED),
        seed(crate::TOKEN_VAULT_SEED),
        seed(crate::BID_SEED),
        seed(crate::SETTLEMENT_SEED),
        seed(crate::POOL_WSOL_SEED),
        seed(crate::POOL_TOKENS_SEED),
        seed(crate::POOL_CREATOR_SEED),
        seed(crate::POSITION_NFT_SEED),
        seed(crate::HIST_SEED),
        seed(crate::FEE_VAULT_SEED),
        seed(crate::BURN_VAULT_SEED)
    )
    .unwrap();
    // 0.29: two bands. Ticks 0 to fine_ticks - 1 step by fine_step_percent (0.25); tick fine_ticks is the first at or
    // above band_edge_multiple times the floor and every step from there is coarse_step_percent (1); the top is pinned
    // to the 0.28 grid's top, so the range is unchanged. The histogram counts lamports (u64), no unit and no cap.
    write!(
        o,
        "\"grid\":{{\"tick_count\":{},\"max_tick\":{},\"scale_bits\":{},\"min_floor_value\":\"{}\",\"max_floor_value\":\"{}\",\"fine_ticks\":{},\"band_edge_multiple\":{},\"fine_step_percent\":0.25,\"coarse_step_percent\":1,\"mult\":[",
        TICK_COUNT, MAX_TICK, SCALE_BITS, MIN_FLOOR_VALUE, MAX_FLOOR_VALUE, FINE_TICKS, BAND_EDGE_MULTIPLE
    )
    .unwrap();
    for (i, m) in MULT.iter().enumerate() {
        if i > 0 {
            o.push(',');
        }
        write!(o, "\"{m}\"").unwrap();
    }
    o.push_str("]},");
    write!(
        o,
        "\"supply\":{{\"token_decimals\":{},\"atoms_per_token\":\"{}\",\"total_supply_tokens\":\"{}\",\"total_supply\":\"{}\",\"float\":\"{}\",\"pool_reserve\":\"{}\"}},",
        TOKEN_DECIMALS, ATOMS_PER_TOKEN, TOTAL_SUPPLY_TOKENS, TOTAL_SUPPLY, FLOAT, POOL_RESERVE
    )
    .unwrap();
    write!(
        o,
        "\"window\":{{\"min_window_secs\":{},\"max_window_secs\":{},\"default_window_secs\":{},\"cold_close_grace_secs\":{},\"landing_grace_secs\":{},\"min_window_at_landing_secs\":{}}},",
        MIN_WINDOW_SECS, MAX_WINDOW_SECS, DEFAULT_WINDOW_SECS, COLD_CLOSE_GRACE_SECS, LANDING_GRACE_SECS, MIN_WINDOW_AT_LANDING_SECS
    )
    .unwrap();
    write!(
        o,
        "\"beacon\":{{\"chain_hash\":\"{}\",\"genesis\":{},\"period\":{},\"reveal_margin_secs\":{},\"reveal_margin_min_secs\":{},\"reveal_margin_max_secs\":{},\"reveal_round_slack\":{},\"round_hints_len\":{},\"public_key_hex\":\"{}\"}},",
        QUICKNET_CHAIN_HASH,
        QUICKNET_GENESIS,
        QUICKNET_PERIOD,
        REVEAL_MARGIN_SECS,
        auction_core::params::REVEAL_MARGIN_MIN_SECS,
        auction_core::params::REVEAL_MARGIN_MAX_SECS,
        crate::REVEAL_ROUND_SLACK,
        crate::h2c::HINTS_LEN,
        hex(&crate::curve_constants::QUICKNET_PUBLIC_KEY_COMPRESSED)
    )
    .unwrap();
    write!(
        o,
        "\"bounds\":{{\"min_abort_after_secs\":{},\"max_abort_after_secs\":{},\"max_delivery_fee_bps\":{},\"max_raise_fee_bps\":{},\"bps_denominator\":{},\"max_name\":{},\"max_symbol\":{},\"max_uri\":{},\"max_crank_bond_lamports\":{},\"mainnet_crank_sunk_lamports\":{},\"lamports_per_sol\":\"{}\",\"min_processing_secs\":{},\"processing_charge_lamports\":{},\"max_processing_charge\":{},\"step_allowance_lamports\":{},\"delivery_reward_lamports\":{},\"metadata_reserve_lamports\":{},\"pool_cash_release_secs\":{},\"reveal_margin_min_secs\":{},\"reveal_margin_max_secs\":{},\"max_delivery_reward_lamports\":{},\"min_metadata_reserve_lamports\":{},\"max_metadata_reserve_lamports\":{},\"creator_lp_bps\":{},\"raise_fee_bps\":{},\"raise_fee_creator_share_bps\":{},\"park_after_secs\":{}}},",
        crate::MIN_ABORT_AFTER_SECS,
        crate::MAX_ABORT_AFTER_SECS,
        crate::MAX_DELIVERY_FEE_BPS,
        auction_core::MAX_RAISE_FEE_BPS,
        crate::BPS_DENOMINATOR,
        metadata::MAX_NAME,
        metadata::MAX_SYMBOL,
        metadata::MAX_URI,
        auction_core::MAX_CRANK_BOND_LAMPORTS,
        auction_core::MAINNET_CRANK_SUNK_LAMPORTS,
        LAMPORTS_PER_SOL,
        crate::MIN_PROCESSING_SECS,
        crate::PROCESSING_CHARGE_LAMPORTS,
        auction_core::MAX_PROCESSING_CHARGE,
        crate::STEP_ALLOWANCE_LAMPORTS,
        crate::DELIVERY_REWARD_LAMPORTS,
        crate::METADATA_RESERVE_LAMPORTS,
        crate::POOL_CASH_RELEASE_SECS,
        // v0.30: the bounds of the three Squad-adjustable values and the three fee constants.
        crate::REVEAL_MARGIN_MIN_SECS,
        crate::REVEAL_MARGIN_MAX_SECS,
        crate::MAX_DELIVERY_REWARD_LAMPORTS,
        crate::MIN_METADATA_RESERVE_LAMPORTS,
        crate::MAX_METADATA_RESERVE_LAMPORTS,
        crate::CREATOR_LP_BPS,
        crate::RAISE_FEE_BPS,
        crate::RAISE_FEE_CREATOR_SHARE_BPS,
        // v0.32: `park_bid`'s catch-all.
        crate::PARK_AFTER_SECS
    )
    .unwrap();
    o.push_str("\"config\":{");
    config_values(&mut o, "production", &PRODUCTION);
    o.push(',');
    config_values(&mut o, "devnet", &DEVNET);
    o.push_str("},");
    // 0.29: the bid attestation (section 4 of the 0.29 design of 2026-10-20): the message a service signs, the Ed25519
    // instruction `commit` expects immediately before it, and the life bound on the expiry.
    write!(
        o,
        "\"attestation\":{{\"tag\":\"{}\",\"message_len\":{},\"max_life_secs\":{},\"ed25519_program\":\"{}\",\"ix_len\":{},\"public_key_offset\":{},\"signature_offset\":{},\"message_offset\":{},\"attestor_slots\":3}},",
        core::str::from_utf8(crate::ATTEST_TAG).unwrap(),
        crate::ATTEST_MESSAGE_LEN,
        crate::ATTEST_MAX_LIFE_SECS,
        key(&crate::ED25519_PROGRAM_ID),
        crate::ATTEST_IX_LEN,
        crate::ATTEST_PUBKEY_OFFSET,
        crate::ATTEST_SIGNATURE_OFFSET,
        crate::ATTEST_MESSAGE_OFFSET
    )
    .unwrap();
    // 0.29 (2026-10-20): the creation permit, the same instruction layout over the 40-byte message
    // expiry || sha256(preimage); the preimage is tag || program || creator || launch || params hash || expiry, and
    // the params hash is the sha256 of the create_launch instruction data after the discriminator.
    write!(
        o,
        "\"create_attestation\":{{\"tag\":\"{}\",\"preimage_len\":{},\"message_len\":{},\"ix_len\":{},\"expiry_offset\":0,\"digest\":\"sha256\",\"params_hash\":\"sha256(create_launch instruction data[8..])\",\"waiver\":false}},",
        core::str::from_utf8(crate::ATTEST_CREATE_TAG).unwrap(),
        crate::ATTEST_CREATE_PREIMAGE_LEN,
        crate::ATTEST_CREATE_MESSAGE_LEN,
        crate::ATTEST_CREATE_IX_LEN
    )
    .unwrap();
    // 2026-10-21 (review finding F7): every Launch layout ever written, with the offsets collect_platform_fees reads
    // (state.rs LAUNCH_LAYOUTS); the keeper's fee claim scans every length.
    o.push_str("\"launch_layouts\":[");
    for (i, l) in crate::state::LAUNCH_LAYOUTS.iter().enumerate() {
        write!(
            o,
            "{}{{\"len\":{},\"version\":{},\"state\":{},\"token_mint\":{},\"lp_owner\":{},\"builds\":\"{}\"}}",
            if i == 0 { "" } else { "," },
            l.len,
            l.version,
            l.state,
            l.token_mint,
            l.lp_owner,
            l.builds
        )
        .unwrap();
    }
    o.push_str("],");
    write!(
        o,
        "\"sizes\":{{\"discriminator\":{},\"pubkey\":{},\"g1_compressed\":{},\"sealed_bid_len\":{},\"commitment_len\":{}}},",
        DISCRIMINATOR, PUBKEY, G1_COMPRESSED, SEALED_BID_LEN, COMMITMENT_LEN
    )
    .unwrap();
    write!(
        o,
        "\"account_len\":{{\"Config\":{},\"Launch\":{},\"Bid\":{},\"Vault\":{},\"SettlementRecord\":{},\"Histogram\":{},\"PlatformVault\":{}}},\"histogram_init_len\":{},",
        Config::LEN,
        Launch::LEN,
        Bid::LEN,
        Vault::LEN,
        SettlementRecord::LEN,
        Histogram::LEN,
        PlatformVault::LEN,
        Histogram::INIT_LEN
    )
    .unwrap();
    o.push_str(concat!(
        "\"enums\":{",
        "\"LaunchState\":{\"Open\":0,\"Closed\":1,\"Settled\":2,\"PoolLive\":3,\"Finalized\":4,\"Aborted\":5,\"Failed\":6,\"Initializing\":7},",
        "\"BidState\":{\"Sealed\":0,\"Revealed\":1,\"Invalid\":2,\"Done\":3},",
        "\"CloseReason\":{\"WindowElapsed\":0},",
        "\"CreatorBidState\":{\"NoBid\":0,\"Revealed\":1,\"Invalid\":2},",
        "\"BidFlags\":{\"Claim\":1,\"Creator\":2},",
        "\"TradingState\":{\"None\":0,\"Frozen\":1,\"Open\":2},",
        "\"DeliveryTerms\":{\"TokenFee\":0,\"BidRent\":1},",
        "\"LpLockState\":{\"None\":0,\"Creator\":1,\"Protocol\":2,\"Both\":3}",
        "},"
    ));
    write!(
        o,
        "\"external\":{{\"metadata_program\":\"{}\",\"meteora_cp_amm\":\"{}\",\"meteora_config\":\"{}\",\"meteora_pool_authority\":\"{}\",\"meteora_event_authority\":\"{}\",\"token_2022_program\":\"{}\"}}",
        key(&metadata::METADATA_PROGRAM_ID),
        key(&meteora::PROGRAM_ID),
        key(&meteora::CONFIG),
        key(&meteora::POOL_AUTHORITY),
        key(&meteora::EVENT_AUTHORITY),
        key(&meteora::TOKEN_2022_PROGRAM_ID)
    )
    .unwrap();
    o.push_str("}\n");
    o
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_enums_match_the_crate() {
        use auction_core::accounts::{BidState, LaunchState};
        assert_eq!(LaunchState::Failed as u8, 6);
        assert_eq!(BidState::Done as u8, 3);
        assert!(emit_json().contains("\"Failed\":6"));
    }
}
