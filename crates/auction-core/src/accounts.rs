//! Account layouts for the Anchor program, as plain Rust.
//!
//! These are the on-chain records the program will keep. They are written here
//! as ordinary structs with explicit byte lengths so the layout is reviewable
//! and testable before any Anchor code exists. The program wraps them with
//! `#[account]` and uses the `LEN` constants for `space`.
//!
//! Decided 2026-09-24 and reflected here: SOL only (deposits are lamports held
//! by the vault PDA, no wrapped SOL, no quote mint, no quote token account);
//! the supply is fixed at one billion tokens and the float is half of it
//! (`supply.rs`), neither a creator input; the floor (which is also the least a
//! launch can raise), the raise cap and the minimum bid are protocol
//! parameters in `Config`, copied into each `Launch` at genesis so a config
//! change never reaches into a running launch. The creator supplies a name, a
//! ticker, an image and a window length, nothing else. There is no partial
//! clear: a launch sells out or fails.
//!
//! Sealing (decided 2026-09-24): every bid carries a
//! drand timelock ciphertext sealed to `Launch.reveal_round`. After that round
//! is published, anyone posts the round signature; the program verifies it
//! against the round's hashed identity `round_point` and the quicknet public
//! key, stores it, and from then on anyone can run decryption over the bids.
//! A ciphertext that does not open under the verified signature is marked
//! invalid and refunded. There is no bidder reveal and no deadline.
//!
//! PDA seeds:
//! - config:     ["config"]                        one per program deployment
//! - launch:     ["launch", token_mint]
//! - bid:        ["bid", launch, bidder]           one bid per wallet per launch
//! - vault:      ["vault", launch]                 holds the SOL, signs for the token vault
//! - settlement: ["settlement", launch]
//!
//! Lengths below exclude the 8 byte Anchor discriminator; `LEN` constants include it.

use crate::grid::TICK_COUNT;

/// Anchor discriminator size.
pub const DISCRIMINATOR: usize = 8;
/// Solana public key size.
pub const PUBKEY: usize = 32;
/// Compressed BLS12-381 G1 point (drand quicknet signature or hashed round).
pub const G1_COMPRESSED: usize = 48;

/// Timelock ciphertext length for one bid: raw drand IBE over BLS12-381 with
/// quicknet's G1 signatures. U is a compressed G2 point (96), V and W are each
/// the message length. The message is 16 bytes, the size every tlock
/// implementation (Go, JS, Rust) is interop tested at because it is the age
/// file key size. Plaintext: tick as u16 little endian, then 14 random bytes.
pub const SEALED_BID_LEN: usize = 96 + 16 + 16;
/// sha256 commitment length (fallback design only, zero filled otherwise).
pub const COMMITMENT_LEN: usize = 32;

/// Launch lifecycle.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum LaunchState {
    /// Accepting bids.
    Open = 0,
    /// Window ended with at least the floor deposited. Waiting for the beacon
    /// signature, then decryption.
    Closed = 1,
    /// Clearing computed, sold out. Refunds may go out; no token leaves the vault yet.
    Settled = 2,
    /// Raydium pool created and locked at the clearing price. Delivery runs.
    PoolLive = 3,
    /// Every bid delivered or refunded, remainder burned, dust swept. Terminal.
    Finalized = 4,
    /// Break glass: settlement or pool creation never completed within the
    /// configured abort window. Every deposit is refundable in full, all tokens
    /// burn, then `burn_unsold` moves it to Finalized. Not a deadline for
    /// anything a bidder does.
    Aborted = 5,
    /// Deposits did not cover the float at the floor, at close (total deposits)
    /// or at settle (revealed deposits). A normal outcome, not a defect: every
    /// deposit is refundable in full, no pool, all tokens burn, then
    /// `burn_unsold` moves it to Finalized.
    Failed = 6,
}

/// Bid lifecycle.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum BidState {
    /// Ciphertext stored, tick unknown.
    Sealed = 0,
    /// Decrypted under the verified beacon signature; `tick` is valid.
    Revealed = 1,
    /// Did not open under the verified beacon signature. Refunded in full.
    Invalid = 2,
    /// Delivered or refunded, account closed.
    Done = 3,
    /// v0.32: the payout could not land and is held for the bidder (`park_bid`); counts as distributed.
    Parked = 4,
}

/// Platform configuration. The only account an admin key can touch, and the
/// admin can only pause creation of new launches and move the protocol
/// parameters that new launches copy. Nothing in it reaches into a running
/// launch. Every economic number a launch uses lives here; the creator sets none.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Config {
    /// Layout version, 1.
    pub version: u8,
    /// PDA bump.
    pub bump: u8,
    /// The emergency update pause (0.18, restored under its current name): 1 while the
    /// admin has paused the creation of new launches for a program update. Read by
    /// `create_launch` only; no instruction on a running launch looks at it.
    /// Disclosed on the page, never hidden. `creation_paused` until 0.15, a pad in
    /// 0.16 and 0.17.
    pub emergency_update_pause: u8,
    /// Alignment, always 0 (until 0.14 the reserved `cap_closes_book_default`).
    pub _pad1: u8,
    /// Admin key (multisig). May update this account, nothing else.
    pub admin: [u8; PUBKEY],
    /// Owner of the locked LP position that collects the 0.5 percent.
    pub lp_owner: [u8; PUBKEY],
    /// Lamports the whole float is worth at tick 0, and the least a launch can
    /// raise. The grid hangs off this. Decided: 5 SOL.
    pub floor_value: u64,
    /// Minimum bid, lamports. 0.02 SOL. At most `floor_value`.
    pub min_bid: u64,
    /// Seconds after a launch's window end before `abort` may be called. Break
    /// glass only; a deployment decision (12 hours), bounded by the program
    /// to 120 s and 30 days.
    pub abort_after_secs: u64,
    /// Basis points of a pushed delivery's tokens paid to whoever pushes it. Claiming
    /// is free. Decided on 2026-09-24: 50. Bounded by the program to 500.
    pub delivery_fee_bps: u16,
    /// Basis points of the pool's LP tokens locked for the creator; the rest is locked
    /// for the protocol. Decided on 2026-09-24: 5000. Bounded by the program to 10000.
    pub creator_lp_bps: u16,
    /// Lamports the creator posts at genesis as the crank bond (0.16): copied
    /// into `Launch.crank_bond`, paid to whoever lands `create_pool`, returned
    /// to the creator by `burn_unsold` after a failure or an abort. Sized to
    /// what the crank sinks, measured on the cluster (a reimbursement, not a
    /// reward; 2026-09-25). Bounded by the program to `MAX_CRANK_BOND_LAMPORTS`.
    pub crank_bond: u64,
    /// Unix time the emergency update pause was last switched on; 0 while off (0.18).
    pub emergency_update_pause_ts: i64,
    /// Reserved for fields appended by later versions (0.18). The layout is append
    /// only from the first mainnet version on: a new field is carved from the start
    /// of this tail, nothing before it moves, and the total size stays. Zeros.
    /// The admin proposed by `propose_admin`, who becomes the admin by signing `accept_admin` (0.24).
    /// All zeros while nothing is proposed. The first 32 bytes of the 0.18 reserved tail.
    pub pending_admin: [u8; PUBKEY],
    /// The fee destination proposed by `admin_update_config`, which becomes `lp_owner` only when it
    /// signs `accept_lp_owner` (0.24). All zeros while nothing is proposed.
    pub pending_lp_owner: [u8; PUBKEY],
    /// 0.28: basis points of the cleared raise taken as the raise fee when the pool opens (2026-10-08: 100),
    /// copied into every launch at genesis. Bounded to `MAX_RAISE_FEE_BPS`.
    pub raise_fee_bps: u16,
    /// 0.28: the creator's share of that fee, basis points of the fee (6,000); the rest to `lp_owner`. Bounded to 10,000.
    pub raise_fee_creator_share_bps: u16,
    /// 0.29: the keys whose Ed25519 attestation a bid may carry (zero = an unused slot). Carved from the reserved tail.
    pub attestors: [[u8; PUBKEY]; 3],
    /// 0.29: 1 when new launches require an attestation on every bid (copied to `Launch.attest_required` at genesis).
    pub attest_bids: u8,
    /// Alignment; zeros.
    pub _pad_attest: [u8; 7],
    /// 0.29: the processing charge each bid pays, lamports (10,000 in production); at most `MAX_PROCESSING_CHARGE`.
    pub processing_charge: u64,
    /// v0.30: the reveal margin (seconds, 60 to 300), the delivery reward and the metadata reserve (lamports), the
    /// treasury and the proposed treasury. Carved from the reserved tail at 300.
    pub reveal_margin_secs: u32,
    /// Alignment; zeros.
    pub _pad_margin: [u8; 4],
    /// v0.30: lamports a pushed delivery pays its caller on top of the rent (`Launch.delivery_reward` at genesis).
    pub delivery_reward: u64,
    /// v0.30: lamports of the prepay held for `finish_mint` (`Launch.metadata_reserve_lamports` at genesis).
    pub metadata_reserve: u64,
    /// v0.30: where the platform's half of the raise fee goes (`Launch.treasury` at genesis); live once it signed `accept_treasury`.
    pub treasury: [u8; PUBKEY],
    /// v0.30: the treasury proposed by `admin_update_config`; the default key while nothing is proposed.
    pub pending_treasury: [u8; PUBKEY],
    /// v0.30 (the buy-and-burn folded into the core, 2026-10-27): the BOUNCER mint and its canonical pool (zeros
    /// until the Squad sets them), the three crankers allowed to run `buy_and_burn`, the cap in lamports, the least
    /// seconds between two buys, the price limit (lamports per atom, Q64.64) and the last buy's unix time. Carved at 388.
    pub bouncer_mint: [u8; PUBKEY],
    /// v0.30: the canonical BOUNCER pool on cp-amm (token A the mint, token B wrapped SOL); zeros until set.
    pub bouncer_pool: [u8; PUBKEY],
    /// v0.30: the keys allowed to call `buy_and_burn`; a zero slot is unused.
    pub burn_crankers: [[u8; PUBKEY]; 3],
    /// v0.30: the most lamports one `buy_and_burn` swaps.
    pub buy_cap_lamports: u64,
    /// v0.30: the least seconds between two buys.
    pub buy_min_interval_secs: u64,
    /// v0.30: the most lamports per atom a buy may pay, Q64.64 (the swap's minimum output is `lamports * 2^64 / price`).
    pub buy_max_price_x64: u128,
    /// v0.30: unix time of the last landed `buy_and_burn`; 0 before the first.
    pub last_buy_ts: i64,
    /// The rest of the reserved tail, 44 bytes since the fold-in (244 earlier in 0.30, 332 since 0.29, 444 since 0.28,
    /// 448 since 0.24). Zeros.
    pub _reserved: [u8; 44],
}

impl Config {
    /// Serialized length including discriminator.
    pub const LEN: usize = DISCRIMINATOR + 4 + PUBKEY * 2 + 8 * 3 + 2 + 2 + 8 + 8 + PUBKEY * 2 + 448;
}

/// One launch. One per token mint. Created by the genesis transaction that also
/// mints the fixed supply, revokes mint authority and nulls freeze authority.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Launch {
    /// Layout version, 1.
    pub version: u8,
    /// PDA bump.
    pub bump: u8,
    /// See [`LaunchState`]: 0 Open, 1 Closed, 2 Settled, 3 PoolLive, 4 Finalized, 5 Aborted, 6 Failed.
    pub state: u8,
    /// 1 once `settle` wrote the settlement record (the launch cleared); never cleared, so a launch
    /// aborted after settling keeps it. Refund and claim require the record whenever this is 1 (0.17).
    /// A pad until 0.16 (`cap_closes_book` until 0.14).
    pub settled: u8,
    /// 1 once `beacon_signature` has been verified and stored.
    pub beacon_posted: u8,
    /// 1 once the creator has placed a bid (set by commit, never cleared).
    pub creator_has_bid: u8,
    /// Reserved.
    pub _pad: [u8; 2],
    /// Creator wallet. Has no special rights after genesis; may bid like anyone else, labelled.
    pub creator: [u8; PUBKEY],
    /// Token mint. Mint authority revoked, freeze authority null.
    pub token_mint: [u8; PUBKEY],
    /// Program token account holding the whole supply (float plus pool reserve) until settlement.
    pub token_vault: [u8; PUBKEY],
    /// Token atoms offered to bidders. Always half the supply; recorded so a
    /// later change of the protocol constant cannot rewrite an old launch.
    pub float: u64,
    /// Lamports the whole float is worth at tick 0, and the least this launch
    /// can raise. Copied from config at genesis.
    pub floor_value: u64,
    /// Minimum deposit per bid, lamports. Copied from config at genesis.
    pub min_bid: u64,
    /// Unix timestamp bidding opened.
    pub open_ts: i64,
    /// Window length in seconds, 300 to 3600. The book closes at `open_ts + window_secs`.
    pub window_secs: i64,
    /// Unix timestamp `close` was called. 0 until then. Informational; reveal checks the window itself.
    pub close_ts: i64,
    /// drand quicknet round every bid is sealed to. Fixed at genesis.
    pub reveal_round: u64,
    /// Hashed identity of `reveal_round` on G1 (hash to curve of sha256 of the
    /// round), compressed. Computed by the creator's client at genesis and
    /// checked by every client before bidding. Used to verify the signature.
    pub round_point: [u8; G1_COMPRESSED],
    /// The round's beacon signature, compressed G1. Zero until posted and verified.
    pub beacon_signature: [u8; G1_COMPRESSED],
    /// Lamports deposited so far. Not bounded by anything (0.15: no cap of any kind).
    /// ceiling on proceeds at settlement. Held by the vault PDA.
    pub total_deposits: u64,
    /// Number of bid accounts created.
    pub bid_count: u32,
    /// Bids decrypted so far.
    pub revealed_count: u32,
    /// Bids that failed to open under the verified signature.
    pub invalid_count: u32,
    /// Reserved.
    /// Bids closed by deliver, refund or claim, in any state.
    pub distributed_count: u32,
    /// Largest single deposit, for the settlement page.
    pub largest_deposit: u64,
    /// Copied from the config at genesis (2026-09-24, after the adversarial
    /// pass found four config values reaching running launches): where this
    /// launch's platform fees are paid by `collect_platform_fees` (0.24; the
    /// live config's value was used instead from 0.19 to 0.23, and until 0.18
    /// this wallet received the protocol's LP lock position NFT).
    pub lp_owner: [u8; PUBKEY],
    /// Copied from the config at genesis: seconds after the window end before `abort` may run.
    pub abort_after_secs: u64,
    /// Copied from the config at genesis: basis points of a pushed delivery's tokens paid to the pusher.
    pub delivery_fee_bps: u16,
    /// Copied from the config at genesis: basis points of the LP locked for the creator.
    pub creator_lp_bps: u16,
    /// The crank bond's state (0.16): 0 held in the vault, 1 paid to whoever
    /// landed `create_pool`, 2 returned to the creator by `burn_unsold` after
    /// a failure or an abort.
    pub bond_state: u8,
    /// Reserved.
    pub _pad2: [u8; 3],
    /// The crank bond, lamports, posted by the creator into the vault at genesis
    /// (`Config.crank_bond` at genesis; recorded so a config change never
    /// reaches a running launch and the vault pays back exactly what was posted).
    pub crank_bond: u64,
    /// Reserved for fields appended by later versions (0.18); zeros. See the
    /// append only rule in INTERFACE.md: carved from the start, nothing moves.
    /// 0.19: the next 258 bytes are carved from it for the deferred mint.
    /// Salt of the mint PDA `["mint", creator, mint_salt LE]` (0.19). The mint does not exist
    /// until `create_pool` creates it, together with the pool (the pool squatting fix).
    pub mint_salt: u64,
    /// Lengths in bytes of `name`, `symbol` and `uri` (0.19).
    pub name_len: u8,
    /// See `name_len`.
    pub symbol_len: u8,
    /// See `name_len`.
    pub uri_len: u8,
    /// Reserved.
    pub _pad3: [u8; 5],
    /// Metaplex name given at genesis, zero padded, written into the metadata by `create_pool` (0.19).
    pub name: [u8; 32],
    /// Metaplex symbol, zero padded (0.19).
    pub symbol: [u8; 10],
    /// Metaplex URI, zero padded (0.19).
    pub uri: [u8; 200],
    /// 0.22: alignment for `ops_paid`; zeros.
    pub _pad_ops: [u8; 6],
    /// 0.22: lamports of `crank_bond` already paid to the signers of operating steps; never above `crank_bond`.
    pub ops_paid: u64,
    /// 0.26: how the caller of `deliver` is paid: 0 the token fee terms (every launch created before 0.26), 1 bid rent terms.
    pub delivery_terms: u8,
    /// 0.26: alignment for `delivery_reward`; zeros.
    pub _pad_terms: [u8; 7],
    /// 0.26: lamports a pushed delivery pays its caller out of the delivered bid's account.
    pub delivery_reward: u64,
    /// 0.28: the raise fee terms copied from the config at genesis: basis points of the cleared raise, and the
    /// creator's share of the fee in basis points of the fee. Zeros in every launch created before 0.28.
    pub raise_fee_bps: u16,
    /// 0.28: the creator's share of the raise fee, basis points of the fee.
    pub raise_fee_creator_share_bps: u16,
    /// 0.28: alignment; zeros.
    pub _pad_fee: [u8; 4],
    /// 0.29: 1 when bids on this launch must carry a Bouncer attestation (copied from `Config.attest_bids` at
    /// genesis; `admin_waive_attestation` sets it to 0, one direction only).
    pub attest_required: u8,
    /// Alignment; zeros.
    pub _pad_attest: [u8; 7],
    /// 0.29: the processing charge each bid pays, lamports (copied from `Config.processing_charge` at genesis).
    pub processing_charge: u64,
    /// 0.29: the lamports the creator paid for the Histogram account (a launch cost, never refunded; the full
    /// size's rent once `grow_histogram` landed).
    pub histogram_rent: u64,
    /// 0.29: when `admin_waive_attestation` cleared `attest_required` (unix seconds), 0 while never waived.
    pub attest_waived_ts: i64,
    /// 0.29: 1 once `grow_histogram` took the histogram to its full size; `commit` refuses bids before that.
    pub histogram_grown: u8,
    /// Alignment; zeros.
    pub _pad_hist: [u8; 7],
    /// 0.29 tenth candidate: the prepay lamports held in the vault for `finish_mint` after the prepay was returned.
    pub metadata_reserve: u64,
    /// 0.29 tenth candidate: 1 once `finish_mint` landed.
    pub mint_finished: u8,
    /// Alignment; zeros.
    pub _pad_mint: [u8; 7],
    /// v0.30: the trading gate (0 none, 1 frozen, 2 open), the treasury, the reveal margin the round was sealed with,
    /// the beacon sample (the chain clock at `post_beacon` and the round's publish time less it) and the metadata
    /// reserve term. 72 bytes from 704.
    pub trading_state: u8,
    /// Alignment; zeros.
    pub _pad_trading: [u8; 7],
    /// v0.30: where this launch's platform raise fee part goes (`Config.treasury` at genesis).
    pub treasury: [u8; PUBKEY],
    /// v0.30: the reveal margin the round was sealed with (`Config.reveal_margin_secs` at genesis).
    pub reveal_margin_secs: u32,
    /// Alignment; zeros.
    pub _pad_margin: [u8; 4],
    /// v0.30: the chain clock when `post_beacon` landed.
    pub beacon_posted_ts: i64,
    /// v0.30: the round's publish time less that clock: a lower bound on the chain clock's lag behind the world's.
    pub beacon_lag_secs: i64,
    /// v0.30: the metadata reserve term (`Config.metadata_reserve` at genesis).
    pub metadata_reserve_lamports: u64,
    /// v0.32: when `create_pool` landed; the start of `park_bid`'s catch-all (0 on a pool created before 0.32).
    pub pool_created_ts: i64,
    /// v0.32: bids parked and not yet collected or pushed.
    pub parked_count: u32,
    /// Alignment; zeros.
    pub _pad_park: [u8; 4],
    /// v0.32: lamports the vault holds for parked bids.
    pub parked_lamports: u64,
    /// What is left of the 0.18 reserve; zeros. 576 bytes since 0.32 (600 since 0.30, 672 since the tenth 0.29 candidate, 688 in the first nine, 728 in 0.28).
    pub _reserved: [u8; 576],
}

impl Launch {
    /// Serialized length including discriminator.
    pub const LEN: usize = DISCRIMINATOR
        + 8
        + PUBKEY * 3
        + 8 * 3
        + 8 * 3
        + 8
        + G1_COMPRESSED * 2
        + 8 + 4 + 4 + 4 + 4 + 8
        + PUBKEY + 8 + 2 + 2 + 1 + 3 + 8
        + 8 + 3 + 5 + 32 + 10 + 200
        + 766
        + 1 + 7 + 8 + 8 - 24;
}

/// 0.29: the launch's histogram, one `u64` lamport sum per tick, in its own account (PDA ["hist", launch]): the
/// auction's on-chain receipt, never closed (2026-10-20), its rent a launch cost the creator pays.
/// Created at `INIT_LEN` by `create_launch` (the most one cross-program create may allocate) and grown to `LEN` by
/// `grow_histogram` in the same transaction. Zero-copy, 8-byte aligned.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Histogram {
    /// Layout version, 1.
    pub version: u8,
    /// PDA bump.
    pub bump: u8,
    /// `TICK_COUNT` as written at genesis.
    pub tick_count: u16,
    /// Zeros.
    pub _pad: [u8; 4],
    /// The histogram: `counts[tick]` is the sum of the revealed deposits at that tick, in lamports.
    pub counts: [u64; TICK_COUNT],
}

impl Histogram {
    /// Serialized length including discriminator: 8 + 8 + 8 x TICK_COUNT (19,272 bytes at 2,407 ticks).
    pub const LEN: usize = DISCRIMINATOR + 1 + 1 + 2 + 4 + 8 * TICK_COUNT;
    /// The size `create_launch` creates it at: the runtime lets one cross-program create allocate 10,240 bytes and
    /// one realloc add 10,240, so `grow_histogram` takes it the rest of the way.
    pub const INIT_LEN: usize = 10_240;
}

/// One sealed bid. Closed and rent released at delivery or refund.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Bid {
    /// Layout version, 1.
    pub version: u8,
    /// PDA bump.
    pub bump: u8,
    /// See [`BidState`]: 0 Sealed, 1 Revealed, 2 Invalid, 3 Done.
    pub state: u8,
    /// Bit 0: bidder will claim (no push delivery). Bit 1: the launch creator's bid, set by the program. Other bits reserved.
    pub flags: u8,
    /// Bidder wallet. Receives tokens and refund.
    pub bidder: [u8; PUBKEY],
    /// Launch this bid belongs to.
    pub launch: [u8; PUBKEY],
    /// Lamports deposited. Visible from the moment the bid lands.
    pub deposit: u64,
    /// Unix timestamp the bid landed.
    pub placed_ts: i64,
    /// Timelock ciphertext of the 16 byte plaintext.
    pub sealed: [u8; SEALED_BID_LEN],
    /// Fallback design only: sha256(domain, launch, bidder, tick, salt). Zeros otherwise.
    pub commitment: [u8; COMMITMENT_LEN],
    /// Tick recovered at decryption. Valid only when `state == 1`.
    pub tick: u16,
    /// Reserved.
    pub _pad2: [u8; 6],
    /// Reserved for fields appended by later versions (0.18); zeros.
    pub _reserved: [u8; 64],
}

impl Bid {
    /// Serialized length including discriminator.
    pub const LEN: usize = DISCRIMINATOR + 4 + PUBKEY * 2 + 8 + 8 + SEALED_BID_LEN + COMMITMENT_LEN + 2 + 6 + 64;
}

/// Vault. Holds every deposit as lamports on top of its own rent, and owns the
/// token vault so the program can sign token transfers. Lamports in, lamports
/// out, no wrapping until `create_pool` needs a wrapped SOL account for Raydium.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Vault {
    /// PDA bump.
    pub bump: u8,
    /// Launch this vault serves.
    pub launch: [u8; PUBKEY],
    /// Reserved for fields appended by later versions (0.18); zeros.
    pub _reserved: [u8; 128],
}

impl Vault {
    /// Serialized length including discriminator.
    pub const LEN: usize = DISCRIMINATOR + 1 + PUBKEY + 128;
}

/// Written once by `settle` when the launch clears. Read by every delivery and
/// by the settlement page. A launch that fails has no record.
///
/// The pool receives exactly `float_value` lamports and the reserve half of
/// the supply, both known here, so `create_pool` runs before any delivery.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SettlementRecord {
    /// Layout version, 1.
    pub version: u8,
    /// PDA bump.
    pub bump: u8,
    /// Reserved, zero (byte 10 was `capped` until 0.14, when the cap was removed).
    pub _pad: [u8; 2],
    /// Clearing tick: sets the one price everyone pays.
    pub clearing_tick: u16,
    /// Marginal tick, at least the clearing tick. Bids above it fill in full,
    /// bids at it are rationed pro rata, bids below it get nothing.
    pub marginal_tick: u16,
    /// Launch.
    pub launch: [u8; PUBKEY],
    /// Lamports the whole float is worth at the clearing tick. Clearing price
    /// is this over float; opening market cap is twice this; the pool receives exactly this.
    pub float_value: u64,
    /// Sum of revealed deposits at or above the clearing tick. Informational.
    pub winning_deposits: u64,
    /// Bids decrypted successfully.
    pub revealed_bids: u32,
    /// Bids whose ciphertext did not open. Refunded in full, excluded from clearing.
    pub invalid_bids: u32,
    /// Unix timestamp of settlement.
    pub settled_ts: i64,
    /// Token atoms delivered so far. Ends within one atom per winner of the float.
    pub tokens_delivered: u64,
    /// Bids delivered or refunded so far.
    pub distributed_bids: u32,
    /// Reserved.
    pub _pad3: u32,
    /// Largest single fill in atoms, for the settlement page's largest bidder share.
    pub largest_fill_tokens: u64,
    /// Pool address once created (Raydium CPMM until 0.18, Meteora DAMM v2 from 0.19). Zero before.
    pub pool: [u8; PUBKEY],
    /// Token atoms burned at finalize: the float's rounding remainder.
    pub burned_tokens: u64,
    /// Sum of revealed deposits strictly above the marginal tick. Under float_value.
    pub above_deposits: u64,
    /// Sum of revealed deposits at the marginal tick. Divisor for the marginal fills.
    pub at_deposits: u64,
    /// The launch creator's own bid, labelled on the record. Zero when the creator did not bid.
    pub creator_deposit: u64,
    /// Token atoms the creator's bid receives.
    pub creator_tokens: u64,
    /// Lamports the creator's bid pays.
    pub creator_cost: u64,
    /// The creator's revealed tick, valid when `creator_bid_state == 1`.
    pub creator_tick: u16,
    /// 0 no creator bid, 1 revealed, 2 invalid.
    pub creator_bid_state: u8,
    /// bit 0: the creator's LP position is locked; bit 1: the protocol's. 3 is
    /// both, and the launch cannot finalize before that.
    pub lp_lock_state: u8,
    /// Reserved.
    pub _pad4: [u8; 4],
    /// LP tokens the pool minted at creation, parked in the vault's token account
    /// until locked; split by `Config.creator_lp_bps` at lock time.
    pub lp_total: u64,
    /// Mint of the creator's lock position NFT; the default key until locked, or
    /// forever when the creator's share was zero.
    pub creator_lock_nft: [u8; PUBKEY],
    /// Mint of the protocol's lock position NFT, same convention.
    pub protocol_lock_nft: [u8; PUBKEY],
    /// The pool's SOL side when it opened, lamports (0.18): `float_value` plus
    /// whatever SOL strangers sent to the pool vault's address before it existed,
    /// which Raydium counts as liquidity (adversarial X11, confirmed in testing
    /// on v17). Opening price = this / reserve, at or above the clearing price.
    pub pool_sol_at_open: u64,
    /// Meteora pool liquidity at open, all permanently locked (0.19).
    pub pool_liquidity: u128,
    /// Opening price, Q64.64 square root of lamports per atom (0.19).
    pub opening_sqrt_price: u128,
    /// Reserve atoms the rounded Meteora deposit could not take, burned at pool creation (0.19).
    pub dust_tokens_burned: u64,
    /// Proceeds lamports the rounded Meteora deposit could not take, paid to the pool creator (0.19).
    pub dust_lamports: u64,
    /// The `create_pool` signer (0.20): `lock_liquidity` returns the pool creator PDA's unused rent loan to it.
    pub pool_payer: [u8; PUBKEY],
    /// The rent loan `create_pool` made to the pool creator PDA, lamports (0.23).
    pub pool_loan: u64,
    /// 0.28: the raise fee agreed at `settle`, lamports: the creator's part.
    pub raise_fee_creator: u64,
    /// 0.28: the platform's part of the raise fee agreed at `settle`, lamports (the fee less the creator's part).
    pub raise_fee_platform: u64,
    /// 0.28: what `create_pool` paid of the creator's part (the agreed part, or 0 when its destination could not hold it).
    pub raise_fee_creator_paid: u64,
    /// 0.28: what `create_pool` paid of the platform's part, same rule.
    pub raise_fee_platform_paid: u64,
    /// 0.28: the proceeds that went into the pool's pass through: `float_value` less the two parts paid.
    pub pool_sol_in: u64,
    /// 0.29 twelfth candidate (review finding F2): 1 once `release_pool_cash` ran.
    pub cash_released: u8,
    /// Alignment; zeros.
    pub _pad_cash: [u8; 7],
    /// v0.30: the chain clock when trading opened (0 while frozen).
    pub opened_ts: i64,
    /// v0.30: 1 when the Squad's break-glass opened it with bids outstanding, 0 for the gated open.
    pub opened_forced: u8,
    /// Alignment; zeros.
    pub _pad_open: [u8; 7],
    /// Reserved for fields appended by later versions (0.18); zeros. 0.19 took 48 of the 512 bytes, 0.20 took 32, 0.23 took 8, 0.28 took 40, the twelfth 0.29 candidate 8, 0.30 took 16.
    pub _reserved: [u8; 360],
}

impl SettlementRecord {
    /// Serialized length including discriminator.
    pub const LEN: usize =
        DISCRIMINATOR + 4 + 2 + 2 + PUBKEY + 8 + 8 + 4 + 4 + 8 + 8 + 4 + 4 + 8 + PUBKEY + 8 + 8 + 8 + 8 + 8 + 8 + 2 + 1 + 1 + 4 + 8 + PUBKEY + PUBKEY + 8 + 16 + 16 + 8 + 8 + PUBKEY + 432;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lengths_are_what_the_program_will_allocate() {
        // Literal numbers so a layout change is a deliberate edit here and in the program.
        assert_eq!(Config::LEN, 8 + 4 + 64 + 24 + 4 + 8 + 8 + 64 + 448);
        assert_eq!(Config::LEN, 632);
        assert_eq!(Launch::LEN, 8 + 8 + 96 + 24 + 24 + 8 + 96 + 32 + 56 + 1024); // 0.29: the histogram has its own account
        assert_eq!(Launch::LEN, 1376);
        assert_eq!(Histogram::LEN, 8 + 8 + 8 * 2407);
        assert_eq!(Histogram::LEN, 19272);
        assert_eq!(Bid::LEN, 8 + 4 + 64 + 8 + 8 + 128 + 32 + 2 + 6 + 64);
        assert_eq!(Bid::LEN, 324);
        assert_eq!(Vault::LEN, 169);
        assert_eq!(SettlementRecord::LEN, 8 + 4 + 2 + 2 + 32 + 8 + 8 + 4 + 4 + 8 + 8 + 4 + 4 + 8 + 32 + 8 + 8 + 8 + 8 + 8 + 8 + 2 + 1 + 1 + 4 + 8 + 32 + 32 + 8 + 512);
        assert_eq!(SettlementRecord::LEN, 784);
    }

    #[test]
    fn launch_offsets_match_the_interface_document() {
        // Offsets published in INTERFACE.md v0.5. Recomputed here from the field
        // sizes in declaration order so the document and the layout cannot drift.
        let mut off = DISCRIMINATOR;
        let mut at = |len: usize| {
            let here = off;
            off += len;
            here
        };
        assert_eq!(at(1), 8); // version
        assert_eq!(at(1), 9); // bump
        assert_eq!(at(1), 10); // state
        assert_eq!(at(1), 11); // settled (0.17; a pad until 0.16, cap_closes_book until 0.14)
        assert_eq!(at(1), 12); // beacon_posted
        assert_eq!(at(1), 13); // creator_has_bid
        assert_eq!(at(2), 14); // pad
        assert_eq!(at(PUBKEY), 16); // creator
        assert_eq!(at(PUBKEY), 48); // token_mint
        assert_eq!(at(PUBKEY), 80); // token_vault
        assert_eq!(at(8), 112); // float
        assert_eq!(at(8), 120); // floor_value
        assert_eq!(at(8), 128); // min_bid
        assert_eq!(at(8), 136); // open_ts
        assert_eq!(at(8), 144); // window_secs
        assert_eq!(at(8), 152); // close_ts
        assert_eq!(at(8), 160); // reveal_round
        assert_eq!(at(G1_COMPRESSED), 168); // round_point
        assert_eq!(at(G1_COMPRESSED), 216); // beacon_signature
        assert_eq!(at(8), 264); // total_deposits
        assert_eq!(at(4), 272); // bid_count
        assert_eq!(at(4), 276); // revealed_count
        assert_eq!(at(4), 280); // invalid_count
        assert_eq!(at(4), 284); // distributed_count
        assert_eq!(at(8), 288); // largest_deposit
        // 0.29: the histogram (8 x 1,024 bytes at 296 until 0.28) lives in its own account; everything after it moved up by 8,192.
        assert_eq!(at(PUBKEY), 296); // lp_owner (8488 until 0.28)
        assert_eq!(at(8), 328); // abort_after_secs
        assert_eq!(at(2), 336); // delivery_fee_bps
        assert_eq!(at(2), 338); // creator_lp_bps
        assert_eq!(at(1), 340); // bond_state
        assert_eq!(at(3), 341); // pad
        assert_eq!(at(8), 344); // crank_bond
        assert_eq!(at(8), 352); // mint_salt (0.19)
        assert_eq!(at(1), 360); // name_len (0.19)
        assert_eq!(at(1), 361); // symbol_len (0.19)
        assert_eq!(at(1), 362); // uri_len (0.19)
        assert_eq!(at(5), 363); // pad
        assert_eq!(at(32), 368); // name (0.19)
        assert_eq!(at(10), 400); // symbol (0.19)
        assert_eq!(at(200), 410); // uri (0.19)
        assert_eq!(at(6), 610); // pad (0.22)
        assert_eq!(at(8), 616); // ops_paid (0.22)
        assert_eq!(at(1), 624); // delivery_terms (0.26)
        assert_eq!(at(7), 625); // pad (0.26)
        assert_eq!(at(8), 632); // delivery_reward (0.26)
        assert_eq!(at(2), 640); // raise_fee_bps (0.28)
        assert_eq!(at(2), 642); // raise_fee_creator_share_bps (0.28)
        assert_eq!(at(4), 644); // pad (0.28)
        assert_eq!(at(1), 648); // attest_required (0.29)
        assert_eq!(at(7), 649); // pad (0.29)
        assert_eq!(at(8), 656); // processing_charge (0.29)
        assert_eq!(at(8), 664); // histogram_rent (0.29)
        assert_eq!(at(8), 672); // attest_waived_ts (0.29)
        assert_eq!(at(1), 680); // histogram_grown (0.29)
        assert_eq!(at(7), 681); // pad (0.29)
        assert_eq!(at(8), 688); // metadata_reserve (0.29 tenth candidate)
        assert_eq!(at(1), 696); // mint_finished (0.29 tenth candidate)
        assert_eq!(at(7), 697); // pad
        assert_eq!(at(672), 704); // reserved (0.18, 766 since 0.19, 728 since 0.28, 688 since 0.29, 672 since the tenth candidate)
        assert_eq!(off, Launch::LEN);
        assert_eq!(Launch::LEN, 1376);
        assert_eq!(Histogram::LEN, 16 + 8 * TICK_COUNT);
        assert_eq!(Histogram::LEN, 19272);
        assert!(Histogram::INIT_LEN <= 10_240, "one cross-program create must be able to make the first step");
        assert!(Histogram::LEN - Histogram::INIT_LEN <= 10_240, "one realloc must be able to make the second step");
    }

    #[test]
    fn config_offsets_match_the_interface_document() {
        let mut off = DISCRIMINATOR;
        let mut at = |len: usize| {
            let here = off;
            off += len;
            here
        };
        assert_eq!(at(1), 8); // version
        assert_eq!(at(1), 9); // bump
        assert_eq!(at(1), 10); // emergency_update_pause (0.18; creation_paused until 0.15, a pad in 0.16 and 0.17)
        assert_eq!(at(1), 11); // pad (was cap_closes_book_default)
        assert_eq!(at(PUBKEY), 12); // admin
        assert_eq!(at(PUBKEY), 44); // lp_owner
        assert_eq!(at(8), 76); // floor_value
        assert_eq!(at(8), 84); // min_bid
        assert_eq!(at(8), 92); // abort_after_secs
        assert_eq!(at(2), 100); // delivery_fee_bps
        assert_eq!(at(2), 102); // creator_lp_bps
        assert_eq!(at(8), 104); // crank_bond
        assert_eq!(at(8), 112); // emergency_update_pause_ts (0.18)
        assert_eq!(at(PUBKEY), 120); // pending_admin (0.24, from the reserved tail)
        assert_eq!(at(PUBKEY), 152); // pending_lp_owner (0.24)
        assert_eq!(at(2), 184); // raise_fee_bps (0.28, from the reserved tail)
        assert_eq!(at(2), 186); // raise_fee_creator_share_bps (0.28)
        assert_eq!(at(PUBKEY * 3), 188); // attestors (0.29, from the reserved tail)
        assert_eq!(at(1), 284); // attest_bids (0.29)
        assert_eq!(at(7), 285); // pad (0.29)
        assert_eq!(at(8), 292); // processing_charge (0.29)
        assert_eq!(at(4), 300); // reveal_margin_secs (0.30, from the reserved tail)
        assert_eq!(at(4), 304); // pad (0.30)
        assert_eq!(at(8), 308); // delivery_reward (0.30)
        assert_eq!(at(8), 316); // metadata_reserve (0.30)
        assert_eq!(at(PUBKEY), 324); // treasury (0.30)
        assert_eq!(at(PUBKEY), 356); // pending_treasury (0.30)
        assert_eq!(at(PUBKEY), 388); // bouncer_mint (0.30, the fold-in)
        assert_eq!(at(PUBKEY), 420); // bouncer_pool
        assert_eq!(at(PUBKEY * 3), 452); // burn_crankers
        assert_eq!(at(8), 548); // buy_cap_lamports
        assert_eq!(at(8), 556); // buy_min_interval_secs
        assert_eq!(at(16), 564); // buy_max_price_x64
        assert_eq!(at(8), 580); // last_buy_ts
        assert_eq!(at(44), 588); // reserved (0.18; 448 bytes since 0.24, 444 since 0.28, 332 since 0.29, 244 in 0.30, 44 since the fold-in)
        assert_eq!(off, Config::LEN);
        assert_eq!(Config::LEN, 632);
    }

    #[test]
    fn settlement_record_offsets_match_the_interface_document() {
        let mut off = DISCRIMINATOR;
        let mut at = |len: usize| {
            let here = off;
            off += len;
            here
        };
        assert_eq!(at(1), 8); // version
        assert_eq!(at(1), 9); // bump
        assert_eq!(at(2), 10); // pad (byte 10 was capped)
        assert_eq!(at(2), 12); // clearing_tick
        assert_eq!(at(2), 14); // marginal_tick
        assert_eq!(at(PUBKEY), 16); // launch
        assert_eq!(at(8), 48); // float_value
        assert_eq!(at(8), 56); // winning_deposits
        assert_eq!(at(4), 64); // revealed_bids
        assert_eq!(at(4), 68); // invalid_bids
        assert_eq!(at(8), 72); // settled_ts
        assert_eq!(at(8), 80); // tokens_delivered
        assert_eq!(at(4), 88); // distributed_bids
        assert_eq!(at(4), 92); // pad
        assert_eq!(at(8), 96); // largest_fill_tokens
        assert_eq!(at(PUBKEY), 104); // pool
        assert_eq!(at(8), 136); // burned_tokens
        assert_eq!(at(8), 144); // above_deposits
        assert_eq!(at(8), 152); // at_deposits
        assert_eq!(at(8), 160); // creator_deposit
        assert_eq!(at(8), 168); // creator_tokens
        assert_eq!(at(8), 176); // creator_cost
        assert_eq!(at(2), 184); // creator_tick
        assert_eq!(at(1), 186); // creator_bid_state
        assert_eq!(at(1), 187); // lp_lock_state
        assert_eq!(at(4), 188); // pad
        assert_eq!(at(8), 192); // lp_total
        assert_eq!(at(PUBKEY), 200); // creator_lock_nft
        assert_eq!(at(PUBKEY), 232); // protocol_lock_nft
        assert_eq!(at(8), 264); // pool_sol_at_open (0.18)
        assert_eq!(at(16), 272); // pool_liquidity (0.19)
        assert_eq!(at(16), 288); // opening_sqrt_price (0.19)
        assert_eq!(at(8), 304); // dust_tokens_burned (0.19)
        assert_eq!(at(8), 312); // dust_lamports (0.19)
        assert_eq!(at(PUBKEY), 320); // pool_payer (0.20)
        assert_eq!(at(8), 352); // pool_loan (0.23)
        assert_eq!(at(8), 360); // raise_fee_creator (0.28)
        assert_eq!(at(8), 368); // raise_fee_platform (0.28)
        assert_eq!(at(8), 376); // raise_fee_creator_paid (0.28)
        assert_eq!(at(8), 384); // raise_fee_platform_paid (0.28)
        assert_eq!(at(8), 392); // pool_sol_in (0.28)
        assert_eq!(at(1), 400); // cash_released (0.29 twelfth candidate, review finding F2)
        assert_eq!(at(7), 401); // pad
        assert_eq!(at(376), 408); // reserved (0.18, 48 bytes taken by 0.19, 32 by 0.20, 8 by 0.23, 40 by 0.28, 8 by the twelfth 0.29 candidate)
        assert_eq!(off, SettlementRecord::LEN);
        assert_eq!(SettlementRecord::LEN, 784);
    }

    #[test]
    fn sealed_bid_is_one_raw_ibe_ciphertext() {
        assert_eq!(SEALED_BID_LEN, 128);
    }

    #[test]
    fn state_discriminants_are_stable() {
        assert_eq!(LaunchState::Open as u8, 0);
        assert_eq!(LaunchState::Closed as u8, 1);
        assert_eq!(LaunchState::Settled as u8, 2);
        assert_eq!(LaunchState::PoolLive as u8, 3);
        assert_eq!(LaunchState::Finalized as u8, 4);
        assert_eq!(LaunchState::Aborted as u8, 5);
        assert_eq!(LaunchState::Failed as u8, 6);
        assert_eq!(BidState::Sealed as u8, 0);
        assert_eq!(BidState::Revealed as u8, 1);
        assert_eq!(BidState::Invalid as u8, 2);
        assert_eq!(BidState::Done as u8, 3);
        assert_eq!(BidState::Parked as u8, 4);
    }
}
