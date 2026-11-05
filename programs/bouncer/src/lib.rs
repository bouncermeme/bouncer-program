//! Bouncer: sealed bid uniform price auction at token genesis, sealed with
//! drand quicknet timelock encryption and decrypted on chain.
//!
//! Every formula comes from `auction_core`; this crate only moves accounts and
//! lamports around it. INTERFACE.md is the contract this implements.

#![allow(unexpected_cfgs)]

pub mod bls;
#[cfg(not(target_os = "solana"))]
pub mod contract;
pub mod curve_constants;
pub mod errors;
pub mod h2c;
pub mod h2c_constants;
pub mod events;
pub mod metadata;
pub mod meteora;
pub mod state;

use anchor_lang::prelude::*;
use anchor_lang::system_program::{self, CreateAccount, Transfer};
use anchor_spl::associated_token::{self, AssociatedToken};
use anchor_spl::token::{self, Burn, CloseAccount, FreezeAccount, InitializeAccount3, InitializeMint2, Mint, MintTo, SetAuthority, SyncNative, ThawAccount, Token, TokenAccount};
use auction_core::close::{BidOutcome, CloseReason, RejectReason};
use auction_core::{Settlement, WindowParams, TICK_COUNT};
use errors::BouncerError;
use events::*;
use state::*;

declare_id!("DK5RcZiHhp5uV99PgwTmBsZWwFJS4G9HrDAsEbPRPu9r");

pub const LAYOUT_VERSION: u8 = 1;

/// How many rounds past the earliest legal reveal round a creator may pick (60 s).
pub const REVEAL_ROUND_SLACK: u64 = 20;
/// 0.22: the least time `create_launch` accepts between the reveal round's publication and the
/// recovery deadline, so no launch can be created with a schedule nobody could finish.
pub const MIN_PROCESSING_SECS: u64 = 300;
/// Bounds on `Config.abort_after_secs`, the recovery delay. The floor covers the build's starting reveal
/// margin (15 s since v0.31), the 60 s of slack and `MIN_PROCESSING_SECS` (0.22), so every valid config leaves a
/// processing window; the ceiling stops a fat finger from stranding deposits for months.
pub const MIN_ABORT_AFTER_SECS: u64 = auction_core::beacon::REVEAL_MARGIN_SECS as u64 + REVEAL_ROUND_SLACK * 3 + MIN_PROCESSING_SECS;
/// 0.22: the processing charge a bidder pays at commit on top of the deposit. It is held in the
/// vault and paid to whoever moves that bid out of Sealed (Revealed or Invalid), once, in the same
/// instruction; a bid never processed gets it back with its deposit. Fixed and published: not a
/// share of anything and not a priority fee reimbursement.
/// 0.24: 10,000 (was 1,000). A reveal of k bids pays its processor 10,000 k against a base fee of
/// 5,000 per signature, so a reveal of any size breaks even with up to 5,000 lamports of priority
/// fee per transaction; at 1,000 a reveal of fewer than 5 bids was a subsidy. Each bid records the
/// charge it paid (`Bid.processing_charge`), so bids placed under an earlier value are paid and
/// refunded at that value.
/// 0.29: a config term. This is the decided value (`PRODUCTION.processing_charge`, the same on devnet); the
/// program charges `Launch.processing_charge`, copied from `Config.processing_charge` at genesis, never this
/// constant. The config bounds it by `MAX_PROCESSING_CHARGE`.
pub const PROCESSING_CHARGE_LAMPORTS: u64 = auction_core::PRODUCTION.processing_charge;
/// 0.29: the bid attestation (section 4 of the 0.29 design of 2026-10-20; design B of
/// the griefing review of 2026-10-20, section 14). A launch whose `attest_required` is 1 accepts a
/// `commit` only when the instruction immediately before it is the Ed25519 program verifying one signature,
/// by one of the config's `attestors`, over this fixed message:
/// `ATTEST_TAG` (21 bytes) || program id (32) || launch (32) || bidder (32) || expiry as i64 little endian (8),
/// `ATTEST_MESSAGE_LEN` bytes, with the key, the signature and the message in that instruction's own data at the
/// precompile's standard single-signature offsets. The precompile verified the signature before any instruction
/// ran, so `commit` checks placement, layout, key, content and time only. The expiry must not have passed and may
/// be at most `ATTEST_MAX_LIFE_SECS` ahead, so a misconfigured service cannot mint attestations that outlive a window.
pub const ATTEST_TAG: &[u8; 21] = b"bouncer/attest/bid/v1";
pub const ATTEST_MESSAGE_LEN: usize = 21 + 32 + 32 + 32 + 8;
pub const ATTEST_MAX_LIFE_SECS: i64 = 900;
/// The Ed25519 precompile's single-signature layout: 1 count byte, 1 pad, the 14-byte offsets record at 2, then
/// the key at 16, the signature at 48 and the message at 112 (solana-sdk `ed25519_instruction.rs`).
pub const ATTEST_PUBKEY_OFFSET: usize = 16;
pub const ATTEST_SIGNATURE_OFFSET: usize = 48;
pub const ATTEST_MESSAGE_OFFSET: usize = 112;
pub const ATTEST_IX_LEN: usize = ATTEST_MESSAGE_OFFSET + ATTEST_MESSAGE_LEN;
/// 0.29 (2026-10-20): creation is gated like bidding, with no waiver. `create_launch` must be preceded,
/// immediately, by an Ed25519 instruction by a listed attestor, in the bid permit's instruction layout, over the
/// 40-byte message `expiry i64 LE (8) || sha256(preimage) (32)`, where the preimage is
/// `ATTEST_CREATE_TAG` (24) || program id (32) || creator (32) || launch (32) || params hash (32) || expiry i64 LE (8),
/// `ATTEST_CREATE_PREIMAGE_LEN` bytes. The attestor signs the digest form so the create transaction fits the packet
/// with Metaplex's longest metadata (the full preimage in the instruction would not); the expiry travels in the
/// clear so the program can bound it, and it is digested too, so it cannot be moved. The params hash is the sha256
/// of the `create_launch` instruction's own data after the 8-byte discriminator (mint_salt, close_ts,
/// reveal_round, round_point, round_hints, name, symbol, uri, the expected terms: every immutable parameter as
/// sent), so a permit opens one exact launch and nothing else. The cluster is bound by the attestor set: each
/// deployment's config lists its own keys and the program cannot read the genesis hash. When no attestor answers,
/// new launches wait; every existing launch, its settlement and its exits need no permit.
pub const ATTEST_CREATE_TAG: &[u8; 24] = b"bouncer/attest/create/v1";
pub const ATTEST_CREATE_PREIMAGE_LEN: usize = 24 + 32 + 32 + 32 + 32 + 8;
pub const ATTEST_CREATE_MESSAGE_LEN: usize = 8 + 32;
pub const ATTEST_CREATE_IX_LEN: usize = ATTEST_MESSAGE_OFFSET + ATTEST_CREATE_MESSAGE_LEN;
pub const ED25519_PROGRAM_ID: Pubkey = Pubkey::from_str_const("Ed25519SigVerify111111111111111111111111111");
/// 0.22: the fixed amount the operating prepay pays the signer of an operating step (settle,
/// create_pool, lock_liquidity, burn_unsold) on top of the rent that step sank: one 5,000 lamport
/// signature plus a fixed 20,000. The same whatever priority fee the signer chose.
pub const STEP_ALLOWANCE_LAMPORTS: u64 = 25_000;
/// 0.26: what a pushed delivery pays its caller, out of the delivered bid's own account, on top of
/// the token account rent the caller advanced. The same 25,000 as an operating step: one 5,000
/// lamport signature plus a fixed 20,000. Copied into each launch at genesis
/// (`Launch.delivery_reward`) and read there, so a later build's value never reaches a launch that
/// people have already bid on. Paid only on launches with `delivery_terms::BID_RENT`.
pub const DELIVERY_REWARD_LAMPORTS: u64 = 25_000;
/// 0.29 tenth candidate (review finding N3, 2026-10-21): what the prepay's return (`lock_liquidity`, `release_pool_cash`)
/// holds back in the vault for `finish_mint` while the metadata is not yet written: the metadata's measured cost
/// on the ninth candidate (13,733,800 lamports: the account's rent at 5,080 a byte plus Metaplex's 0.01 SOL fee)
/// plus the step allowance, rounded up. `finish_mint` pays its payer from it and the rest to the creator. Bounded:
/// a Metaplex fee above this leaves the payer short by the difference, never the creator or a bidder.
pub const METADATA_RESERVE_LAMPORTS: u64 = 14_000_000;
/// v0.30 (2026-10-27): the hard bounds of the three Squad-adjustable operating values (`Config.reveal_margin_secs`,
/// `delivery_reward`, `metadata_reserve`). The margin starts at `auction_core::beacon::REVEAL_MARGIN_SECS` (120) within
/// 60 to 300 s; the reward at `DELIVERY_REWARD_LAMPORTS` up to 0.0005 SOL; the reserve at `METADATA_RESERVE_LAMPORTS`
/// within 0.01 and 0.05 SOL. Nothing else a launch copies from the config is adjustable: the creator terms are the
/// creator's to sign and the fee terms below are constants.
pub const REVEAL_MARGIN_MIN_SECS: u32 = auction_core::params::REVEAL_MARGIN_MIN_SECS;
pub const REVEAL_MARGIN_MAX_SECS: u32 = auction_core::params::REVEAL_MARGIN_MAX_SECS;
pub const MAX_DELIVERY_REWARD_LAMPORTS: u64 = auction_core::params::MAX_DELIVERY_REWARD_LAMPORTS;
pub const MIN_METADATA_RESERVE_LAMPORTS: u64 = auction_core::params::MIN_METADATA_RESERVE_LAMPORTS;
pub const MAX_METADATA_RESERVE_LAMPORTS: u64 = auction_core::params::MAX_METADATA_RESERVE_LAMPORTS;
/// v0.30 (2026-10-27): the fee terms are program constants, never config values. The creator's share of the
/// pool's LP (2,188 basis points: 21.875 percent of the 1.6 percent of volume Meteora's 2 percent pool fee leaves after
/// its fifth is 0.35 percent, rounded up in the creator's favour; the platform position keeps 78.125 percent, which the
/// buyback router splits 60/40 between the treasury and the burn), the raise fee (1 percent of the cleared raise) and
/// the creator's half of it. The three Config fields and the signed terms keep their layout and their place in
/// `LaunchTerms`; `validate_config` refuses any other value (`TermsPinned`), so no update can move them.
pub const CREATOR_LP_BPS: u16 = auction_core::params::CREATOR_LP_BPS;
pub const RAISE_FEE_BPS: u16 = auction_core::params::RAISE_FEE_BPS;
pub const RAISE_FEE_CREATOR_SHARE_BPS: u16 = auction_core::params::RAISE_FEE_CREATOR_SHARE_BPS;
/// 0.29 tenth candidate (review finding F2): how long after `settle` `release_pool_cash` waits, so the keeper's lock
/// (minutes after the pool) is never raced by a stranger's release, which would leave that lock's payer unpaid.
pub const POOL_CASH_RELEASE_SECS: i64 = 3 * 86_400;
/// v0.32 (2026-10-28, Q0): `park_bid`'s catch-all. A payout still open this long after the pool was created (or
/// after the close of a launch that failed or aborted) may be parked whatever the reason it has not landed: parking
/// moves nothing to anyone but a place held for its bidder, so it never opens trading early or takes anything.
pub const PARK_AFTER_SECS: i64 = 600;
pub const MAX_ABORT_AFTER_SECS: u64 = 30 * 86_400;
/// Ceiling on `Config.delivery_fee_bps`. 0 since 0.26 (500, 5 percent of a pushed delivery, until
/// then): a pushed delivery is repaid from the bid account's rent and takes no tokens, so a config
/// can no longer be given a token fee. A config written before 0.26 may still hold one, and
/// `create_launch` refuses it there.
pub const MAX_DELIVERY_FEE_BPS: u16 = 0;
/// `Config.creator_lp_bps` is a share of 10,000.
pub const BPS_DENOMINATOR: u64 = 10_000;
/// v0.30 (2026-10-27): of the platform's trading fees `collect_platform_fees` claims into the fee vault, the
/// basis points moved to the burn vault for the buy-and-burn (40 percent); the rest goes to the treasury as native SOL.
/// The lamport of rounding, when there is one, stays on the treasury's side.
pub const BUYBACK_BURN_BPS: u64 = 4_000;

/// 0.29: every instruction that takes a launch requires the account to be exactly `Launch::LEN` bytes
/// (`LaunchLayoutUnknown`). The 0.29 layout moved every field after offset 296 (the histogram left the
/// account), so a launch created under 0.28 or earlier (9,568 bytes) would otherwise be read with its fields
/// displaced; Anchor's loader only checks a minimum length. Those launches are stranded, as INTERFACE.md's
/// layout rule says a layout break does; the emergency update pause sees every one of them finalized before
/// the upgrade lands.
/// Seeds.
pub const CONFIG_SEED: &[u8] = b"config";

pub const LAUNCH_SEED: &[u8] = b"launch";
pub const VAULT_SEED: &[u8] = b"vault";
pub const TOKEN_VAULT_SEED: &[u8] = b"token_vault";
/// The launch token's mint (0.19), `["mint", creator, mint_salt LE]`. It does not exist until
/// `create_pool` creates it in the same instruction that opens the pool, so the pool's address
/// cannot be taken first (the pool squatting fix, 2026-09-27). Until 0.18 the mint was a
/// fresh keypair created at genesis.
pub const MINT_SEED: &[u8] = b"mint";
pub const BID_SEED: &[u8] = b"bid";
pub const SETTLEMENT_SEED: &[u8] = b"settlement";
pub const POOL_WSOL_SEED: &[u8] = b"pool_wsol";
pub const POOL_TOKENS_SEED: &[u8] = b"pool_tokens";
/// The launch's pool creator (0.19: Meteora's pool creator and payer, and owner of
/// the platform position's NFT): a dataless system account this program signs for.
pub const POOL_CREATOR_SEED: &[u8] = b"pool_creator";
/// Position NFT mints (0.19), `["position_nft", launch, side]`: side 0 the creator's, 1 the platform's.
pub const POSITION_NFT_SEED: &[u8] = b"position_nft";
/// 0.29: the launch's histogram, `["hist", launch]`; created at genesis (two instructions), paid by the creator as a
/// launch cost, never closed: the auction's permanent receipt.
pub const HIST_SEED: &[u8] = b"hist";
/// v0.30 (2026-10-27, the buy-and-burn folded into the core): the fee vault, `["fee_vault"]`, a program-owned
/// account that is `Config.lp_owner` on mainnet (the destination every launch records at genesis), so the platform's
/// trading fees land in a wrapped SOL account the program alone controls; and the burn vault, `["burn_vault"]`, the
/// authority (never an account) of the wrapped SOL and BOUNCER token accounts the buy-and-burn runs through.
pub const FEE_VAULT_SEED: &[u8] = b"fee_vault";
pub const BURN_VAULT_SEED: &[u8] = b"burn_vault";
pub const SIDE_CREATOR: u8 = 0;
pub const SIDE_PLATFORM: u8 = 1;
/// `SettlementRecord.lp_lock_state` bits.
/// Bit 0 is the creator's split having completed: `lock_liquidity` sets it and nothing else
/// does, in the same instruction as `split_position2`, the NFT handover and their read back
/// (or with no split at all when `creator_lp_bps` is 0). It says nothing about Meteora's lock
/// status: the platform's genesis position is permanently locked from `create_pool` on.
pub const LOCK_BIT_CREATOR: u8 = 1;
pub const LOCK_BIT_PLATFORM: u8 = 2;

/// The collect gate (0.21): the platform's position may pay its fees out only once the pool
/// exists and the creator's split has completed. Before the split every fee the pool earned sits
/// pending in the platform position, and the split gives the creator its share of them.
fn require_collect_allowed(lp_lock_state: u8) -> Result<()> {
    require!(lp_lock_state & LOCK_BIT_PLATFORM != 0, BouncerError::PlatformNotLocked);
    require!(lp_lock_state & LOCK_BIT_CREATOR != 0, BouncerError::SplitNotDone);
    Ok(())
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy)]
pub struct ConfigArgs {
    pub lp_owner: Pubkey,
    pub floor_value: u64,
    pub min_bid: u64,
    pub abort_after_secs: u64,
    pub delivery_fee_bps: u16,
    pub creator_lp_bps: u16,
    /// The crank bond, lamports (0.16): the measured cost of `create_pool`, at most 1 SOL.
    pub crank_bond: u64,
    /// 0.28: the raise fee, basis points of the cleared raise (at most `MAX_RAISE_FEE_BPS`), and the creator's
    /// share of it in basis points of the fee (at most 10,000). Appended, so a 0.27 argument is a prefix of this one.
    pub raise_fee_bps: u16,
    pub raise_fee_creator_share_bps: u16,
    /// 0.29: the attestor keys (a zero slot is unused), whether new launches require a bid attestation (0 or 1),
    /// and the processing charge each bid pays (at most `MAX_PROCESSING_CHARGE`). Appended, the same way.
    pub attestors: [Pubkey; 3],
    pub attest_bids: u8,
    pub processing_charge: u64,
    /// v0.30: the reveal margin (60 to 300 s), the delivery reward, the metadata reserve and the treasury (proposed, as
    /// `lp_owner` is: it takes effect when it signs `accept_treasury`; naming the current one cancels a proposal).
    /// Appended, the same way.
    pub reveal_margin_secs: u32,
    pub delivery_reward: u64,
    pub metadata_reserve: u64,
    pub treasury: Pubkey,
}

/// v0.30 (2026-10-27): the buy-and-burn's terms, set by `admin_set_buyback` (the ops Squad) after the BOUNCER
/// genesis; its own instruction, so `ConfigArgs` and every update sent before it keep their shape. The pool is the
/// canonical BOUNCER pool on cp-amm (this program's own: token A the mint, token B wrapped SOL); the crankers are the
/// keys allowed to call `buy_and_burn` (keeper 1, keeper 2, an operator wallet; a zero slot is unused); the cap bounds one
/// buy in lamports; the interval is the least seconds between two; the price limit is the most lamports per atom a buy
/// may pay, Q64.64 (`buy_and_burn` demands at least `lamports * 2^64 / price` atoms out; the caller may only raise it).
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug, PartialEq, Eq)]
pub struct BuybackArgs {
    pub bouncer_mint: Pubkey,
    pub bouncer_pool: Pubkey,
    pub burn_crankers: [Pubkey; 3],
    pub buy_cap_lamports: u64,
    pub buy_min_interval_secs: u64,
    pub buy_max_price_x64: u128,
}

/// 0.25: the terms a creator agrees to, stated in `create_launch`'s own data: the six values a
/// launch copies from the config, in the config's own order (`Config` bytes 76..112 are this
/// struct, serialised). `create_launch` refuses `TermsChanged` unless every one equals the config
/// at execution, and then writes the launch and takes the prepay from these, never from the config,
/// so an `admin_update_config` that lands between the creator's signature and the instruction
/// cannot change what the creator gets or pays. Exact equality, not bounds: which direction is
/// better for the creator is not defined for the floor, the minimum or the delay, so a difference
/// means read again and sign again. `lp_owner` is not a term: it is where the platform's own fees
/// go, and no creator money rides on it.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq)]
pub struct LaunchTerms {
    pub floor_value: u64,
    pub min_bid: u64,
    pub abort_after_secs: u64,
    pub delivery_fee_bps: u16,
    pub creator_lp_bps: u16,
    /// The operating prepay debited from the creator in `create_launch`.
    pub crank_bond: u64,
    /// 0.28: the seventh and eighth terms, `Config` bytes 184..188: the raise fee and the creator's share of it.
    pub raise_fee_bps: u16,
    pub raise_fee_creator_share_bps: u16,
}

impl LaunchTerms {
    fn of(config: &Config) -> LaunchTerms {
        LaunchTerms {
            floor_value: config.floor_value,
            min_bid: config.min_bid,
            abort_after_secs: config.abort_after_secs,
            delivery_fee_bps: config.delivery_fee_bps,
            creator_lp_bps: config.creator_lp_bps,
            crank_bond: config.crank_bond,
            raise_fee_bps: config.raise_fee_bps,
            raise_fee_creator_share_bps: config.raise_fee_creator_share_bps,
        }
    }
}

fn validate_config(args: &ConfigArgs) -> Result<()> {
    // The window is irrelevant here; reuse the crate's parameter validation
    // with a legal window so only the protocol numbers are judged.
    let p = WindowParams {
        open_ts: 0,
        window_secs: auction_core::close::DEFAULT_WINDOW_SECS,
        floor_value: args.floor_value,
        min_bid: args.min_bid,
    };
    match p.validate() {
        Ok(()) => {}
        Err(auction_core::Error::FloorValueOutOfRange) => return err!(BouncerError::FloorValueOutOfRange),
        Err(_) => return err!(BouncerError::InvalidConfig),
    }
    require!(
        (MIN_ABORT_AFTER_SECS..=MAX_ABORT_AFTER_SECS).contains(&args.abort_after_secs),
        BouncerError::InvalidConfig
    );
    require!(args.delivery_fee_bps <= MAX_DELIVERY_FEE_BPS, BouncerError::TokenFeeRetired);
    // v0.30: the fee terms are constants; the fields stay for the layout and must carry them.
    require!(
        args.creator_lp_bps == CREATOR_LP_BPS && args.raise_fee_bps == RAISE_FEE_BPS && args.raise_fee_creator_share_bps == RAISE_FEE_CREATOR_SHARE_BPS,
        BouncerError::TermsPinned
    );
    require!(args.crank_bond <= auction_core::MAX_CRANK_BOND_LAMPORTS, BouncerError::InvalidConfig);
    // 0.28: the raise fee is bounded (5 percent is a typo guard, not a decision) and the share is a share.
    require!(args.raise_fee_bps <= auction_core::MAX_RAISE_FEE_BPS && args.raise_fee_creator_share_bps as u64 <= BPS_DENOMINATOR, BouncerError::RaiseFeeTooHigh);
    // 0.24: a fee destination is always named; the default key would be nobody's.
    require!(args.lp_owner != Pubkey::default(), BouncerError::InvalidConfig);
    // 0.29: the charge is bounded (a typo cannot make bidding dear) and never zero (a zero charge would leave every
    // reveal unpaid, and zero is also what a config written before 0.29 reads, see `admin_emergency_update_pause`),
    // the flag is a flag, and requiring attestations with no attestor would refuse every bid on every new launch.
    require!((1..=auction_core::MAX_PROCESSING_CHARGE).contains(&args.processing_charge) && args.attest_bids <= 1, BouncerError::InvalidConfig);
    // 0.29 (2026-10-20): creation is gated with no waiver, so a config with no attestor would refuse every
    // new launch; it is refused here instead, whatever the bid flag says.
    require!(args.attestors.iter().any(|k| *k != Pubkey::default()), BouncerError::InvalidConfig);
    // v0.30: the Squad-adjustable operating values within their hard bounds, and a treasury named (it takes effect only by
    // signing). The recovery delay must leave room past the margin: margin + 3 x slack + the processing minimum.
    require!((REVEAL_MARGIN_MIN_SECS..=REVEAL_MARGIN_MAX_SECS).contains(&args.reveal_margin_secs), BouncerError::RevealMarginOutOfRange);
    require!(
        args.delivery_reward <= MAX_DELIVERY_REWARD_LAMPORTS && (MIN_METADATA_RESERVE_LAMPORTS..=MAX_METADATA_RESERVE_LAMPORTS).contains(&args.metadata_reserve),
        BouncerError::OperatingValueOutOfRange
    );
    require!(args.treasury != Pubkey::default(), BouncerError::InvalidConfig);
    require!(args.abort_after_secs >= args.reveal_margin_secs as u64 + REVEAL_ROUND_SLACK * 3 + MIN_PROCESSING_SECS, BouncerError::InvalidConfig);
    Ok(())
}

/// 0.29: the bid permit's message: tag, program, launch, bidder, expiry (125 bytes).
fn bid_attest_message(launch: Pubkey, bidder: Pubkey, expiry: i64) -> [u8; ATTEST_MESSAGE_LEN] {
    let mut m = [0u8; ATTEST_MESSAGE_LEN];
    m[..21].copy_from_slice(ATTEST_TAG);
    m[21..53].copy_from_slice(&crate::ID.to_bytes());
    m[53..85].copy_from_slice(&launch.to_bytes());
    m[85..117].copy_from_slice(&bidder.to_bytes());
    m[117..125].copy_from_slice(&expiry.to_le_bytes());
    m
}

/// 0.29: the creation permit's message (see `ATTEST_CREATE_TAG`): the expiry in the clear, then the sha256 of the
/// 160-byte preimage (tag, program, creator, launch, params hash, expiry).
fn create_attest_message(creator: Pubkey, launch: Pubkey, params_hash: [u8; 32], expiry: i64) -> [u8; ATTEST_CREATE_MESSAGE_LEN] {
    let mut p = [0u8; ATTEST_CREATE_PREIMAGE_LEN];
    p[..24].copy_from_slice(ATTEST_CREATE_TAG);
    p[24..56].copy_from_slice(&crate::ID.to_bytes());
    p[56..88].copy_from_slice(&creator.to_bytes());
    p[88..120].copy_from_slice(&launch.to_bytes());
    p[120..152].copy_from_slice(&params_hash);
    p[152..160].copy_from_slice(&expiry.to_le_bytes());
    let mut m = [0u8; ATTEST_CREATE_MESSAGE_LEN];
    m[..8].copy_from_slice(&expiry.to_le_bytes());
    m[8..40].copy_from_slice(&solana_sha256_hasher::hash(&p).to_bytes());
    m
}

/// 0.29: the attestation check for a bid (`ATTEST_TAG`) or a creation (`ATTEST_CREATE_TAG`). `instructions` is the
/// Instructions sysvar, whose address the account struct checked. The Ed25519 instruction must come immediately
/// before the caller's and carry one signature over exactly `msg_len` bytes at the standard offsets, by a listed key;
/// the expiry read at `expiry_at` must be at or after now and at most `ATTEST_MAX_LIFE_SECS` ahead, and the message
/// must equal `expected(expiry)`, the caller's own rebuild of it. Every refusal is specific, so the site can tell a
/// stale attestation from a wrong one.
fn check_attestation(instructions: &AccountInfo, attestors: &[Pubkey; 3], msg_len: usize, expiry_at: usize, expected: impl Fn(i64) -> Vec<u8>, now: i64) -> Result<()> {
    use solana_instructions_sysvar::{load_current_index_checked, load_instruction_at_checked};
    let index = load_current_index_checked(instructions).map_err(|_| error!(BouncerError::AttestationMissing))?;
    require!(index >= 1, BouncerError::AttestationMissing);
    let ix = load_instruction_at_checked(index as usize - 1, instructions).map_err(|_| error!(BouncerError::AttestationMissing))?;
    require!(ix.program_id.to_bytes() == ED25519_PROGRAM_ID.to_bytes(), BouncerError::AttestationMissing);
    let d = &ix.data;
    // One signature, and the offsets record must point at this instruction's own key, signature and message, at the
    // standard places (the instruction index u16::MAX means "this instruction").
    require!(d.len() == ATTEST_MESSAGE_OFFSET + msg_len && d[0] == 1 && d[1] == 0, BouncerError::AttestationMissing);
    let at = |o: usize| u16::from_le_bytes([d[o], d[o + 1]]);
    require!(
        at(2) == ATTEST_SIGNATURE_OFFSET as u16
            && at(4) == u16::MAX
            && at(6) == ATTEST_PUBKEY_OFFSET as u16
            && at(8) == u16::MAX
            && at(10) == ATTEST_MESSAGE_OFFSET as u16
            && at(12) == msg_len as u16
            && at(14) == u16::MAX,
        BouncerError::AttestationMissing
    );
    let key = Pubkey::new_from_array(d[ATTEST_PUBKEY_OFFSET..ATTEST_PUBKEY_OFFSET + 32].try_into().unwrap());
    require!(key != Pubkey::default() && attestors.contains(&key), BouncerError::AttestorUnknown);
    let m = &d[ATTEST_MESSAGE_OFFSET..ATTEST_MESSAGE_OFFSET + msg_len];
    let expiry = i64::from_le_bytes(m[expiry_at..expiry_at + 8].try_into().unwrap());
    require!(*m == expected(expiry)[..], BouncerError::AttestationMismatch);
    require!(now <= expiry, BouncerError::AttestationExpired);
    require!(expiry.checked_sub(now).ok_or(BouncerError::Overflow)? <= ATTEST_MAX_LIFE_SECS, BouncerError::AttestationTooLong);
    Ok(())
}

fn now_ts() -> Result<i64> {
    Ok(Clock::get()?.unix_timestamp)
}

/// 0.22: the recovery deadline D, from the launch's own genesis values only: the scheduled close
/// (`open_ts + window_secs`, not when `close` ran) plus the launch's copy of the recovery delay.
/// Never from the config or the settlement time.
/// The rent loan `create_pool` makes to the pool creator PDA (see step 1 there). `lock_liquidity`
/// recomputes it to repay, from the operating prepay, the part Meteora kept (0.22).
fn pool_loan(rent: &Rent) -> Result<u64> {
    rent.minimum_balance(meteora::pool::LEN)
        .checked_add(rent.minimum_balance(meteora::position::LEN))
        .and_then(|v| v.checked_add(rent.minimum_balance(TokenAccount::LEN).checked_mul(2)?))
        .and_then(|v| v.checked_add(rent.minimum_balance(2_048)))
        .and_then(|v| v.checked_add(rent.minimum_balance(0)))
        .ok_or_else(|| error!(BouncerError::Overflow))
}

/// "Recover deposit" (0.22): a launch still Open, Closed or Settled at or after its recovery
/// deadline becomes Aborted inside the refund or claim that finds it so, and that same instruction
/// then refunds. No separate abort has to land first.
fn expire_if_due(launch: &mut Launch, launch_key: Pubkey, now: i64) -> Result<()> {
    if matches!(launch.state, launch_state::OPEN | launch_state::CLOSED | launch_state::SETTLED) && is_expired(launch, now)? {
        if launch.close_ts == 0 {
            launch.close_ts = now;
        }
        launch.state = launch_state::ABORTED;
        emit!(Aborted { launch: launch_key, slot: Clock::get()?.slot });
    }
    Ok(())
}

fn recovery_deadline(launch: &Launch) -> Result<i64> {
    let delay = i64::try_from(launch.abort_after_secs).map_err(|_| error!(BouncerError::Overflow))?;
    launch
        .open_ts
        .checked_add(launch.window_secs)
        .and_then(|t| t.checked_add(delay))
        .ok_or_else(|| error!(BouncerError::Overflow))
}

/// 0.22: the one boundary every instruction uses. At or after D the launch is expired: it may not
/// progress, and a launch that has not reached PoolLive refunds everyone. Before D it may progress
/// and nothing expires. There is no instant at which both hold.
fn is_expired(launch: &Launch, now: i64) -> Result<bool> {
    Ok(now >= recovery_deadline(launch)?)
}

fn require_not_expired(launch: &Launch, now: i64) -> Result<()> {
    require!(!is_expired(launch, now)?, BouncerError::RecoveryDeadlinePassed);
    Ok(())
}

/// 0.22: pay the signer of an operating step from the creator's operating prepay, capped at what
/// is left of it, and record the amount. A launch whose prepay was already paid out whole (0.21
/// and earlier, `bond_state` 1) or returned (2) pays nothing more.
fn pay_ops<'info>(launch: &mut Launch, vault: &AccountInfo<'info>, to: &AccountInfo<'info>, amount: u64) -> Result<u64> {
    if launch.bond_state != 0 {
        return Ok(0);
    }
    let pay = amount.min(launch.crank_bond.saturating_sub(launch.ops_paid));
    pay_from_vault(vault, to, pay)?;
    launch.ops_paid = launch.ops_paid.checked_add(pay).ok_or(BouncerError::Overflow)?;
    Ok(pay)
}

/// 0.23: the last operating step of a cleared launch returns the unused prepay to the creator, from the recorded
/// amounts, never the balance. Held back in the vault: `burn_unsold`'s allowance and (0.29 tenth candidate, review finding
/// N3) `METADATA_RESERVE_LAMPORTS` for `finish_mint` while the metadata is not written, each capped by what is left.
/// Returns (amount paid to the creator, held, metadata reserve); sets `bond_state` 3 and `metadata_reserve`.
fn return_prepay<'info>(launch: &mut Launch, vault: &AccountInfo<'info>, creator: &AccountInfo<'info>) -> Result<(u64, u64, u64)> {
    let left = launch.crank_bond.checked_sub(launch.ops_paid).ok_or(BouncerError::Overflow)?;
    let allowance = left.min(STEP_ALLOWANCE_LAMPORTS);
    // v0.30: the launch's own term (`Config.metadata_reserve` at genesis); the constant for a launch created before 0.30.
    let term = if launch.metadata_reserve_lamports == 0 { METADATA_RESERVE_LAMPORTS } else { launch.metadata_reserve_lamports };
    let reserve = if launch.mint_finished == 0 { (left - allowance).min(term) } else { 0 };
    let amount = left - allowance - reserve;
    pay_from_vault(vault, creator, amount)?;
    launch.metadata_reserve = reserve;
    launch.bond_state = 3;
    Ok((amount, allowance + reserve, reserve))
}

/// Apply the floor at close time and move the launch out of Open.
fn close_launch(launch: &mut Launch, launch_key: Pubkey, reason: CloseReason, now: i64) -> Result<()> {
    require!(launch.state == launch_state::OPEN, BouncerError::LaunchNotOpen);
    launch.close_ts = now;
    let p = launch.window_params();
    if p.below_floor(launch.total_deposits as u128) {
        launch.state = launch_state::FAILED;
        emit!(LaunchFailed { launch: launch_key, stage: 0, total_deposits: launch.total_deposits, revealed_deposits: 0 });
    } else {
        launch.state = launch_state::CLOSED;
    }
    emit!(LaunchClosed {
        launch: launch_key,
        close_ts: now,
        reason: match reason {
            CloseReason::WindowElapsed => 0,
        },
        total_deposits: launch.total_deposits,
    });
    Ok(())
}

/// Move lamports out of the vault, which this program owns.
fn pay_from_vault<'info>(vault: &AccountInfo<'info>, to: &AccountInfo<'info>, lamports: u64) -> Result<()> {
    if lamports == 0 {
        return Ok(());
    }
    let mut from = vault.try_borrow_mut_lamports()?;
    let mut dest = to.try_borrow_mut_lamports()?;
    **from = from.checked_sub(lamports).ok_or(BouncerError::Overflow)?;
    **dest = dest.checked_add(lamports).ok_or(BouncerError::Overflow)?;
    Ok(())
}

/// v0.30 (the fold-in): the fee vault, the burn vault (addresses and bumps, by derivation).
fn fee_vault_address() -> (Pubkey, u8) {
    Pubkey::find_program_address(&[FEE_VAULT_SEED], &crate::ID)
}

fn burn_vault_address() -> (Pubkey, u8) {
    Pubkey::find_program_address(&[BURN_VAULT_SEED], &crate::ID)
}

/// 0.28: the raise fee's two parts for a cleared value under a launch's terms (2026-10-08: 1 percent of
/// successful auction proceeds in SOL, 60 percent of it to the creator, 40 to Bouncer, none to Meteora). The fee
/// is floor(value x bps / 10,000), the creator's part floor(fee x share / 10,000), the platform's the rest, so the
/// lamport of rounding, when there is one, goes to the platform. (0, 0) under a launch created before 0.28, whose
/// terms are zeros. Nothing here can overflow a u128; the u64 conversions are the bound check.
fn raise_fee_parts(float_value: u64, fee_bps: u16, creator_share_bps: u16) -> Result<(u64, u64)> {
    let fee = (float_value as u128) * (fee_bps as u128) / (BPS_DENOMINATOR as u128);
    let creator = fee * (creator_share_bps as u128) / (BPS_DENOMINATOR as u128);
    let fee = u64::try_from(fee).map_err(|_| error!(BouncerError::Overflow))?;
    let creator = u64::try_from(creator).map_err(|_| error!(BouncerError::Overflow))?;
    Ok((creator, fee - creator))
}

/// 0.28: a raise fee part its destination can hold. The runtime refuses a credit that leaves an account above
/// nothing and under the rent exemption of its own size, so a part that would (a share under the exemption of a
/// dataless account, to an address holding nothing: devnet sizes, never at the mainnet floor) stays in the proceeds
/// and opens the pool instead. A fee never strands a launch (2026-10-08: it stays in the pool rather than
/// failing the launch).
fn fee_payable(dest: &AccountInfo, part: u64, rent: &Rent) -> u64 {
    if part > 0 && dest.lamports().saturating_add(part) >= rent.minimum_balance(dest.data_len()) { part } else { 0 }
}

/// v0.32: whether a normal delivery to the bidder's associated token account cannot complete because of that account.
/// It is usable when the address is empty (the ATA program creates it, a stranger's lamports there included) or holds
/// an initialized token account of this mint owned by the bidder. Anything else (an owner moved by SetAuthority, a
/// frozen account, another program's account) makes `deliver`'s idempotent create or its transfer fail every time.
fn bidder_token_unusable(info: &AccountInfo, bidder: &Pubkey, mint: &Pubkey) -> bool {
    if info.data_is_empty() && *info.owner == system_program::ID {
        return false;
    }
    if *info.owner != token::ID || info.data_len() != TokenAccount::LEN {
        return true;
    }
    let Ok(d) = info.try_borrow_data() else { return true };
    !(d[0..32] == mint.as_ref()[..] && d[32..64] == bidder.as_ref()[..] && d[108] == 1)
}

/// v0.32: whether `deliver` would be refused `BidRentTooSmall` (launches with bid rent terms): the bid's account cannot
/// repay the token account rent the caller would front and still leave the bidder's wallet rent exempt after the
/// refund. The same arithmetic as `deliver_tokens` and `repay_caller_from_bid`, read before anything moves.
fn delivery_rent_short(bid: &AccountInfo, bidder: &AccountInfo, bidder_token: &AccountInfo, refund: u64) -> Result<bool> {
    let rent = Rent::get()?;
    let rent_paid = if bidder_token.data_is_empty() { rent.minimum_balance(TokenAccount::LEN).saturating_sub(bidder_token.lamports()) } else { 0 };
    let needed = rent.minimum_balance(bidder.data_len()).saturating_sub(bidder.lamports().saturating_add(refund));
    Ok(bid.lamports() < rent_paid.saturating_add(needed))
}

/// v0.32: writes a bid back into its account by hand (the account is unchecked since 0.30).
fn store_bid(info: &AccountInfo, bid: &Bid) -> Result<()> {
    let mut data = info.try_borrow_mut_data()?;
    let mut w: &mut [u8] = &mut data[..];
    bid.try_serialize(&mut w)
}

/// What one bid is owed in the launch's current state.
enum Payout {
    /// Winner after the pool is live: tokens plus the lamport refund.
    Tokens(auction_core::Fill),
    /// Full deposit back.
    Refund(u64),
    /// Winner before the pool is live: nothing yet.
    WaitForPool,
}

fn payout_for(launch: &Launch, settlement: Option<&SettlementRecord>, bid: &Bid) -> Result<Payout> {
    require!(bid.state != bid_state::DONE, BouncerError::AlreadyDone);
    // v0.32: a parked bid's payout is recorded on the bid; only `collect_parked` and `push_parked` pay it.
    require!(bid.state != bid_state::PARKED, BouncerError::AlreadyDone);
    // The record must be passed whenever the launch has one (0.17): every refund
    // and every delivery is counted on it, and a refund without it left
    // `distributed_bids` behind the launch's own `distributed_count` (found in testing,
    // 2026-09-25). `settled` is set by `settle` and survives an abort; the state
    // match below covers launches settled before 0.17, whose byte is still 0.
    if launch.settled == 1 {
        require!(settlement.is_some(), BouncerError::SettlementRequired);
    }
    match launch.state {
        // 0.22: plus the bid's processing charge if no reveal ever took it (zero once processed).
        launch_state::FAILED | launch_state::ABORTED => {
            Ok(Payout::Refund(bid.deposit.checked_add(bid.processing_charge).ok_or(BouncerError::Overflow)?))
        }
        launch_state::SETTLED | launch_state::POOL_LIVE | launch_state::FINALIZED => {
            let s = settlement.ok_or(BouncerError::SettlementRequired)?;
            if bid.state == bid_state::INVALID {
                return Ok(Payout::Refund(bid.deposit));
            }
            require!(bid.state == bid_state::REVEALED, BouncerError::NotRefundable);
            if bid.tick < s.marginal_tick {
                return Ok(Payout::Refund(bid.deposit));
            }
            let fill = auction_core::fill(bid.deposit, bid.tick, &s.clearing(launch.float))
                .map_err(|_| error!(BouncerError::Overflow))?;
            // 0.27 (2026-10-06: a bidder must never win zero tokens): a bid at the
            // margin whose share of the remainder rounds down to no atoms is not a winner. It is refunded
            // like a loser, from here on in every state a loser is: deposit less its cost (the margin's
            // cost rounds up, so one lamport at any value the grid reaches), so the sum of costs the pool's
            // `V` rests on is unchanged. No token account, no delivery, no reward.
            // 2026-10-21 (review finding F9): every fill with a cost waits for the pool, the zero-token fill included. Refunded
            // before the pool at deposit less its cost, a zero-token fill was closed; if the pool then never opened
            // and the launch aborted, the whole-principal rule above could no longer pay the lamport its cost took,
            // and finalization swept it as dust. So while Settled a charged fill waits: at PoolLive it is refunded
            // deposit less cost, at Aborted its whole deposit. Losers and invalid bids (above) stay refundable.
            if launch.state == launch_state::SETTLED && fill.cost > 0 {
                return Ok(Payout::WaitForPool);
            }
            if fill.tokens == 0 {
                return Ok(Payout::Refund(fill.refund));
            }
            if launch.state == launch_state::SETTLED {
                return Ok(Payout::WaitForPool);
            }
            Ok(Payout::Tokens(fill))
        }
        _ => err!(BouncerError::NotRefundable),
    }
}

/// 2026-10-21 (review finding F7): what `collect_platform_fees` reads off a launch of any layout this program has
/// written on a cluster, found through `LAUNCH_LAYOUTS` by the account's length and version byte. The one
/// standing exception to the exact-length refusal every other instruction makes (`LaunchLayoutUnknown`): a pool
/// trades for as long as the chain exists and its platform position's fees are claimable only through this
/// program (the pool creator PDA owns the NFT and signs by its seeds), so the fee path must outlive every layout
/// break or the break strands the platform's own revenue. Owner, discriminator, length and version are checked;
/// nothing else of an old launch is read.
struct LaunchFeeView {
    state: u8,
    token_mint: Pubkey,
    lp_owner: Pubkey,
}

fn launch_fee_view(info: &AccountInfo) -> Result<LaunchFeeView> {
    require_keys_eq!(*info.owner, crate::ID, BouncerError::LaunchLayoutUnknown);
    let d = info.try_borrow_data()?;
    require!(d.len() > 8 && d[..8] == Launch::DISCRIMINATOR[..], BouncerError::LaunchLayoutUnknown);
    let layout = LAUNCH_LAYOUTS.iter().find(|l| l.len == d.len() && l.version == d[8]).ok_or(BouncerError::LaunchLayoutUnknown)?;
    let key = |at: usize| Pubkey::new_from_array(d[at..at + 32].try_into().unwrap());
    Ok(LaunchFeeView { state: d[layout.state], token_mint: key(layout.token_mint), lp_owner: key(layout.lp_owner) })
}

/// 2026-10-21 (the trace headroom review finding): one of this program's PDAs, created as `owner`'s account of
/// `space` bytes paid by `payer`, in at most two system CPIs. A stranger's lamports at the address (kept, never
/// refused: X6) are moved out to the payer first, one transfer the PDA signs for, so the account is empty and one
/// `create_account` makes it. Anchor's `init` on a funded address took transfer, allocate and assign instead,
/// three entries, and four such accounts sat in `create_pool`'s worst case.
fn create_pda<'info>(
    payer: &AccountInfo<'info>,
    account: &AccountInfo<'info>,
    system_program: &AccountInfo<'info>,
    seeds: &[&[u8]],
    space: usize,
    owner: &Pubkey,
    rent: &Rent,
) -> Result<()> {
    let signer: &[&[&[u8]]] = &[seeds];
    let stray = account.lamports();
    if stray > 0 {
        system_program::transfer(
            CpiContext::new_with_signer(system_program.key(), Transfer { from: account.clone(), to: payer.clone() }, signer),
            stray,
        )?;
    }
    system_program::create_account(
        CpiContext::new_with_signer(system_program.key(), CreateAccount { from: payer.clone(), to: account.clone() }, signer),
        rent.minimum_balance(space),
        space as u64,
        owner,
    )?;
    Ok(())
}

/// The token genesis `create_launch` did until 0.18, run by `create_pool` since 0.19: the mint and the token
/// vault, the two pass through accounts the pool creator PDA owns (all four by hand since 2026-10-21, `create_pda`;
/// Anchor's `init` until then), and the whole supply minted into the vault. The Metaplex metadata and the revocation
/// of the mint authority follow in `finish_mint`, the next instruction (2026-10-21, the trace headroom review finding:
/// five trace entries out of `create_pool`). Until it lands the mint authority is the vault PDA, which only this
/// program signs for, so no supply can appear in between. v0.30: the vault is the freeze authority too, for the pool's
/// launch token vault (gate X); `open_trading` revokes it for good. No other account is ever frozen.
#[inline(never)]
fn mint_launch_token(a: &CreatePool, launch_key: Pubkey, vault_bump: u8, creator: &Pubkey, mint_salt: u64, bumps: &CreatePoolBumps, rent: &Rent) -> Result<()> {
    let sys = a.system_program.to_account_info();
    let payer = a.payer.to_account_info();
    let token_program = a.token_program.key();
    let salt = mint_salt.to_le_bytes();
    let (mint_bump, vault_bump_seed, wsol_bump, tokens_bump) = ([bumps.token_mint], [bumps.token_vault], [bumps.payer_wsol], [bumps.payer_tokens]);
    create_pda(&payer, &a.token_mint.to_account_info(), &sys, &[MINT_SEED, creator.as_ref(), &salt, &mint_bump], Mint::LEN, &token::ID, rent)?;
    token::initialize_mint2(CpiContext::new(token_program, InitializeMint2 { mint: a.token_mint.to_account_info() }), 6, &a.vault.key(), Some(&a.vault.key()))?;
    let accounts: [(AccountInfo<'_>, &[&[u8]], AccountInfo<'_>, AccountInfo<'_>); 3] = [
        (a.token_vault.to_account_info(), &[TOKEN_VAULT_SEED, launch_key.as_ref(), &vault_bump_seed], a.token_mint.to_account_info(), a.vault.to_account_info()),
        (a.payer_wsol.to_account_info(), &[POOL_WSOL_SEED, launch_key.as_ref(), &wsol_bump], a.wsol_mint.to_account_info(), a.pool_creator.to_account_info()),
        (a.payer_tokens.to_account_info(), &[POOL_TOKENS_SEED, launch_key.as_ref(), &tokens_bump], a.token_mint.to_account_info(), a.pool_creator.to_account_info()),
    ];
    for (account, seeds, mint, authority) in accounts {
        create_pda(&payer, &account, &sys, seeds, TokenAccount::LEN, &token::ID, rent)?;
        token::initialize_account3(CpiContext::new(token_program, InitializeAccount3 { account: account.clone(), mint, authority }))?;
    }
    let signer_seeds: &[&[&[u8]]] = &[&[VAULT_SEED, launch_key.as_ref(), &[vault_bump]]];
    token::mint_to(
        CpiContext::new_with_signer(
            token_program,
            MintTo { mint: a.token_mint.to_account_info(), to: a.token_vault.to_account_info(), authority: a.vault.to_account_info() },
            signer_seeds,
        ),
        auction_core::TOTAL_SUPPLY,
    )?;
    Ok(())
}

/// `finish_mint`'s work: the Metaplex metadata (immutable, update authority the vault, which never signs for it
/// again) from the name, symbol and URI kept at genesis, then the mint authority revoked.
#[inline(never)]
fn write_metadata_and_revoke(a: &FinishMint, launch_key: Pubkey, vault_bump: u8) -> Result<()> {
    let signer_seeds: &[&[&[u8]]] = &[&[VAULT_SEED, launch_key.as_ref(), &[vault_bump]]];
    let (name, symbol, uri) = {
        let launch = a.launch.load()?;
        let text = |b: &[u8], n: u8| -> Result<String> {
            String::from_utf8(b[..n as usize].to_vec()).map_err(|_| error!(BouncerError::MetadataTooLong))
        };
        (text(&launch.name, launch.name_len)?, text(&launch.symbol, launch.symbol_len)?, text(&launch.uri, launch.uri_len)?)
    };
    let ix = metadata::create_metadata_v3_instruction(
        a.metadata.key(),
        a.token_mint.key(),
        a.vault.key(),
        a.payer.key(),
        a.vault.key(),
        &name,
        &symbol,
        &uri,
    )?;
    solana_cpi::invoke_signed(
        &ix,
        &[
            a.metadata.to_account_info(),
            a.token_mint.to_account_info(),
            a.vault.to_account_info(),
            a.payer.to_account_info(),
            a.vault.to_account_info(),
            a.system_program.to_account_info(),
            a.rent.to_account_info(),
        ],
        signer_seeds,
    )?;
    token::set_authority(
        CpiContext::new_with_signer(
            a.token_program.key(),
            SetAuthority { current_authority: a.vault.to_account_info(), account_or_mint: a.token_mint.to_account_info() },
            signer_seeds,
        ),
        token::spl_token::instruction::AuthorityType::MintTokens,
        None,
    )?;
    Ok(())
}

/// v0.30: `freeze_account` on the pool's launch token vault, signed by the vault PDA (the mint's freeze authority),
/// then the state byte read back.
#[inline(never)]
fn freeze_pool_vault(a: &CreatePool, launch_key: Pubkey, vault_bump: u8) -> Result<()> {
    let signer_seeds: &[&[&[u8]]] = &[&[VAULT_SEED, launch_key.as_ref(), &[vault_bump]]];
    token::freeze_account(CpiContext::new_with_signer(
        a.token_program.key(),
        FreezeAccount { account: a.token_a_vault.to_account_info(), mint: a.token_mint.to_account_info(), authority: a.vault.to_account_info() },
        signer_seeds,
    ))?;
    require!(token_account_frozen(&a.token_a_vault.to_account_info())?, BouncerError::VaultNotFrozen);
    Ok(())
}

/// v0.30: an SPL token account's state byte (offset 108): 2 is Frozen.
fn token_account_frozen(info: &AccountInfo) -> Result<bool> {
    let d = info.try_borrow_data()?;
    Ok(d.len() >= TokenAccount::LEN && d[108] == 2)
}

/// v0.30: the gate's shared checks: PoolLive, and frozen (1); open (2) and no gate (0) have their own refusals.
fn require_trading_frozen(launch: &Launch) -> Result<()> {
    require!(launch.state == launch_state::POOL_LIVE, BouncerError::NotPoolLive);
    match launch.trading_state {
        1 => Ok(()),
        2 => err!(BouncerError::TradingAlreadyOpen),
        _ => err!(BouncerError::TradingGateNone),
    }
}

/// v0.30: the two opens' shared body. The pool is the record's and its launch token vault, read off the pool's own
/// bytes, must be the account passed and must be frozen; the thaw and the revocation of the freeze authority are
/// signed by the vault PDA (two CPIs, two inner entries); the launch and the record are then marked open. Returns
/// (opened_ts, distributed_count, bid_count).
#[allow(clippy::too_many_arguments)]
#[inline(never)]
fn thaw_and_open<'info>(
    launch: &AccountLoader<'info, Launch>,
    settlement: &mut Account<'info, SettlementRecord>,
    vault: &AccountInfo<'info>,
    vault_bump: u8,
    token_mint: &AccountInfo<'info>,
    pool: &AccountInfo<'info>,
    token_a_vault: &AccountInfo<'info>,
    token_program: &AccountInfo<'info>,
    forced: bool,
) -> Result<(i64, u32, u32)> {
    let launch_key = launch.key();
    require_keys_eq!(pool.key(), settlement.pool, BouncerError::WrongLaunch);
    {
        let d = pool.try_borrow_data()?;
        require!(
            *pool.owner == meteora::PROGRAM_ID && d.len() == meteora::pool::LEN && d[..8] == meteora::pool::DISCRIMINATOR && key_at(&d, meteora::pool::TOKEN_A_VAULT) == token_a_vault.key(),
            BouncerError::PoolReadbackMismatch
        );
    }
    require!(token_account_frozen(token_a_vault)?, BouncerError::VaultNotFrozen);
    let signer_seeds: &[&[&[u8]]] = &[&[VAULT_SEED, launch_key.as_ref(), &[vault_bump]]];
    token::thaw_account(CpiContext::new_with_signer(
        token_program.key(),
        ThawAccount { account: token_a_vault.clone(), mint: token_mint.clone(), authority: vault.clone() },
        signer_seeds,
    ))?;
    token::set_authority(
        CpiContext::new_with_signer(token_program.key(), SetAuthority { current_authority: vault.clone(), account_or_mint: token_mint.clone() }, signer_seeds),
        token::spl_token::instruction::AuthorityType::FreezeAccount,
        None,
    )?;
    let now = now_ts()?;
    let mut l = launch.load_mut()?;
    l.trading_state = 2;
    settlement.opened_ts = now;
    settlement.opened_forced = forced as u8;
    Ok((now, l.distributed_count, l.bid_count))
}

/// v0.30: the bid at `info` if it is still open: `None` when the account is closed (empty and the system program's,
/// which the runtime hands back for an account a push closed, or a stranger's lamports at the address), which a push
/// that lost a race finds; refused `NotABid` when it holds something else or names another bidder or launch.
fn load_open_bid(info: &AccountInfo, bidder: &Pubkey, launch: Pubkey) -> Result<Option<Bid>> {
    if *info.owner != crate::ID {
        require!(info.data_is_empty() && *info.owner == system_program::ID, BouncerError::NotABid);
        return Ok(None);
    }
    let data = info.try_borrow_data()?;
    let bid = Bid::try_deserialize(&mut &data[..]).map_err(|_| error!(BouncerError::NotABid))?;
    require!(bid.bidder == *bidder && bid.launch == launch, BouncerError::NotABid);
    Ok(Some(bid))
}

/// v0.30: closes a bid account to its bidder by hand (the account is unchecked since the no-op path): its lamports to
/// the bidder, the data gone and the account returned to the system program, as Anchor's `close` did. Only this program
/// moves this account's lamports: it signs for nothing and is passed to no CPI.
fn close_bid<'info>(bid: &AccountInfo<'info>, bidder: &AccountInfo<'info>) -> Result<()> {
    let lamports = bid.lamports();
    {
        let mut from = bid.try_borrow_mut_lamports()?;
        let mut to = bidder.try_borrow_mut_lamports()?;
        **to = to.checked_add(lamports).ok_or(BouncerError::Overflow)?;
        **from = 0;
    }
    bid.assign(&system_program::ID);
    bid.resize(0)?;
    Ok(())
}

struct DeliveryAccounts<'a, 'info> {
    launch_key: Pubkey,
    /// Tokens out of the fill that go to the pusher, and the pusher's token account and wallet.
    fee_tokens: u64,
    fee_to: Option<(AccountInfo<'info>, AccountInfo<'info>)>,
    vault: &'a Account<'info, Vault>,
    token_vault: &'a Account<'info, TokenAccount>,
    token_mint: AccountInfo<'info>,
    bidder: AccountInfo<'info>,
    bidder_token: AccountInfo<'info>,
    payer: AccountInfo<'info>,
    token_program: &'a Program<'info, Token>,
    associated_token_program: &'a Program<'info, AssociatedToken>,
    system_program: &'a Program<'info, System>,
}

/// Send a winner its tokens and refund, into an associated token account the
/// payer creates if it is missing. Returns the lamports the payer put into that
/// token account (0.26): its whole rent when the address was empty, the shortfall
/// when someone had already sent it lamports, nothing when the account existed.
/// Measured around the creating call alone, so no other transfer is counted.
fn deliver_tokens<'info>(d: &DeliveryAccounts<'_, 'info>, fill: &auction_core::Fill) -> Result<u64> {
    let token_lamports_before = d.bidder_token.lamports();
    associated_token::create_idempotent(CpiContext::new(
        d.associated_token_program.key(),
        associated_token::Create {
            payer: d.payer.clone(),
            associated_token: d.bidder_token.clone(),
            authority: d.bidder.clone(),
            mint: d.token_mint.clone(),
            system_program: d.system_program.to_account_info(),
            token_program: d.token_program.to_account_info(),
        },
    ))?;
    let rent_paid = d.bidder_token.lamports().checked_sub(token_lamports_before).ok_or(BouncerError::Overflow)?;
    let vault_bump = d.vault.bump;
    let signer_seeds: &[&[&[u8]]] = &[&[VAULT_SEED, d.launch_key.as_ref(), &[vault_bump]]];
    let to_bidder = fill.tokens.checked_sub(d.fee_tokens).ok_or(BouncerError::Overflow)?;
    token::transfer(
        CpiContext::new_with_signer(
            d.token_program.key(),
            token::Transfer {
                from: d.token_vault.to_account_info(),
                to: d.bidder_token.clone(),
                authority: d.vault.to_account_info(),
            },
            signer_seeds,
        ),
        to_bidder,
    )?;
    if d.fee_tokens > 0 {
        let (fee_token_account, pusher) = d.fee_to.as_ref().ok_or(BouncerError::Overflow)?;
        associated_token::create_idempotent(CpiContext::new(
            d.associated_token_program.key(),
            associated_token::Create {
                payer: pusher.clone(),
                associated_token: fee_token_account.clone(),
                authority: pusher.clone(),
                mint: d.token_mint.clone(),
                system_program: d.system_program.to_account_info(),
                token_program: d.token_program.to_account_info(),
            },
        ))?;
        token::transfer(
            CpiContext::new_with_signer(
                d.token_program.key(),
                token::Transfer {
                    from: d.token_vault.to_account_info(),
                    to: fee_token_account.clone(),
                    authority: d.vault.to_account_info(),
                },
                signer_seeds,
            ),
            d.fee_tokens,
        )?;
    }
    pay_from_vault(&d.vault.to_account_info(), &d.bidder, fill.refund)?;
    Ok(rent_paid)
}

/// Pushed deliveries pay `Config.delivery_fee_bps` of their tokens to the pusher.
fn delivery_fee(tokens: u64, bps: u16) -> Result<u64> {
    let fee = (tokens as u128)
        .checked_mul(bps as u128)
        .ok_or(BouncerError::Overflow)?
        / BPS_DENOMINATOR as u128;
    u64::try_from(fee).map_err(|_| error!(BouncerError::Overflow))
}

fn record_delivery(s: &mut SettlementRecord, fill: &auction_core::Fill) -> Result<()> {
    s.tokens_delivered = s.tokens_delivered.checked_add(fill.tokens).ok_or(BouncerError::Overflow)?;
    s.distributed_bids = s.distributed_bids.checked_add(1).ok_or(BouncerError::Overflow)?;
    if fill.tokens > s.largest_fill_tokens {
        s.largest_fill_tokens = fill.tokens;
    }
    Ok(())
}

/// 0.26, launches with bid rent terms: repay `deliver`'s caller the token account rent it just paid
/// (`rent_paid`, measured by `deliver_tokens`) plus the launch's delivery reward, out of the
/// delivered bid's own account. Runs after every CPI of the instruction; Anchor's `close = bidder`
/// then sends the bidder whatever the bid account still holds. Returns the reward paid.
///
/// The bid account's own lamports are the only source: the vault, and with it every deposit, is
/// not touched. When they do not cover the rent the caller paid, or would leave the bidder's
/// wallet below its rent exempt minimum, the delivery is refused whole (`BidRentTooSmall`) and the
/// bid stays as it was, claimable by its bidder. The reward is cut, to nothing if need be, before
/// the bidder's wallet is left short.
fn repay_caller_from_bid<'info>(bid: &AccountInfo<'info>, bidder: &AccountInfo<'info>, caller: &AccountInfo<'info>, rent_paid: u64, reward: u64) -> Result<u64> {
    let left = bid.lamports().checked_sub(rent_paid).ok_or(BouncerError::BidRentTooSmall)?;
    // What the bidder's wallet still lacks to be rent exempt. The vault's refund is already in it.
    let needed = Rent::get()?.minimum_balance(bidder.data_len()).saturating_sub(bidder.lamports());
    let spare = left.checked_sub(needed).ok_or(BouncerError::BidRentTooSmall)?;
    let reward = reward.min(spare);
    let pay = rent_paid.checked_add(reward).ok_or(BouncerError::Overflow)?;
    if pay > 0 {
        let mut from = bid.try_borrow_mut_lamports()?;
        let mut to = caller.try_borrow_mut_lamports()?;
        **from = from.checked_sub(pay).ok_or(BouncerError::Overflow)?;
        **to = to.checked_add(pay).ok_or(BouncerError::Overflow)?;
    }
    Ok(reward)
}

fn token_amount(info: &AccountInfo) -> Result<u64> {
    let data = info.try_borrow_data()?;
    let acc = TokenAccount::try_deserialize(&mut &data[..])?;
    Ok(acc.amount)
}

fn key_at(d: &[u8], offset: usize) -> Pubkey {
    let mut a = [0u8; 32];
    a.copy_from_slice(&d[offset..offset + 32]);
    Pubkey::new_from_array(a)
}

fn u64_at(d: &[u8], offset: usize) -> u64 {
    let mut a = [0u8; 8];
    a.copy_from_slice(&d[offset..offset + 8]);
    u64::from_le_bytes(a)
}

/// Associated token account address, for any token program.
fn associated_token_address(owner: &Pubkey, mint: &Pubkey, token_program: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[owner.as_ref(), token_program.as_ref(), mint.as_ref()], &associated_token::ID).0
}

/// The Meteora config `create_pool` is pinned to must still be what was locked:
/// public, 2 percent flat (v0.30; 1 percent until 0.29) with no dynamic fee, OnlyB, static, timestamp activated,
/// over cp-amm's absolute price range, Meteora's protocol share 20 (v0.30). Checked on every pool creation, so a config
/// Meteora's admin changed stops pool creation instead of producing a different pool.
fn assert_meteora_config(info: &AccountInfo) -> Result<()> {
    let d = info.try_borrow_data()?;
    check_meteora_config_bytes(info.owner, &d)
}

/// The byte-level half of `assert_meteora_config`, separate so the unit tests can
/// feed it the real config's bytes with one field changed at a time (a drifted
/// config cannot be produced on a validator: the address is pinned and only
/// Meteora's admin writes it).
fn check_meteora_config_bytes(owner: &Pubkey, d: &[u8]) -> Result<()> {
    use meteora::config as c;
    require_keys_eq!(*owner, meteora::PROGRAM_ID, BouncerError::WrongMeteoraConfig);
    require!(d.len() == c::LEN && d[..8] == c::DISCRIMINATOR, BouncerError::WrongMeteoraConfig);
    require!(
        key_at(&d, c::VAULT_CONFIG_KEY) == Pubkey::default()
            && key_at(&d, c::POOL_CREATOR_AUTHORITY) == Pubkey::default()
            && u64_at(&d, c::CLIFF_FEE_NUMERATOR) == meteora::POOL_FEE_NUMERATOR
            && d[c::BASE_FEE_MODE] == 0
            && d[c::NUMBER_OF_PERIOD] == 0
            && d[c::NUMBER_OF_PERIOD + 1] == 0
            && d[c::DYNAMIC_FEE_INITIALIZED] == 0
            // v0.30: Meteora's protocol share and the referral share taken out of it, so a config whose split moved
            // (the review windows' unchecked byte 152) stops pool creation.
            && d[c::PROTOCOL_FEE_PERCENT] == meteora::PROTOCOL_FEE_PERCENT
            && d[c::REFERRAL_FEE_PERCENT] == meteora::REFERRAL_FEE_PERCENT
            && d[c::ACTIVATION_TYPE] == meteora::ACTIVATION_TIMESTAMP
            && d[c::COLLECT_FEE_MODE] == meteora::COLLECT_FEE_MODE_ONLY_B
            && d[c::CONFIG_TYPE] == 0
            && meteora::u128_at(&d, c::SQRT_MIN_PRICE) == meteora::MIN_SQRT_PRICE
            && meteora::u128_at(&d, c::SQRT_MAX_PRICE) == meteora::MAX_SQRT_PRICE,
        BouncerError::WrongMeteoraConfig
    );
    Ok(())
}

#[inline(never)]
fn initialize_meteora_pool(a: &CreatePool, opening: &meteora::Opening, creator_seeds: &[&[u8]], nft_seeds: &[&[u8]]) -> Result<()> {
    let ix = meteora::initialize_pool(
        &meteora::InitializePoolAccounts {
            creator: a.pool_creator.key(),
            position_nft_mint: a.platform_nft_mint.key(),
            position_nft_account: a.platform_nft_account.key(),
            payer: a.pool_creator.key(),
            pool: a.pool.key(),
            position: a.platform_position.key(),
            token_a_mint: a.token_mint.key(),
            token_b_mint: a.wsol_mint.key(),
            token_a_vault: a.token_a_vault.key(),
            token_b_vault: a.token_b_vault.key(),
            payer_token_a: a.payer_tokens.key(),
            payer_token_b: a.payer_wsol.key(),
            token_a_program: a.token_program.key(),
            token_b_program: a.token_program.key(),
        },
        opening.liquidity,
        opening.sqrt_price,
    );
    solana_cpi::invoke_signed(
        &ix,
        &[
            a.pool_creator.to_account_info(),
            a.platform_nft_mint.to_account_info(),
            a.platform_nft_account.to_account_info(),
            a.meteora_config.to_account_info(),
            a.pool_authority.to_account_info(),
            a.pool.to_account_info(),
            a.platform_position.to_account_info(),
            a.token_mint.to_account_info(),
            a.wsol_mint.to_account_info(),
            a.token_a_vault.to_account_info(),
            a.token_b_vault.to_account_info(),
            a.payer_tokens.to_account_info(),
            a.payer_wsol.to_account_info(),
            a.token_program.to_account_info(),
            a.token_2022_program.to_account_info(),
            a.system_program.to_account_info(),
            a.event_authority.to_account_info(),
            a.cp_amm_program.to_account_info(),
        ],
        &[creator_seeds, nft_seeds],
    )?;
    Ok(())
}

/// Reads the new pool back and returns its SOL vault balance. Everything asked for
/// must be there exactly; the SOL vault may hold more than the deposit only by
/// lamports strangers sent to its address before it existed.
#[inline(never)]
fn check_pool_after_create(a: &CreatePool, opening: &meteora::Opening) -> Result<u64> {
    let info = a.pool.to_account_info();
    {
        let d = info.try_borrow_data()?;
        let expect = PoolExpect {
            token_mint: a.token_mint.key(),
            wsol_mint: a.wsol_mint.key(),
            token_a_vault: a.token_a_vault.key(),
            token_b_vault: a.token_b_vault.key(),
            creator: a.pool_creator.key(),
            sqrt_price: opening.sqrt_price,
            liquidity: opening.liquidity,
            activation_point: Clock::get()?.unix_timestamp as u64,
        };
        check_pool_bytes(info.owner, &d, &expect)?;
    }
    let sol_at_open = token_amount(&a.token_b_vault.to_account_info())?;
    require!(
        token_amount(&a.token_a_vault.to_account_info())? == opening.token_amount && sol_at_open >= opening.sol_amount,
        BouncerError::PoolAmountsMismatch
    );
    Ok(sol_at_open)
}

/// What `create_pool` asked Meteora for, to compare with the pool it read back.
struct PoolExpect {
    token_mint: Pubkey,
    wsol_mint: Pubkey,
    token_a_vault: Pubkey,
    token_b_vault: Pubkey,
    creator: Pubkey,
    sqrt_price: u128,
    liquidity: u128,
    /// This instruction's clock (0.20): `activation_point: None` makes Meteora activate at once.
    activation_point: u64,
}

/// The byte-level half of `check_pool_after_create`, separate so the unit tests
/// can feed it a real pool's bytes with one field changed at a time (cp-amm only
/// ever writes a correct pool, so a mismatch cannot be produced on a validator).
fn check_pool_bytes(owner: &Pubkey, d: &[u8], e: &PoolExpect) -> Result<()> {
    use meteora::pool as p;
    require_keys_eq!(*owner, meteora::PROGRAM_ID, BouncerError::PoolReadbackMismatch);
    require!(d.len() == p::LEN && d[..8] == p::DISCRIMINATOR, BouncerError::PoolReadbackMismatch);
    require!(
        key_at(d, p::TOKEN_A_MINT) == e.token_mint
            && key_at(d, p::TOKEN_B_MINT) == e.wsol_mint
            && key_at(d, p::TOKEN_A_VAULT) == e.token_a_vault
            && key_at(d, p::TOKEN_B_VAULT) == e.token_b_vault
            && key_at(d, p::CREATOR) == e.creator
            && meteora::u128_at(d, p::SQRT_MIN_PRICE) == meteora::MIN_SQRT_PRICE
            && meteora::u128_at(d, p::SQRT_MAX_PRICE) == meteora::MAX_SQRT_PRICE
            && meteora::u128_at(d, p::SQRT_PRICE) == e.sqrt_price
            && meteora::u128_at(d, p::LIQUIDITY) == e.liquidity
            && d[p::COLLECT_FEE_MODE] == meteora::COLLECT_FEE_MODE_ONLY_B
            // 0.20, the alpha vault: no vault may swap before activation, activation is now, the pool is enabled.
            && key_at(d, p::WHITELISTED_VAULT) == Pubkey::default()
            && u64_at(d, p::ACTIVATION_POINT) == e.activation_point
            && d[p::POOL_STATUS] == 0,
        BouncerError::PoolReadbackMismatch
    );
    Ok(())
}

/// The platform position is never delegated (0.20): its NFT account (Token-2022, owned by the pool
/// creator PDA, which never signs an Approve) has no SPL delegate and nothing delegated, and the
/// position grants its delegate no permission. Checked wherever the platform position is used.
fn assert_platform_not_delegated(position: &AccountInfo, nft_account: &AccountInfo) -> Result<()> {
    let pd = position.try_borrow_data()?;
    let nd = nft_account.try_borrow_data()?;
    check_not_delegated_bytes(&pd, &nd)
}

fn check_not_delegated_bytes(pd: &[u8], nd: &[u8]) -> Result<()> {
    // SPL token account base layout: delegate COption<Pubkey> tag at 72, delegated_amount at 121.
    require!(
        pd.len() == meteora::position::LEN
            && u32::from_le_bytes(pd[meteora::position::DELEGATE_PERMISSION..meteora::position::DELEGATE_PERMISSION + 4].try_into().unwrap()) == 0
            && nd.len() >= 165
            && nd[72..76] == [0u8; 4]
            && u64_at(nd, 121) == 0,
        BouncerError::PlatformPositionDelegated
    );
    Ok(())
}

fn position_buckets(info: &AccountInfo, nft_mint: &Pubkey, pool: &Pubkey) -> Result<(u128, u128, u128)> {
    use meteora::position as q;
    require_keys_eq!(*info.owner, meteora::PROGRAM_ID, BouncerError::PositionReadbackMismatch);
    let d = info.try_borrow_data()?;
    require!(d.len() == q::LEN && d[..8] == q::DISCRIMINATOR, BouncerError::PositionReadbackMismatch);
    require!(key_at(&d, q::POOL) == *pool && key_at(&d, q::NFT_MINT) == *nft_mint, BouncerError::PositionReadbackMismatch);
    Ok((
        meteora::u128_at(&d, q::UNLOCKED_LIQUIDITY),
        meteora::u128_at(&d, q::VESTED_LIQUIDITY),
        meteora::u128_at(&d, q::PERMANENT_LOCKED_LIQUIDITY),
    ))
}

#[inline(never)]
fn lock_platform_position(a: &CreatePool, liquidity: u128, creator_seeds: &[&[u8]]) -> Result<()> {
    let (pool, mint, position) = (a.pool.key(), a.platform_nft_mint.key(), a.platform_position.to_account_info());
    require!(position_buckets(&position, &mint, &pool)? == (liquidity, 0, 0), BouncerError::PositionReadbackMismatch);
    // 0.20: the pool-wide total is compared as a delta, never to our snapshot: anyone may lock
    // their own liquidity in this pool, so the total is not ours to predict.
    let locked_before = meteora::u128_at(&a.pool.try_borrow_data()?, meteora::pool::PERMANENT_LOCK_LIQUIDITY);
    let ix = meteora::permanent_lock_position(pool, position.key(), a.platform_nft_account.key(), a.pool_creator.key(), liquidity);
    solana_cpi::invoke_signed(
        &ix,
        &[
            a.pool.to_account_info(),
            position.clone(),
            a.platform_nft_account.to_account_info(),
            a.pool_creator.to_account_info(),
            a.event_authority.to_account_info(),
            a.cp_amm_program.to_account_info(),
        ],
        &[creator_seeds],
    )?;
    require!(position_buckets(&position, &mint, &pool)? == (0, 0, liquidity), BouncerError::PositionReadbackMismatch);
    let d = a.pool.try_borrow_data()?;
    require!(
        meteora::u128_at(&d, meteora::pool::PERMANENT_LOCK_LIQUIDITY) == locked_before.checked_add(liquidity).ok_or(BouncerError::Overflow)?,
        BouncerError::PositionReadbackMismatch
    );
    Ok(())
}

/// A new empty position owned by the pool creator PDA, then `numerator` / 1e9 of the
/// platform position split into it. Returns the creator position's permanent liquidity.
#[inline(never)]
fn split_to_creator(a: &LockLiquidity, launch_key: Pubkey, numerator: u32, creator_bump: u8, nft_bump: u8, pool_liquidity: u128) -> Result<u128> {
    let creator_seeds: &[&[u8]] = &[POOL_CREATOR_SEED, launch_key.as_ref(), &[creator_bump]];
    let nft_seeds: &[&[u8]] = &[POSITION_NFT_SEED, launch_key.as_ref(), &[SIDE_CREATOR], &[nft_bump]];
    let (pool, owner) = (a.pool.key(), a.pool_creator.key());
    let ix = meteora::create_position(owner, a.creator_nft_mint.key(), a.creator_nft_pda_account.key(), pool, a.creator_position.key(), a.payer.key());
    solana_cpi::invoke_signed(
        &ix,
        &[
            a.pool_creator.to_account_info(),
            a.creator_nft_mint.to_account_info(),
            a.creator_nft_pda_account.to_account_info(),
            a.pool.to_account_info(),
            a.creator_position.to_account_info(),
            a.pool_authority.to_account_info(),
            a.payer.to_account_info(),
            a.token_2022_program.to_account_info(),
            a.system_program.to_account_info(),
            a.event_authority.to_account_info(),
            a.cp_amm_program.to_account_info(),
        ],
        &[nft_seeds],
    )?;
    let ix = meteora::split_position2(
        pool,
        a.platform_position.key(),
        a.platform_nft_account.key(),
        a.creator_position.key(),
        a.creator_nft_pda_account.key(),
        owner,
        owner,
        numerator,
    );
    solana_cpi::invoke_signed(
        &ix,
        &[
            a.pool.to_account_info(),
            a.platform_position.to_account_info(),
            a.platform_nft_account.to_account_info(),
            a.creator_position.to_account_info(),
            a.creator_nft_pda_account.to_account_info(),
            a.pool_creator.to_account_info(),
            a.event_authority.to_account_info(),
            a.cp_amm_program.to_account_info(),
        ],
        &[creator_seeds],
    )?;
    let (pu, pv, pp) = position_buckets(&a.platform_position.to_account_info(), &a.platform_nft_mint.key(), &pool)?;
    let (cu, cv, cp) = position_buckets(&a.creator_position.to_account_info(), &a.creator_nft_mint.key(), &pool)?;
    require!(
        pu == 0 && pv == 0 && cu == 0 && cv == 0 && cp > 0 && pp.checked_add(cp) == Some(pool_liquidity),
        BouncerError::PositionReadbackMismatch
    );
    Ok(cp)
}

/// The creator position's NFT moves from Meteora's account (owned by the pool creator
/// PDA) to the creator's own Token-2022 associated token account; the emptied account
/// is closed and its rent returned to the payer.
#[inline(never)]
fn give_creator_nft(a: &LockLiquidity, launch_key: Pubkey, creator: &Pubkey, creator_bump: u8) -> Result<()> {
    let mint = a.creator_nft_mint.key();
    require_keys_eq!(
        a.creator_nft_ata.key(),
        associated_token_address(creator, &mint, &meteora::TOKEN_2022_PROGRAM_ID),
        BouncerError::WrongCreator
    );
    associated_token::create_idempotent(CpiContext::new(
        a.associated_token_program.key(),
        associated_token::Create {
            payer: a.payer.to_account_info(),
            associated_token: a.creator_nft_ata.to_account_info(),
            authority: a.creator.to_account_info(),
            mint: a.creator_nft_mint.to_account_info(),
            system_program: a.system_program.to_account_info(),
            token_program: a.token_2022_program.to_account_info(),
        },
    ))?;
    let creator_seeds: &[&[u8]] = &[POOL_CREATOR_SEED, launch_key.as_ref(), &[creator_bump]];
    let owner = a.pool_creator.key();
    let ix = meteora::token_2022_transfer_checked(a.creator_nft_pda_account.key(), mint, a.creator_nft_ata.key(), owner, 1, 0);
    solana_cpi::invoke_signed(
        &ix,
        &[
            a.creator_nft_pda_account.to_account_info(),
            a.creator_nft_mint.to_account_info(),
            a.creator_nft_ata.to_account_info(),
            a.pool_creator.to_account_info(),
            a.token_2022_program.to_account_info(),
        ],
        &[creator_seeds],
    )?;
    let ix = meteora::token_2022_close_account(a.creator_nft_pda_account.key(), a.payer.key(), owner);
    solana_cpi::invoke_signed(
        &ix,
        &[
            a.creator_nft_pda_account.to_account_info(),
            a.payer.to_account_info(),
            a.pool_creator.to_account_info(),
            a.token_2022_program.to_account_info(),
        ],
        &[creator_seeds],
    )?;
    // The creator now holds the position's only NFT: amount 1 at offset 64 of the token account.
    let d = a.creator_nft_ata.try_borrow_data()?;
    require!(d.len() >= 72 && key_at(&d, 32) == *creator && u64_at(&d, 64) == 1, BouncerError::PositionReadbackMismatch);
    Ok(())
}

#[program]
pub mod bouncer {
    use super::*;

    // ---------------------------------------------------------------- admin

    /// 0.24: permissionless, and the caller chooses nothing. The admin is this program's upgrade
    /// authority, read from its ProgramData (the loader's own PDA of the program id; see `InitConfig`),
    /// never an argument, so a watcher who runs this first only pays our rent, and the upgrade key never
    /// has to sign. No values and no fee destination are set: the admin sets them with
    /// `admin_update_config`, the destination accepts by signing (`accept_lp_owner`), and creation stays
    /// paused until the admin lifts the pause, which it refuses while either is missing.
    pub fn init_config(ctx: Context<InitConfig>) -> Result<()> {
        let admin = ctx.accounts.program_data.upgrade_authority_address.ok_or(BouncerError::NoUpgradeAuthority)?;
        let now = now_ts()?;
        let c = &mut ctx.accounts.config;
        c.version = LAYOUT_VERSION;
        c.bump = ctx.bumps.config;
        c.emergency_update_pause = 1;
        c._pad1 = 0;
        c.admin = admin;
        c.lp_owner = Pubkey::default();
        c.floor_value = 0;
        c.min_bid = 0;
        c.abort_after_secs = 0;
        c.delivery_fee_bps = 0;
        c.creator_lp_bps = 0;
        c.crank_bond = 0;
        c.emergency_update_pause_ts = now;
        c.pending_admin = Pubkey::default();
        c.pending_lp_owner = Pubkey::default();
        c.raise_fee_bps = 0;
        c.raise_fee_creator_share_bps = 0;
        c.attestors = [Pubkey::default(); 3];
        c.attest_bids = 0;
        c._pad_attest = [0u8; 7];
        c.processing_charge = 0;
        c.reveal_margin_secs = 0;
        c._pad_margin = [0u8; 4];
        c.delivery_reward = 0;
        c.metadata_reserve = 0;
        c.treasury = Pubkey::default();
        c.pending_treasury = Pubkey::default();
        c.bouncer_mint = Pubkey::default();
        c.bouncer_pool = Pubkey::default();
        c.burn_crankers = [Pubkey::default(); 3];
        c.buy_cap_lamports = 0;
        c.buy_min_interval_secs = 0;
        c.buy_max_price_x64 = 0;
        c.last_buy_ts = 0;
        c._reserved = [0u8; 44];
        emit!(ConfigInitialized { admin, payer: ctx.accounts.payer.key(), ts: now });
        Ok(())
    }

    /// 0.24: the admin proposes a successor, who takes the role only by signing `accept_admin`, so an
    /// address nobody controls can never become the admin. Proposing the default key cancels.
    pub fn propose_admin(ctx: Context<ProposeAdmin>, proposed: Pubkey) -> Result<()> {
        let c = &mut ctx.accounts.config;
        let now = now_ts()?;
        if proposed == Pubkey::default() {
            let cancelled = c.pending_admin;
            c.pending_admin = Pubkey::default();
            emit!(AdminProposalCancelled { admin: c.admin, cancelled, ts: now });
        } else {
            c.pending_admin = proposed;
            emit!(AdminProposed { admin: c.admin, proposed, ts: now });
        }
        Ok(())
    }

    /// 0.24: the proposed fee destination takes effect by signing, so revenue can never be pointed at
    /// an address nobody controls.
    pub fn accept_lp_owner(ctx: Context<AcceptLpOwner>) -> Result<()> {
        let c = &mut ctx.accounts.config;
        let new = &ctx.accounts.new_lp_owner;
        require!(c.pending_lp_owner != Pubkey::default() && c.pending_lp_owner == new.key(), BouncerError::NotProposedLpOwner);
        // v0.30 (the fold-in): the fee vault PDA cannot sign; it is accepted by its derivation, since the program alone
        // controls it. Any other destination still signs, so revenue can never be pointed at an address nobody controls.
        require!(new.is_signer || new.key() == fee_vault_address().0, BouncerError::NotProposedLpOwner);
        let old_lp_owner = c.lp_owner;
        c.lp_owner = c.pending_lp_owner;
        c.pending_lp_owner = Pubkey::default();
        emit!(LpOwnerChanged { old_lp_owner, new_lp_owner: c.lp_owner, ts: now_ts()? });
        Ok(())
    }

    /// v0.30: the proposed treasury takes effect by signing, as the fee destination does (0.24): the platform's half of
    /// the raise fee can never be pointed at an address nobody controls. A Squads vault signs through a vault transaction.
    pub fn accept_treasury(ctx: Context<AcceptTreasury>) -> Result<()> {
        let c = &mut ctx.accounts.config;
        require!(c.pending_treasury != Pubkey::default() && c.pending_treasury == ctx.accounts.new_treasury.key(), BouncerError::NotProposedTreasury);
        let old_treasury = c.treasury;
        c.treasury = c.pending_treasury;
        c.pending_treasury = Pubkey::default();
        emit!(TreasuryChanged { old_treasury, new_treasury: c.treasury, ts: now_ts()? });
        Ok(())
    }

    /// 0.24: the proposed admin takes the role by signing.
    pub fn accept_admin(ctx: Context<AcceptAdmin>) -> Result<()> {
        let c = &mut ctx.accounts.config;
        require!(c.pending_admin != Pubkey::default() && c.pending_admin == ctx.accounts.new_admin.key(), BouncerError::NotProposedAdmin);
        let old_admin = c.admin;
        c.admin = c.pending_admin;
        c.pending_admin = Pubkey::default();
        emit!(AdminChanged { old_admin, new_admin: c.admin, ts: now_ts()? });
        Ok(())
    }

    pub fn admin_update_config(ctx: Context<AdminUpdateConfig>, args: ConfigArgs) -> Result<()> {
        validate_config(&args)?;
        // The config is read raw so an account written by an older, shorter layout
        // can be grown in place: a layout change is then a config update, not a
        // redeploy of a fresh config.
        let info = ctx.accounts.config.to_account_info();
        let (expected, bump) = Pubkey::find_program_address(&[CONFIG_SEED], &crate::ID);
        require_keys_eq!(info.key(), expected, BouncerError::Unauthorized);
        require_keys_eq!(*info.owner, crate::ID, BouncerError::Unauthorized);
        // The pause, its timestamp and the whole reserved tail survive a config
        // update (0.18): they are read raw with the version and the admin, and
        // written back byte for byte, so a field carved from the reserve by a later
        // version is never cleared by a config update made under this one.
        let (version, admin, pause, pause_ts, reserved, old) = {
            let data = info.try_borrow_data()?;
            require!(data.len() >= 44 && data[..8] == Config::DISCRIMINATOR[..], BouncerError::Unauthorized);
            // 0.24: the values before the update, for the event (zeros where an older layout lacks them).
            let u = |o: usize| if data.len() >= o + 8 { u64::from_le_bytes(data[o..o + 8].try_into().unwrap()) } else { 0 };
            let h = |o: usize| if data.len() >= o + 2 { u16::from_le_bytes(data[o..o + 2].try_into().unwrap()) } else { 0 };
            let k = |o: usize| if data.len() >= o + 32 { Pubkey::new_from_array(data[o..o + 32].try_into().unwrap()) } else { Pubkey::default() };
            let old = ConfigArgs {
                lp_owner: if data.len() >= 76 { Pubkey::new_from_array(data[44..76].try_into().unwrap()) } else { Pubkey::default() },
                floor_value: u(76),
                min_bid: u(84),
                abort_after_secs: u(92),
                delivery_fee_bps: h(100),
                creator_lp_bps: h(102),
                crank_bond: u(104),
                raise_fee_bps: h(184),
                raise_fee_creator_share_bps: h(186),
                // 0.29: carved from the tail at 188, 284 and 292; zeros under an older layout.
                attestors: [k(188), k(220), k(252)],
                attest_bids: if data.len() > 284 { data[284] } else { 0 },
                processing_charge: u(292),
                // v0.30: carved from the tail at 300, 308, 316 and 324 (the pending treasury at 356); zeros before 0.30.
                reveal_margin_secs: if data.len() >= 304 { u32::from_le_bytes(data[300..304].try_into().unwrap()) } else { 0 },
                delivery_reward: u(308),
                metadata_reserve: u(316),
                treasury: k(324),
            };
            let mut a = [0u8; 32];
            a.copy_from_slice(&data[12..44]);
            let pause_ts = if data.len() >= 120 { i64::from_le_bytes(data[112..120].try_into().unwrap()) } else { 0 };
            let mut reserved = [0u8; 512];
            if data.len() > 120 {
                let n = core::cmp::min(data.len(), Config::LEN) - 120;
                reserved[..n].copy_from_slice(&data[120..120 + n]);
            }
            (data[8], Pubkey::new_from_array(a), data[10], pause_ts, reserved, old)
        };
        require_keys_eq!(admin, ctx.accounts.admin.key(), BouncerError::Unauthorized);
        let pending_lp_owner = if args.lp_owner == old.lp_owner { Pubkey::default() } else { args.lp_owner };
        // v0.30: the treasury follows the same rule as the fee destination: proposed here, live when it signs.
        let pending_treasury = if args.treasury == old.treasury { Pubkey::default() } else { args.treasury };
        if info.data_len() != Config::LEN {
            // Grown (rent topped up by the admin) or shrunk (0.15 dropped the cap) in place.
            let needed = Rent::get()?.minimum_balance(Config::LEN).saturating_sub(info.lamports());
            if needed > 0 {
                system_program::transfer(
                    CpiContext::new(
                        ctx.accounts.system_program.key(),
                        Transfer { from: ctx.accounts.admin.to_account_info(), to: info.clone() },
                    ),
                    needed,
                )?;
            }
            info.resize(Config::LEN)?;
        }
        let c = Config {
            version,
            bump,
            emergency_update_pause: pause,
            _pad1: 0,
            admin,
            // 0.24: the fee destination never changes here. A different one is proposed and takes effect
            // when it signs `accept_lp_owner`; naming the current one cancels a pending proposal.
            lp_owner: old.lp_owner,
            floor_value: args.floor_value,
            min_bid: args.min_bid,
            abort_after_secs: args.abort_after_secs,
            delivery_fee_bps: args.delivery_fee_bps,
            creator_lp_bps: args.creator_lp_bps,
            crank_bond: args.crank_bond,
            emergency_update_pause_ts: pause_ts,
            pending_admin: Pubkey::new_from_array(reserved[..32].try_into().unwrap()),
            pending_lp_owner,
            raise_fee_bps: args.raise_fee_bps,
            raise_fee_creator_share_bps: args.raise_fee_creator_share_bps,
            // 0.29: the three new values take `reserved[68..180]` (offsets 188..300); the tail after them is kept.
            attestors: args.attestors,
            attest_bids: args.attest_bids,
            _pad_attest: [0u8; 7],
            processing_charge: args.processing_charge,
            // v0.30: the four values and the pending treasury take `reserved[180..268]` (offsets 300..388); the tail after is kept.
            reveal_margin_secs: args.reveal_margin_secs,
            _pad_margin: [0u8; 4],
            delivery_reward: args.delivery_reward,
            metadata_reserve: args.metadata_reserve,
            treasury: old.treasury,
            pending_treasury,
            // v0.30, the fold-in: the buy-and-burn's terms and its clock live in the tail at 388..588 (`reserved[268..468]`),
            // written by `admin_set_buyback` and `buy_and_burn` only; a config update carries them through unchanged.
            bouncer_mint: Pubkey::new_from_array(reserved[268..300].try_into().unwrap()),
            bouncer_pool: Pubkey::new_from_array(reserved[300..332].try_into().unwrap()),
            burn_crankers: [
                Pubkey::new_from_array(reserved[332..364].try_into().unwrap()),
                Pubkey::new_from_array(reserved[364..396].try_into().unwrap()),
                Pubkey::new_from_array(reserved[396..428].try_into().unwrap()),
            ],
            buy_cap_lamports: u64::from_le_bytes(reserved[428..436].try_into().unwrap()),
            buy_min_interval_secs: u64::from_le_bytes(reserved[436..444].try_into().unwrap()),
            buy_max_price_x64: u128::from_le_bytes(reserved[444..460].try_into().unwrap()),
            last_buy_ts: i64::from_le_bytes(reserved[460..468].try_into().unwrap()),
            _reserved: reserved[468..].try_into().unwrap(),
        };
        let bytes = anchor_lang::prelude::borsh::to_vec(&c)?;
        let mut data = info.try_borrow_mut_data()?;
        data[..8].copy_from_slice(&Config::DISCRIMINATOR[..]);
        data[8..8 + bytes.len()].copy_from_slice(&bytes);
        let new = ConfigArgs { lp_owner: old.lp_owner, treasury: old.treasury, ..args };
        emit!(ConfigUpdated { admin, old, new, pending_lp_owner, ts: now_ts()?, pending_treasury });
        Ok(())
    }

    /// The emergency update pause (0.18, restored under its current name). While on,
    /// `create_launch` refuses `EmergencyUpdatePaused`; no other instruction reads
    /// the flag, so a launch already running goes on exactly as before: bids,
    /// close, beacon, reveal, settle, pool, locks, deliveries, refunds, claims,
    /// abort and finalize all work. Its one purpose is a program update: creation
    /// stops so no launch is created under a layout the next build could strand,
    /// the update lands, creation resumes. Disclosed on the page from
    /// `Config.emergency_update_pause` and `emergency_update_pause_ts`, never hidden.
    pub fn admin_emergency_update_pause(ctx: Context<AdminOnly>, on: bool) -> Result<()> {
        let now = now_ts()?;
        let c = &mut ctx.accounts.config;
        if !on {
            // 0.24: creation cannot start without the values and an accepted fee destination. 0.29: nor before the
            // 0.29 terms are set: a config written before 0.29 reads 0 in `processing_charge` (an update refuses 0),
            // and a launch created in that window would carry a zero charge and no attestation gate for life.
            require!(c.lp_owner != Pubkey::default() && c.floor_value != 0 && c.min_bid != 0 && c.abort_after_secs != 0, BouncerError::ConfigIncomplete);
            require!(c.processing_charge != 0, BouncerError::ConfigIncomplete);
            require!(c.attestors.iter().any(|k| *k != Pubkey::default()), BouncerError::ConfigIncomplete);
            // v0.30: nor without an accepted treasury, a margin in bounds and a metadata reserve (a config written before
            // 0.30 reads zeros, which an update refuses).
            require!(
                c.treasury != Pubkey::default() && (REVEAL_MARGIN_MIN_SECS..=REVEAL_MARGIN_MAX_SECS).contains(&c.reveal_margin_secs) && c.metadata_reserve != 0,
                BouncerError::ConfigIncomplete
            );
        }
        c.emergency_update_pause = if on { 1 } else { 0 };
        c.emergency_update_pause_ts = if on { now } else { 0 };
        emit!(EmergencyUpdatePauseSet { on, admin: ctx.accounts.admin.key(), ts: now });
        Ok(())
    }

    // -------------------------------------------------------------- genesis

    /// v0.31 (2026-10-28): `close_ts` is the absolute window end the creator chose; the window is
    /// `close_ts` less the landing clock, accepted from `MIN_WINDOW_AT_LANDING_SECS` (240, the approval grace
    /// under the 300 the client may choose; `CloseTooSoon` under it) to `MAX_WINDOW_SECS`. The reveal round is
    /// then a pure function of `close_ts` and the config's margin, so a slow wallet approval shortens the window
    /// and moves nothing else (`window_secs` as an argument until v0.30 timed the window from the landing, and an
    /// approval slower than the client's aim past the earliest round was refused `RevealRoundOutOfRange`).
    /// `reveal_round` is the quicknet round bids are sealed to; the creator supplies it because its hashed
    /// identity is verified from the creator's hints, which are specific to one round. It must be at or after
    /// the first round past `close_ts` + `Config.reveal_margin_secs` and within `REVEAL_ROUND_SLACK` rounds of it.
    /// `round_point` must be that round's hashed identity on G1; the program
    /// derives the identity from `reveal_round` itself (h2c.rs) and refuses
    /// any other point (`InvalidRoundPoint`). `round_hints` are the four
    /// field elements of that derivation the program verifies instead of
    /// computing (two square roots, two inverses; `h2c::hints_for` on the
    /// host, `idl/round-point.ts` for clients); wrong hints are refused with
    /// the same error and cannot change the derived point.
    ///
    /// 0.19: the mint is not created here. `token_mint` is the address the mint will have,
    /// the PDA `["mint", creator, mint_salt LE]`, and nothing exists there until `create_pool`.
    /// Name, symbol and URI are checked against Metaplex's limits and kept in the launch;
    /// `create_pool` writes them into the metadata. No token vault, metadata account or
    /// supply exists during bidding, and a launch that fails or is aborted never has any.
    pub fn create_launch(
        ctx: Context<CreateLaunch>,
        mint_salt: u64,
        close_ts: i64,
        reveal_round: u64,
        round_point: [u8; 48],
        round_hints: [u8; 192],
        name: String,
        symbol: String,
        uri: String,
        expected: LaunchTerms,
    ) -> Result<()> {
        // The config is read here and nowhere below. It is not writable in this instruction and is
        // passed to no CPI, so it cannot change between this check and the writes; and the writes do
        // not read it again in any case.
        // 0.29: the attestation flag and the processing charge are platform policy, not creator terms: they are copied
        // from the config as it stands, not from the creator's signed argument.
        let (terms, lp_owner, attest_bids, processing_charge, treasury, reveal_margin_secs, delivery_reward, metadata_reserve_lamports) = {
            let config = &ctx.accounts.config;
            // The emergency update pause (0.18) stops creation and nothing else.
            require!(config.emergency_update_pause == 0, BouncerError::EmergencyUpdatePaused);
            // 0.24: every launch snapshots a real fee destination. v0.30: and a real treasury, a margin in bounds and a reserve.
            require!(config.lp_owner != Pubkey::default() && config.treasury != Pubkey::default(), BouncerError::ConfigIncomplete);
            require!((REVEAL_MARGIN_MIN_SECS..=REVEAL_MARGIN_MAX_SECS).contains(&config.reveal_margin_secs) && config.metadata_reserve != 0, BouncerError::ConfigIncomplete);
            // 0.25: the terms the creator signed must be the config's, all six. From here on every
            // value comes from `terms`, the creator's own signed argument.
            require!(LaunchTerms::of(config) == expected, BouncerError::TermsChanged);
            (expected, config.lp_owner, config.attest_bids, config.processing_charge, config.treasury, config.reveal_margin_secs, config.delivery_reward, config.metadata_reserve)
        };
        // 0.29 (2026-10-20): creation is gated like bidding, with no waiver (see `ATTEST_CREATE_TAG`). The
        // permit names this creator, this launch and the hash of this instruction's own data after the
        // discriminator, so it opens one exact launch; it is checked before any write, so a refused creation leaves
        // nothing (Anchor's inits roll back with the transaction).
        {
            use solana_instructions_sysvar::{load_current_index_checked, load_instruction_at_checked};
            let info = ctx.accounts.instructions.to_account_info();
            let index = load_current_index_checked(&info).map_err(|_| error!(BouncerError::AttestationMissing))?;
            let own = load_instruction_at_checked(index as usize, &info).map_err(|_| error!(BouncerError::AttestationMissing))?;
            require!(own.program_id == crate::ID && own.data.len() > 8, BouncerError::AttestationMissing);
            let params_hash = solana_sha256_hasher::hash(&own.data[8..]).to_bytes();
            let (creator, launch) = (ctx.accounts.creator.key(), ctx.accounts.launch.key());
            check_attestation(&info, &ctx.accounts.config.attestors, ATTEST_CREATE_MESSAGE_LEN, 0, |e| create_attest_message(creator, launch, params_hash, e).to_vec(), now_ts()?)?;
        }
        // 0.26: a launch created from here on repays a pushed delivery out of the delivered bid's own
        // account (`delivery_terms::BID_RENT`, written below) and takes no tokens for it, so its terms
        // must not carry a token fee: the two charges never meet on one launch. `validate_config`
        // lets no new config hold one; this catches a config written before 0.26 and not yet
        // updated. A launch created before 0.26 keeps the token fee it recorded.
        require!(terms.delivery_fee_bps == 0, BouncerError::TokenFeeRetired);
        let open_ts = now_ts()?;
        // v0.31: the window is the creator's absolute close less the landing clock. Under the landing floor (240 s)
        // the refusal names the fix (`CloseTooSoon`: rebuild with a later close); over the ceiling, or a close not
        // after now, is the window refusal as before.
        require!(close_ts > open_ts, BouncerError::InvalidWindow);
        let window_secs = close_ts.checked_sub(open_ts).ok_or(BouncerError::Overflow)?;
        require!(window_secs >= auction_core::close::MIN_WINDOW_AT_LANDING_SECS, BouncerError::CloseTooSoon);
        let params = WindowParams {
            open_ts,
            window_secs,
            floor_value: terms.floor_value,
            min_bid: terms.min_bid,
        };
        match params.validate_at_landing() {
            Ok(()) => {}
            Err(auction_core::Error::InvalidWindow) => return err!(BouncerError::InvalidWindow),
            Err(auction_core::Error::FloorValueOutOfRange) => return err!(BouncerError::FloorValueOutOfRange),
            Err(_) => return err!(BouncerError::InvalidConfig),
        }
        // v0.30: the margin is the config's (Squad-adjustable within hard bounds), recorded on the launch below. The round
        // the creator signed is the commitment: a margin change between its read and this instruction either leaves the
        // round in range (a longer wait of at most the slack) or refuses it here, never changes what the bids are sealed to.
        let earliest_round = auction_core::beacon::reveal_round_for_margin(params.close_ts(), reveal_margin_secs as i64)
            .map_err(|_| error!(BouncerError::Overflow))?;
        require!(
            reveal_round >= earliest_round && reveal_round <= earliest_round.saturating_add(REVEAL_ROUND_SLACK),
            BouncerError::RevealRoundOutOfRange
        );
        // The round's identity is derived here from `reveal_round` (hash to curve,
        // h2c.rs) and the supplied point must equal it. Until 2026-09-24 the point
        // was only checked to be on the curve, and a creator could store the point
        // of another round so that only a bid sealed to that round would open.
        let supplied = bls::g1_decompress(&round_point).map_err(|_| error!(BouncerError::InvalidRoundPoint))?;
        let derived = bls::round_point(reveal_round, &round_hints)?;
        require!(supplied == derived, BouncerError::InvalidRoundPoint);
        // 0.22: the schedule must be finishable: from the round's publication to the recovery
        // deadline there must be at least MIN_PROCESSING_SECS for the beacon, reveals and settle.
        let delay = i64::try_from(terms.abort_after_secs).map_err(|_| error!(BouncerError::Overflow))?;
        let deadline = params.close_ts().checked_add(delay).ok_or(BouncerError::Overflow)?;
        let round_ts = auction_core::beacon::publish_time(reveal_round);
        require!(deadline.saturating_sub(round_ts) >= MIN_PROCESSING_SECS as i64, BouncerError::ScheduleTooTight);

        let launch_key = ctx.accounts.launch.key();
        let vault_bump = ctx.bumps.vault;

        // The metadata strings are only kept here (0.19); the same limits the metadata builder
        // enforces are checked now, so a launch that would fail to get its metadata at
        // `create_pool` is refused before anyone bids.
        require!(
            name.len() <= metadata::MAX_NAME && symbol.len() <= metadata::MAX_SYMBOL && uri.len() <= metadata::MAX_URI,
            BouncerError::MetadataTooLong
        );

        // The operating prepay (0.22; the crank bond since 0.16): the creator posts
        // `Config.crank_bond` into the vault on top of the vault's rent. Each operating
        // step (settle, create_pool, lock_liquidity, burn_unsold) repays its signer the
        // rent it sank plus STEP_ALLOWANCE_LAMPORTS from it, and `burn_unsold` returns
        // what is left to the creator in every outcome. Never to the platform. Copied
        // into the launch below, so a config change never reaches a running launch.
        // 0.25: the amount is the creator's own signed term, checked equal to the config above.
        if terms.crank_bond > 0 {
            system_program::transfer(
                CpiContext::new(
                    ctx.accounts.system_program.key(),
                    Transfer { from: ctx.accounts.creator.to_account_info(), to: ctx.accounts.vault.to_account_info() },
                ),
                terms.crank_bond,
            )?;
        }

        let vault = &mut ctx.accounts.vault;
        vault.bump = vault_bump;
        vault.launch = launch_key;

        let mut launch = ctx.accounts.launch.load_init()?;
        launch.version = LAYOUT_VERSION;
        launch.bump = ctx.bumps.launch;
        // 0.29: Initializing until `grow_histogram` lands (the create flow's second instruction, in the same
        // transaction). An explicit state, so a launch whose second step never landed is inert everywhere, not an Open
        // launch with a flag (the 0.29 direct-call safety review, item 6).
        launch.state = launch_state::INITIALIZING;
        launch.settled = 0;
        launch.beacon_posted = 0;
        launch.creator = ctx.accounts.creator.key();
        // Addresses only (0.19): both accounts are created by `create_pool`.
        launch.token_mint = ctx.accounts.token_mint.key();
        launch.token_vault = Pubkey::find_program_address(&[TOKEN_VAULT_SEED, launch_key.as_ref()], &crate::ID).0;
        launch.float = auction_core::FLOAT;
        launch.floor_value = terms.floor_value;
        launch.min_bid = terms.min_bid;
        // The four values that instructions read after genesis, copied so a
        // config change never reaches a running launch (0.25: from the creator's
        // signed terms, which equal the config). `lp_owner` is where this
        // launch's platform fees go for good (0.24: `collect_platform_fees` reads
        // it, not the config). It is never the default key here (`ConfigIncomplete`
        // above), and since 0.24 the config's value is only ever one that signed
        // `accept_lp_owner`: a destination proposed but not yet accepted is not in
        // `config.lp_owner` and so is never recorded on a launch.
        launch.lp_owner = lp_owner;
        launch.abort_after_secs = terms.abort_after_secs;
        launch.delivery_fee_bps = terms.delivery_fee_bps;
        launch.creator_lp_bps = terms.creator_lp_bps;
        launch.bond_state = 0;
        launch._pad2 = [0u8; 3];
        launch.crank_bond = terms.crank_bond;
        launch.mint_salt = mint_salt;
        launch.name_len = name.len() as u8;
        launch.symbol_len = symbol.len() as u8;
        launch.uri_len = uri.len() as u8;
        launch._pad3 = [0u8; 5];
        launch.name = [0u8; 32];
        launch.name[..name.len()].copy_from_slice(name.as_bytes());
        launch.symbol = [0u8; 10];
        launch.symbol[..symbol.len()].copy_from_slice(symbol.as_bytes());
        launch.uri = [0u8; 200];
        launch.uri[..uri.len()].copy_from_slice(uri.as_bytes());
        launch.ops_paid = 0;
        launch._pad_ops = [0u8; 6];
        // 0.26: fixed here for the launch's life, before anyone bids. `deliver` reads these two from
        // the launch, never the constant and never the config.
        launch.delivery_terms = delivery_terms::BID_RENT;
        launch._pad_terms = [0u8; 7];
        // v0.30: the config's value (the constant `DELIVERY_REWARD_LAMPORTS` until 0.29).
        launch.delivery_reward = delivery_reward;
        // 0.28: the raise fee terms, from the creator's signed terms, read by `settle` and nowhere else.
        launch.raise_fee_bps = terms.raise_fee_bps;
        launch.raise_fee_creator_share_bps = terms.raise_fee_creator_share_bps;
        launch._pad_fee = [0u8; 4];
        // 0.29: the attestation flag and the processing charge, the config's at genesis; the histogram's rent for display.
        launch.attest_required = attest_bids;
        launch._pad_attest = [0u8; 7];
        launch.processing_charge = processing_charge;
        launch.histogram_rent = 0; // set below, once the account exists
        launch.attest_waived_ts = 0;
        launch.histogram_grown = 0;
        launch._pad_hist = [0u8; 7];
        launch.metadata_reserve = 0;
        launch.mint_finished = 0;
        launch._pad_mint = [0u8; 7];
        // v0.30: no gate until the pool exists; the treasury, the margin and the reserve term from the config; the beacon
        // sample empty until `post_beacon`.
        launch.trading_state = 0;
        launch._pad_trading = [0u8; 7];
        launch.treasury = treasury;
        launch.reveal_margin_secs = reveal_margin_secs;
        launch._pad_margin = [0u8; 4];
        launch.beacon_posted_ts = 0;
        launch.beacon_lag_secs = 0;
        launch.metadata_reserve_lamports = metadata_reserve_lamports;
        launch.pool_created_ts = 0;
        launch.parked_count = 0;
        launch._pad_park = [0u8; 4];
        launch.parked_lamports = 0;
        launch._reserved = [0u8; 576];
        launch.open_ts = open_ts;
        launch.window_secs = window_secs;
        launch.close_ts = 0;
        launch.reveal_round = reveal_round;
        launch.round_point = round_point;
        launch.beacon_signature = [0u8; 48];
        launch.total_deposits = 0;
        launch.bid_count = 0;
        launch.revealed_count = 0;
        launch.invalid_count = 0;
        launch.distributed_count = 0;
        launch.largest_deposit = 0;

        // 0.29: the histogram, its own account, created here by hand at `Histogram::INIT_LEN` (the most one
        // cross-program create may allocate; Anchor's typed init would read the full struct from the short account)
        // and taken to `Histogram::LEN` by `grow_histogram` in the same transaction. A pre-funded address is handled
        // as Anchor's init handles it (top up, allocate, assign). The discriminator and the header are written now;
        // the counts stay zero until `reveal`.
        {
            let info = ctx.accounts.histogram.to_account_info();
            require!(info.owner == &system_program::ID && info.data_len() == 0, BouncerError::WrongLaunch);
            let bump = ctx.bumps.histogram;
            let seeds: &[&[u8]] = &[HIST_SEED, launch_key.as_ref(), &[bump]];
            let rent = Rent::get()?.minimum_balance(Histogram::INIT_LEN);
            let sys = ctx.accounts.system_program.key();
            let creator_info = ctx.accounts.creator.to_account_info();
            if info.lamports() == 0 {
                system_program::create_account(
                    CpiContext::new_with_signer(sys, system_program::CreateAccount { from: creator_info.clone(), to: info.clone() }, &[seeds]),
                    rent,
                    Histogram::INIT_LEN as u64,
                    &crate::ID,
                )?;
            } else {
                let short = rent.saturating_sub(info.lamports());
                if short > 0 {
                    system_program::transfer(CpiContext::new(sys, Transfer { from: creator_info.clone(), to: info.clone() }), short)?;
                }
                system_program::allocate(CpiContext::new_with_signer(sys, system_program::Allocate { account_to_allocate: info.clone() }, &[seeds]), Histogram::INIT_LEN as u64)?;
                system_program::assign(CpiContext::new_with_signer(sys, system_program::Assign { account_to_assign: info.clone() }, &[seeds]), &crate::ID)?;
            }
            {
                let mut d = info.try_borrow_mut_data()?;
                d[..8].copy_from_slice(&Histogram::DISCRIMINATOR[..8]);
                d[8] = LAYOUT_VERSION;
                d[9] = bump;
                d[10..12].copy_from_slice(&(TICK_COUNT as u16).to_le_bytes());
            }
            launch.histogram_rent = info.lamports();
        }

        emit!(LaunchCreated {
            launch: launch_key,
            token_mint: launch.token_mint,
            creator: launch.creator,
            float: launch.float,
            floor_value: launch.floor_value,
            min_bid: launch.min_bid,
            open_ts,
            window_secs,
            reveal_round,
            crank_bond: launch.crank_bond,
            mint_salt,
            name,
            symbol,
            uri,
            abort_after_secs: launch.abort_after_secs,
            delivery_fee_bps: launch.delivery_fee_bps,
            creator_lp_bps: launch.creator_lp_bps,
            raise_fee_bps: launch.raise_fee_bps,
            raise_fee_creator_share_bps: launch.raise_fee_creator_share_bps,
            attest_required: launch.attest_required,
            processing_charge: launch.processing_charge,
            histogram_rent: launch.histogram_rent,
            treasury,
            reveal_margin_secs,
            delivery_reward,
            metadata_reserve_lamports,
        });
        Ok(())
    }

    // -------------------------------------------------------------- bidding

    pub fn commit(ctx: Context<Commit>, deposit: u64, sealed: [u8; 128], commitment: [u8; 32], flags: u8, max_processing_charge: u64) -> Result<()> {
        let now = now_ts()?;
        let launch_key = ctx.accounts.launch.key();
        let mut launch = ctx.accounts.launch.load_mut()?;
        // 0.25: the processing charge is debited from the bidder and is set by this program, not by
        // anything in the bid, so the bidder states the most they agreed to pay. A ceiling, not an
        // amount: what is taken is the launch's own `processing_charge` (0.29: copied from the config
        // at genesis, so a config update never reaches a launch people have already bid on). Checked
        // before anything else, so a bid signed against a lower charge is refused whole.
        let charge = launch.processing_charge;
        require!(charge <= max_processing_charge, BouncerError::ProcessingChargeAboveMaximum);
        // 0.29: a launch whose histogram was never grown is Initializing and takes no bid, said as such.
        require!(launch.state != launch_state::INITIALIZING, BouncerError::HistogramNotReady);
        require!(launch.state == launch_state::OPEN, BouncerError::LaunchNotOpen);
        let params = launch.window_params();
        match auction_core::process_bid(&params, now, launch.total_deposits as u128, deposit) {
            BidOutcome::ClosedInstead(reason) => {
                // The auction was already closeable. Close it, take nothing, and
                // hand the bid account's rent straight back.
                close_launch(&mut launch, launch_key, reason, now)?;
                drop(launch);
                ctx.accounts.bid.close(ctx.accounts.bidder.to_account_info())?;
                return Ok(());
            }
            BidOutcome::Rejected(RejectReason::NotOpenYet) => return err!(BouncerError::NotOpenYet),
            BidOutcome::Rejected(RejectReason::BelowMinimum) => return err!(BouncerError::BelowMinimum),
            BidOutcome::Accepted { closes_after } => {
                // 0.29: no bid before the histogram is at its full size (the create flow's second instruction).
                require!(launch.histogram_grown == 1, BouncerError::HistogramNotReady);
                // v0.30 (2026-10-27): self-claim is removed. A client still sending the claim-only flag is refused
                // loud rather than silently pushed.
                require!(flags & Bid::FLAG_CLAIM == 0, BouncerError::ClaimRemoved);
                // 0.29: the attestation, when this launch requires one (checked here, after the close and the
                // bid's own checks, so a late or too small bid is answered as before).
                if launch.attest_required == 1 {
                    check_attestation(&ctx.accounts.instructions.to_account_info(), &ctx.accounts.config.attestors, ATTEST_MESSAGE_LEN, ATTEST_MESSAGE_LEN - 8, |e| bid_attest_message(launch_key, ctx.accounts.bidder.key(), e).to_vec(), now)?;
                }
                // 0.22: the deposit and the processing charge in one transfer; the charge is
                // recorded on the bid and never counts toward the auction.
                system_program::transfer(
                    CpiContext::new(
                        ctx.accounts.system_program.key(),
                        Transfer { from: ctx.accounts.bidder.to_account_info(), to: ctx.accounts.vault.to_account_info() },
                    ),
                    deposit.checked_add(charge).ok_or(BouncerError::Overflow)?,
                )?;
                let bid = &mut ctx.accounts.bid;
                bid.version = LAYOUT_VERSION;
                bid.bump = ctx.bumps.bid;
                bid.state = bid_state::SEALED;
                // The creator's bid is labelled by the program, never by the client:
                // bit 1 is set when the bidder is the launch creator and cleared otherwise.
                let is_creator = ctx.accounts.bidder.key() == launch.creator;
                bid.flags = if is_creator { Bid::FLAG_CREATOR } else { 0 };
                if is_creator {
                    launch.creator_has_bid = 1;
                }
                bid.bidder = ctx.accounts.bidder.key();
                bid.launch = launch_key;
                bid.deposit = deposit;
                bid.placed_ts = now;
                bid.sealed = sealed;
                bid.commitment = commitment;
                bid.tick = 0;
                bid._pad2 = [0u8; 6];
                bid.processing_charge = charge;
                bid.parked_tokens = 0;
                bid.parked_lamports = 0;
                bid._reserved = [0u8; 40];

                launch.total_deposits = launch.total_deposits.checked_add(deposit).ok_or(BouncerError::Overflow)?;
                launch.bid_count = launch.bid_count.checked_add(1).ok_or(BouncerError::Overflow)?;
                if deposit > launch.largest_deposit {
                    launch.largest_deposit = deposit;
                }
                emit!(BidCommitted {
                    launch: launch_key,
                    bid: bid.key(),
                    bidder: bid.bidder,
                    creator: is_creator,
                    deposit,
                    total_deposits: launch.total_deposits,
                    bid_count: launch.bid_count,
                });
                if let Some(reason) = closes_after {
                    close_launch(&mut launch, launch_key, reason, now)?;
                }
            }
        }
        Ok(())
    }

    pub fn close(ctx: Context<CloseLaunch>) -> Result<()> {
        let now = now_ts()?;
        let launch_key = ctx.accounts.launch.key();
        let mut launch = ctx.accounts.launch.load_mut()?;
        require!(launch.state == launch_state::OPEN, BouncerError::LaunchNotOpen);
        let params = launch.window_params();
        match auction_core::close_reason(&params, now, launch.total_deposits as u128) {
            Some(reason) => close_launch(&mut launch, launch_key, reason, now),
            None => err!(BouncerError::NotCloseable),
        }
    }

    /// 0.29: the second instruction of a launch's creation, in the same transaction as `create_launch`: the
    /// histogram is grown from `Histogram::INIT_LEN` to `Histogram::LEN` (one cross-program create allocates at most
    /// 10,240 bytes and one realloc adds at most 10,240), the creator pays the rent of the added bytes, and the launch
    /// records the account's lamports as the launch cost (`Launch.histogram_rent`, never refunded: the account is
    /// the auction's permanent receipt). The launch is Initializing until this lands and Open after it: `commit`
    /// refuses every bid before (`HistogramNotReady`); a second call is refused (`HistogramAlreadyGrown`); only the
    /// launch's creator may send it, and only while the bidding window is still open (`LaunchNotOpen` once
    /// `close_ts` has passed, or on a launch aborted at the deadline): nothing regrows or resets an activated launch,
    /// and nothing activates one whose window is already over (the 0.29 direct-call safety review, item 6).
    pub fn grow_histogram(ctx: Context<GrowHistogram>) -> Result<()> {
        let now = now_ts()?;
        let launch_key = ctx.accounts.launch.key();
        let mut launch = ctx.accounts.launch.load_mut()?;
        require!(launch.histogram_grown == 0, BouncerError::HistogramAlreadyGrown);
        require!(launch.state == launch_state::INITIALIZING, BouncerError::LaunchNotOpen);
        require!(now < launch.window_params().close_ts(), BouncerError::LaunchNotOpen);
        let info = ctx.accounts.histogram.to_account_info();
        require!(info.data_len() == Histogram::INIT_LEN, BouncerError::HistogramAlreadyGrown);
        {
            let d = info.try_borrow_data()?;
            require!(
                d[..8] == Histogram::DISCRIMINATOR[..] && d[8] == LAYOUT_VERSION && u16::from_le_bytes([d[10], d[11]]) as usize == TICK_COUNT,
                BouncerError::WrongLaunch
            );
        }
        let needed = Rent::get()?.minimum_balance(Histogram::LEN);
        let short = needed.saturating_sub(info.lamports());
        if short > 0 {
            system_program::transfer(
                CpiContext::new(
                    ctx.accounts.system_program.key(),
                    Transfer { from: ctx.accounts.creator.to_account_info(), to: info.clone() },
                ),
                short,
            )?;
        }
        info.resize(Histogram::LEN)?;
        // The added bytes are zero (the runtime zero-fills growth); made certain here, the counts start from zero.
        info.try_borrow_mut_data()?[Histogram::INIT_LEN..].fill(0);
        launch.histogram_grown = 1;
        launch.state = launch_state::OPEN;
        launch.histogram_rent = info.lamports();
        emit!(HistogramGrown { launch: launch_key, histogram_rent: launch.histogram_rent });
        Ok(())
    }

    /// 0.29: the admin waives the bid attestation on one running launch (Squad B's per-launch waiver, for a service
    /// outage or a launch that should not gate its bidders). Launch-wide and one direction only: nothing sets the
    /// flag back, new launches follow `Config.attest_bids`, it lands only while the bidding window is open (`Open`
    /// and before `close_ts`; `LaunchNotOpen` otherwise), once (`AttestationAlreadyWaived` after, or on a launch
    /// that never required it), and the time is recorded on the launch (`attest_waived_ts`) beside the event.
    pub fn admin_waive_attestation(ctx: Context<AdminWaiveAttestation>) -> Result<()> {
        let now = now_ts()?;
        let launch_key = ctx.accounts.launch.key();
        let mut launch = ctx.accounts.launch.load_mut()?;
        require!(launch.state == launch_state::OPEN && now < launch.window_params().close_ts(), BouncerError::LaunchNotOpen);
        require!(launch.attest_required == 1, BouncerError::AttestationAlreadyWaived);
        launch.attest_required = 0;
        launch.attest_waived_ts = now;
        emit!(AttestationWaived { launch: launch_key, admin: ctx.accounts.admin.key(), ts: now });
        Ok(())
    }

    // -------------------------------------------------------------- reveal

    pub fn post_beacon(ctx: Context<PostBeacon>, signature: [u8; 48]) -> Result<()> {
        let now = now_ts()?;
        let launch_key = ctx.accounts.launch.key();
        let mut launch = ctx.accounts.launch.load_mut()?;
        require_not_expired(&launch, now)?;
        let params = launch.window_params();
        require!(now >= params.close_ts(), BouncerError::WindowStillOpen);
        if launch.state == launch_state::OPEN {
            close_launch(&mut launch, launch_key, CloseReason::WindowElapsed, now)?;
        }
        require!(launch.state != launch_state::FAILED, BouncerError::LaunchFailed);
        require!(launch.state == launch_state::CLOSED, BouncerError::LaunchNotClosed);
        require!(launch.beacon_posted == 0, BouncerError::AlreadyPosted);

        let pk = bls::g2_decompress(&curve_constants::QUICKNET_PUBLIC_KEY_COMPRESSED)?;
        let ok = bls::verify_round_signature(&signature, &launch.round_point, &pk)?;
        require!(ok, BouncerError::SignatureInvalid);
        launch.beacon_signature = signature;
        launch.beacon_posted = 1;
        // v0.30 (2026-10-27): the lag sample, record only, never a refusal (a sniped launch is preferred to a
        // failed one). The verified signature proves the round's key exists, so the world's clock is at or past the round's
        // publish time; the chain's clock is `now`; the difference is a lower bound on how far the chain's clock lags the
        // world's (negative when the chain is ahead or the post was late). `breach` says the sample reached the launch's
        // margin: the chain was behind by a whole margin or more, the case the margin exists to cover. The keeper alerts.
        let publish = auction_core::beacon::publish_time(launch.reveal_round);
        let lag_secs = publish.saturating_sub(now);
        launch.beacon_posted_ts = now;
        launch.beacon_lag_secs = lag_secs;
        let margin_secs = launch.reveal_margin_secs;
        let breach = lag_secs >= margin_secs as i64;
        emit!(BeaconPosted { launch: launch_key, reveal_round: launch.reveal_round, posted_ts: now, lag_secs, margin_secs, breach });
        Ok(())
    }

    /// Decrypt every Bid account passed in remaining accounts. Anyone may send it; no bidder signs.
    ///
    /// 0.22: each bid moved out of Sealed (to Revealed or to Invalid) pays its processing charge to
    /// `processor`, once, in this instruction. A bid already processed is skipped and pays nothing
    /// (until 0.21 it failed the whole batch with `AlreadyRevealed`), so two processors racing lose
    /// only the overlap. Invalid means the ciphertext fails a deterministic check against the posted
    /// beacon (`bls::open_bid`); a syscall error, running out of compute or a wrong account is a
    /// transaction error and marks nothing. Refused at or after the recovery deadline.
    pub fn reveal<'info>(ctx: Context<'info, Reveal<'info>>) -> Result<()> {
        let now = now_ts()?;
        let launch_key = ctx.accounts.launch.key();
        let mut launch = ctx.accounts.launch.load_mut()?;
        require_not_expired(&launch, now)?;
        require!(launch.state == launch_state::CLOSED, BouncerError::LaunchNotClosed);
        require!(launch.beacon_posted == 1, BouncerError::BeaconNotPosted);
        let sig = bls::g1_decompress(&launch.beacon_signature)?;
        let mut hist = ctx.accounts.histogram.load_mut()?;

        let mut reward: u64 = 0;
        for info in ctx.remaining_accounts.iter() {
            require!(info.is_writable, BouncerError::AlreadyRevealed);
            let mut bid: Account<'info, Bid> = Account::try_from(info)?;
            require!(bid.launch == launch_key, BouncerError::WrongLaunch);
            if bid.state != bid_state::SEALED {
                continue;
            }
            reward = reward.checked_add(bid.processing_charge).ok_or(BouncerError::Overflow)?;
            bid.processing_charge = 0;
            match bls::open_bid(&sig, &bid.sealed)? {
                bls::Opened::Tick(tick) => {
                    bid.tick = tick;
                    bid.state = bid_state::REVEALED;
                    // 0.29: the deposit in lamports, exact; a slot cannot reach u64::MAX (the chain's supply is far
                    // under it) and the add is checked regardless.
                    let slot = &mut hist.counts[tick as usize];
                    *slot = slot.checked_add(bid.deposit).ok_or(BouncerError::Overflow)?;
                    launch.revealed_count = launch.revealed_count.checked_add(1).ok_or(BouncerError::Overflow)?;
                    emit!(BidRevealed { launch: launch_key, bid: bid.key(), tick, deposit: bid.deposit, revealed_count: launch.revealed_count });
                }
                bls::Opened::Invalid => {
                    bid.state = bid_state::INVALID;
                    launch.invalid_count = launch.invalid_count.checked_add(1).ok_or(BouncerError::Overflow)?;
                    emit!(BidInvalid { launch: launch_key, bid: bid.key(), deposit: bid.deposit, invalid_count: launch.invalid_count });
                }
            }
            bid.exit(&crate::ID)?;
        }
        drop(hist);
        drop(launch);
        pay_from_vault(&ctx.accounts.vault.to_account_info(), &ctx.accounts.processor.to_account_info(), reward)?;
        Ok(())
    }

    // ------------------------------------------------------------ settlement

    pub fn settle(ctx: Context<Settle>) -> Result<()> {
        let now = now_ts()?;
        let launch_key = ctx.accounts.launch.key();
        let mut launch = ctx.accounts.launch.load_mut()?;
        // 0.22: at or after the recovery deadline the launch cannot settle; a launch whose bids are
        // not all processed by then fails whole and refunds everyone (there is no settling on part
        // of the bid set, now or ever: the count check below is the only way in).
        require_not_expired(&launch, now)?;
        require!(launch.state == launch_state::CLOSED, BouncerError::LaunchNotClosed);
        require!(
            launch.revealed_count.checked_add(launch.invalid_count) == Some(launch.bid_count),
            BouncerError::BidsNotAllRevealed
        );
        let vault_info = ctx.accounts.vault.to_account_info();
        let payer_info = ctx.accounts.payer.to_account_info();
        // 0.29: the histogram (lamports per tick) is read here; it is never written again and never closed: the
        // auction's permanent receipt, every later step works from the record written below.
        let settlement = {
            let hist = ctx.accounts.histogram.load()?;
            require!(hist.tick_count as usize == TICK_COUNT, BouncerError::WrongLaunch);
            auction_core::settle(&hist.counts, launch.floor_value, launch.float).map_err(|_| error!(BouncerError::Overflow))?
        };
        match settlement {
            Settlement::Failed { revealed_deposits } => {
                launch.state = launch_state::FAILED;
                emit!(LaunchFailed {
                    launch: launch_key,
                    stage: 1,
                    total_deposits: launch.total_deposits,
                    revealed_deposits: revealed_deposits as u64,
                });
                // 0.22: the signer is repaid its allowance from the operating prepay; the record's
                // rent comes back to it on the close below.
                pay_ops(&mut launch, &vault_info, &payer_info, STEP_ALLOWANCE_LAMPORTS)?;
                drop(launch);
                // No record for a failed launch: give its rent back.
                ctx.accounts.settlement.close(ctx.accounts.payer.to_account_info())?;
            }
            Settlement::Cleared(c) => {
                let s = &mut ctx.accounts.settlement;
                s.version = LAYOUT_VERSION;
                s.bump = ctx.bumps.settlement;
                s._pad = [0u8; 2];
                s.clearing_tick = c.tick;
                s.marginal_tick = c.marginal_tick;
                s.launch = launch_key;
                s.float_value = u64::try_from(c.float_value).map_err(|_| error!(BouncerError::Overflow))?;
                s.winning_deposits = u64::try_from(c.winning_deposits).map_err(|_| error!(BouncerError::Overflow))?;
                s.above_deposits = u64::try_from(c.above_deposits).map_err(|_| error!(BouncerError::Overflow))?;
                s.at_deposits = u64::try_from(c.at_deposits).map_err(|_| error!(BouncerError::Overflow))?;
                s.revealed_bids = launch.revealed_count;
                s.invalid_bids = launch.invalid_count;
                s.settled_ts = now;
                s.tokens_delivered = 0;
                s.distributed_bids = 0;
                s.largest_fill_tokens = 0;
                s.pool = Pubkey::default();
                s.burned_tokens = 0;
                // Label the creator's own bid on the record. The launch says whether
                // one exists, so a settler cannot leave it out; the fill is the same
                // arithmetic delivery will use.
                let (cstate, ctick, cdeposit, ctokens, ccost) = if launch.creator_has_bid == 1 {
                    let cb = ctx.accounts.creator_bid.as_ref().ok_or_else(|| error!(BouncerError::CreatorBidMissing))?;
                    require!(cb.launch == launch_key && cb.bidder == launch.creator, BouncerError::WrongLaunch);
                    require!(cb.flags & Bid::FLAG_CREATOR != 0, BouncerError::WrongLaunch);
                    match cb.state {
                        bid_state::REVEALED => {
                            let f = auction_core::fill(cb.deposit, cb.tick, &c).map_err(|_| error!(BouncerError::Overflow))?;
                            (1u8, cb.tick, cb.deposit, f.tokens, f.cost)
                        }
                        bid_state::INVALID => (2u8, 0u16, cb.deposit, 0u64, 0u64),
                        _ => return err!(BouncerError::BidsNotAllRevealed),
                    }
                } else {
                    (0u8, 0u16, 0u64, 0u64, 0u64)
                };
                s.creator_deposit = cdeposit;
                s.creator_tokens = ctokens;
                s.creator_cost = ccost;
                s.creator_tick = ctick;
                s.creator_bid_state = cstate;
                s.lp_lock_state = 0;
                s._pad4 = [0u8; 4];
                s.lp_total = 0;
                s.creator_lock_nft = Pubkey::default();
                s.protocol_lock_nft = Pubkey::default();
                s.pool_sol_at_open = 0;
                s.pool_liquidity = 0;
                s.opening_sqrt_price = 0;
                s.dust_tokens_burned = 0;
                s.dust_lamports = 0;
                s.pool_payer = Pubkey::default();
                s.pool_loan = 0;
                // 0.28: the raise fee, agreed here from the launch's own copies of the terms and paid by `create_pool`.
                // `float_value` itself is untouched: every fill and every refund reads it exactly as before.
                let (fee_creator, fee_platform) = raise_fee_parts(s.float_value, launch.raise_fee_bps, launch.raise_fee_creator_share_bps)?;
                s.raise_fee_creator = fee_creator;
                s.raise_fee_platform = fee_platform;
                s.raise_fee_creator_paid = 0;
                s.raise_fee_platform_paid = 0;
                s.pool_sol_in = 0;
                s.cash_released = 0;
                s._pad_cash = [0u8; 7];
                // v0.30: frozen from `create_pool` until the open; nothing has opened yet.
                s.opened_ts = 0;
                s.opened_forced = 0;
                s._pad_open = [0u8; 7];
                s._reserved = [0u8; 360];
                launch.settled = 1;
                launch.state = launch_state::SETTLED;
                // 0.22: the record's rent, which the signer paid, plus the allowance, from the prepay.
                let record_rent = Rent::get()?.minimum_balance(SettlementRecord::LEN);
                let repay = record_rent.checked_add(STEP_ALLOWANCE_LAMPORTS).ok_or(BouncerError::Overflow)?;
                pay_ops(&mut launch, &vault_info, &payer_info, repay)?;
                emit!(Settled {
                    launch: launch_key,
                    clearing_tick: c.tick,
                    marginal_tick: c.marginal_tick,
                    float_value: s.float_value,
                    winning_deposits: s.winning_deposits,
                    above_deposits: s.above_deposits,
                    at_deposits: s.at_deposits,
                    revealed_bids: s.revealed_bids,
                    invalid_bids: s.invalid_bids,
                    creator_deposit: cdeposit,
                    creator_tokens: ctokens,
                    creator_cost: ccost,
                    creator_bid_state: cstate,
                    raise_fee_creator: fee_creator,
                    raise_fee_platform: fee_platform,
                });
                drop(launch);
            }
        }
        Ok(())
    }

    // ------------------------------------------------------------------ pool

    /// Open the launch's Meteora DAMM v2 pool (0.19) on the one config v19
    /// accepts, `meteora::CONFIG`, and lock all of its liquidity forever in the
    /// platform's position. Permissionless.
    ///
    /// The config is checked before anything moves (public, 1 percent flat, no
    /// dynamic fee, OnlyB, static, timestamp activation, full range). The
    /// opening price is computed here from the auction's proceeds,
    /// `float_value` lamports against the reserve half of the supply, with the
    /// largest liquidity whose rounded up deposit fits both; the pool is read
    /// back afterwards and must hold exactly that price, range, liquidity, fee
    /// mode, mints and creator.
    ///
    /// Meteora's payer and pool creator is the launch's `pool_creator` PDA (a
    /// dataless system account this program signs for): it pays the rents
    /// Meteora charges from lamports the payer lends it here, it owns the two
    /// pass through token accounts Meteora pulls from, and it owns the
    /// platform's position NFT for good. What the lent lamports did not cover
    /// goes back to the payer at the end.
    ///
    /// Rounding: Meteora rounds the deposit up, so the liquidity chosen leaves
    /// a few atoms of one or both sides behind. Leftover reserve atoms are
    /// burned (the mint authority is gone, so nobody could ever be owed them
    /// and the supply shrinks by exactly that). Leftover proceeds lamports go
    /// to the payer with the wrapped SOL account's rent, the same path stray
    /// wrapped SOL has taken since 0.17. Both amounts are recorded and emitted.
    ///
    /// The launch token (0.19, the pool squatting fix): the mint, the token vault and the
    /// metadata are created here, not at genesis. Anchor's `init` creates the mint at
    /// `["mint", creator, mint_salt]` (a stranger's lamports at that address are kept, not
    /// refused) and the token vault; this instruction then mints the whole supply into the
    /// vault, writes the Metaplex metadata from the name, symbol and URI kept at genesis,
    /// revokes the mint authority, and opens the pool, all in one instruction. Before it the
    /// mint does not exist, so Meteora refuses a pool for it; after it the pool's address is
    /// taken by this launch's own pool. `creator` and `mint_salt` repeat `Launch.creator`
    /// and `Launch.mint_salt` for the seeds; any other value derives another address and is
    /// refused `WrongLaunch`. The payer pays the mint, vault and metadata rents and Metaplex's
    /// fee, reimbursed by the bond like the rest.
    pub fn create_pool(ctx: Context<CreatePool>, creator: Pubkey, mint_salt: u64) -> Result<()> {
        let launch_key = ctx.accounts.launch.key();
        let float_value = ctx.accounts.settlement.float_value;
        let vault_bump = ctx.accounts.vault.bump;
        {
            let launch = ctx.accounts.launch.load()?;
            require_not_expired(&launch, now_ts()?)?;
            require!(launch.state == launch_state::SETTLED, BouncerError::NotSettled);
            require!(launch.creator == creator && launch.mint_salt == mint_salt, BouncerError::WrongLaunch);
            // v0.30: the platform's half of the raise fee goes to the treasury this launch recorded, or, for a launch
            // created before 0.30 (no treasury recorded), to its `lp_owner` as its terms said; never anywhere else.
            let want = if launch.treasury == Pubkey::default() { launch.lp_owner } else { launch.treasury };
            require!(ctx.accounts.treasury.key() == want, BouncerError::WrongTreasury);
        }
        // 0.22: what the payer spends in this handler, measured, plus the rents Anchor's `init`
        // took from it before the handler ran, is repaid from the operating prepay at the end.
        let payer_at_start = ctx.accounts.payer.lamports();

        let rent = Rent::get()?;
        // Genesis of the token, moved here from `create_launch` (0.19): the four accounts by hand and the whole
        // supply (2026-10-21); the metadata and the revocation follow in `finish_mint`, the next instruction.
        mint_launch_token(&ctx.accounts, launch_key, vault_bump, &creator, mint_salt, &ctx.bumps, &rent)?;

        // 0. The config, then the opening, before anything moves.
        assert_meteora_config(&ctx.accounts.meteora_config.to_account_info())?;
        // 0.28: the raise fee (2026-10-08), agreed at `settle` and paid in step 8, after the last CPI:
        // the creator's part to the creator's wallet, the platform's to the fee destination this launch recorded
        // at genesis, both as lamports out of the vault, no CPI (the instruction's trace does not grow). A part
        // its destination could not hold rent exempt stays in the proceeds (`fee_payable`). The pool opens on what
        // is left against the whole reserve, so its price is the clearing price less the fee's share: 1 percent
        // under at 100 basis points. Nothing is burned beyond the rounding dust of any opening.
        let fee_creator = fee_payable(&ctx.accounts.creator_wallet.to_account_info(), ctx.accounts.settlement.raise_fee_creator, &rent);
        // v0.30: the platform's part goes to the treasury the launch recorded, never to `lp_owner` (the router, trading fees only).
        let fee_platform = fee_payable(&ctx.accounts.treasury.to_account_info(), ctx.accounts.settlement.raise_fee_platform, &rent);
        let pool_sol = float_value.checked_sub(fee_creator).and_then(|v| v.checked_sub(fee_platform)).ok_or(BouncerError::Overflow)?;
        let opening = meteora::opening(pool_sol, auction_core::POOL_RESERVE).ok_or(BouncerError::OpeningPriceOutOfRange)?;
        // Stray wrapped SOL (0.17): lamports strangers sent to the pass through's address before it existed.
        let stray_wsol = token_amount(&ctx.accounts.payer_wsol.to_account_info())?;

        // 1. Lend the pool creator PDA the rents Meteora charges its payer: the pool, the
        //    position, the two vaults and the position NFT's mint and token account (Token-2022
        //    with metadata, sized by Meteora, so a flat 2,048 byte allowance covers both).
        //    Plus the rent exemption of a zero byte account (0.20): the unused part of the loan
        //    now stays in the PDA until `lock_liquidity` returns it, and a system account may not
        //    end an instruction holding more than nothing but less than that exemption.
        let creator_bump = ctx.bumps.pool_creator;
        let creator_seeds: &[&[u8]] = &[POOL_CREATOR_SEED, launch_key.as_ref(), &[creator_bump]];
        let nft_seeds: &[&[u8]] = &[POSITION_NFT_SEED, launch_key.as_ref(), &[SIDE_PLATFORM], &[ctx.bumps.platform_nft_mint]];
        let lend = pool_loan(&rent)?;
        system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.key(),
                Transfer { from: ctx.accounts.payer.to_account_info(), to: ctx.accounts.pool_creator.to_account_info() },
            ),
            lend,
        )?;

        // 2. Proceeds: vault lamports into the wrapped SOL pass through (0.28: less the raise fee parts paid in
        //    step 8). The vault is debited directly (this program owns it); a zero lamport system transfer
        //    carrying the vault makes the runtime see the move before the token program's sync (unchanged since
        //    0.12: at a CPI the runtime checks the instruction's lamports over the accounts that call carries, so
        //    the sync alone, the credited pass through without the debited vault, is refused. A sync carrying the
        //    vault as an extra account would save this entry; LiteSVM's token program refuses the extra account,
        //    so it was not taken, 2026-10-21).
        pay_from_vault(&ctx.accounts.vault.to_account_info(), &ctx.accounts.payer_wsol.to_account_info(), pool_sol)?;
        let mut sync_data = Vec::with_capacity(12);
        sync_data.extend_from_slice(&2u32.to_le_bytes());
        sync_data.extend_from_slice(&0u64.to_le_bytes());
        solana_cpi::invoke(
            &solana_instruction::Instruction {
                program_id: system_program::ID,
                accounts: vec![
                    solana_instruction::AccountMeta::new(ctx.accounts.payer.key(), true),
                    solana_instruction::AccountMeta::new(ctx.accounts.payer_wsol.key(), false),
                    solana_instruction::AccountMeta::new(ctx.accounts.vault.key(), false),
                ],
                data: sync_data,
            },
            &[ctx.accounts.payer.to_account_info(), ctx.accounts.payer_wsol.to_account_info(), ctx.accounts.vault.to_account_info()],
        )?;
        token::sync_native(CpiContext::new(ctx.accounts.token_program.key(), SyncNative { account: ctx.accounts.payer_wsol.to_account_info() }))?;

        // 3. The reserve half of the supply into the token pass through.
        let vault_seeds: &[&[&[u8]]] = &[&[VAULT_SEED, launch_key.as_ref(), &[vault_bump]]];
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.key(),
                token::Transfer {
                    from: ctx.accounts.token_vault.to_account_info(),
                    to: ctx.accounts.payer_tokens.to_account_info(),
                    authority: ctx.accounts.vault.to_account_info(),
                },
                vault_seeds,
            ),
            auction_core::POOL_RESERVE,
        )?;

        // 4. Meteora initialize_pool: token A the launch token (classic SPL), token B wrapped SOL.
        initialize_meteora_pool(&ctx.accounts, &opening, creator_seeds, nft_seeds)?;

        // 5. Read back. The pool must be exactly what was asked, and the pass throughs must
        //    have lost exactly the computed deposit.
        let pool_sol_at_open = check_pool_after_create(&ctx.accounts, &opening)?;
        let dust_tokens = auction_core::POOL_RESERVE - opening.token_amount;
        let dust_lamports = pool_sol - opening.sol_amount;
        require!(
            token_amount(&ctx.accounts.payer_tokens.to_account_info())? == dust_tokens
                && token_amount(&ctx.accounts.payer_wsol.to_account_info())? == dust_lamports.checked_add(stray_wsol).ok_or(BouncerError::Overflow)?,
            BouncerError::PoolAmountsMismatch
        );

        // 6. Permanent lock of the whole initial position, in the same instruction that created
        //    it, so the liquidity is never withdrawable for even one slot.
        lock_platform_position(&ctx.accounts, opening.liquidity, creator_seeds)?;
        assert_platform_not_delegated(&ctx.accounts.platform_position.to_account_info(), &ctx.accounts.platform_nft_account.to_account_info())?;

        // 6b. v0.30 (2026-10-27, gate X): the pool's launch token vault is frozen in the instruction that made it,
        //     by the mint's freeze authority, the vault PDA. The token program then refuses every transfer into or out of
        //     it, whoever signs and whichever program calls, so no swap can land on this pool until `open_trading` thaws
        //     it once every bid is delivered or refunded (or the Squad's break-glass does). One CPI, one inner trace
        //     entry (measured 55 of 64 with the keeper's prefix in the v0.30 review). The state byte is read back.
        freeze_pool_vault(&ctx.accounts, launch_key, vault_bump)?;

        // 7. Rounding leftovers. Reserve atoms stay in the token pass through and are recorded
        //    (`dust_tokens_burned`); `burn_unsold` burns exactly that many (0.21: moved out of this
        //    instruction, whose trace had one entry left under full pre-funding). The pass through
        //    stays open as the platform position's token A claim destination (zero under OnlyB).
        //    The wrapped SOL pass through stays open too, holding its rent, the leftover proceeds
        //    lamports and any stray wrapped SOL: `lock_liquidity` closes it to this payer (the ninth
        //    0.29 candidate, 2026-10-21: one trace entry out of here; until then it closed here), and
        //    the repayment below leaves those lamports out as it leaves out the PDA's loan.
        if dust_lamports > 0 || stray_wsol > 0 {
            msg!("rounding leftover: {} reserve atoms kept for burn_unsold, {} proceeds lamports and {} stray wrapped SOL left in the wrapped SOL pass through for lock_liquidity", dust_tokens, dust_lamports, stray_wsol);
        }

        // 8. The unused rent loan stays in the pool creator PDA: `lock_liquidity` returns it to
        //    the payer recorded below (0.20; moved out to keep this instruction's trace short).
        //    The raise fee (0.28): the two parts out of the vault, here, after the last CPI. At each CPI the
        //    runtime checks the instruction's lamports only over the accounts that call carries, so a credit
        //    to the creator's wallet or the fee destination before one is a lamport it cannot see, and the
        //    instruction is refused (the first 0.28 build, cec53100, made them in step 2 and was refused
        //    whenever a part was paid to an account other than the payer). The end of the instruction checks
        //    every account it carries. Before step 9, so a payer that is also a destination is measured with
        //    its part, which step 9 adds back.
        pay_from_vault(&ctx.accounts.vault.to_account_info(), &ctx.accounts.creator_wallet.to_account_info(), fee_creator)?;
        pay_from_vault(&ctx.accounts.vault.to_account_info(), &ctx.accounts.treasury.to_account_info(), fee_platform)?;

        // 9. Repay the payer from the operating prepay (0.22; until 0.21 the whole bond was paid
        //    here, whatever the step cost). Repaid: its net spend in this handler (the four accounts
        //    it created, measured since 2026-10-21 like the rest, and the pass through's rent coming
        //    back on its close), less the loan to the pool creator PDA, which `lock_liquidity` returns
        //    or, for the part Meteora keeps, repays; plus the fixed step allowance.
        // 0.28: a payer that is also a fee destination (the creator opening its own pool) was credited its part
        // above; that credit is not a saving on the step, so it is added back before the spend is measured.
        let payer_fee = (if ctx.accounts.creator_wallet.key() == ctx.accounts.payer.key() { fee_creator } else { 0 })
            .checked_add(if ctx.accounts.treasury.key() == ctx.accounts.payer.key() { fee_platform } else { 0 })
            .ok_or(BouncerError::Overflow)?;
        // The ninth 0.29 candidate: the wrapped SOL pass through stays open (its rent, the leftover and any stray
        // wrapped SOL), a second loan `lock_liquidity` returns to this payer whole, so it is left out here as the
        // PDA's loan is; the payer's repayment and the prepay are what they were when the close was here.
        let wsol_held = ctx.accounts.payer_wsol.to_account_info().lamports();
        let spent_here = (payer_at_start as i128) - (ctx.accounts.payer.lamports() as i128) - (lend as i128) - (wsol_held as i128) + (payer_fee as i128);
        let repay = u64::try_from(spent_here.max(0)).map_err(|_| error!(BouncerError::Overflow))?;
        let repay = repay.checked_add(STEP_ALLOWANCE_LAMPORTS).ok_or(BouncerError::Overflow)?;
        let crank_bond = {
            let mut launch = ctx.accounts.launch.load_mut()?;
            pay_ops(&mut launch, &ctx.accounts.vault.to_account_info(), &ctx.accounts.payer.to_account_info(), repay)?
        };

        let pool = ctx.accounts.pool.key();
        let platform_nft_mint = ctx.accounts.platform_nft_mint.key();
        let s = &mut ctx.accounts.settlement;
        s.pool = pool;
        s.lp_total = 0;
        s.protocol_lock_nft = platform_nft_mint;
        s.lp_lock_state |= LOCK_BIT_PLATFORM;
        s.pool_sol_at_open = pool_sol_at_open;
        s.pool_liquidity = opening.liquidity;
        s.opening_sqrt_price = opening.sqrt_price;
        s.dust_tokens_burned = dust_tokens;
        s.dust_lamports = dust_lamports;
        s.pool_payer = ctx.accounts.payer.key();
        s.pool_loan = lend;
        s.raise_fee_creator_paid = fee_creator;
        s.raise_fee_platform_paid = fee_platform;
        s.pool_sol_in = pool_sol;
        let mut launch = ctx.accounts.launch.load_mut()?;
        launch.state = launch_state::POOL_LIVE;
        launch.trading_state = 1;
        launch.pool_created_ts = now_ts()?;
        emit!(PoolCreated {
            launch: launch_key,
            pool,
            float_value,
            crank_bond,
            cranker: ctx.accounts.payer.key(),
            pool_sol_at_open,
            liquidity: opening.liquidity,
            sqrt_price: opening.sqrt_price,
            dust_tokens_burned: dust_tokens,
            dust_lamports,
            platform_nft_mint,
            raise_fee_creator_paid: fee_creator,
            raise_fee_platform_paid: fee_platform,
            pool_sol_in: pool_sol,
        });
        emit!(LiquidityLocked {
            launch: launch_key,
            pool,
            which: 1,
            nft_owner: ctx.accounts.pool_creator.key(),
            nft_mint: platform_nft_mint,
            liquidity: opening.liquidity,
        });
        Ok(())
    }

    /// 2026-10-21 (the trace headroom review finding): the launch token's Metaplex metadata, written from the name,
    /// symbol and URI kept at genesis, and the revocation of its mint authority, both out of `create_pool`, which
    /// ran at the runtime's 64 trace entries exactly with the keeper's price instruction in front. Permissionless,
    /// exactly once per launch, in PoolLive or Finalized (the tenth candidate, review finding N4: nothing requires it, and
    /// finalization never closes it; the metadata is never a prerequisite of any money step). Until it lands the mint
    /// authority is the vault PDA, which only this program signs for: the supply is fixed from `create_pool` on either
    /// way. Funding (review finding N3): while the prepay is open (`bond_state` 0, the normal order) the payer's spend (the
    /// metadata's rent and Metaplex's fee) plus the step allowance are repaid from it, as every step's are; once the
    /// prepay was returned (a lock or a cash release landed first) the payer is paid from `Launch.metadata_reserve`,
    /// which that return held back, capped by it, and the rest of the reserve goes to the creator.
    pub fn finish_mint(ctx: Context<FinishMint>) -> Result<()> {
        let launch_key = ctx.accounts.launch.key();
        let vault_bump = ctx.accounts.vault.bump;
        {
            let launch = ctx.accounts.launch.load()?;
            require!(matches!(launch.state, launch_state::POOL_LIVE | launch_state::FINALIZED), BouncerError::NotPoolLive);
            require!(launch.mint_finished == 0, BouncerError::MintAlreadyFinished);
        }
        require!(ctx.accounts.token_mint.mint_authority.is_some(), BouncerError::MintAlreadyFinished);
        let payer_at_start = ctx.accounts.payer.lamports();
        write_metadata_and_revoke(&ctx.accounts, launch_key, vault_bump)?;
        let spent_here = u64::try_from(((payer_at_start as i128) - (ctx.accounts.payer.lamports() as i128)).max(0)).map_err(|_| error!(BouncerError::Overflow))?;
        let repay = spent_here.checked_add(STEP_ALLOWANCE_LAMPORTS).ok_or(BouncerError::Overflow)?;
        let (repaid, reserve_returned) = {
            let vault_info = ctx.accounts.vault.to_account_info();
            let mut launch = ctx.accounts.launch.load_mut()?;
            launch.mint_finished = 1;
            if launch.bond_state == 0 {
                (pay_ops(&mut launch, &vault_info, &ctx.accounts.payer.to_account_info(), repay)?, 0)
            } else {
                // After every CPI: direct credits. The reserve leaves the vault whole, so `ops_paid` grows by all of it
                // and `crank_bond - ops_paid` stays what the vault still holds of the prepay.
                let reserve = launch.metadata_reserve;
                let pay = repay.min(reserve);
                let rest = reserve - pay;
                pay_from_vault(&vault_info, &ctx.accounts.payer.to_account_info(), pay)?;
                pay_from_vault(&vault_info, &ctx.accounts.creator.to_account_info(), rest)?;
                launch.ops_paid = launch.ops_paid.checked_add(reserve).ok_or(BouncerError::Overflow)?;
                launch.metadata_reserve = 0;
                (pay, rest)
            }
        };
        emit!(MintFinished { launch: launch_key, mint: ctx.accounts.token_mint.key(), metadata: ctx.accounts.metadata.key(), payer: ctx.accounts.payer.key(), repaid, reserve_returned });
        Ok(())
    }

    /// 0.29 twelfth candidate (review finding F2, built in the tenth, deferred in the eleventh, approved
    /// 2026-10-21): the cash steps of `lock_liquidity` without Meteora's split,
    /// for a launch whose creator split cannot land (cp-amm changed, the creator's position refused, anything): the
    /// wrapped SOL pass through closed to the pool payer, the pool creator PDA's unused rent loan returned to it,
    /// the part Meteora kept repaid to it from the prepay, and the unused prepay returned to the creator (less
    /// `burn_unsold`'s allowance and the metadata reserve). Permissionless, once, `POOL_CASH_RELEASE_SECS` after
    /// settlement, while the creator side is not locked. `lock_liquidity` afterwards does the split and the NFT only,
    /// with the program id in its pass through slot; its payer is then not repaid (the prepay is gone). The creator's
    /// unsplit share stays in the platform position, where `collect_platform_fees` cannot touch it (`SplitNotDone`),
    /// and `burn_unsold` still waits for the split: this moves cash only.
    pub fn release_pool_cash(ctx: Context<ReleasePoolCash>) -> Result<()> {
        let launch_key = ctx.accounts.launch.key();
        let creator = {
            let launch = ctx.accounts.launch.load()?;
            require!(launch.state == launch_state::POOL_LIVE, BouncerError::NotPoolLive);
            launch.creator
        };
        let s = &ctx.accounts.settlement;
        require!(s.lp_lock_state & LOCK_BIT_CREATOR == 0, BouncerError::LpAlreadyLocked);
        require!(s.cash_released == 0, BouncerError::CashAlreadyReleased);
        let due = s.settled_ts.checked_add(POOL_CASH_RELEASE_SECS).ok_or(BouncerError::Overflow)?;
        require!(now_ts()? >= due, BouncerError::ReleaseTooEarly);
        let pool_loan = s.pool_loan;
        let creator_seeds: &[&[u8]] = &[POOL_CREATOR_SEED, launch_key.as_ref(), &[ctx.bumps.pool_creator]];
        let wsol_closed = ctx.accounts.payer_wsol.to_account_info().lamports();
        token::close_account(CpiContext::new_with_signer(
            ctx.accounts.token_program.key(),
            CloseAccount {
                account: ctx.accounts.payer_wsol.to_account_info(),
                destination: ctx.accounts.pool_payer.to_account_info(),
                authority: ctx.accounts.pool_creator.to_account_info(),
            },
            &[creator_seeds],
        ))?;
        let returned = ctx.accounts.pool_creator.lamports();
        if returned > 0 {
            system_program::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.system_program.key(),
                    Transfer { from: ctx.accounts.pool_creator.to_account_info(), to: ctx.accounts.pool_payer.to_account_info() },
                    &[creator_seeds],
                ),
                returned,
            )?;
        }
        // After the last CPI: direct credits from the vault, by the recorded amounts.
        let kept = pool_loan.saturating_sub(returned);
        let loan_repaid = {
            let vault_info = ctx.accounts.vault.to_account_info();
            let mut launch = ctx.accounts.launch.load_mut()?;
            let paid = pay_ops(&mut launch, &vault_info, &ctx.accounts.pool_payer.to_account_info(), kept)?;
            if launch.bond_state == 0 {
                let (amount, held, metadata_reserve) = return_prepay(&mut launch, &vault_info, &ctx.accounts.creator.to_account_info())?;
                emit!(PrepayReturned { launch: launch_key, creator, amount, held, metadata_reserve });
            }
            paid
        };
        ctx.accounts.settlement.cash_released = 1;
        emit!(PoolCashReleased { launch: launch_key, pool_payer: ctx.accounts.pool_payer.key(), wsol_closed, loan_returned: returned, loan_repaid });
        Ok(())
    }

    /// Collect the platform position's trading fees (0.19). Permissionless and
    /// keyless: the only authority in the path is the launch's pool creator
    /// PDA, which owns the platform's position NFT, and it signs through this
    /// program. The payer is any fee payer (a cron's hot key does); it signs
    /// nothing that moves value and pays only for the LP owner's wrapped SOL
    /// account the first time. Fees are paid to `Launch.lp_owner`, the
    /// destination copied from the config at genesis (0.24; until 0.23 the
    /// live `Config.lp_owner`, so one accepted change moved every launch's
    /// accrued fees), as wrapped SOL in its associated token account; the
    /// launch token side (zero under OnlyB) lands in the PDA's own token
    /// account. A change of destination reaches only launches created after
    /// it. Claiming nothing is not an error.
    pub fn collect_platform_fees<'info>(ctx: Context<'info, CollectPlatformFees<'info>>) -> Result<()> {
        let launch_key = ctx.accounts.launch.key();
        // 2026-10-21 (review finding F7): the launch is read through the layout table (`launch_fee_view`), so a pool
        // opened under an earlier layout keeps its fee rights across every upgrade; the three fields it needs are
        // checked here, where the account's shape is known.
        let view = launch_fee_view(&ctx.accounts.launch.to_account_info())?;
        require!(view.state == launch_state::POOL_LIVE || view.state == launch_state::FINALIZED, BouncerError::NotPoolLive);
        require_keys_eq!(ctx.accounts.lp_owner.key(), view.lp_owner, BouncerError::WrongFeeOwner);
        require_keys_eq!(ctx.accounts.token_mint.key(), view.token_mint, BouncerError::WrongLaunch);
        // Not before the creator's split (0.20, its own error since 0.21): see `require_collect_allowed`.
        require_collect_allowed(ctx.accounts.settlement.lp_lock_state)?;
        // The position is the platform's (0.21): its address is derived from the recorded NFT mint
        // already; its own `nft_mint` and `pool` fields must say so too, so no other position of
        // this pool (the creator's included) can be claimed through the pool creator PDA.
        position_buckets(&ctx.accounts.platform_position.to_account_info(), &ctx.accounts.settlement.protocol_lock_nft, &ctx.accounts.settlement.pool)?;
        let lp_owner = ctx.accounts.lp_owner.key();
        let wsol = ctx.accounts.wsol_mint.key();
        require_keys_eq!(
            ctx.accounts.lp_owner_wsol.key(),
            associated_token_address(&lp_owner, &wsol, &token::ID),
            BouncerError::WrongFeeOwner
        );
        associated_token::create_idempotent(CpiContext::new(
            ctx.accounts.associated_token_program.key(),
            associated_token::Create {
                payer: ctx.accounts.payer.to_account_info(),
                associated_token: ctx.accounts.lp_owner_wsol.to_account_info(),
                authority: ctx.accounts.lp_owner.to_account_info(),
                mint: ctx.accounts.wsol_mint.to_account_info(),
                system_program: ctx.accounts.system_program.to_account_info(),
                token_program: ctx.accounts.token_program.to_account_info(),
            },
        ))?;
        assert_platform_not_delegated(&ctx.accounts.platform_position.to_account_info(), &ctx.accounts.platform_nft_account.to_account_info())?;
        let before_b = token_amount(&ctx.accounts.lp_owner_wsol.to_account_info())?;
        let before_a = token_amount(&ctx.accounts.pool_tokens.to_account_info())?;
        let ix = meteora::claim_position_fee(&meteora::ClaimPositionFeeAccounts {
            pool: ctx.accounts.pool.key(),
            position: ctx.accounts.platform_position.key(),
            token_a_account: ctx.accounts.pool_tokens.key(),
            token_b_account: ctx.accounts.lp_owner_wsol.key(),
            token_a_vault: ctx.accounts.token_a_vault.key(),
            token_b_vault: ctx.accounts.token_b_vault.key(),
            token_a_mint: ctx.accounts.token_mint.key(),
            token_b_mint: wsol,
            position_nft_account: ctx.accounts.platform_nft_account.key(),
            signer: ctx.accounts.pool_creator.key(),
            token_a_program: ctx.accounts.token_program.key(),
            token_b_program: ctx.accounts.token_program.key(),
        });
        solana_cpi::invoke_signed(
            &ix,
            &[
                ctx.accounts.pool_authority.to_account_info(),
                ctx.accounts.pool.to_account_info(),
                ctx.accounts.platform_position.to_account_info(),
                ctx.accounts.pool_tokens.to_account_info(),
                ctx.accounts.lp_owner_wsol.to_account_info(),
                ctx.accounts.token_a_vault.to_account_info(),
                ctx.accounts.token_b_vault.to_account_info(),
                ctx.accounts.token_mint.to_account_info(),
                ctx.accounts.wsol_mint.to_account_info(),
                ctx.accounts.platform_nft_account.to_account_info(),
                ctx.accounts.pool_creator.to_account_info(),
                ctx.accounts.token_program.to_account_info(),
                ctx.accounts.event_authority.to_account_info(),
                ctx.accounts.cp_amm_program.to_account_info(),
            ],
            &[&[POOL_CREATOR_SEED, launch_key.as_ref(), &[ctx.bumps.pool_creator]]],
        )?;
        let lamports = token_amount(&ctx.accounts.lp_owner_wsol.to_account_info())?.saturating_sub(before_b);
        let token_atoms = token_amount(&ctx.accounts.pool_tokens.to_account_info())?.saturating_sub(before_a);
        emit!(PlatformFeesCollected { launch: launch_key, pool: ctx.accounts.pool.key(), lp_owner, lamports, token_atoms });
        // v0.30 (2026-10-27, the buy-and-burn folded into the core): a launch whose destination is the fee vault
        // PDA splits what its wrapped SOL account holds, `BUYBACK_BURN_BPS` to the burn vault's wrapped SOL account and
        // the rest to the treasury as native SOL, exact to the lamport: the wrapped SOL account is closed into the fee
        // vault (its balance and its rent arrive as lamports), the treasury's part moves on and the rent goes back to
        // the payer, who created the account at the top of this instruction. Nobody signs but the payer; the treasury key
        // never does. The three accounts come as the remaining accounts, since a launch created before the fee vault
        // (every devnet launch) keeps the 0.24 behaviour and the 0.24 account list. The config is read raw for its
        // live treasury: a treasury rotation (proposed, accepted by its key) reaches every pool's future fees.
        let (fee_vault, fee_bump) = fee_vault_address();
        if lp_owner == fee_vault {
            let rem = ctx.remaining_accounts;
            require!(rem.len() >= 3, BouncerError::SplitAccountsMissing);
            let (config_ai, burn_wsol_ai, treasury_ai) = (&rem[0], &rem[1], &rem[2]);
            let vault_ai = ctx.accounts.lp_owner.to_account_info();
            let payer_ai = ctx.accounts.payer.to_account_info();
            require!(vault_ai.is_writable && burn_wsol_ai.is_writable && treasury_ai.is_writable, BouncerError::SplitAccountsMissing);
            require_keys_eq!(*vault_ai.owner, crate::ID, BouncerError::WrongFeeOwner);
            require_keys_eq!(config_ai.key(), Pubkey::find_program_address(&[CONFIG_SEED], &crate::ID).0, BouncerError::Unauthorized);
            require_keys_eq!(*config_ai.owner, crate::ID, BouncerError::Unauthorized);
            let treasury = {
                let d = config_ai.try_borrow_data()?;
                require!(d.len() >= 356 && d[..8] == Config::DISCRIMINATOR[..], BouncerError::Unauthorized);
                Pubkey::new_from_array(d[324..356].try_into().unwrap())
            };
            require!(treasury != Pubkey::default(), BouncerError::ConfigIncomplete);
            require_keys_eq!(treasury_ai.key(), treasury, BouncerError::WrongTreasury);
            require_keys_eq!(burn_wsol_ai.key(), associated_token_address(&burn_vault_address().0, &wsol, &token::ID), BouncerError::WrongBurnVault);
            let held = token_amount(&ctx.accounts.lp_owner_wsol.to_account_info())?;
            let burn_part = u64::try_from((held as u128) * (BUYBACK_BURN_BPS as u128) / (BPS_DENOMINATOR as u128)).map_err(|_| error!(BouncerError::Overflow))?;
            let treasury_part = held - burn_part;
            let seeds: &[&[u8]] = &[FEE_VAULT_SEED, &[fee_bump]];
            if burn_part > 0 {
                token::transfer(
                    CpiContext::new_with_signer(
                        ctx.accounts.token_program.key(),
                        token::Transfer { from: ctx.accounts.lp_owner_wsol.to_account_info(), to: burn_wsol_ai.clone(), authority: vault_ai.clone() },
                        &[seeds],
                    ),
                    burn_part,
                )?;
            }
            let vault_before = vault_ai.lamports();
            token::close_account(CpiContext::new_with_signer(
                ctx.accounts.token_program.key(),
                CloseAccount { account: ctx.accounts.lp_owner_wsol.to_account_info(), destination: vault_ai.clone(), authority: vault_ai.clone() },
                &[seeds],
            ))?;
            let got = vault_ai.lamports().checked_sub(vault_before).ok_or(BouncerError::Overflow)?;
            let rent_back = got.checked_sub(treasury_part).ok_or(BouncerError::Overflow)?;
            pay_from_vault(&vault_ai, treasury_ai, treasury_part)?;
            pay_from_vault(&vault_ai, &payer_ai, rent_back)?;
            emit!(PlatformFeesSplit { launch: launch_key, pool: ctx.accounts.pool.key(), claimed: lamports, held, treasury, treasury_lamports: treasury_part, burn_lamports: burn_part });
        }
        Ok(())
    }

    /// v0.30 (2026-10-27, the buy-and-burn folded into the core): the ops Squad sets the buy-and-burn's terms
    /// after the BOUNCER genesis (the mint and its canonical pool), the crankers allowed to run it, the cap, the
    /// interval and the price limit. Zeros for the mint and the pool keep `buy_and_burn` refused `BuybackPoolNotSet`
    /// while the burn vault accumulates; a non-zero pool needs a non-zero mint, cap and price limit (`InvalidConfig`).
    /// The clock (`last_buy_ts`) is not an argument and is not reset here.
    pub fn admin_set_buyback(ctx: Context<AdminSetBuyback>, args: BuybackArgs) -> Result<()> {
        let c = &mut ctx.accounts.config;
        require_keys_eq!(c.admin, ctx.accounts.admin.key(), BouncerError::Unauthorized);
        if args.bouncer_pool != Pubkey::default() {
            require!(args.bouncer_mint != Pubkey::default() && args.buy_cap_lamports != 0 && args.buy_max_price_x64 != 0, BouncerError::InvalidConfig);
        }
        c.bouncer_mint = args.bouncer_mint;
        c.bouncer_pool = args.bouncer_pool;
        c.burn_crankers = args.burn_crankers;
        c.buy_cap_lamports = args.buy_cap_lamports;
        c.buy_min_interval_secs = args.buy_min_interval_secs;
        c.buy_max_price_x64 = args.buy_max_price_x64;
        emit!(BuybackConfigured {
            admin: c.admin,
            bouncer_mint: args.bouncer_mint,
            bouncer_pool: args.bouncer_pool,
            burn_crankers: args.burn_crankers,
            buy_cap_lamports: args.buy_cap_lamports,
            buy_min_interval_secs: args.buy_min_interval_secs,
            buy_max_price_x64: args.buy_max_price_x64,
            ts: now_ts()?,
        });
        Ok(())
    }

    /// v0.30 (the fold-in): anyone creates the fee vault (a program-owned account, so the program may move the lamports
    /// a closed wrapped SOL account leaves in it) and the burn vault's wrapped SOL account, once; the payer pays their
    /// rent. The burn vault itself is an address, never an account: it signs its token accounts by its seeds.
    pub fn init_platform_vaults(ctx: Context<InitPlatformVaults>) -> Result<()> {
        ctx.accounts.fee_vault.bump = ctx.bumps.fee_vault;
        let burn_vault = ctx.accounts.burn_vault.key();
        require_keys_eq!(ctx.accounts.burn_vault_wsol.key(), associated_token_address(&burn_vault, &ctx.accounts.wsol_mint.key(), &token::ID), BouncerError::WrongBurnVault);
        associated_token::create_idempotent(CpiContext::new(
            ctx.accounts.associated_token_program.key(),
            associated_token::Create {
                payer: ctx.accounts.payer.to_account_info(),
                associated_token: ctx.accounts.burn_vault_wsol.to_account_info(),
                authority: ctx.accounts.burn_vault.to_account_info(),
                mint: ctx.accounts.wsol_mint.to_account_info(),
                system_program: ctx.accounts.system_program.to_account_info(),
                token_program: ctx.accounts.token_program.to_account_info(),
            },
        ))?;
        emit!(PlatformVaultsInitialized { payer: ctx.accounts.payer.key(), fee_vault: ctx.accounts.fee_vault.key(), burn_vault, burn_vault_wsol: ctx.accounts.burn_vault_wsol.key() });
        Ok(())
    }

    /// v0.30 (2026-10-27, the buy-and-burn folded into the core): a cranker on the config's list swaps the burn
    /// vault's wrapped SOL (at most the cap) for BOUNCER on the canonical pool and burns every atom bought in the same
    /// transaction. Refused `BuybackPoolNotSet` until the Squad set the mint and the pool (the vault accumulates
    /// meanwhile), `NotABurnCranker` for any other signer, `BuybackTooSoon` within the interval of the last buy,
    /// `NothingToBuy` on an empty vault. The price limit: the swap's minimum output is `lamports * 2^64 / max_price`
    /// atoms, or the caller's `min_out` when that is higher; cp-amm refuses the swap (and so the whole instruction,
    /// nothing moves) when the pool's state, a sandwich included, would pay fewer. The caller pays the signature fee
    /// and, the first time, the burn vault's BOUNCER token account.
    pub fn buy_and_burn(ctx: Context<BuyAndBurn>, min_out: u64) -> Result<()> {
        let c = &ctx.accounts.config;
        require!(c.bouncer_pool != Pubkey::default() && c.bouncer_mint != Pubkey::default(), BouncerError::BuybackPoolNotSet);
        let cranker = ctx.accounts.cranker.key();
        require!(cranker != Pubkey::default() && c.burn_crankers.contains(&cranker), BouncerError::NotABurnCranker);
        let now = now_ts()?;
        let due = c.last_buy_ts.saturating_add(i64::try_from(c.buy_min_interval_secs).unwrap_or(i64::MAX));
        require!(now >= due, BouncerError::BuybackTooSoon);
        require!(c.buy_cap_lamports != 0 && c.buy_max_price_x64 != 0, BouncerError::BuybackLimitUnset);
        require_keys_eq!(ctx.accounts.pool.key(), c.bouncer_pool, BouncerError::WrongBuybackPool);
        require_keys_eq!(ctx.accounts.bouncer_mint.key(), c.bouncer_mint, BouncerError::WrongBuybackPool);
        let wsol = ctx.accounts.wsol_mint.key();
        {
            // The pool: cp-amm's, the mint as token A and wrapped SOL as token B (this program's own pools), and its
            // vaults as it records them.
            let pool_ai = ctx.accounts.pool.to_account_info();
            require_keys_eq!(*pool_ai.owner, meteora::PROGRAM_ID, BouncerError::WrongBuybackPool);
            let d = pool_ai.try_borrow_data()?;
            require!(d.len() >= meteora::pool::LEN && d[..8] == meteora::pool::DISCRIMINATOR[..], BouncerError::WrongBuybackPool);
            let k = |o: usize| Pubkey::new_from_array(d[o..o + 32].try_into().unwrap());
            require!(k(meteora::pool::TOKEN_A_MINT) == c.bouncer_mint && k(meteora::pool::TOKEN_B_MINT) == wsol, BouncerError::WrongBuybackPool);
            require!(k(meteora::pool::TOKEN_A_VAULT) == ctx.accounts.token_a_vault.key() && k(meteora::pool::TOKEN_B_VAULT) == ctx.accounts.token_b_vault.key(), BouncerError::WrongBuybackPool);
        }
        let (burn_vault, burn_bump) = burn_vault_address();
        require_keys_eq!(ctx.accounts.burn_vault.key(), burn_vault, BouncerError::WrongBurnVault);
        require_keys_eq!(ctx.accounts.burn_vault_wsol.key(), associated_token_address(&burn_vault, &wsol, &token::ID), BouncerError::WrongBurnVault);
        require_keys_eq!(ctx.accounts.burn_vault_tokens.key(), associated_token_address(&burn_vault, &c.bouncer_mint, &token::ID), BouncerError::WrongBurnVault);
        associated_token::create_idempotent(CpiContext::new(
            ctx.accounts.associated_token_program.key(),
            associated_token::Create {
                payer: ctx.accounts.cranker.to_account_info(),
                associated_token: ctx.accounts.burn_vault_tokens.to_account_info(),
                authority: ctx.accounts.burn_vault.to_account_info(),
                mint: ctx.accounts.bouncer_mint.to_account_info(),
                system_program: ctx.accounts.system_program.to_account_info(),
                token_program: ctx.accounts.token_program.to_account_info(),
            },
        ))?;
        let held = token_amount(&ctx.accounts.burn_vault_wsol.to_account_info())?;
        let amount = core::cmp::min(held, c.buy_cap_lamports);
        require!(amount > 0, BouncerError::NothingToBuy);
        let floor = u64::try_from(((amount as u128) << 64) / c.buy_max_price_x64).map_err(|_| error!(BouncerError::Overflow))?;
        require!(floor > 0, BouncerError::BuybackLimitUnset);
        let min_out = core::cmp::max(min_out, floor);
        let before = token_amount(&ctx.accounts.burn_vault_tokens.to_account_info())?;
        let ix = meteora::swap(
            &meteora::SwapAccounts {
                pool: ctx.accounts.pool.key(),
                input_token_account: ctx.accounts.burn_vault_wsol.key(),
                output_token_account: ctx.accounts.burn_vault_tokens.key(),
                token_a_vault: ctx.accounts.token_a_vault.key(),
                token_b_vault: ctx.accounts.token_b_vault.key(),
                token_a_mint: c.bouncer_mint,
                token_b_mint: wsol,
                payer: burn_vault,
                token_a_program: ctx.accounts.token_program.key(),
                token_b_program: ctx.accounts.token_program.key(),
            },
            amount,
            min_out,
        );
        let seeds: &[&[u8]] = &[BURN_VAULT_SEED, &[burn_bump]];
        solana_cpi::invoke_signed(
            &ix,
            &[
                ctx.accounts.pool_authority.to_account_info(),
                ctx.accounts.pool.to_account_info(),
                ctx.accounts.burn_vault_wsol.to_account_info(),
                ctx.accounts.burn_vault_tokens.to_account_info(),
                ctx.accounts.token_a_vault.to_account_info(),
                ctx.accounts.token_b_vault.to_account_info(),
                ctx.accounts.bouncer_mint.to_account_info(),
                ctx.accounts.wsol_mint.to_account_info(),
                ctx.accounts.burn_vault.to_account_info(),
                ctx.accounts.token_program.to_account_info(),
                ctx.accounts.cp_amm_program.to_account_info(),
                ctx.accounts.event_authority.to_account_info(),
            ],
            &[seeds],
        )?;
        let bought = token_amount(&ctx.accounts.burn_vault_tokens.to_account_info())?.checked_sub(before).ok_or(BouncerError::Overflow)?;
        require!(bought >= min_out, BouncerError::BuybackLimitUnset);
        let atoms = token_amount(&ctx.accounts.burn_vault_tokens.to_account_info())?;
        token::burn(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.key(),
                Burn { mint: ctx.accounts.bouncer_mint.to_account_info(), from: ctx.accounts.burn_vault_tokens.to_account_info(), authority: ctx.accounts.burn_vault.to_account_info() },
                &[seeds],
            ),
            atoms,
        )?;
        let c = &mut ctx.accounts.config;
        c.last_buy_ts = now;
        emit!(BoughtAndBurned { cranker, lamports: amount, atoms, min_out, max_price_x64: c.buy_max_price_x64, ts: now });
        Ok(())
    }

    // ---------------------------------------------------------- distribution

    /// Push a winner its tokens and refund. Anyone may run it, and the caller pays
    /// for the bidder's token account if it is missing. How the caller is paid is
    /// the launch's own term, fixed at genesis (`Launch.delivery_terms`):
    /// - a launch created by 0.26 or later: the caller is repaid the rent it just
    ///   paid into that token account, plus `Launch.delivery_reward`, out of this
    ///   bid's own account, and the rest of the bid account goes to the bidder with
    ///   the refund (`close = bidder`). No tokens are taken.
    /// - a launch created before 0.26: as it always was. The caller is paid
    ///   `Launch.delivery_fee_bps` of the tokens and the whole bid account goes to
    ///   the bidder.
    pub fn deliver(ctx: Context<Deliver>) -> Result<()> {
        let launch_key = ctx.accounts.launch.key();
        // v0.30 (2026-10-27): a bid whose account is already closed (another push landed first, or the bidder's
        // own) is a harmless no-op: the transaction lands, nothing moves for it, the other items of a batch are
        // unaffected. The claim-only refusal is gone with the flag: every winner is pushed.
        let bid_info = ctx.accounts.bid.to_account_info();
        let Some(bid) = load_open_bid(&bid_info, &ctx.accounts.bidder.key(), launch_key)? else {
            emit!(AlreadyDistributed { launch: launch_key, bid: bid_info.key(), caller: ctx.accounts.caller.key() });
            return Ok(());
        };
        // v0.32: a parked bid is distributed; its push is `push_parked`. A no-op here, so a batch still lands.
        if bid.state == bid_state::PARKED {
            emit!(AlreadyDistributed { launch: launch_key, bid: bid_info.key(), caller: ctx.accounts.caller.key() });
            return Ok(());
        }
        let (fill, fee_bps, bid_rent_terms, reward) = {
            let launch = ctx.accounts.launch.load()?;
            require!(launch.state == launch_state::POOL_LIVE, BouncerError::NotPoolLive);
            match payout_for(&launch, Some(&ctx.accounts.settlement), &bid)? {
                Payout::Tokens(fill) => (fill, launch.delivery_fee_bps, launch.delivery_terms == delivery_terms::BID_RENT, launch.delivery_reward),
                _ => return err!(BouncerError::NotAWinner),
            }
        };
        // The launch's own copy of the fee, taken at genesis. The config is not in
        // this instruction's accounts (0.18): a pushed delivery depends on nothing
        // it does not read. 0.26: with bid rent terms no tokens are taken, whatever
        // the launch's fee field holds.
        let fee_tokens = if bid_rent_terms { 0 } else { delivery_fee(fill.tokens, fee_bps)? };
        let d = DeliveryAccounts {
            launch_key,
            fee_tokens,
            fee_to: Some((ctx.accounts.caller_token.to_account_info(), ctx.accounts.caller.to_account_info())),
            vault: &ctx.accounts.vault,
            token_vault: &ctx.accounts.token_vault,
            token_mint: ctx.accounts.token_mint.to_account_info(),
            bidder: ctx.accounts.bidder.to_account_info(),
            bidder_token: ctx.accounts.bidder_token.to_account_info(),
            payer: ctx.accounts.caller.to_account_info(),
            token_program: &ctx.accounts.token_program,
            associated_token_program: &ctx.accounts.associated_token_program,
            system_program: &ctx.accounts.system_program,
        };
        let rent_paid = deliver_tokens(&d, &fill)?;
        record_delivery(&mut ctx.accounts.settlement, &fill)?;
        {
            let mut launch = ctx.accounts.launch.load_mut()?;
            launch.distributed_count = launch.distributed_count.checked_add(1).ok_or(BouncerError::Overflow)?;
        }
        emit!(Delivered { launch: launch_key, bid: bid_info.key(), bidder: bid.bidder, tokens: fill.tokens, cost: fill.cost, refund: fill.refund, fee_tokens });
        if bid_rent_terms {
            // After every CPI: the bid account pays the caller, then the close below empties it to the bidder.
            let reward = repay_caller_from_bid(&bid_info, &ctx.accounts.bidder.to_account_info(), &ctx.accounts.caller.to_account_info(), rent_paid, reward)?;
            emit!(DeliveryRepaid { launch: launch_key, bid: bid_info.key(), caller: ctx.accounts.caller.key(), rent: rent_paid, reward });
        }
        close_bid(&bid_info, &ctx.accounts.bidder.to_account_info())
    }

    /// Refund an invalid bid, a loser, or any bid of a failed or aborted launch.
    pub fn refund(ctx: Context<Refund>) -> Result<()> {
        let launch_key = ctx.accounts.launch.key();
        // v0.30: a closed bid account is a harmless no-op, as in `deliver`.
        let bid_info = ctx.accounts.bid.to_account_info();
        let Some(bid) = load_open_bid(&bid_info, &ctx.accounts.bidder.key(), launch_key)? else {
            emit!(AlreadyDistributed { launch: launch_key, bid: bid_info.key(), caller: ctx.accounts.caller.key() });
            return Ok(());
        };
        // v0.32: a parked bid is distributed and its lamports are held for it; a refund of it is a no-op.
        if bid.state == bid_state::PARKED {
            emit!(AlreadyDistributed { launch: launch_key, bid: bid_info.key(), caller: ctx.accounts.caller.key() });
            return Ok(());
        }
        let amount = {
            let mut launch = ctx.accounts.launch.load_mut()?;
            expire_if_due(&mut launch, launch_key, now_ts()?)?;
            match payout_for(&launch, ctx.accounts.settlement.as_deref().map(|a| &**a), &bid)? {
                Payout::Refund(a) => a,
                _ => return err!(BouncerError::IsAWinner),
            }
        };
        pay_from_vault(&ctx.accounts.vault.to_account_info(), &ctx.accounts.bidder.to_account_info(), amount)?;
        if let Some(s) = ctx.accounts.settlement.as_mut() {
            s.distributed_bids = s.distributed_bids.checked_add(1).ok_or(BouncerError::Overflow)?;
        }
        {
            let mut launch = ctx.accounts.launch.load_mut()?;
            launch.distributed_count = launch.distributed_count.checked_add(1).ok_or(BouncerError::Overflow)?;
        }
        emit!(Refunded { launch: launch_key, bid: bid_info.key(), bidder: bid.bidder, amount });
        close_bid(&bid_info, &ctx.accounts.bidder.to_account_info())
    }

    /// v0.32 (2026-10-28): park a payout that cannot land, so one bid
    /// never holds up its launch. Permissionless. Allowed on an open bid of a PoolLive, Failed or Aborted launch when
    /// (1) a winner's associated token account is unusable (`bidder_token_unusable`: an owner moved by SetAuthority, a
    /// frozen or foreign account), (2) a winner's bid account cannot repay the delivery's rent (`delivery_rent_short`:
    /// a rent rise, an emptied wallet), or (4) `PARK_AFTER_SECS` have passed since the pool was created (since the close
    /// for a failed or aborted launch), whatever the reason the payout has not landed. Nothing leaves the program: a
    /// winner's tokens stay in the launch's token vault (recorded as delivered, so `burn_unsold` leaves them), the
    /// lamports owed stay in the vault (`Launch.parked_lamports`, which `burn_unsold` leaves), both recorded on the bid,
    /// which stays open as the bidder's ticket in state Parked. The bid counts as distributed, so `open_trading` and
    /// `burn_unsold` proceed. The caller of a winner's park is paid the launch's delivery reward out of the bidder's own
    /// money, as a push's is: what the bid's account holds above its rent, then the parked lamports (never below zero;
    /// a full fill with an account at its rent pays none). No CPI. A closed or already parked bid is a no-op.
    pub fn park_bid(ctx: Context<ParkBid>) -> Result<()> {
        let launch_key = ctx.accounts.launch.key();
        let bid_info = ctx.accounts.bid.to_account_info();
        let bidder_key = ctx.accounts.bidder.key();
        let Some(mut bid) = load_open_bid(&bid_info, &bidder_key, launch_key)? else {
            emit!(AlreadyDistributed { launch: launch_key, bid: bid_info.key(), caller: ctx.accounts.caller.key() });
            return Ok(());
        };
        if bid.state == bid_state::PARKED {
            emit!(AlreadyDistributed { launch: launch_key, bid: bid_info.key(), caller: ctx.accounts.caller.key() });
            return Ok(());
        }
        let now = now_ts()?;
        let (payout, since, mint, bid_rent_terms, reward) = {
            let mut launch = ctx.accounts.launch.load_mut()?;
            expire_if_due(&mut launch, launch_key, now)?;
            require!(matches!(launch.state, launch_state::POOL_LIVE | launch_state::FAILED | launch_state::ABORTED), BouncerError::NotParkable);
            let payout = payout_for(&launch, ctx.accounts.settlement.as_deref().map(|a| &**a), &bid)?;
            let since = if launch.state == launch_state::POOL_LIVE {
                if launch.pool_created_ts != 0 {
                    launch.pool_created_ts
                } else {
                    ctx.accounts.settlement.as_ref().ok_or(BouncerError::SettlementRequired)?.settled_ts
                }
            } else {
                launch.close_ts
            };
            (payout, since, launch.token_mint, launch.delivery_terms == delivery_terms::BID_RENT, launch.delivery_reward)
        };
        let late = now >= since.checked_add(PARK_AFTER_SECS).ok_or(BouncerError::Overflow)?;
        let (fill, lamports, reason) = match payout {
            Payout::Tokens(fill) => {
                let bidder_token = ctx.accounts.bidder_token.to_account_info();
                require_keys_eq!(bidder_token.key(), anchor_spl::associated_token::get_associated_token_address(&bidder_key, &mint), BouncerError::WrongBidderToken);
                let reason = if bidder_token_unusable(&bidder_token, &bidder_key, &mint) {
                    1u8
                } else if bid_rent_terms && delivery_rent_short(&bid_info, &ctx.accounts.bidder.to_account_info(), &bidder_token, fill.refund)? {
                    2
                } else if late {
                    4
                } else {
                    return err!(BouncerError::NotParkable);
                };
                (Some(fill), fill.refund, reason)
            }
            Payout::Refund(amount) => {
                require!(late, BouncerError::NotParkable);
                (None, amount, 4u8)
            }
            Payout::WaitForPool => return err!(BouncerError::NotParkable),
        };
        // A winner's park pays its caller the launch's reward, as a push does, out of the bidder's own money: first what
        // the bid's account holds above its rent, then the parked lamports. A loser's park is free, as its refund is.
        let (from_bid, from_parked) = if fill.is_some() && bid_rent_terms && reward > 0 {
            let spare = bid_info.lamports().saturating_sub(Rent::get()?.minimum_balance(bid_info.data_len()));
            let from_bid = reward.min(spare);
            (from_bid, (reward - from_bid).min(lamports))
        } else {
            (0, 0)
        };
        let lamports = lamports - from_parked;
        if let Some(fill) = fill.as_ref() {
            record_delivery(ctx.accounts.settlement.as_mut().ok_or(BouncerError::SettlementRequired)?, fill)?;
        } else if let Some(s) = ctx.accounts.settlement.as_mut() {
            s.distributed_bids = s.distributed_bids.checked_add(1).ok_or(BouncerError::Overflow)?;
        }
        {
            let mut launch = ctx.accounts.launch.load_mut()?;
            launch.distributed_count = launch.distributed_count.checked_add(1).ok_or(BouncerError::Overflow)?;
            launch.parked_count = launch.parked_count.checked_add(1).ok_or(BouncerError::Overflow)?;
            launch.parked_lamports = launch.parked_lamports.checked_add(lamports).ok_or(BouncerError::Overflow)?;
        }
        let tokens = fill.as_ref().map(|f| f.tokens).unwrap_or(0);
        bid.state = bid_state::PARKED;
        bid.parked_tokens = tokens;
        bid.parked_lamports = lamports;
        store_bid(&bid_info, &bid)?;
        let caller_info = ctx.accounts.caller.to_account_info();
        pay_from_vault(&ctx.accounts.vault.to_account_info(), &caller_info, from_parked)?;
        if from_bid > 0 {
            let mut from = bid_info.try_borrow_mut_lamports()?;
            let mut to = caller_info.try_borrow_mut_lamports()?;
            **from = from.checked_sub(from_bid).ok_or(BouncerError::Overflow)?;
            **to = to.checked_add(from_bid).ok_or(BouncerError::Overflow)?;
        }
        let paid = from_bid + from_parked;
        emit!(BidParked { launch: launch_key, bid: bid_info.key(), bidder: bidder_key, caller: ctx.accounts.caller.key(), tokens, lamports, reason, reward: paid });
        Ok(())
    }

    /// v0.32: the bidder collects its parked payout to destinations it names: the tokens to any token account of the
    /// mint (the token program checks the mint), the lamports and the bid account's own lamports to `destination`.
    /// Only the bidder signs; any launch state (the bid is parked). The bid account is closed.
    pub fn collect_parked(ctx: Context<CollectParked>) -> Result<()> {
        let launch_key = ctx.accounts.launch.key();
        let bid_info = ctx.accounts.bid.to_account_info();
        let bidder_key = ctx.accounts.bidder.key();
        let bid = load_open_bid(&bid_info, &bidder_key, launch_key)?.ok_or(BouncerError::NotParked)?;
        require!(bid.state == bid_state::PARKED, BouncerError::NotParked);
        let (tokens, lamports) = (bid.parked_tokens, bid.parked_lamports);
        let mut token_destination = Pubkey::default();
        if tokens > 0 {
            let (Some(token_vault), Some(dest)) = (ctx.accounts.token_vault.as_ref(), ctx.accounts.token_destination.as_ref()) else {
                return err!(BouncerError::TokenAccountsRequired);
            };
            token_destination = dest.key();
            let signer_seeds: &[&[&[u8]]] = &[&[VAULT_SEED, launch_key.as_ref(), &[ctx.accounts.vault.bump]]];
            token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.key(),
                    token::Transfer { from: token_vault.to_account_info(), to: dest.to_account_info(), authority: ctx.accounts.vault.to_account_info() },
                    signer_seeds,
                ),
                tokens,
            )?;
        }
        // After the CPI: direct credits.
        let destination = ctx.accounts.destination.to_account_info();
        pay_from_vault(&ctx.accounts.vault.to_account_info(), &destination, lamports)?;
        {
            let mut launch = ctx.accounts.launch.load_mut()?;
            launch.parked_count = launch.parked_count.checked_sub(1).ok_or(BouncerError::Overflow)?;
            launch.parked_lamports = launch.parked_lamports.checked_sub(lamports).ok_or(BouncerError::Overflow)?;
        }
        emit!(ParkedCollected { launch: launch_key, bid: bid_info.key(), bidder: bidder_key, token_destination, destination: destination.key(), tokens, lamports });
        close_bid(&bid_info, &destination)
    }

    /// v0.32: anyone pushes a parked payout to the bidder's own associated token account (created if missing, its rent
    /// repaid to the caller out of the bid's own account as `deliver` does, no reward) and wallet, once they can take
    /// it. A closed bid is a no-op; a bid that is not parked is refused.
    pub fn push_parked(ctx: Context<PushParked>) -> Result<()> {
        let launch_key = ctx.accounts.launch.key();
        let bid_info = ctx.accounts.bid.to_account_info();
        let bidder_info = ctx.accounts.bidder.to_account_info();
        let Some(bid) = load_open_bid(&bid_info, &bidder_info.key(), launch_key)? else {
            emit!(AlreadyDistributed { launch: launch_key, bid: bid_info.key(), caller: ctx.accounts.caller.key() });
            return Ok(());
        };
        require!(bid.state == bid_state::PARKED, BouncerError::NotParked);
        let (tokens, lamports) = (bid.parked_tokens, bid.parked_lamports);
        let mut rent_paid = 0;
        if tokens > 0 {
            let (Some(token_mint), Some(token_vault), Some(bidder_token)) =
                (ctx.accounts.token_mint.as_ref(), ctx.accounts.token_vault.as_ref(), ctx.accounts.bidder_token.as_ref())
            else {
                return err!(BouncerError::TokenAccountsRequired);
            };
            let d = DeliveryAccounts {
                launch_key,
                fee_tokens: 0,
                fee_to: None,
                vault: &ctx.accounts.vault,
                token_vault,
                token_mint: token_mint.to_account_info(),
                bidder: bidder_info.clone(),
                bidder_token: bidder_token.to_account_info(),
                payer: ctx.accounts.caller.to_account_info(),
                token_program: &ctx.accounts.token_program,
                associated_token_program: &ctx.accounts.associated_token_program,
                system_program: &ctx.accounts.system_program,
            };
            rent_paid = deliver_tokens(&d, &auction_core::Fill { tokens, cost: 0, refund: lamports })?;
        } else {
            pay_from_vault(&ctx.accounts.vault.to_account_info(), &bidder_info, lamports)?;
        }
        // After every CPI: the caller's fronted rent back out of the bid's own account, then the rest to the bidder.
        if rent_paid > 0 {
            repay_caller_from_bid(&bid_info, &bidder_info, &ctx.accounts.caller.to_account_info(), rent_paid, 0)?;
        }
        {
            let mut launch = ctx.accounts.launch.load_mut()?;
            launch.parked_count = launch.parked_count.checked_sub(1).ok_or(BouncerError::Overflow)?;
            launch.parked_lamports = launch.parked_lamports.checked_sub(lamports).ok_or(BouncerError::Overflow)?;
        }
        emit!(ParkedPushed { launch: launch_key, bid: bid_info.key(), bidder: bidder_info.key(), caller: ctx.accounts.caller.key(), tokens, lamports, rent: rent_paid });
        close_bid(&bid_info, &bidder_info)
    }

    // v0.30 (2026-10-27): `claim` is gone. Self-claim is removed; every winner is pushed by `deliver`, which a
    // winner may send for its own bid (it is its own caller, so the repayment and the reward come back to it), and every
    // loser by `refund`. A client sending the old instruction is refused by Anchor's dispatch (an unknown discriminator).

    /// v0.30 (2026-10-27, gate X): trading opens only once every bid of the launch is delivered or refunded
    /// (`distributed_count == bid_count`, the guard finalize already uses). Permissionless and without allowance: the
    /// keeper sends it in the transaction of its last push batch, and anyone else may. Thaws the pool's launch token
    /// vault, which `create_pool` froze, and revokes the mint's freeze authority for good, so no account of this mint
    /// can ever be frozen again. Refused on a launch whose pool predates 0.30 (`TradingGateNone`) and twice
    /// (`TradingAlreadyOpen`).
    pub fn open_trading(ctx: Context<OpenTrading>) -> Result<()> {
        let launch_key = ctx.accounts.launch.key();
        {
            let launch = ctx.accounts.launch.load()?;
            require_trading_frozen(&launch)?;
            require!(launch.distributed_count == launch.bid_count, BouncerError::TradingNotOpenable);
        }
        let OpenTrading { launch, settlement, vault, token_mint, pool, token_a_vault, token_program } = &mut *ctx.accounts;
        let vault_bump = vault.bump;
        let (opened_ts, distributed_count, bid_count) = thaw_and_open(
            launch,
            &mut **settlement,
            &vault.to_account_info(),
            vault_bump,
            &token_mint.to_account_info(),
            &pool.to_account_info(),
            &token_a_vault.to_account_info(),
            &token_program.to_account_info(),
            false,
        )?;
        emit!(TradingOpened { launch: launch_key, pool: settlement.pool, opened_ts, distributed_count, bid_count });
        Ok(())
    }

    /// v0.30 (the stall escape is the Squad's break-glass only, no timer): opens trading with bids still
    /// outstanding. The config admin (the Squad after the freeze) signs; nothing else differs from `open_trading`.
    /// Every undelivered bid stays pushable afterwards. The event and `SettlementRecord.opened_forced` record it.
    pub fn admin_open_trading(ctx: Context<AdminOpenTrading>) -> Result<()> {
        let launch_key = ctx.accounts.launch.key();
        let undelivered = {
            let launch = ctx.accounts.launch.load()?;
            require_trading_frozen(&launch)?;
            launch.bid_count.saturating_sub(launch.distributed_count)
        };
        let admin = ctx.accounts.admin.key();
        let AdminOpenTrading { launch, settlement, vault, token_mint, pool, token_a_vault, token_program, .. } = &mut *ctx.accounts;
        let vault_bump = vault.bump;
        let (opened_ts, _, _) = thaw_and_open(
            launch,
            &mut **settlement,
            &vault.to_account_info(),
            vault_bump,
            &token_mint.to_account_info(),
            &pool.to_account_info(),
            &token_a_vault.to_account_info(),
            &token_program.to_account_info(),
            true,
        )?;
        emit!(TradingForcedOpen { launch: launch_key, pool: settlement.pool, opened_ts, undelivered, admin });
        Ok(())
    }

    /// The creator's side of the pool's permanently locked liquidity (0.19).
    /// `create_pool` locked all of it in the platform's position; this moves
    /// `Launch.creator_lp_bps` of it (every bucket, permanent liquidity and any
    /// pending fees alike) into a second position with Meteora's
    /// `split_position2`, then hands that position's NFT to the launch creator,
    /// who claims its fees from Meteora directly with their own key: no Bouncer
    /// instruction and no permission of ours is in that path. Both positions
    /// stay permanently locked; a split cannot unlock anything.
    ///
    /// Permissionless; the payer pays the new position's rents and the
    /// creator's NFT token account. Runs once, and `burn_unsold` refuses to
    /// finalize until it has.
    pub fn lock_liquidity(ctx: Context<LockLiquidity>) -> Result<()> {
        let launch_key = ctx.accounts.launch.key();
        let (creator, creator_lp_bps) = {
            let launch = ctx.accounts.launch.load()?;
            require!(launch.state == launch_state::POOL_LIVE, BouncerError::NotPoolLive);
            (launch.creator, launch.creator_lp_bps)
        };
        let payer_at_start = ctx.accounts.payer.lamports();
        let (lock_state, pool_liquidity) = (ctx.accounts.settlement.lp_lock_state, ctx.accounts.settlement.pool_liquidity);
        require!(lock_state & LOCK_BIT_PLATFORM != 0, BouncerError::PlatformNotLocked);
        require!(lock_state & LOCK_BIT_CREATOR == 0, BouncerError::LpAlreadyLocked);
        let numerator = u32::try_from((creator_lp_bps as u64) * (meteora::SPLIT_DENOMINATOR / BPS_DENOMINATOR)).map_err(|_| error!(BouncerError::Overflow))?;
        assert_platform_not_delegated(&ctx.accounts.platform_position.to_account_info(), &ctx.accounts.platform_nft_account.to_account_info())?;
        // The wrapped SOL pass through of `create_pool`, closed to the pool payer (the ninth 0.29 candidate: one
        // trace entry out of `create_pool`): its rent, the opening's leftover lamports and any stray wrapped SOL,
        // which `create_pool` left out of that payer's repayment as it leaves out the PDA's loan. Before every
        // direct credit below (a CPI after one would be refused: the runtime checks the lamports of the accounts a
        // call carries). 0.29 tenth candidate (review finding F2): already closed when `release_pool_cash` ran; the slot then
        // carries the program id and is required otherwise.
        let released = ctx.accounts.settlement.cash_released != 0;
        let wsol_closed = if released {
            0
        } else {
            let payer_wsol = ctx.accounts.payer_wsol.as_ref().ok_or(BouncerError::TokenAccountsRequired)?;
            let wsol_closed = payer_wsol.to_account_info().lamports();
            let creator_seeds: &[&[u8]] = &[POOL_CREATOR_SEED, launch_key.as_ref(), &[ctx.bumps.pool_creator]];
            token::close_account(CpiContext::new_with_signer(
                ctx.accounts.token_program.key(),
                CloseAccount {
                    account: payer_wsol.to_account_info(),
                    destination: ctx.accounts.pool_payer.to_account_info(),
                    authority: ctx.accounts.pool_creator.to_account_info(),
                },
                &[creator_seeds],
            ))?;
            msg!("wrapped SOL pass through closed to the pool payer: {} lamports", wsol_closed);
            wsol_closed
        };
        let pool = ctx.accounts.pool.key();
        let (nft_mint, creator_liquidity) = if numerator > 0 {
            let creator_liquidity = split_to_creator(&ctx.accounts, launch_key, numerator, ctx.bumps.pool_creator, ctx.bumps.creator_nft_mint, pool_liquidity)?;
            give_creator_nft(&ctx.accounts, launch_key, &creator, ctx.bumps.pool_creator)?;
            (ctx.accounts.creator_nft_mint.key(), creator_liquidity)
        } else {
            (Pubkey::default(), 0)
        };
        // The pool creator PDA's unused rent loan goes back to the `create_pool` payer (0.20).
        let returned = ctx.accounts.pool_creator.lamports();
        if returned > 0 {
            let creator_seeds: &[&[u8]] = &[POOL_CREATOR_SEED, launch_key.as_ref(), &[ctx.bumps.pool_creator]];
            system_program::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.system_program.key(),
                    Transfer { from: ctx.accounts.pool_creator.to_account_info(), to: ctx.accounts.pool_payer.to_account_info() },
                    &[creator_seeds],
                ),
                returned,
            )?;
        }
        msg!("rent loan returned to the pool payer: {} lamports", returned);

        // 0.22: from the operating prepay, the part of the loan Meteora kept goes to the pool
        // payer, and this signer's measured spend here plus the step allowance goes to it.
        let payer_key = ctx.accounts.payer.key();
        let mut spent_here = (payer_at_start as i128) - (ctx.accounts.payer.lamports() as i128);
        if payer_key == ctx.accounts.pool_payer.key() {
            spent_here += (returned as i128) + (wsol_closed as i128);
        }
        let spent_here = u64::try_from(spent_here.max(0)).map_err(|_| error!(BouncerError::Overflow))?;
        // 0.23: the loan as recorded when it was made, never recomputed.
        let kept = ctx.accounts.settlement.pool_loan.saturating_sub(returned);
        {
            let vault_info = ctx.accounts.vault.to_account_info();
            let mut launch = ctx.accounts.launch.load_mut()?;
            pay_ops(&mut launch, &vault_info, &ctx.accounts.pool_payer.to_account_info(), kept)?;
            let repay = spent_here.checked_add(STEP_ALLOWANCE_LAMPORTS).ok_or(BouncerError::Overflow)?;
            pay_ops(&mut launch, &vault_info, &ctx.accounts.payer.to_account_info(), repay)?;
            // 0.23: this is the last operating step of a cleared launch. The unused prepay goes back to the
            // creator here, not at finalize, which one absent claim-only winner can block forever. Only
            // `burn_unsold`'s allowance stays (bond_state 3). From recorded amounts, never the balance.
            // 0.29 tenth candidate: `release_pool_cash` may have done this already (bond_state 3 then); and the
            // metadata reserve is held back while `finish_mint` has not landed (review finding N3).
            if launch.bond_state == 0 {
                let (amount, held, metadata_reserve) = return_prepay(&mut launch, &vault_info, &ctx.accounts.creator.to_account_info())?;
                emit!(PrepayReturned { launch: launch_key, creator, amount, held, metadata_reserve });
            }
        }
        let s = &mut ctx.accounts.settlement;
        s.lp_lock_state |= LOCK_BIT_CREATOR;
        s.creator_lock_nft = nft_mint;
        emit!(LiquidityLocked { launch: launch_key, pool, which: 0, nft_owner: creator, nft_mint, liquidity: creator_liquidity });
        Ok(())
    }

    /// Burn what is left in the token vault, sweep the lamport dust to the
    /// caller, Finalized. Requires every bid delivered or refunded, and both
    /// LP positions locked.
    pub fn burn_unsold(ctx: Context<BurnUnsold>) -> Result<()> {
        let launch_key = ctx.accounts.launch.key();
        let vault_bump = ctx.accounts.vault.bump;
        {
            let launch = ctx.accounts.launch.load()?;
            require!(
                matches!(launch.state, launch_state::POOL_LIVE | launch_state::FAILED | launch_state::ABORTED),
                BouncerError::NotAllDistributed
            );
            require!(launch.distributed_count == launch.bid_count, BouncerError::NotAllDistributed); // load-bearing, see below
            if launch.state == launch_state::POOL_LIVE {
                let s = ctx.accounts.settlement.as_ref().ok_or(BouncerError::NotAllDistributed)?;
                require!(s.lp_lock_state == 3, BouncerError::LpNotLocked);
                // v0.30: never finalize a frozen pool; the order open, then finalize, holds on chain whatever the keeper does.
                require!(launch.trading_state != 1, BouncerError::TradingNotOpen);
                require!(ctx.accounts.token_mint.is_some() && ctx.accounts.token_vault.is_some(), BouncerError::TokenAccountsRequired);
            }
        }
        // Failed or aborted: no pool, so (since 0.19) no mint or token vault; both passed as the program id. The guard
        // above keeps a hazard latent: `payout_for` pays FINALIZED by cleared rules, safe only because no bid survives.
        let signer_seeds: &[&[&[u8]]] = &[&[VAULT_SEED, launch_key.as_ref(), &[vault_bump]]];
        let mut burned_tokens = 0;
        if let (Some(token_mint), Some(token_vault)) = (ctx.accounts.token_mint.as_ref(), ctx.accounts.token_vault.as_ref()) {
            // Every bid is closed (the guard above), so nothing here backs a claim. The burn is FLOAT - tokens_delivered,
            // recorded, capped by the balance (0.21): a donation is neither burned nor able to block it. Without the guard
            // this figure would include undelivered winners' fills. What remains is rounding dust, fewer atoms than filled
            // bids (auction-core invariant 3). Destructive work runs on recorded amounts, never on an empty vault test.
            let unsold = auction_core::FLOAT
                .checked_sub(ctx.accounts.settlement.as_ref().map(|s| s.tokens_delivered).unwrap_or(0))
                .ok_or(BouncerError::Overflow)?;
            if token_vault.amount != unsold {
                msg!("token vault holds {} atoms against {} unsold; burning {}", token_vault.amount, unsold, token_vault.amount.min(unsold));
            }
            burned_tokens = token_vault.amount.min(unsold);
            if burned_tokens > 0 {
                token::burn(
                    CpiContext::new_with_signer(
                        ctx.accounts.token_program.key(),
                        Burn { mint: token_mint.to_account_info(), from: token_vault.to_account_info(), authority: ctx.accounts.vault.to_account_info() },
                        signer_seeds,
                    ),
                    burned_tokens,
                )?;
            }
        }
        // The opening's leftover reserve atoms (0.21, moved here from `create_pool`): exactly the
        // recorded number, min(balance, recorded), from the pool creator PDA's token pass through,
        // which the PDA signs for. Skipped when none were left, so a launch without leftovers needs
        // neither account.
        let dust_recorded = ctx.accounts.settlement.as_ref().map(|s| s.dust_tokens_burned).unwrap_or(0);
        let mut dust_tokens_burned = 0;
        if dust_recorded > 0 {
            let (Some(token_mint), Some(pool_tokens), Some(pool_creator)) =
                (ctx.accounts.token_mint.as_ref(), ctx.accounts.pool_tokens.as_ref(), ctx.accounts.pool_creator.as_ref())
            else {
                return err!(BouncerError::TokenAccountsRequired);
            };
            dust_tokens_burned = pool_tokens.amount.min(dust_recorded);
            if dust_tokens_burned > 0 {
                let creator_bump = ctx.bumps.pool_creator.ok_or(BouncerError::TokenAccountsRequired)?;
                token::burn(
                    CpiContext::new_with_signer(
                        ctx.accounts.token_program.key(),
                        Burn { mint: token_mint.to_account_info(), from: pool_tokens.to_account_info(), authority: pool_creator.to_account_info() },
                        &[&[POOL_CREATOR_SEED, launch_key.as_ref(), &[creator_bump]]],
                    ),
                    dust_tokens_burned,
                )?;
            }
        }
        // The operating prepay (0.22): this signer is repaid its step allowance, then whatever the
        // steps did not use goes back to the creator, in every outcome, before the dust is swept.
        // Computed from the recorded amounts (`crank_bond - ops_paid`), never from the balance.
        // A launch whose pool was opened under 0.16 to 0.21 (bond_state 1) paid the whole bond
        // to that payer already, and nothing is returned.
        let vault_info = ctx.accounts.vault.to_account_info();
        let crank_bond_returned = {
            let mut launch = ctx.accounts.launch.load_mut()?;
            if launch.bond_state == 0 {
                pay_ops(&mut launch, &vault_info, &ctx.accounts.caller.to_account_info(), STEP_ALLOWANCE_LAMPORTS)?;
                let rest = launch.crank_bond.checked_sub(launch.ops_paid).ok_or(BouncerError::Overflow)?;
                launch.bond_state = 2;
                rest
            } else if launch.bond_state == 3 {
                // 0.23: the remainder went to the creator at `lock_liquidity`; only the allowance is held, and (0.29
                // tenth candidate) the metadata reserve, which stays for `finish_mint` and is neither paid nor swept here.
                // `ops_paid` has not moved since: nothing after lock can call `pay_ops` (it pays only at
                // bond_state 0, and settle, create_pool and lock are refused by state or lock bit).
                let outstanding = launch.crank_bond.checked_sub(launch.ops_paid).ok_or(BouncerError::Overflow)?;
                let held = outstanding.saturating_sub(launch.metadata_reserve).min(STEP_ALLOWANCE_LAMPORTS);
                pay_from_vault(&vault_info, &ctx.accounts.caller.to_account_info(), held)?;
                launch.ops_paid = launch.ops_paid.checked_add(held).ok_or(BouncerError::Overflow)?;
                launch.bond_state = 2;
                0
            } else {
                0
            }
        };
        pay_from_vault(&vault_info, &ctx.accounts.creator.to_account_info(), crank_bond_returned)?;
        // Above rent is dust (under a lamport per winner), sweepable only because of the guard: else a winner's change.
        // 0.29 tenth candidate: less the metadata reserve, which waits for `finish_mint` in Finalized.
        // v0.32: less the lamports held for parked bids, which wait for their bidders.
        let (metadata_reserve, parked_lamports) = {
            let l = ctx.accounts.launch.load()?;
            (l.metadata_reserve, l.parked_lamports)
        };
        let rent_min = Rent::get()?.minimum_balance(vault_info.data_len());
        let dust_lamports = vault_info.lamports().saturating_sub(rent_min).saturating_sub(metadata_reserve).saturating_sub(parked_lamports);
        pay_from_vault(&vault_info, &ctx.accounts.caller.to_account_info(), dust_lamports)?;

        let largest_fill_tokens = match ctx.accounts.settlement.as_mut() {
            Some(s) => {
                s.burned_tokens = burned_tokens;
                s.largest_fill_tokens
            }
            None => 0,
        };
        let mut launch = ctx.accounts.launch.load_mut()?;
        launch.state = launch_state::FINALIZED;
        emit!(Finalized { launch: launch_key, burned_tokens, largest_fill_tokens, dust_lamports, crank_bond_returned, dust_tokens_burned });
        Ok(())
    }

    // ------------------------------------------------------------ break glass

    pub fn abort(ctx: Context<Abort>) -> Result<()> {
        let launch_key = ctx.accounts.launch.key();
        let mut launch = ctx.accounts.launch.load_mut()?;
        // Kill switch, not an exit. The first abort ends the launch for everyone:
        // Aborted is terminal, every remaining bid can only be refunded, and no
        // settlement can follow. Refused once a pool exists (PoolLive, Finalized)
        // and once the launch is already terminal (Aborted, Failed). Allowed from
        // Open (nobody closed the book after the window), Closed and Settled, and
        // (0.29) from Initializing, a launch whose `grow_histogram` never landed: it
        // holds no bid, and Aborted lets `burn_unsold` return the creator's prepay.
        // Since 0.22 `refund` and `claim` make the same transition themselves, so
        // this exists for anyone who wants the launch marked without collecting.
        match launch.state {
            launch_state::OPEN | launch_state::CLOSED | launch_state::SETTLED | launch_state::INITIALIZING => {}
            launch_state::POOL_LIVE | launch_state::FINALIZED => return err!(BouncerError::PoolAlreadyLive),
            _ => return err!(BouncerError::NotAbortable),
        }
        let clock = Clock::get()?;
        // 0.22: one absolute recovery deadline, the scheduled close plus the valve, every term
        // copied onto the launch at genesis. It no longer restarts at settlement (finding 7's
        // ruling reversed on 2026-09-29): `post_beacon`, `reveal`, `settle` and
        // `create_pool` are all refused from the same instant, so completion and expiry are
        // never both valid, and at the deadline expiry wins. The settlement account is still
        // accepted, and no longer read.
        require!(is_expired(&launch, clock.unix_timestamp)?, BouncerError::TooEarlyToAbort);
        if launch.close_ts == 0 {
            launch.close_ts = clock.unix_timestamp;
        }
        launch.state = launch_state::ABORTED;
        emit!(Aborted { launch: launch_key, slot: clock.slot });
        drop(launch);
        Ok(())
    }
}

// ======================================================================== accounts

#[derive(Accounts)]
pub struct InitConfig<'info> {
    #[account(init, payer = payer, space = Config::LEN, seeds = [CONFIG_SEED], bump)]
    pub config: Box<Account<'info, Config>>,
    /// Anyone (0.24): pays the rent and chooses nothing.
    #[account(mut)]
    pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
    /// This program's ProgramData (0.24). The address is the upgradeable loader's PDA of `crate::ID`,
    /// the only address the loader accepts for this program's data at deploy, so no other program's
    /// ProgramData can be passed; `Account` checks the loader owns it and that it is in the ProgramData
    /// state. No `Program` account is taken: the id is the compile-time `crate::ID`.
    #[account(seeds = [crate::ID.as_ref()], bump, seeds::program = anchor_lang::solana_program::bpf_loader_upgradeable::ID)]
    pub program_data: Account<'info, ProgramData>,
}

#[derive(Accounts)]
pub struct ProposeAdmin<'info> {
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump, has_one = admin @ BouncerError::Unauthorized)]
    pub config: Box<Account<'info, Config>>,
    pub admin: Signer<'info>,
}

#[derive(Accounts)]
pub struct AcceptLpOwner<'info> {
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    /// CHECK: the proposed destination: it signs, or it is the fee vault PDA (v0.30, accepted by derivation); the
    /// handler checks both, and refuses `NotProposedLpOwner` otherwise.
    pub new_lp_owner: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct AcceptAdmin<'info> {
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    pub new_admin: Signer<'info>,
}

#[derive(Accounts)]
pub struct AdminUpdateConfig<'info> {
    /// CHECK: the Config PDA; seeds, discriminator and admin are checked in the handler, which may grow it.
    #[account(mut)]
    pub config: UncheckedAccount<'info>,
    #[account(mut)]
    pub admin: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AdminOnly<'info> {
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump, has_one = admin @ BouncerError::Unauthorized)]
    pub config: Box<Account<'info, Config>>,
    pub admin: Signer<'info>,
}

#[derive(Accounts)]
#[instruction(mint_salt: u64)]
pub struct CreateLaunch<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut)]
    pub creator: Signer<'info>,
    /// CHECK: the address the launch token's mint will have (0.19), `["mint", creator, mint_salt LE]`.
    /// Nothing is created here; `create_pool` creates the mint. Until 0.18 a fresh keypair signed and
    /// the mint was created at genesis.
    #[account(seeds = [MINT_SEED, creator.key().as_ref(), &mint_salt.to_le_bytes()], bump)]
    pub token_mint: UncheckedAccount<'info>,
    #[account(init, payer = creator, space = Launch::LEN, seeds = [LAUNCH_SEED, token_mint.key().as_ref()], bump)]
    pub launch: AccountLoader<'info, Launch>,
    #[account(init, payer = creator, space = Vault::LEN, seeds = [VAULT_SEED, launch.key().as_ref()], bump)]
    pub vault: Account<'info, Vault>,
    /// CHECK: 0.29: the histogram PDA, paid by the creator (`Launch.histogram_rent`, a launch cost, never refunded),
    /// created by the handler at `Histogram::INIT_LEN` (a typed init would read the full struct from the short
    /// account) and grown to `Histogram::LEN` by `grow_histogram` in the same transaction; must not exist yet.
    #[account(mut, seeds = [HIST_SEED, launch.key().as_ref()], bump)]
    pub histogram: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
    /// CHECK: 0.29, the creation permit (`ATTEST_CREATE_TAG`): the Instructions sysvar, by address.
    #[account(address = solana_instructions_sysvar::ID @ BouncerError::AttestationMissing)]
    pub instructions: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct Commit<'info> {
    #[account(mut, constraint = launch.to_account_info().data_len() == Launch::LEN @ BouncerError::LaunchLayoutUnknown)]
    pub launch: AccountLoader<'info, Launch>,
    #[account(mut, seeds = [VAULT_SEED, launch.key().as_ref()], bump = vault.bump)]
    pub vault: Account<'info, Vault>,
    #[account(init, payer = bidder, space = Bid::LEN, seeds = [BID_SEED, launch.key().as_ref(), bidder.key().as_ref()], bump)]
    pub bid: Box<Account<'info, Bid>>,
    #[account(mut)]
    pub bidder: Signer<'info>,
    pub system_program: Program<'info, System>,
    /// 0.29: read for the attestor keys only, and only when the launch requires an attestation; the charge and the
    /// flag are the launch's own copies.
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    /// CHECK: 0.29: the Instructions sysvar, by address; read only when the launch requires an attestation.
    #[account(address = solana_instructions_sysvar::ID @ BouncerError::AttestationMissing)]
    pub instructions: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct CloseLaunch<'info> {
    #[account(mut, constraint = launch.to_account_info().data_len() == Launch::LEN @ BouncerError::LaunchLayoutUnknown)]
    pub launch: AccountLoader<'info, Launch>,
}

/// 0.29: `grow_histogram`, the creator signs and pays.
#[derive(Accounts)]
pub struct GrowHistogram<'info> {
    #[account(mut, constraint = launch.to_account_info().data_len() == Launch::LEN @ BouncerError::LaunchLayoutUnknown)]
    pub launch: AccountLoader<'info, Launch>,
    /// CHECK: the launch's histogram at its genesis size (`Histogram::INIT_LEN`): a typed load needs the full size,
    /// so the handler checks the header by hand and grows the account.
    #[account(mut, seeds = [HIST_SEED, launch.key().as_ref()], bump)]
    pub histogram: UncheckedAccount<'info>,
    #[account(mut, address = launch.load()?.creator @ BouncerError::WrongCreator)]
    pub creator: Signer<'info>,
    pub system_program: Program<'info, System>,
}

/// 0.29: `admin_waive_attestation`.
#[derive(Accounts)]
pub struct AdminWaiveAttestation<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump, has_one = admin @ BouncerError::Unauthorized)]
    pub config: Box<Account<'info, Config>>,
    pub admin: Signer<'info>,
    #[account(mut, constraint = launch.to_account_info().data_len() == Launch::LEN @ BouncerError::LaunchLayoutUnknown)]
    pub launch: AccountLoader<'info, Launch>,
}

#[derive(Accounts)]
pub struct PostBeacon<'info> {
    #[account(mut, constraint = launch.to_account_info().data_len() == Launch::LEN @ BouncerError::LaunchLayoutUnknown)]
    pub launch: AccountLoader<'info, Launch>,
}

#[derive(Accounts)]
pub struct Reveal<'info> {
    #[account(mut, constraint = launch.to_account_info().data_len() == Launch::LEN @ BouncerError::LaunchLayoutUnknown)]
    pub launch: AccountLoader<'info, Launch>,
    /// 0.22: pays the processing charges.
    #[account(mut, seeds = [VAULT_SEED, launch.key().as_ref()], bump = vault.bump)]
    pub vault: Box<Account<'info, Vault>>,
    /// 0.22: whoever sends it; receives the processing charge of every bid it moves out of Sealed.
    #[account(mut)]
    pub processor: Signer<'info>,
    /// 0.29: the histogram every opened bid is added to.
    #[account(mut, seeds = [HIST_SEED, launch.key().as_ref()], bump = histogram.load()?.bump)]
    pub histogram: AccountLoader<'info, Histogram>,
}

#[derive(Accounts)]
pub struct Settle<'info> {
    #[account(mut, constraint = launch.to_account_info().data_len() == Launch::LEN @ BouncerError::LaunchLayoutUnknown)]
    pub launch: AccountLoader<'info, Launch>,
    #[account(init, payer = payer, space = SettlementRecord::LEN, seeds = [SETTLEMENT_SEED, launch.key().as_ref()], bump)]
    pub settlement: Box<Account<'info, SettlementRecord>>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
    /// The creator's own Bid, required when `Launch.creator_has_bid == 1`; pass the program id otherwise.
    #[account(seeds = [BID_SEED, launch.key().as_ref(), launch.load()?.creator.as_ref()], bump = creator_bid.bump)]
    pub creator_bid: Option<Box<Account<'info, Bid>>>,
    /// 0.22: repays the signer from the operating prepay.
    #[account(mut, seeds = [VAULT_SEED, launch.key().as_ref()], bump = vault.bump)]
    pub vault: Box<Account<'info, Vault>>,
    /// 0.29: the histogram, read here (never written again, never closed).
    #[account(seeds = [HIST_SEED, launch.key().as_ref()], bump = histogram.load()?.bump)]
    pub histogram: AccountLoader<'info, Histogram>,
}

#[derive(Accounts)]
#[instruction(creator: Pubkey, mint_salt: u64)]
pub struct CreatePool<'info> {
    #[account(mut, constraint = launch.to_account_info().data_len() == Launch::LEN @ BouncerError::LaunchLayoutUnknown)]
    pub launch: AccountLoader<'info, Launch>,
    #[account(mut, seeds = [SETTLEMENT_SEED, launch.key().as_ref()], bump = settlement.bump)]
    pub settlement: Box<Account<'info, SettlementRecord>>,
    #[account(mut, seeds = [VAULT_SEED, launch.key().as_ref()], bump = vault.bump)]
    pub vault: Box<Account<'info, Vault>>,
    /// CHECK: the launch token's mint, created here (0.19) at `["mint", creator, mint_salt LE]` by this program's
    /// own two CPIs (2026-10-21, `create_pda`: a stranger's lamports at the address are moved out and kept by the
    /// payer, never refused); must be `Launch.token_mint`. The metadata and the revocation follow in `finish_mint`.
    #[account(mut, seeds = [MINT_SEED, creator.as_ref(), &mint_salt.to_le_bytes()], bump, constraint = token_mint.key() == launch.load()?.token_mint @ BouncerError::WrongLaunch)]
    pub token_mint: UncheckedAccount<'info>,
    /// CHECK: created here (0.19; by hand since 2026-10-21); holds the whole supply until the reserve and the fills leave it.
    #[account(mut, seeds = [TOKEN_VAULT_SEED, launch.key().as_ref()], bump)]
    pub token_vault: UncheckedAccount<'info>,
    #[account(address = token::spl_token::native_mint::ID)]
    pub wsol_mint: Box<Account<'info, Mint>>,
    /// Meteora's pool creator and payer for this launch, and owner of the platform's
    /// position NFT: a dataless system account at `["pool_creator", launch]` this
    /// program signs for. Lent the rents by the payer here and emptied back to it.
    #[account(mut, seeds = [POOL_CREATOR_SEED, launch.key().as_ref()], bump)]
    pub pool_creator: SystemAccount<'info>,
    /// CHECK: pass through for the proceeds, owned by the pool creator PDA; created here (by hand since 2026-10-21)
    /// and closed to the payer here.
    #[account(mut, seeds = [POOL_WSOL_SEED, launch.key().as_ref()], bump)]
    pub payer_wsol: UncheckedAccount<'info>,
    /// CHECK: pass through for the reserve, owned by the pool creator PDA; created here (by hand since 2026-10-21).
    /// Left open and empty as the platform position's launch token claim destination.
    #[account(mut, seeds = [POOL_TOKENS_SEED, launch.key().as_ref()], bump)]
    pub payer_tokens: UncheckedAccount<'info>,
    /// Pays the pass through accounts and lends Meteora's rents, never from proceeds; the unspent part comes back.
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: the platform position's NFT mint, `["position_nft", launch, 1]`; Meteora creates it (Token-2022) with this program signing for the address.
    #[account(mut, seeds = [POSITION_NFT_SEED, launch.key().as_ref(), &[SIDE_PLATFORM]], bump)]
    pub platform_nft_mint: UncheckedAccount<'info>,
    /// CHECK: Meteora's NFT token account for that mint, created by Meteora, owned by the pool creator PDA.
    #[account(mut, seeds = [meteora::POSITION_NFT_ACCOUNT_SEED, platform_nft_mint.key().as_ref()], bump, seeds::program = meteora::PROGRAM_ID)]
    pub platform_nft_account: UncheckedAccount<'info>,
    /// CHECK: the platform position, created by Meteora.
    #[account(mut, seeds = [meteora::POSITION_SEED, platform_nft_mint.key().as_ref()], bump, seeds::program = meteora::PROGRAM_ID)]
    pub platform_position: UncheckedAccount<'info>,
    /// CHECK: the pool, created by Meteora at its own seeds (config, mints); read back in full afterwards.
    #[account(mut)]
    pub pool: UncheckedAccount<'info>,
    /// CHECK: the pool's launch token vault, created by Meteora; checked against the pool on read back.
    #[account(mut)]
    pub token_a_vault: UncheckedAccount<'info>,
    /// CHECK: the pool's wrapped SOL vault, created by Meteora; checked against the pool on read back.
    #[account(mut)]
    pub token_b_vault: UncheckedAccount<'info>,
    /// CHECK: the one Meteora config v19 accepts, address pinned; its fields are asserted in the handler.
    #[account(address = meteora::CONFIG @ BouncerError::WrongMeteoraConfig)]
    pub meteora_config: UncheckedAccount<'info>,
    /// CHECK: Meteora's pool authority PDA, pinned.
    #[account(address = meteora::POOL_AUTHORITY)]
    pub pool_authority: UncheckedAccount<'info>,
    /// CHECK: Meteora's event authority PDA, pinned.
    #[account(address = meteora::EVENT_AUTHORITY)]
    pub event_authority: UncheckedAccount<'info>,
    /// CHECK: Meteora DAMM v2, pinned.
    #[account(address = meteora::PROGRAM_ID)]
    pub cp_amm_program: UncheckedAccount<'info>,
    /// CHECK: Token-2022, pinned; Meteora's position NFTs only.
    #[account(address = meteora::TOKEN_2022_PROGRAM_ID)]
    pub token_2022_program: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    /// CHECK: 0.28, the launch's creator, credited its part of the raise fee here; must be `Launch.creator`. A
    /// plain lamport credit, so any account shape receives it (a Squads vault PDA that does not exist yet included).
    #[account(mut, address = launch.load()?.creator @ BouncerError::WrongCreator)]
    pub creator_wallet: UncheckedAccount<'info>,
    /// CHECK: v0.30, the treasury this launch recorded at genesis, credited the platform's part of the raise fee here;
    /// must be `Launch.treasury` (0.28 to 0.29: the fee destination `lp_owner`, which now receives trading fees only).
    /// The same slot, so the account count is unchanged. The config is not in this instruction's accounts. A launch
    /// created before 0.30 recorded no treasury (zeros): its slot takes `Launch.lp_owner`, the destination its genesis
    /// terms named (the check is in the handler, where both fields are read).
    #[account(mut)]
    pub treasury: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct AdminSetBuyback<'info> {
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    pub admin: Signer<'info>,
}

#[derive(Accounts)]
pub struct InitPlatformVaults<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(init, seeds = [FEE_VAULT_SEED], bump, payer = payer, space = PlatformVault::LEN)]
    pub fee_vault: Account<'info, PlatformVault>,
    /// CHECK: the burn vault address, `["burn_vault"]`; an authority by derivation, never an account.
    #[account(seeds = [BURN_VAULT_SEED], bump)]
    pub burn_vault: UncheckedAccount<'info>,
    /// CHECK: the burn vault's wrapped SOL associated token account, checked in the handler and created if missing.
    #[account(mut)]
    pub burn_vault_wsol: UncheckedAccount<'info>,
    #[account(address = token::spl_token::native_mint::ID)]
    pub wsol_mint: Box<Account<'info, Mint>>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct BuyAndBurn<'info> {
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    /// One of `Config.burn_crankers`; pays the signature fee and, once, the burn vault's BOUNCER token account.
    #[account(mut)]
    pub cranker: Signer<'info>,
    /// CHECK: the burn vault address, `["burn_vault"]`, the authority of the two token accounts; signs by its seeds.
    #[account(seeds = [BURN_VAULT_SEED], bump)]
    pub burn_vault: UncheckedAccount<'info>,
    /// CHECK: the burn vault's wrapped SOL account (the swap's input), checked in the handler.
    #[account(mut)]
    pub burn_vault_wsol: UncheckedAccount<'info>,
    /// CHECK: the burn vault's BOUNCER token account (the swap's output, burned at once), checked and created if missing.
    #[account(mut)]
    pub burn_vault_tokens: UncheckedAccount<'info>,
    /// CHECK: `Config.bouncer_mint`, checked in the handler (an unchecked account so an unset config refuses `BuybackPoolNotSet`).
    #[account(mut)]
    pub bouncer_mint: UncheckedAccount<'info>,
    #[account(address = token::spl_token::native_mint::ID)]
    pub wsol_mint: Box<Account<'info, Mint>>,
    /// CHECK: `Config.bouncer_pool`, cp-amm's, with the mint as token A and wrapped SOL as token B; checked in the handler.
    #[account(mut)]
    pub pool: UncheckedAccount<'info>,
    /// CHECK: the pool's BOUNCER vault, as the pool records it.
    #[account(mut)]
    pub token_a_vault: UncheckedAccount<'info>,
    /// CHECK: the pool's wrapped SOL vault, as the pool records it.
    #[account(mut)]
    pub token_b_vault: UncheckedAccount<'info>,
    /// CHECK: Meteora's pool authority PDA, pinned.
    #[account(address = meteora::POOL_AUTHORITY)]
    pub pool_authority: UncheckedAccount<'info>,
    /// CHECK: Meteora's event authority PDA, pinned.
    #[account(address = meteora::EVENT_AUTHORITY)]
    pub event_authority: UncheckedAccount<'info>,
    /// CHECK: Meteora DAMM v2, pinned.
    #[account(address = meteora::PROGRAM_ID)]
    pub cp_amm_program: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CollectPlatformFees<'info> {
    /// CHECK: the launch, of any layout in `LAUNCH_LAYOUTS` (2026-10-21, review finding F7): owner, discriminator, length
    /// and version checked by `launch_fee_view` in the handler, which reads its state, mint and fee destination.
    pub launch: UncheckedAccount<'info>,
    #[account(seeds = [SETTLEMENT_SEED, launch.key().as_ref()], bump = settlement.bump)]
    pub settlement: Box<Account<'info, SettlementRecord>>,
    /// CHECK: the pool creator PDA, owner of the platform position's NFT; signs the claim by its seeds.
    #[account(seeds = [POOL_CREATOR_SEED, launch.key().as_ref()], bump)]
    pub pool_creator: UncheckedAccount<'info>,
    /// CHECK: receives the fees; must be the destination this launch recorded at genesis (0.24; the live
    /// `Config.lp_owner` until 0.23), checked in the handler through the layout table. The config is not in
    /// this instruction's accounts: nothing written after genesis can move this launch's fees.
    pub lp_owner: UncheckedAccount<'info>,
    /// CHECK: the LP owner's wrapped SOL associated token account, checked in the handler and created if missing.
    #[account(mut)]
    pub lp_owner_wsol: UncheckedAccount<'info>,
    /// CHECK: the pool creator PDA's launch token account from `create_pool`, the claim's token A destination.
    #[account(mut, seeds = [POOL_TOKENS_SEED, launch.key().as_ref()], bump)]
    pub pool_tokens: UncheckedAccount<'info>,
    /// CHECK: the platform position's NFT mint, as recorded at pool creation.
    #[account(address = settlement.protocol_lock_nft @ BouncerError::WrongPoolCreator)]
    pub platform_nft_mint: UncheckedAccount<'info>,
    /// CHECK: the platform position.
    #[account(mut, seeds = [meteora::POSITION_SEED, platform_nft_mint.key().as_ref()], bump, seeds::program = meteora::PROGRAM_ID)]
    pub platform_position: UncheckedAccount<'info>,
    /// CHECK: Meteora's NFT token account for the platform position.
    #[account(seeds = [meteora::POSITION_NFT_ACCOUNT_SEED, platform_nft_mint.key().as_ref()], bump, seeds::program = meteora::PROGRAM_ID)]
    pub platform_nft_account: UncheckedAccount<'info>,
    /// CHECK: the launch's pool, as recorded at pool creation.
    #[account(address = settlement.pool @ BouncerError::WrongPool)]
    pub pool: UncheckedAccount<'info>,
    /// CHECK: the pool's launch token vault; Meteora checks it against the pool.
    #[account(mut)]
    pub token_a_vault: UncheckedAccount<'info>,
    /// CHECK: the pool's wrapped SOL vault; Meteora checks it against the pool.
    #[account(mut)]
    pub token_b_vault: UncheckedAccount<'info>,
    /// The launch token's mint, checked against the launch in the handler (the layout table).
    pub token_mint: Box<Account<'info, Mint>>,
    #[account(address = token::spl_token::native_mint::ID)]
    pub wsol_mint: Box<Account<'info, Mint>>,
    /// Any fee payer; pays the LP owner's wrapped SOL account once. Not an authority over anything.
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: Meteora's pool authority PDA, pinned.
    #[account(address = meteora::POOL_AUTHORITY)]
    pub pool_authority: UncheckedAccount<'info>,
    /// CHECK: Meteora's event authority PDA, pinned.
    #[account(address = meteora::EVENT_AUTHORITY)]
    pub event_authority: UncheckedAccount<'info>,
    /// CHECK: Meteora DAMM v2, pinned.
    #[account(address = meteora::PROGRAM_ID)]
    pub cp_amm_program: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Deliver<'info> {
    #[account(mut, constraint = launch.to_account_info().data_len() == Launch::LEN @ BouncerError::LaunchLayoutUnknown)]
    pub launch: AccountLoader<'info, Launch>,
    #[account(mut, seeds = [VAULT_SEED, launch.key().as_ref()], bump = vault.bump)]
    pub vault: Account<'info, Vault>,
    #[account(mut, seeds = [SETTLEMENT_SEED, launch.key().as_ref()], bump = settlement.bump)]
    pub settlement: Box<Account<'info, SettlementRecord>>,
    #[account(constraint = token_mint.key() == launch.load()?.token_mint @ BouncerError::WrongLaunch)]
    pub token_mint: Account<'info, Mint>,
    #[account(mut, seeds = [TOKEN_VAULT_SEED, launch.key().as_ref()], bump)]
    pub token_vault: Account<'info, TokenAccount>,
    /// CHECK: v0.30: the bid, read and closed by hand (`load_open_bid`, `close_bid`): an open bid of this launch naming
    /// `bidder`, delivered and closed to the bidder, who gets everything the account still holds when the instruction
    /// ends (its rent less what `deliver` repaid the caller); or an already closed account, a harmless no-op. Only this
    /// program moves this account's lamports: it signs for nothing and is passed to no CPI.
    #[account(mut)]
    pub bid: UncheckedAccount<'info>,
    /// CHECK: receives the refund; matched to the bid in the handler (v0.30; Anchor's `has_one` until 0.29).
    #[account(mut)]
    pub bidder: UncheckedAccount<'info>,
    /// CHECK: the bidder's associated token account for the mint, created if missing.
    #[account(mut)]
    pub bidder_token: UncheckedAccount<'info>,
    #[account(mut)]
    pub caller: Signer<'info>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
    /// CHECK: the caller's associated token account for the mint, created if missing when a fee is due
    /// (launches created before 0.26). Not read on a launch with bid rent terms.
    #[account(mut)]
    pub caller_token: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct Refund<'info> {
    #[account(mut, constraint = launch.to_account_info().data_len() == Launch::LEN @ BouncerError::LaunchLayoutUnknown)]
    pub launch: AccountLoader<'info, Launch>,
    #[account(mut, seeds = [VAULT_SEED, launch.key().as_ref()], bump = vault.bump)]
    pub vault: Account<'info, Vault>,
    /// Required whenever the launch has a record (`Launch.settled` 1: Settled, PoolLive, Finalized, or
    /// Aborted after settling; 0.17), refused `SettlementRequired` without it; the program id in its
    /// place for a Failed launch or one aborted before settling.
    #[account(mut, seeds = [SETTLEMENT_SEED, launch.key().as_ref()], bump = settlement.bump)]
    pub settlement: Option<Box<Account<'info, SettlementRecord>>>,
    /// CHECK: v0.30: the bid, read and closed by hand to the bidder (the rent goes back with the deposit), or an already
    /// closed account, a harmless no-op. Pushed refunds are free.
    #[account(mut)]
    pub bid: UncheckedAccount<'info>,
    /// CHECK: receives the deposit; matched to the bid in the handler.
    #[account(mut)]
    pub bidder: UncheckedAccount<'info>,
    #[account(mut)]
    pub caller: Signer<'info>,
}

/// v0.32: `park_bid`'s accounts. Nothing is paid to the bidder here, so its accounts are read only.
#[derive(Accounts)]
pub struct ParkBid<'info> {
    #[account(mut, constraint = launch.to_account_info().data_len() == Launch::LEN @ BouncerError::LaunchLayoutUnknown)]
    pub launch: AccountLoader<'info, Launch>,
    /// Pays a winner's park its reward out of the parked lamports.
    #[account(mut, seeds = [VAULT_SEED, launch.key().as_ref()], bump = vault.bump)]
    pub vault: Account<'info, Vault>,
    /// Required whenever the launch has a record (as in `refund`); the program id in its place otherwise.
    #[account(mut, seeds = [SETTLEMENT_SEED, launch.key().as_ref()], bump = settlement.bump)]
    pub settlement: Option<Box<Account<'info, SettlementRecord>>>,
    /// CHECK: the bid, read and written by hand (`load_open_bid`, `store_bid`); stays open, Parked. Passed to no CPI.
    #[account(mut)]
    pub bid: UncheckedAccount<'info>,
    /// CHECK: the bid's bidder, matched in the handler; read for the rent check only.
    pub bidder: UncheckedAccount<'info>,
    /// CHECK: a winner's: the bidder's associated token account address for the mint, checked by derivation and read;
    /// a loser's: not read (any account).
    pub bidder_token: UncheckedAccount<'info>,
    #[account(mut)]
    pub caller: Signer<'info>,
}

/// v0.32: `collect_parked`'s accounts. The bidder signs and names both destinations.
#[derive(Accounts)]
pub struct CollectParked<'info> {
    #[account(mut, constraint = launch.to_account_info().data_len() == Launch::LEN @ BouncerError::LaunchLayoutUnknown)]
    pub launch: AccountLoader<'info, Launch>,
    #[account(mut, seeds = [VAULT_SEED, launch.key().as_ref()], bump = vault.bump)]
    pub vault: Account<'info, Vault>,
    /// Required when the bid parked tokens; the program id in its place otherwise.
    #[account(mut, seeds = [TOKEN_VAULT_SEED, launch.key().as_ref()], bump)]
    pub token_vault: Option<Account<'info, TokenAccount>>,
    /// CHECK: any token account of the launch's mint the bidder names (the token program checks the mint); required
    /// when the bid parked tokens.
    #[account(mut)]
    pub token_destination: Option<UncheckedAccount<'info>>,
    /// CHECK: the parked bid, read and closed by hand to `destination`. Passed to no CPI.
    #[account(mut)]
    pub bid: UncheckedAccount<'info>,
    pub bidder: Signer<'info>,
    /// CHECK: where the bidder wants the lamports (the parked lamports and the bid account's own).
    #[account(mut)]
    pub destination: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
}

/// v0.32: `push_parked`'s accounts (as `deliver`'s, without the fee account).
#[derive(Accounts)]
pub struct PushParked<'info> {
    #[account(mut, constraint = launch.to_account_info().data_len() == Launch::LEN @ BouncerError::LaunchLayoutUnknown)]
    pub launch: AccountLoader<'info, Launch>,
    #[account(mut, seeds = [VAULT_SEED, launch.key().as_ref()], bump = vault.bump)]
    pub vault: Account<'info, Vault>,
    #[account(constraint = token_mint.key() == launch.load()?.token_mint @ BouncerError::WrongLaunch)]
    pub token_mint: Option<Account<'info, Mint>>,
    #[account(mut, seeds = [TOKEN_VAULT_SEED, launch.key().as_ref()], bump)]
    pub token_vault: Option<Account<'info, TokenAccount>>,
    /// CHECK: the parked bid, read and closed by hand to the bidder. Passed to no CPI.
    #[account(mut)]
    pub bid: UncheckedAccount<'info>,
    /// CHECK: the bid's bidder, matched in the handler; receives the lamports.
    #[account(mut)]
    pub bidder: UncheckedAccount<'info>,
    /// CHECK: the bidder's associated token account for the mint, created if missing (the ATA program checks the
    /// address); required when the bid parked tokens.
    #[account(mut)]
    pub bidder_token: Option<UncheckedAccount<'info>>,
    #[account(mut)]
    pub caller: Signer<'info>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

/// v0.30: `open_trading`'s accounts. The vault signs by its seeds (the mint's freeze authority); the pool is the record's
/// and its launch token vault is checked against the pool's bytes in the handler. No signer of its own.
#[derive(Accounts)]
pub struct OpenTrading<'info> {
    #[account(mut, constraint = launch.to_account_info().data_len() == Launch::LEN @ BouncerError::LaunchLayoutUnknown)]
    pub launch: AccountLoader<'info, Launch>,
    #[account(mut, seeds = [SETTLEMENT_SEED, launch.key().as_ref()], bump = settlement.bump)]
    pub settlement: Box<Account<'info, SettlementRecord>>,
    #[account(seeds = [VAULT_SEED, launch.key().as_ref()], bump = vault.bump)]
    pub vault: Box<Account<'info, Vault>>,
    #[account(mut, constraint = token_mint.key() == launch.load()?.token_mint @ BouncerError::WrongLaunch)]
    pub token_mint: Box<Account<'info, Mint>>,
    /// CHECK: the launch's pool, `SettlementRecord.pool`, read for its vault address.
    #[account(address = settlement.pool @ BouncerError::WrongLaunch)]
    pub pool: UncheckedAccount<'info>,
    /// CHECK: the pool's launch token vault, checked against the pool's bytes; thawed here.
    #[account(mut)]
    pub token_a_vault: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
}

/// v0.30: `admin_open_trading`'s accounts: the config admin, then `OpenTrading`'s.
#[derive(Accounts)]
pub struct AdminOpenTrading<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump, has_one = admin @ BouncerError::Unauthorized)]
    pub config: Box<Account<'info, Config>>,
    pub admin: Signer<'info>,
    #[account(mut, constraint = launch.to_account_info().data_len() == Launch::LEN @ BouncerError::LaunchLayoutUnknown)]
    pub launch: AccountLoader<'info, Launch>,
    #[account(mut, seeds = [SETTLEMENT_SEED, launch.key().as_ref()], bump = settlement.bump)]
    pub settlement: Box<Account<'info, SettlementRecord>>,
    #[account(seeds = [VAULT_SEED, launch.key().as_ref()], bump = vault.bump)]
    pub vault: Box<Account<'info, Vault>>,
    #[account(mut, constraint = token_mint.key() == launch.load()?.token_mint @ BouncerError::WrongLaunch)]
    pub token_mint: Box<Account<'info, Mint>>,
    /// CHECK: the launch's pool, `SettlementRecord.pool`.
    #[account(address = settlement.pool @ BouncerError::WrongLaunch)]
    pub pool: UncheckedAccount<'info>,
    /// CHECK: the pool's launch token vault, checked against the pool's bytes; thawed here.
    #[account(mut)]
    pub token_a_vault: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
}

/// v0.30: `accept_treasury`, the proposed treasury's own signature.
#[derive(Accounts)]
pub struct AcceptTreasury<'info> {
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    pub new_treasury: Signer<'info>,
}

/// 2026-10-21: `finish_mint`'s accounts. The metadata PDA and the Token Metadata program were `create_pool`'s
/// until then (removed from its list in the same change).
#[derive(Accounts)]
pub struct FinishMint<'info> {
    #[account(mut, constraint = launch.to_account_info().data_len() == Launch::LEN @ BouncerError::LaunchLayoutUnknown)]
    pub launch: AccountLoader<'info, Launch>,
    /// Repays the payer from the operating prepay; the mint authority until this instruction, signs by its seeds.
    #[account(mut, seeds = [VAULT_SEED, launch.key().as_ref()], bump = vault.bump)]
    pub vault: Box<Account<'info, Vault>>,
    #[account(mut, constraint = token_mint.key() == launch.load()?.token_mint @ BouncerError::WrongLaunch)]
    pub token_mint: Box<Account<'info, Mint>>,
    /// CHECK: Metaplex metadata PDA for the mint, created by CPI here (in `create_pool` from 0.19 to the seventh
    /// 0.29 candidate; at genesis until 0.18).
    #[account(mut, seeds = [b"metadata", metadata::METADATA_PROGRAM_ID.as_ref(), token_mint.key().as_ref()], bump, seeds::program = metadata::METADATA_PROGRAM_ID)]
    pub metadata: UncheckedAccount<'info>,
    /// CHECK: the Token Metadata program, address pinned.
    #[account(address = metadata::METADATA_PROGRAM_ID)]
    pub token_metadata_program: UncheckedAccount<'info>,
    /// Pays the metadata's rent and Metaplex's fee, repaid from the prepay with the step allowance.
    #[account(mut)]
    pub payer: Signer<'info>,
    pub rent: Sysvar<'info, Rent>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    /// CHECK: `Launch.creator`, any account type; 0.29 tenth candidate (trailing): receives what is left of the
    /// metadata reserve after the payer, when the prepay was returned before this step.
    #[account(mut, constraint = creator.key() == launch.load()?.creator @ BouncerError::WrongCreator)]
    pub creator: UncheckedAccount<'info>,
}

/// 0.29 twelfth candidate (review finding F2): `release_pool_cash`'s accounts: `lock_liquidity`'s cash side alone.
#[derive(Accounts)]
pub struct ReleasePoolCash<'info> {
    #[account(mut, constraint = launch.to_account_info().data_len() == Launch::LEN @ BouncerError::LaunchLayoutUnknown)]
    pub launch: AccountLoader<'info, Launch>,
    #[account(mut, seeds = [SETTLEMENT_SEED, launch.key().as_ref()], bump = settlement.bump)]
    pub settlement: Box<Account<'info, SettlementRecord>>,
    #[account(mut, seeds = [VAULT_SEED, launch.key().as_ref()], bump = vault.bump)]
    pub vault: Box<Account<'info, Vault>>,
    /// CHECK: the pool creator PDA; signs by its seeds for the pass through's close and its own loan's return.
    #[account(mut, seeds = [POOL_CREATOR_SEED, launch.key().as_ref()], bump)]
    pub pool_creator: UncheckedAccount<'info>,
    /// CHECK: `SettlementRecord.pool_payer`, the `create_pool` payer: gets the pass through and its loan.
    #[account(mut, address = settlement.pool_payer @ BouncerError::WrongPoolPayer)]
    pub pool_payer: UncheckedAccount<'info>,
    /// CHECK: `Launch.creator`, any account type: gets the unused prepay.
    #[account(mut, constraint = creator.key() == launch.load()?.creator @ BouncerError::WrongCreator)]
    pub creator: UncheckedAccount<'info>,
    /// `create_pool`'s wrapped SOL pass through, owned by the pool creator PDA.
    #[account(mut, seeds = [POOL_WSOL_SEED, launch.key().as_ref()], bump, constraint = payer_wsol.owner == pool_creator.key() @ BouncerError::WrongPoolCreator)]
    pub payer_wsol: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct LockLiquidity<'info> {
    /// Writable since 0.22: the operating prepay's running total is recorded on it.
    #[account(mut, constraint = launch.to_account_info().data_len() == Launch::LEN @ BouncerError::LaunchLayoutUnknown)]
    pub launch: AccountLoader<'info, Launch>,
    #[account(mut, seeds = [SETTLEMENT_SEED, launch.key().as_ref()], bump = settlement.bump)]
    pub settlement: Box<Account<'info, SettlementRecord>>,
    /// 0.22: repays the pool payer and this signer from the operating prepay.
    #[account(mut, seeds = [VAULT_SEED, launch.key().as_ref()], bump = vault.bump)]
    pub vault: Box<Account<'info, Vault>>,
    /// CHECK: the pool creator PDA, owner of both positions' NFTs until the creator's is handed over; signs by its seeds.
    /// Writable since 0.20: its unused rent loan leaves here for `pool_payer`.
    #[account(mut, seeds = [POOL_CREATOR_SEED, launch.key().as_ref()], bump)]
    pub pool_creator: UncheckedAccount<'info>,
    /// Pays the creator position's rents and the creator's NFT token account.
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: `Launch.creator`, who receives the position NFT; any account type.
    /// Writable since 0.23: receives the unused operating prepay.
    #[account(mut, constraint = creator.key() == launch.load()?.creator @ BouncerError::WrongCreator)]
    pub creator: UncheckedAccount<'info>,
    /// CHECK: the creator position's NFT mint, `["position_nft", launch, 0]`; Meteora creates it with this program signing for the address.
    #[account(mut, seeds = [POSITION_NFT_SEED, launch.key().as_ref(), &[SIDE_CREATOR]], bump)]
    pub creator_nft_mint: UncheckedAccount<'info>,
    /// CHECK: Meteora's NFT token account for that mint, created by Meteora and closed here once the NFT has left it.
    #[account(mut, seeds = [meteora::POSITION_NFT_ACCOUNT_SEED, creator_nft_mint.key().as_ref()], bump, seeds::program = meteora::PROGRAM_ID)]
    pub creator_nft_pda_account: UncheckedAccount<'info>,
    /// CHECK: the creator position, created by Meteora.
    #[account(mut, seeds = [meteora::POSITION_SEED, creator_nft_mint.key().as_ref()], bump, seeds::program = meteora::PROGRAM_ID)]
    pub creator_position: UncheckedAccount<'info>,
    /// CHECK: the creator's Token-2022 associated token account for the NFT; checked in the handler, created if missing.
    #[account(mut)]
    pub creator_nft_ata: UncheckedAccount<'info>,
    /// CHECK: the platform position's NFT mint, as recorded at pool creation.
    #[account(address = settlement.protocol_lock_nft @ BouncerError::WrongPoolCreator)]
    pub platform_nft_mint: UncheckedAccount<'info>,
    /// CHECK: the platform position.
    #[account(mut, seeds = [meteora::POSITION_SEED, platform_nft_mint.key().as_ref()], bump, seeds::program = meteora::PROGRAM_ID)]
    pub platform_position: UncheckedAccount<'info>,
    /// CHECK: Meteora's NFT token account for the platform position.
    #[account(seeds = [meteora::POSITION_NFT_ACCOUNT_SEED, platform_nft_mint.key().as_ref()], bump, seeds::program = meteora::PROGRAM_ID)]
    pub platform_nft_account: UncheckedAccount<'info>,
    /// CHECK: the launch's pool, as recorded at pool creation.
    #[account(mut, address = settlement.pool @ BouncerError::WrongPool)]
    pub pool: UncheckedAccount<'info>,
    /// CHECK: Meteora's pool authority PDA, pinned.
    #[account(address = meteora::POOL_AUTHORITY)]
    pub pool_authority: UncheckedAccount<'info>,
    /// CHECK: Meteora's event authority PDA, pinned.
    #[account(address = meteora::EVENT_AUTHORITY)]
    pub event_authority: UncheckedAccount<'info>,
    /// CHECK: Meteora DAMM v2, pinned.
    #[account(address = meteora::PROGRAM_ID)]
    pub cp_amm_program: UncheckedAccount<'info>,
    /// CHECK: Token-2022, pinned; Meteora's position NFTs only.
    #[account(address = meteora::TOKEN_2022_PROGRAM_ID)]
    pub token_2022_program: UncheckedAccount<'info>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
    /// CHECK: the `create_pool` signer recorded in the settlement (0.20); receives the pool creator PDA's unused rent loan.
    #[account(mut, address = settlement.pool_payer @ BouncerError::WrongPoolPayer)]
    pub pool_payer: UncheckedAccount<'info>,
    /// The wrapped SOL pass through `create_pool` wrapped the proceeds through (`["pool_wsol", launch]`, owned by the
    /// pool creator PDA): closed here to `pool_payer` since the ninth 0.29 candidate (2026-10-21), its rent, the
    /// opening's leftover lamports and any stray wrapped SOL, a loan that payer made like the PDA's rent loan.
    /// 0.29 tenth candidate: optional, the program id in its place once `release_pool_cash` closed it (refused
    /// `TokenAccountsRequired` without it otherwise).
    #[account(mut, seeds = [POOL_WSOL_SEED, launch.key().as_ref()], bump, constraint = payer_wsol.owner == pool_creator.key() @ BouncerError::WrongPoolCreator)]
    pub payer_wsol: Option<Box<Account<'info, TokenAccount>>>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct BurnUnsold<'info> {
    #[account(mut, constraint = launch.to_account_info().data_len() == Launch::LEN @ BouncerError::LaunchLayoutUnknown)]
    pub launch: AccountLoader<'info, Launch>,
    #[account(mut, seeds = [VAULT_SEED, launch.key().as_ref()], bump = vault.bump)]
    pub vault: Account<'info, Vault>,
    /// Present once the launch settled; absent for a failed or aborted launch that never settled.
    #[account(mut, seeds = [SETTLEMENT_SEED, launch.key().as_ref()], bump = settlement.bump)]
    pub settlement: Option<Box<Account<'info, SettlementRecord>>>,
    /// Required once the pool exists; the program id in its place for a launch that failed or was
    /// aborted, which never had a mint (0.19).
    #[account(mut, constraint = token_mint.key() == launch.load()?.token_mint @ BouncerError::WrongLaunch)]
    pub token_mint: Option<Account<'info, Mint>>,
    /// Required once the pool exists; the program id in its place otherwise (0.19).
    #[account(mut, seeds = [TOKEN_VAULT_SEED, launch.key().as_ref()], bump)]
    pub token_vault: Option<Account<'info, TokenAccount>>,
    #[account(mut)]
    pub caller: Signer<'info>,
    pub token_program: Program<'info, Token>,
    /// CHECK: `Launch.creator`, who receives the crank bond back when the launch failed or was aborted (0.16);
    /// any account type, since the creator signed genesis and may be a program's PDA.
    #[account(mut, constraint = creator.key() == launch.load()?.creator @ BouncerError::WrongCreator)]
    pub creator: UncheckedAccount<'info>,
    /// The pool creator PDA's token pass through, holding the opening's leftover reserve atoms (0.21).
    /// Required when `SettlementRecord.dust_tokens_burned` is above 0; the program id in its place otherwise.
    #[account(mut, seeds = [POOL_TOKENS_SEED, launch.key().as_ref()], bump)]
    pub pool_tokens: Option<Box<Account<'info, TokenAccount>>>,
    /// CHECK: the pool creator PDA, which owns `pool_tokens` and signs the burn by its seeds (0.21).
    #[account(seeds = [POOL_CREATOR_SEED, launch.key().as_ref()], bump)]
    pub pool_creator: Option<UncheckedAccount<'info>>,
}

#[derive(Accounts)]
pub struct Abort<'info> {
    #[account(mut, constraint = launch.to_account_info().data_len() == Launch::LEN @ BouncerError::LaunchLayoutUnknown)]
    pub launch: AccountLoader<'info, Launch>,
    /// The settlement record, or the program id in its place. Unread since 0.22 (the deadline
    /// no longer counts from `settled_ts`); kept so the account list does not change.
    #[account(seeds = [SETTLEMENT_SEED, launch.key().as_ref()], bump = settlement.bump)]
    pub settlement: Option<Box<Account<'info, SettlementRecord>>>,
}

/// The two refusal paths that cannot be produced on a validator: a Meteora config
/// that drifted from what was locked (its address is pinned and only Meteora's
/// admin writes it) and a pool that reads back differently from what was asked
/// (cp-amm only ever writes a correct one). Both checks are fed the real accounts'
/// bytes, dumped from the local validator on 2026-09-27 (the config cloned from
/// devnet, the pool created by the measured v19 Meteora run),
/// with one checked field changed at a time. Each change must be refused with the
/// specific error; the untouched bytes must pass.
#[cfg(test)]
mod refusal_tests {
    use super::*;

    /// v0.30: the 2 percent config HQ6vW45K... (devnet and mainnet hold the same bytes, read 2026-10-27); the 1 percent
    /// AeLtDKgw... bytes stay beside it as the drifted-fee case.
    const CONFIG: &[u8] = include_bytes!("fixtures/meteora_config_HQ6v.bin");
    const CONFIG_1PCT: &[u8] = include_bytes!("fixtures/meteora_config_AeLt.bin");
    const POOL: &[u8] = include_bytes!("fixtures/meteora_pool_F5AY.bin");

    fn code(r: Result<()>) -> u32 {
        match r {
            Ok(()) => 0,
            Err(anchor_lang::error::Error::AnchorError(a)) => a.error_code_number,
            Err(e) => panic!("not an Anchor error: {e:?}"),
        }
    }

    fn flip(d: &mut [u8], at: usize) {
        d[at] ^= 1;
    }

    #[test]
    fn config_drift_is_refused_field_by_field() {
        let wrong = u32::from(BouncerError::WrongMeteoraConfig);
        let id = meteora::PROGRAM_ID;
        assert_eq!(code(check_meteora_config_bytes(&id, CONFIG)), 0, "the real config must pass");
        use meteora::config as c;
        assert_eq!(code(check_meteora_config_bytes(&id, CONFIG_1PCT)), wrong, "the 1 percent config (0.29's) must be refused by v0.30");
        let fields: [(&str, usize); 17] = [
            ("discriminator", 0),
            ("vault_config_key (an alpha vault appears, 0.20)", c::VAULT_CONFIG_KEY),
            ("vault_config_key, last byte", c::VAULT_CONFIG_KEY + 31),
            ("pool_creator_authority (the config stops being public)", c::POOL_CREATOR_AUTHORITY),
            ("cliff_fee_numerator (the fee changes)", c::CLIFF_FEE_NUMERATOR),
            ("base_fee_mode (a fee scheduler appears)", c::BASE_FEE_MODE),
            ("number_of_period, low byte", c::NUMBER_OF_PERIOD),
            ("number_of_period, high byte", c::NUMBER_OF_PERIOD + 1),
            ("dynamic_fee initialized", c::DYNAMIC_FEE_INITIALIZED),
            ("protocol_fee_percent (Meteora's share moves, v0.30)", c::PROTOCOL_FEE_PERCENT),
            ("referral_fee_percent (v0.30)", c::REFERRAL_FEE_PERCENT),
            ("activation_type (slot instead of timestamp)", c::ACTIVATION_TYPE),
            ("collect_fee_mode (no longer OnlyB)", c::COLLECT_FEE_MODE),
            ("config_type (no longer static)", c::CONFIG_TYPE),
            ("sqrt_min_price", c::SQRT_MIN_PRICE),
            ("sqrt_max_price", c::SQRT_MAX_PRICE),
            ("sqrt_max_price, top byte", c::SQRT_MAX_PRICE + 15),
        ];
        for (name, at) in fields {
            let mut d = CONFIG.to_vec();
            flip(&mut d, at);
            assert_eq!(code(check_meteora_config_bytes(&id, &d)), wrong, "{name} changed must be refused");
        }
        assert_eq!(code(check_meteora_config_bytes(&id, &CONFIG[..CONFIG.len() - 1])), wrong, "a short account must be refused");
        let mut longer = CONFIG.to_vec();
        longer.push(0);
        assert_eq!(code(check_meteora_config_bytes(&id, &longer)), wrong, "a longer account must be refused");
        assert_eq!(code(check_meteora_config_bytes(&Pubkey::new_unique(), CONFIG)), wrong, "the right bytes under another owner must be refused");
    }

    #[test]
    fn platform_delegation_is_refused() {
        let wrong = u32::from(BouncerError::PlatformPositionDelegated);
        let (pos, nft) = (vec![0u8; meteora::position::LEN], vec![0u8; 170]);
        assert_eq!(code(check_not_delegated_bytes(&pos, &nft)), 0, "an undelegated position must pass");
        let mut p = pos.clone();
        p[meteora::position::DELEGATE_PERMISSION] = 8; // ClaimPositionFee, what phase 1 granted on devnet
        assert_eq!(code(check_not_delegated_bytes(&p, &nft)), wrong, "a delegate permission must be refused");
        let mut n = nft.clone();
        n[72] = 1; // COption::Some delegate
        assert_eq!(code(check_not_delegated_bytes(&pos, &n)), wrong, "an SPL delegate must be refused");
        let mut n = nft.clone();
        n[121] = 1; // delegated_amount 1
        assert_eq!(code(check_not_delegated_bytes(&pos, &n)), wrong, "a delegated amount must be refused");
        assert_eq!(code(check_not_delegated_bytes(&pos[..400], &nft)), wrong, "a short position must be refused");
    }

    #[test]
    fn collect_waits_for_the_split() {
        // 0.21: every lock state the record can hold. Only the split having completed (bit 0, set by
        // `lock_liquidity` alone) opens the collect; the platform's lock (bit 1, from `create_pool`) never does.
        assert_eq!(code(require_collect_allowed(0)), u32::from(BouncerError::PlatformNotLocked), "no pool yet");
        assert_eq!(code(require_collect_allowed(LOCK_BIT_PLATFORM)), u32::from(BouncerError::SplitNotDone), "pool live, genesis position locked, no split");
        assert_eq!(code(require_collect_allowed(LOCK_BIT_PLATFORM | LOCK_BIT_CREATOR)), 0, "after the split");
    }

    fn expect_from(d: &[u8]) -> PoolExpect {
        use meteora::pool as p;
        PoolExpect {
            token_mint: key_at(d, p::TOKEN_A_MINT),
            wsol_mint: key_at(d, p::TOKEN_B_MINT),
            token_a_vault: key_at(d, p::TOKEN_A_VAULT),
            token_b_vault: key_at(d, p::TOKEN_B_VAULT),
            creator: key_at(d, p::CREATOR),
            sqrt_price: meteora::u128_at(d, p::SQRT_PRICE),
            liquidity: meteora::u128_at(d, p::LIQUIDITY),
            activation_point: u64_at(d, p::ACTIVATION_POINT),
        }
    }

    #[test]
    fn pool_readback_mismatch_is_refused_field_by_field() {
        use meteora::pool as p;
        let wrong = u32::from(BouncerError::PoolReadbackMismatch);
        let id = meteora::PROGRAM_ID;
        let e = expect_from(POOL);
        // The fixture is the measured run's pool: its liquidity and wrapped SOL mint are the recorded ones.
        assert_eq!(e.liquidity, 65_687_044_345_347_267_604_043_778_981_079);
        assert_eq!(e.wsol_mint, anchor_spl::token::spl_token::native_mint::ID);
        assert_eq!(code(check_pool_bytes(&id, POOL, &e)), 0, "the real pool must pass");
        // 0.20: the fixture is a real pool, so its alpha vault slot reads default and its status enabled.
        assert_eq!(key_at(POOL, p::WHITELISTED_VAULT), Pubkey::default());
        assert_eq!(POOL[p::POOL_STATUS], 0);
        let fields: [(&str, usize); 15] = [
            ("discriminator", 0),
            ("whitelisted_vault (an alpha vault may swap before activation, 0.20)", p::WHITELISTED_VAULT),
            ("whitelisted_vault, last byte", p::WHITELISTED_VAULT + 31),
            ("activation_point (not now, 0.20)", p::ACTIVATION_POINT),
            ("pool_status (disabled, 0.20)", p::POOL_STATUS),
            ("token_a_mint", p::TOKEN_A_MINT),
            ("token_b_mint", p::TOKEN_B_MINT),
            ("token_a_vault", p::TOKEN_A_VAULT),
            ("token_b_vault", p::TOKEN_B_VAULT),
            ("creator", p::CREATOR),
            ("sqrt_min_price", p::SQRT_MIN_PRICE),
            ("sqrt_max_price", p::SQRT_MAX_PRICE),
            ("sqrt_price", p::SQRT_PRICE),
            ("liquidity", p::LIQUIDITY),
            ("collect_fee_mode", p::COLLECT_FEE_MODE),
        ];
        for (name, at) in fields {
            let mut d = POOL.to_vec();
            flip(&mut d, at);
            assert_eq!(code(check_pool_bytes(&id, &d, &e)), wrong, "{name} changed in the pool must be refused");
        }
        // The same from the other side: the pool is untouched but create_pool asked for something else.
        let asks: [(&str, PoolExpect); 4] = [
            ("another activation point", PoolExpect { activation_point: e.activation_point + 1, ..expect_from(POOL) }),
            ("another opening price", PoolExpect { sqrt_price: e.sqrt_price + 1, ..expect_from(POOL) }),
            ("another liquidity", PoolExpect { liquidity: e.liquidity - 1, ..expect_from(POOL) }),
            ("another creator", PoolExpect { creator: Pubkey::new_unique(), ..expect_from(POOL) }),
        ];
        for (name, ask) in asks {
            assert_eq!(code(check_pool_bytes(&id, POOL, &ask)), wrong, "{name} asked for must be refused");
        }
        assert_eq!(code(check_pool_bytes(&id, &POOL[..POOL.len() - 1], &e)), wrong, "a short pool must be refused");
        assert_eq!(code(check_pool_bytes(&Pubkey::new_unique(), POOL, &e)), wrong, "the right bytes under another owner must be refused");
    }
}

#[cfg(test)]
mod raise_fee_tests {
    use super::raise_fee_parts;

    /// 1 percent at 60/40: the worked example of the 0.28 raise fee design, the rounding lamport to the platform,
    /// zeros under zero terms, and the bound of a u64 raise.
    #[test]
    fn the_two_parts() {
        assert_eq!(raise_fee_parts(12_400_000_000, 100, 6_000).unwrap(), (74_400_000, 49_600_000));
        assert_eq!(raise_fee_parts(10_000_000_000, 100, 6_000).unwrap(), (60_000_000, 40_000_000));
        // 1,234,567,891 lamports: the fee floors to 12,345,678, the creator's part to 7,407,406, the platform gets 4,938,272.
        assert_eq!(raise_fee_parts(1_234_567_891, 100, 6_000).unwrap(), (7_407_406, 4_938_272));
        assert_eq!(raise_fee_parts(1_234_567_891, 0, 6_000).unwrap(), (0, 0));
        assert_eq!(raise_fee_parts(1_234_567_891, 100, 0).unwrap(), (0, 12_345_678));
        assert_eq!(raise_fee_parts(1_234_567_891, 100, 10_000).unwrap(), (12_345_678, 0));
        assert_eq!(raise_fee_parts(u64::MAX, 500, 10_000).unwrap(), (u64::MAX / 20, 0));
        assert_eq!(raise_fee_parts(0, 100, 6_000).unwrap(), (0, 0));
    }
}
