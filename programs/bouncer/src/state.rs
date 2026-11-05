//! On chain accounts. Layouts are the ones in `auction_core::accounts` and
//! INTERFACE.md v0.5; the tests at the bottom pin every length to the crate's
//! constants so the two cannot drift.

use anchor_lang::prelude::*;
use auction_core::grid::TICK_COUNT;

/// Platform configuration. PDA ["config"], 632 bytes (0.18).
#[account]
pub struct Config {
    pub version: u8,
    pub bump: u8,
    /// The emergency update pause (0.18, restored under its current name): 1 while the
    /// admin has paused the creation of new launches for a program update. Read by
    /// `create_launch` only; nothing on a running launch looks at it. Disclosed on
    /// the page. `creation_paused` until 0.15, a pad in 0.16 and 0.17.
    pub emergency_update_pause: u8,
    /// Alignment, always 0 (until 0.14 the reserved `cap_closes_book_default`).
    pub _pad1: u8,
    pub admin: Pubkey,
    pub lp_owner: Pubkey,
    /// Lamports the whole float is worth at tick 0, and the least a launch can raise. No ceiling exists.
    pub floor_value: u64,
    pub min_bid: u64,
    pub abort_after_secs: u64,
    /// Basis points of a pushed delivery's tokens paid to the pusher. Claiming is free. 0.26: must
    /// be 0 (a pushed delivery is repaid from the bid account's rent instead); a config written
    /// before 0.26 may hold 50 until it is updated, and no launch is created while it does.
    pub delivery_fee_bps: u16,
    /// Basis points of the pool's LP locked for the creator; the rest for the protocol.
    pub creator_lp_bps: u16,
    /// Lamports the creator posts at genesis as the crank bond (0.16): the measured cost of `create_pool`, copied into the launch.
    pub crank_bond: u64,
    /// Unix time the emergency update pause was last switched on; 0 while off (0.18).
    pub emergency_update_pause_ts: i64,
    /// The admin proposed by `propose_admin`, who becomes the admin by signing `accept_admin` (0.24).
    /// The default key while nothing is proposed. Carved from the start of the reserved tail.
    pub pending_admin: Pubkey,
    /// The fee destination proposed by `admin_update_config`, which becomes `lp_owner` only when it signs
    /// `accept_lp_owner` (0.24). The default key while nothing is proposed.
    pub pending_lp_owner: Pubkey,
    /// 0.28: basis points of the cleared raise taken as the raise fee when a launch opens its pool (decided
    /// 2026-10-08: 1 percent of successful auction proceeds, in SOL). Copied into every launch at genesis and
    /// signed in the creator's terms; at most `MAX_RAISE_FEE_BPS`. Carved from the reserved tail, so a config
    /// written before 0.28 reads 0 here and no launch created under it pays a fee.
    pub raise_fee_bps: u16,
    /// 0.28: the creator's share of that fee, basis points of the fee (6,000: 60 percent to the creator, the
    /// rest to the launch's `lp_owner`); at most 10,000.
    pub raise_fee_creator_share_bps: u16,
    /// 0.29: the keys whose Ed25519 attestation a bid may carry when `attest_bids` is 1 (the attestation services'
    /// keys, held in Turnkey); a zero slot is unused. Carved from the reserved tail, so a config written before 0.29
    /// reads three zero slots here.
    pub attestors: [Pubkey; 3],
    /// 0.29: 1 when every launch created from now on requires a Bouncer attestation on each bid; copied to
    /// `Launch.attest_required` at genesis and read nowhere else.
    pub attest_bids: u8,
    /// 0.29: alignment; zeros.
    pub _pad_attest: [u8; 7],
    /// 0.29: the processing charge each bid pays at commit, lamports (10,000 in production), at most
    /// `MAX_PROCESSING_CHARGE`; copied to `Launch.processing_charge` at genesis and read there by `commit`.
    pub processing_charge: u64,
    /// v0.30 (2026-10-27): the reveal margin, seconds, Squad-adjustable within hard bounds (`REVEAL_MARGIN_MIN_SECS`
    /// 60 to `REVEAL_MARGIN_MAX_SECS` 300; starts at 120, the constant every build before 0.30 used). Copied to
    /// `Launch.reveal_margin_secs` at genesis, where it fixes the drand round the bids are sealed to. A config written
    /// before 0.30 reads 0 here, which an update refuses, so the first 0.30 update sets it. Carved from the tail at 300.
    pub reveal_margin_secs: u32,
    /// v0.30: alignment; zeros.
    pub _pad_margin: [u8; 4],
    /// v0.30: lamports a pushed delivery pays its caller on top of the token account rent (`Launch.delivery_reward` at
    /// genesis; the constant `DELIVERY_REWARD_LAMPORTS` until 0.29); at most `MAX_DELIVERY_REWARD_LAMPORTS`.
    pub delivery_reward: u64,
    /// v0.30: lamports of the creator's prepay held back for `finish_mint` when the prepay is returned before the metadata
    /// is written (`Launch.metadata_reserve_lamports` at genesis; the constant `METADATA_RESERVE_LAMPORTS` until 0.29);
    /// within `MIN_METADATA_RESERVE_LAMPORTS` and `MAX_METADATA_RESERVE_LAMPORTS`.
    pub metadata_reserve: u64,
    /// v0.30: where the platform's half of the raise fee is paid by `create_pool`, copied to `Launch.treasury` at genesis
    /// as `lp_owner` is; `lp_owner` (the buyback router) then receives trading fees only. Takes effect only when the
    /// proposed key signs `accept_treasury` (a Squads vault signs through a vault transaction). The default key until
    /// then, and creation is refused `ConfigIncomplete` while it is.
    pub treasury: Pubkey,
    /// v0.30: the treasury proposed by `admin_update_config`, the default key while nothing is proposed.
    pub pending_treasury: Pubkey,
    /// v0.30 (2026-10-27, the buy-and-burn folded into the core): the BOUNCER mint and its canonical cp-amm pool
    /// (this program's own: token A the mint, token B wrapped SOL), set by `admin_set_buyback` after genesis; zeros
    /// until then, and `buy_and_burn` refuses `BuybackPoolNotSet` while the burn vault accumulates. Carved at 388.
    pub bouncer_mint: Pubkey,
    pub bouncer_pool: Pubkey,
    /// v0.30: the keys allowed to call `buy_and_burn` (keeper 1, keeper 2, an operator wallet); a zero slot is unused.
    pub burn_crankers: [Pubkey; 3],
    /// v0.30: the most lamports one `buy_and_burn` swaps; the least seconds between two; the most lamports per atom a
    /// buy may pay, Q64.64 (the swap's minimum output is `lamports * 2^64 / price`; the caller may only raise it).
    pub buy_cap_lamports: u64,
    pub buy_min_interval_secs: u64,
    pub buy_max_price_x64: u128,
    /// v0.30: unix time of the last landed `buy_and_burn`; 0 before the first. Written by `buy_and_burn` only.
    pub last_buy_ts: i64,
    /// Reserved for fields appended by later versions (0.18); zeros. See the append only rule in INTERFACE.md.
    /// 0.24 took 64 of the 512 bytes, 0.28 took 4, 0.29 took 112, 0.30 took 88 and then 200 (the fold-in).
    pub _reserved: [u8; 44],
}

impl Config {
    pub const LEN: usize = auction_core::accounts::Config::LEN;
}

/// One launch. PDA ["launch", token_mint], 1,376 bytes since 0.29 (9,568 until 0.28, when the 8 KB histogram
/// lived inside it; it is now the `Histogram` account below, the permanent receipt). Zero copy.
#[account(zero_copy)]
#[repr(C)]
pub struct Launch {
    pub version: u8,
    pub bump: u8,
    /// 0 Open, 1 Closed, 2 Settled, 3 PoolLive, 4 Finalized, 5 Aborted, 6 Failed, 7 Initializing (0.29: created,
    /// the histogram not yet grown; `grow_histogram` takes it to Open, nothing else moves it but `abort` at the deadline)
    pub state: u8,
    /// 1 once `settle` wrote the settlement record (the launch cleared); never
    /// cleared, so a launch aborted after settling keeps it. `refund` and `claim`
    /// require the record whenever this is 1 (0.17). A pad until 0.16.
    pub settled: u8,
    pub beacon_posted: u8,
    /// 1 once the creator has placed a bid in this launch (set by `commit`, never cleared).
    /// `settle` then requires the creator's Bid account so the record can label the fill.
    pub creator_has_bid: u8,
    pub _pad: [u8; 2],
    pub creator: Pubkey,
    pub token_mint: Pubkey,
    pub token_vault: Pubkey,
    pub float: u64,
    pub floor_value: u64,
    pub min_bid: u64,
    pub open_ts: i64,
    pub window_secs: i64,
    pub close_ts: i64,
    pub reveal_round: u64,
    pub round_point: [u8; 48],
    pub beacon_signature: [u8; 48],
    pub total_deposits: u64,
    pub bid_count: u32,
    pub revealed_count: u32,
    pub invalid_count: u32,
    /// Bids closed by deliver, refund or claim, in any state.
    pub distributed_count: u32,
    pub largest_deposit: u64,
    /// Copied from the config at genesis; nothing in the config reaches a running launch. Where this
    /// launch's platform fees are paid by `collect_platform_fees` (0.24; written but unread from 0.19
    /// to 0.23, when collection followed the live config).
    pub lp_owner: Pubkey,
    pub abort_after_secs: u64,
    pub delivery_fee_bps: u16,
    pub creator_lp_bps: u16,
    /// Operating prepay state: 0 held in the vault, 1 paid whole to a `create_pool` payer (0.16 to 0.21
    /// only; a launch created under 0.22 never reaches it), 2 remainder returned to the creator (at finalize,
    /// or at lock since 0.23 and then finalized), 3 (0.23) remainder returned to the creator at `lock_liquidity`,
    /// the finalize allowance still held for `burn_unsold`'s caller.
    pub bond_state: u8,
    pub _pad2: [u8; 3],
    /// The operating prepay the creator posted at genesis (the crank bond until 0.21), lamports. Since
    /// 0.22 each operating step repays its signer from it (`ops_paid`) and finalize returns the rest to
    /// the creator in every outcome.
    pub crank_bond: u64,
    /// 0.19, carved from the 0.18 reserve (the pool squatting fix, 2026-09-27): the
    /// mint is the PDA ["mint", creator, mint_salt LE] and does not exist until `create_pool`
    /// creates it, so the salt is kept here for that instruction's seeds.
    pub mint_salt: u64,
    /// Lengths of the three metadata strings below, in bytes (0.19).
    pub name_len: u8,
    pub symbol_len: u8,
    pub uri_len: u8,
    pub _pad3: [u8; 5],
    /// Metaplex name, symbol and URI given at genesis and written into the mint's metadata by
    /// `create_pool` (0.19); zero padded. Until 0.18 the metadata account was created at genesis.
    pub name: [u8; 32],
    pub symbol: [u8; 10],
    pub uri: [u8; 200],
    /// 0.22: alignment for `ops_paid`; zeros.
    pub _pad_ops: [u8; 6],
    /// 0.22: lamports of `crank_bond` already paid to the signers of operating steps (settle,
    /// create_pool, lock_liquidity, burn_unsold). Never more than `crank_bond`.
    pub ops_paid: u64,
    /// 0.26, carved from the reserve: how the caller of `deliver` is paid (`delivery_terms`), fixed at
    /// genesis. Zero in every launch created before 0.26, whose reserve was zeros.
    pub delivery_terms: u8,
    /// 0.26: alignment for `delivery_reward`; zeros.
    pub _pad_terms: [u8; 7],
    /// 0.26: lamports a pushed delivery pays its caller out of the delivered bid's own account, on top
    /// of the token account rent the caller advanced (`DELIVERY_REWARD_LAMPORTS` at genesis). Read only
    /// when `delivery_terms` is `BID_RENT`; zero in every launch created before 0.26.
    pub delivery_reward: u64,
    /// 0.28, carved from the reserve: the raise fee terms copied from the config at genesis and read by `settle`,
    /// never the config. Basis points of the cleared raise taken when the pool opens, and the creator's share of
    /// that fee in basis points of the fee. Zeros in every launch created before 0.28, whose reserve was zeros.
    pub raise_fee_bps: u16,
    pub raise_fee_creator_share_bps: u16,
    /// 0.28: alignment; zeros.
    pub _pad_fee: [u8; 4],
    /// 0.29, carved from the reserve: 1 when every bid must carry a Bouncer attestation (`Config.attest_bids` at
    /// genesis); `admin_waive_attestation` sets it to 0 (while the window is open, once) and nothing sets it back.
    /// Read by `commit` only.
    pub attest_required: u8,
    /// 0.29: alignment; zeros.
    pub _pad_attest: [u8; 7],
    /// 0.29: the processing charge each bid pays at commit, lamports (`Config.processing_charge` at genesis). Read by
    /// `commit`; each bid records what it paid, so the reveal reward and refunds use the bid's own figure.
    pub processing_charge: u64,
    /// 0.29: the lamports the creator paid for the launch's `Histogram` account (its rent at `Histogram::LEN`, written
    /// by `grow_histogram`; the genesis size's rent until then). A launch cost, never refunded: the account is the
    /// auction's permanent receipt. For display.
    pub histogram_rent: u64,
    /// 0.29: when `admin_waive_attestation` cleared `attest_required` (unix seconds), 0 while never waived. The
    /// waiver is launch-wide and one way, lands only while the bidding window is open, and is recorded here as well
    /// as in the `AttestationWaived` event.
    pub attest_waived_ts: i64,
    /// 0.29: 1 once `grow_histogram` took the histogram to its full size; `commit` refuses every bid before that
    /// (`HistogramNotReady`). Set in the same transaction as `create_launch` by the site's create flow.
    pub histogram_grown: u8,
    pub _pad_hist: [u8; 7],
    /// 0.29 tenth candidate (review finding N3, 2026-10-21): lamports of the operating prepay held in the vault for
    /// `finish_mint` when the prepay was returned to the creator (`lock_liquidity` or `release_pool_cash`) before the
    /// metadata was written: `METADATA_RESERVE_LAMPORTS` at most, less when the prepay had less left. `finish_mint`
    /// pays its payer from it (the measured spend plus the step allowance, capped by it) and the rest to the creator,
    /// then zeroes it. `burn_unsold` neither pays it out nor sweeps it. 0 while the prepay is still open
    /// (`bond_state` 0) or once the metadata is written.
    pub metadata_reserve: u64,
    /// 0.29 tenth candidate (review finding N4): 1 once `finish_mint` landed (PoolLive or Finalized). The money steps read
    /// this, not the mint: the prepay's return holds the reserve above while it is 0.
    pub mint_finished: u8,
    pub _pad_mint: [u8; 7],
    /// v0.30 (2026-10-27, gate X): 0 no gate (the pool was created under 0.29 or earlier, or does not exist yet),
    /// 1 frozen (`create_pool` froze the pool's launch token vault the instant Meteora made it; no swap can land),
    /// 2 open (`open_trading` thawed it once every bid was delivered or refunded, or `admin_open_trading` did). Read
    /// by the two opens and by `burn_unsold`, which refuses to finalize a frozen pool.
    pub trading_state: u8,
    pub _pad_trading: [u8; 7],
    /// v0.30: where this launch's platform raise fee part goes (`Config.treasury` at genesis), read by `create_pool`
    /// and nothing else; `lp_owner` keeps the trading fees.
    pub treasury: Pubkey,
    /// v0.30: the reveal margin the launch's round was sealed with (`Config.reveal_margin_secs` at genesis). Record.
    pub reveal_margin_secs: u32,
    pub _pad_margin: [u8; 4],
    /// v0.30: the chain clock when `post_beacon` landed, and the lag sample: the round's scheduled publish time (wall
    /// clock) less that chain clock. Positive means the chain's clock was behind the world's by at least that much when
    /// the key was posted (the signature proves the key existed). Record only; no instruction reads either.
    pub beacon_posted_ts: i64,
    pub beacon_lag_secs: i64,
    /// v0.30: the metadata reserve term (`Config.metadata_reserve` at genesis), read by the prepay's return.
    pub metadata_reserve_lamports: u64,
    /// v0.32: when `create_pool` landed (the chain clock), the start of `park_bid`'s catch-all; 0 on a pool created
    /// before 0.32, where the record's `settled_ts` stands in.
    pub pool_created_ts: i64,
    /// v0.32: bids parked and not yet collected or pushed, and the lamports the vault holds for them (excluded from
    /// `burn_unsold`'s dust sweep).
    pub parked_count: u32,
    pub _pad_park: [u8; 4],
    pub parked_lamports: u64,
    /// Reserved for fields appended by later versions (0.18, 752 since 0.22, 736 since 0.26, 728 since 0.28, 688
    /// in the first nine 0.29 candidates, 672 since the tenth, 600 since 0.30, 576 since 0.32); zeros.
    pub _reserved: [u8; 576],
}

/// 0.29: the launch's histogram. PDA ["hist", launch], 19,272 bytes, zero copy (`reveal` touches one slot per bid).
/// Created by `create_launch` at `INIT_LEN` and grown to `LEN` by `grow_histogram` in the same transaction, both
/// paid by the creator (`Launch.histogram_rent`, a launch cost, never refunded); `reveal` adds each opened bid's
/// deposit in lamports to `counts[tick]`; `settle` reads it to clear the launch. Nothing writes it after the reveals
/// and nothing closes it, ever: it is the auction's on-chain receipt (2026-10-20). Every step after
/// `settle` works from the `SettlementRecord`.
#[account(zero_copy)]
#[repr(C)]
pub struct Histogram {
    pub version: u8,
    pub bump: u8,
    /// `TICK_COUNT` as written at genesis (2,407).
    pub tick_count: u16,
    pub _pad: [u8; 4],
    /// Revealed deposits per tick, in lamports. A sum of deposits is under 2^63 (the chain's supply), so no slot can
    /// overflow; `reveal` adds with a checked add regardless.
    pub counts: [u64; TICK_COUNT],
}

impl Histogram {
    pub const LEN: usize = auction_core::accounts::Histogram::LEN;
    pub const INIT_LEN: usize = auction_core::accounts::Histogram::INIT_LEN;
}

/// 2026-10-21 (review finding F7): every `Launch` layout this program has written on a cluster, by account length and
/// version byte, with the offsets `collect_platform_fees` reads (`launch_fee_view`, lib.rs). A pool trades for as
/// long as the chain exists and its platform position's fees are claimable only through this program, so the fee
/// path must read a launch of any age: a layout break appends a row here and never removes one, and the fee
/// rights of every launch ever created survive it. Every other instruction keeps the exact-length refusal
/// (`LaunchLayoutUnknown`). The contract exports the table (`LAUNCH_LAYOUTS` in `idl/constants`), so the keeper's
/// fee claim scans every length too.
pub struct LaunchLayout {
    pub len: usize,
    pub version: u8,
    pub state: usize,
    pub token_mint: usize,
    pub lp_owner: usize,
    /// The builds that wrote it.
    pub builds: &'static str,
}

pub const LAUNCH_LAYOUTS: &[LaunchLayout] = &[
    // The histogram inside the account at 296, 8,192 bytes; the genesis copies after it.
    LaunchLayout { len: 9568, version: 1, state: 10, token_mint: 48, lp_owner: 8488, builds: "0.18 to 0.28" },
    // 0.29: the histogram in its own account; every field after 296 moved up by 8,192.
    LaunchLayout { len: 1376, version: 1, state: 10, token_mint: 48, lp_owner: 296, builds: "0.29" },
];

impl Launch {
    pub const LEN: usize = auction_core::accounts::Launch::LEN;

    pub fn window_params(&self) -> auction_core::WindowParams {
        auction_core::WindowParams {
            open_ts: self.open_ts,
            window_secs: self.window_secs,
            floor_value: self.floor_value,
            min_bid: self.min_bid,
        }
    }
}

/// Launch states, as u8 in `Launch.state`.
pub mod launch_state {
    pub const OPEN: u8 = 0;
    pub const CLOSED: u8 = 1;
    pub const SETTLED: u8 = 2;
    pub const POOL_LIVE: u8 = 3;
    pub const FINALIZED: u8 = 4;
    pub const ABORTED: u8 = 5;
    pub const FAILED: u8 = 6;
    /// 0.29: `create_launch` wrote the launch and the histogram at its genesis size; `grow_histogram` has not landed.
    /// Inert: no bid (`HistogramNotReady`), no close, no beacon, no waiver, no reveal, no settle, no pool, no payout;
    /// `grow_histogram` (the creator, before the window ends) takes it to Open, and `abort` at the recovery deadline
    /// takes it to Aborted so `burn_unsold` can return the creator's prepay. The direct-call safety review of
    /// 2026-10-20 asked for the explicit state (item 6).
    pub const INITIALIZING: u8 = 7;
}

/// 0.26: how the caller of `deliver` is paid, as u8 in `Launch.delivery_terms`. Written once, by
/// `create_launch`, and never changed.
pub mod delivery_terms {
    /// Every launch created before 0.26 (the byte was reserved and zero): the caller pays the
    /// bidder's token account rent and is paid `Launch.delivery_fee_bps` of the tokens; the whole
    /// bid account goes back to the bidder.
    pub const TOKEN_FEE: u8 = 0;
    /// Every launch created by 0.26 or later: the caller is repaid the token account rent it
    /// actually paid, plus `Launch.delivery_reward`, out of the delivered bid's own account; the
    /// rest of the bid account goes back to the bidder. No tokens are taken.
    pub const BID_RENT: u8 = 1;
}

/// Bid states, as u8 in `Bid.state`.
pub mod bid_state {
    pub const SEALED: u8 = 0;
    pub const REVEALED: u8 = 1;
    pub const INVALID: u8 = 2;
    pub const DONE: u8 = 3;
    /// v0.32: the payout could not land and was parked (`park_bid`): its tokens stay in the launch's token vault and its
    /// lamports in the vault, both recorded on the bid, until the bidder collects them (`collect_parked`) or anyone
    /// pushes them (`push_parked`). Counts as distributed.
    pub const PARKED: u8 = 4;
}

/// One sealed bid. PDA ["bid", launch, bidder], 260 bytes.
#[account]
pub struct Bid {
    pub version: u8,
    pub bump: u8,
    pub state: u8,
    /// bit 0: retired in v0.30 (self-claim is removed; `commit` refuses it, `ClaimRemoved`), the claim-only flag of
    /// 0.18 to 0.29. bit 1: this is the launch creator's bid (set by the program).
    pub flags: u8,
    pub bidder: Pubkey,
    pub launch: Pubkey,
    pub deposit: u64,
    pub placed_ts: i64,
    pub sealed: [u8; 128],
    pub commitment: [u8; 32],
    pub tick: u16,
    pub _pad2: [u8; 6],
    /// 0.22: the processing charge paid at commit on top of the deposit, held in the vault and paid to
    /// whoever moves this bid out of Sealed (reveal), or returned with the deposit if it never is. 0 for
    /// a bid committed before 0.22.
    pub processing_charge: u64,
    /// v0.32: what a parked bid is owed (`bid_state::PARKED`): the fill's tokens, held in the launch's token vault, and
    /// the lamports, held in the vault. Zero on every other bid.
    pub parked_tokens: u64,
    pub parked_lamports: u64,
    /// Reserved for fields appended by later versions (0.18, 56 since 0.22, 40 since 0.32); zeros.
    pub _reserved: [u8; 40],
}

impl Bid {
    pub const LEN: usize = auction_core::accounts::Bid::LEN;
    /// Retired in v0.30: refused by `commit`. Kept so the bit stays reserved and old bids read.
    pub const FLAG_CLAIM: u8 = 1;
    /// Set by `commit` when the bidder is `Launch.creator`. Clients cannot set or clear it.
    pub const FLAG_CREATOR: u8 = 2;
}

/// Vault. PDA ["vault", launch], 41 bytes. Holds the deposits as lamports on
/// top of its rent and is the authority of the token vault.
#[account]
pub struct Vault {
    pub bump: u8,
    pub launch: Pubkey,
    /// Reserved for fields appended by later versions (0.18); zeros.
    pub _reserved: [u8; 128],
}

impl Vault {
    pub const LEN: usize = auction_core::accounts::Vault::LEN;
}

/// v0.30 (the fold-in): the fee vault, PDA `["fee_vault"]`, 9 bytes, one per deployment: a program-owned account so
/// the lamports a closed wrapped SOL account leaves in it can be moved on by the program (`collect_platform_fees`).
/// It holds nothing between instructions but its own rent.
#[account]
pub struct PlatformVault {
    pub bump: u8,
}

impl PlatformVault {
    pub const LEN: usize = 8 + 1;
}

/// Settlement record. PDA ["settlement", launch], 264 bytes. Only exists for
/// a launch that cleared.
#[account]
pub struct SettlementRecord {
    pub version: u8,
    pub bump: u8,
    /// Reserved, zero (byte 10 was `capped` until 0.14, when the cap was removed).
    pub _pad: [u8; 2],
    pub clearing_tick: u16,
    /// At least clearing_tick. Bids above it fill in full, bids at it are rationed, bids below it get nothing.
    pub marginal_tick: u16,
    pub launch: Pubkey,
    pub float_value: u64,
    pub winning_deposits: u64,
    pub revealed_bids: u32,
    pub invalid_bids: u32,
    pub settled_ts: i64,
    pub tokens_delivered: u64,
    pub distributed_bids: u32,
    pub _pad3: u32,
    pub largest_fill_tokens: u64,
    pub pool: Pubkey,
    pub burned_tokens: u64,
    pub above_deposits: u64,
    pub at_deposits: u64,
    /// The launch creator's own bid, labelled here so nobody has to infer it. Zero when the creator did not bid.
    pub creator_deposit: u64,
    /// Token atoms the creator's bid receives under the fill rule.
    pub creator_tokens: u64,
    /// Lamports the creator's bid pays (deposit minus refund).
    pub creator_cost: u64,
    /// The creator's revealed tick. Valid when creator_bid_state is 1.
    pub creator_tick: u16,
    /// 0 no creator bid, 1 revealed, 2 invalid ciphertext (refunded in full).
    pub creator_bid_state: u8,
    /// bit 0: the creator's LP position is locked; bit 1: the protocol's. 3 is both, required to finalize.
    pub lp_lock_state: u8,
    pub _pad4: [u8; 4],
    /// Raydium only (until 0.18): LP tokens the pool minted. Always 0 from 0.19; see `pool_liquidity`.
    pub lp_total: u64,
    /// Mint of the creator's Meteora position NFT (0.19; default key until locked, or when the creator's share was zero).
    pub creator_lock_nft: Pubkey,
    /// Mint of the platform's Meteora position NFT (0.19), owned by the launch's pool creator PDA.
    pub protocol_lock_nft: Pubkey,
    /// The pool's SOL side when it opened, lamports (0.18): from 0.19 what Meteora's SOL vault held after
    /// the deposit, the rounded deposit plus any SOL strangers sent to the vault's address before it existed.
    pub pool_sol_at_open: u64,
    /// The pool's liquidity at open (0.19), all of it permanently locked; split between the two positions at lock time.
    pub pool_liquidity: u128,
    /// The price the pool opened at (0.19): Q64.64 square root of lamports per token atom.
    pub opening_sqrt_price: u128,
    /// Reserve atoms Meteora's rounded deposit could not take, burned at pool creation (0.19).
    pub dust_tokens_burned: u64,
    /// Proceeds lamports Meteora's rounded deposit could not take, paid to the `create_pool` payer (0.19).
    pub dust_lamports: u64,
    /// The `create_pool` signer (0.20). `lock_liquidity` returns the pool creator PDA's unused rent loan here.
    pub pool_payer: Pubkey,
    /// The rent loan `create_pool` made to the pool creator PDA, lamports (0.23): the amount transferred,
    /// recorded in the same instruction. `lock_liquidity` repays the part Meteora kept from this record,
    /// never from a recomputation (a Rent change between the two steps mispriced it under 0.22).
    pub pool_loan: u64,
    /// 0.28: the raise fee agreed at `settle` from the launch's own terms, lamports: the creator's part
    /// (floor of the fee times the creator's share) and the platform's (the rest of the fee, which is the floor
    /// of `float_value` times `Launch.raise_fee_bps`). Nothing is paid here; `create_pool` pays.
    pub raise_fee_creator: u64,
    pub raise_fee_platform: u64,
    /// 0.28: what `create_pool` paid of each part. Equal to the agreed part, or 0 when the destination could not
    /// hold it rent exempt (then it stayed in the proceeds). 0 until the pool opens.
    pub raise_fee_creator_paid: u64,
    pub raise_fee_platform_paid: u64,
    /// 0.28: the proceeds `create_pool` put into the wrapped SOL pass through for the pool: `float_value` less the
    /// two parts paid. The pool's SOL side at open is this less `dust_lamports` plus any stray SOL (`pool_sol_at_open`).
    pub pool_sol_in: u64,
    /// 0.29 twelfth candidate (review finding F2): 1 once `release_pool_cash` closed the wrapped SOL pass through and returned
    /// the pool creator PDA's loan to the pool payer and the unused prepay to the creator, ahead of the creator's
    /// split. `lock_liquidity` then skips those steps (its pass through slot takes the program id).
    pub cash_released: u8,
    pub _pad_cash: [u8; 7],
    /// v0.30: the chain clock when trading opened (`open_trading` or `admin_open_trading`); 0 while the pool is frozen.
    pub opened_ts: i64,
    /// v0.30: 1 when the open was the Squad's break-glass (`admin_open_trading`, bids still outstanding), 0 for the
    /// gated open.
    pub opened_forced: u8,
    pub _pad_open: [u8; 7],
    /// Reserved for fields appended by later versions (0.18); zeros. 0.19 took 48 of the 512 bytes, 0.20 took 32, 0.23 took 8, 0.28 took 40, the twelfth 0.29 candidate 8, 0.30 took 16.
    pub _reserved: [u8; 360],
}

impl SettlementRecord {
    pub const LEN: usize = auction_core::accounts::SettlementRecord::LEN;

    pub fn clearing(&self, float: u64) -> auction_core::Clearing {
        auction_core::Clearing {
            tick: self.clearing_tick,
            marginal_tick: self.marginal_tick,
            float_value: self.float_value as u128,
            winning_deposits: self.winning_deposits as u128,
            above_deposits: self.above_deposits as u128,
            at_deposits: self.at_deposits as u128,
            float,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::mem::size_of;

    /// The layout table's last row is this build's layout, at the offsets the struct puts the three fields; the
    /// rows are distinct by length and no row is ever shorter than its offsets reach.
    #[test]
    fn the_launch_layout_table_ends_with_this_build() {
        let last = LAUNCH_LAYOUTS.last().unwrap();
        assert_eq!(last.len, Launch::LEN);
        assert_eq!(last.version, crate::LAYOUT_VERSION);
        assert_eq!(last.state, std::mem::offset_of!(Launch, state) + 8);
        assert_eq!(last.token_mint, std::mem::offset_of!(Launch, token_mint) + 8);
        assert_eq!(last.lp_owner, std::mem::offset_of!(Launch, lp_owner) + 8);
        for (i, l) in LAUNCH_LAYOUTS.iter().enumerate() {
            assert!(l.lp_owner + 32 <= l.len && l.token_mint + 32 <= l.len && l.state < l.len, "row {i} reads past its length");
            assert!(LAUNCH_LAYOUTS.iter().filter(|m| m.len == l.len && m.version == l.version).count() == 1, "row {i} is not unique");
        }
        assert_eq!(LAUNCH_LAYOUTS[0].len, 9568, "the 0.28 layout (devnet's pools of 2026-10) stays in the table");
    }

    #[test]
    fn zero_copy_launch_matches_the_published_layout() {
        assert_eq!(8 + size_of::<Launch>(), Launch::LEN);
        assert_eq!(Launch::LEN, 1376);
        assert_eq!(TICK_COUNT, 2407);
        assert_eq!(std::mem::offset_of!(Launch, settled) + 8, 11);
        assert_eq!(std::mem::offset_of!(Launch, creator_has_bid) + 8, 13);
        assert_eq!(std::mem::offset_of!(Launch, creator) + 8, 16);
        assert_eq!(std::mem::offset_of!(Launch, float) + 8, 112);
        assert_eq!(std::mem::offset_of!(Launch, floor_value) + 8, 120);
        assert_eq!(std::mem::offset_of!(Launch, min_bid) + 8, 128);
        assert_eq!(std::mem::offset_of!(Launch, open_ts) + 8, 136);
        assert_eq!(std::mem::offset_of!(Launch, reveal_round) + 8, 160);
        assert_eq!(std::mem::offset_of!(Launch, round_point) + 8, 168);
        assert_eq!(std::mem::offset_of!(Launch, total_deposits) + 8, 264);
        assert_eq!(std::mem::offset_of!(Launch, distributed_count) + 8, 284);
        assert_eq!(std::mem::offset_of!(Launch, largest_deposit) + 8, 288);
        // 0.29: the histogram left the launch (8,192 bytes at 296 until 0.28); every field after it moved up by 8,192.
        assert_eq!(std::mem::offset_of!(Launch, lp_owner) + 8, 296);
        assert_eq!(std::mem::offset_of!(Launch, abort_after_secs) + 8, 328);
        assert_eq!(std::mem::offset_of!(Launch, delivery_fee_bps) + 8, 336);
        assert_eq!(std::mem::offset_of!(Launch, creator_lp_bps) + 8, 338);
        assert_eq!(std::mem::offset_of!(Launch, bond_state) + 8, 340);
        assert_eq!(std::mem::offset_of!(Launch, crank_bond) + 8, 344);
        assert_eq!(std::mem::offset_of!(Launch, mint_salt) + 8, 352);
        assert_eq!(std::mem::offset_of!(Launch, name_len) + 8, 360);
        assert_eq!(std::mem::offset_of!(Launch, symbol_len) + 8, 361);
        assert_eq!(std::mem::offset_of!(Launch, uri_len) + 8, 362);
        assert_eq!(std::mem::offset_of!(Launch, name) + 8, 368);
        assert_eq!(std::mem::offset_of!(Launch, symbol) + 8, 400);
        assert_eq!(std::mem::offset_of!(Launch, uri) + 8, 410);
        assert_eq!(std::mem::offset_of!(Launch, ops_paid) + 8, 616);
        assert_eq!(std::mem::offset_of!(Launch, delivery_terms) + 8, 624);
        assert_eq!(std::mem::offset_of!(Launch, delivery_reward) + 8, 632);
        assert_eq!(std::mem::offset_of!(Launch, raise_fee_bps) + 8, 640);
        assert_eq!(std::mem::offset_of!(Launch, raise_fee_creator_share_bps) + 8, 642);
        assert_eq!(std::mem::offset_of!(Launch, _pad_fee) + 8, 644);
        assert_eq!(std::mem::offset_of!(Launch, attest_required) + 8, 648);
        assert_eq!(std::mem::offset_of!(Launch, processing_charge) + 8, 656);
        assert_eq!(std::mem::offset_of!(Launch, histogram_rent) + 8, 664);
        assert_eq!(std::mem::offset_of!(Launch, attest_waived_ts) + 8, 672);
        assert_eq!(std::mem::offset_of!(Launch, histogram_grown) + 8, 680);
        assert_eq!(std::mem::offset_of!(Launch, metadata_reserve) + 8, 688);
        assert_eq!(std::mem::offset_of!(Launch, mint_finished) + 8, 696);
        // v0.30: the trading gate, the treasury, the margin, the beacon sample and the reserve term, 72 bytes from 704.
        assert_eq!(std::mem::offset_of!(Launch, trading_state) + 8, 704);
        assert_eq!(std::mem::offset_of!(Launch, treasury) + 8, 712);
        assert_eq!(std::mem::offset_of!(Launch, reveal_margin_secs) + 8, 744);
        assert_eq!(std::mem::offset_of!(Launch, beacon_posted_ts) + 8, 752);
        assert_eq!(std::mem::offset_of!(Launch, beacon_lag_secs) + 8, 760);
        assert_eq!(std::mem::offset_of!(Launch, metadata_reserve_lamports) + 8, 768);
        // v0.32: park and collect, 24 bytes from 776.
        assert_eq!(std::mem::offset_of!(Launch, pool_created_ts) + 8, 776);
        assert_eq!(std::mem::offset_of!(Launch, parked_count) + 8, 784);
        assert_eq!(std::mem::offset_of!(Launch, parked_lamports) + 8, 792);
        assert_eq!(std::mem::offset_of!(Launch, _reserved) + 8, 800);
        assert_eq!(std::mem::size_of::<Launch>() + 8, 1376);
    }

    #[test]
    fn zero_copy_histogram_matches_the_published_layout() {
        assert_eq!(8 + size_of::<Histogram>(), Histogram::LEN);
        assert_eq!(Histogram::LEN, 19272);
        assert_eq!(Histogram::INIT_LEN, 10240);
        assert!(Histogram::LEN - Histogram::INIT_LEN <= 10_240, "one realloc must finish the account");
        assert_eq!(std::mem::offset_of!(Histogram, tick_count) + 8, 10);
        assert_eq!(std::mem::offset_of!(Histogram, _pad) + 8, 12);
        assert_eq!(std::mem::offset_of!(Histogram, counts) + 8, 16);
        assert_eq!(std::mem::align_of::<Histogram>(), 8);
    }

    #[test]
    fn borsh_lengths_match_the_crate() {
        assert_eq!(Config::LEN, 632);
        // v0.30: the Config's new fields sit at 300 (margin), 308 (reward), 316 (reserve), 324 (treasury), 356 (pending).
        {
            let c = Config {
                version: 1, bump: 0, emergency_update_pause: 0, _pad1: 0, admin: Pubkey::default(), lp_owner: Pubkey::default(),
                floor_value: 0, min_bid: 0, abort_after_secs: 0, delivery_fee_bps: 0, creator_lp_bps: 0, crank_bond: 0,
                emergency_update_pause_ts: 0, pending_admin: Pubkey::default(), pending_lp_owner: Pubkey::default(),
                raise_fee_bps: 0, raise_fee_creator_share_bps: 0, attestors: [Pubkey::default(); 3], attest_bids: 0,
                _pad_attest: [0; 7], processing_charge: 0, reveal_margin_secs: 0x0403_0201, _pad_margin: [0; 4],
                delivery_reward: 7, metadata_reserve: 9, treasury: Pubkey::new_from_array([0xAA; 32]),
                pending_treasury: Pubkey::new_from_array([0xBB; 32]),
                // The fold-in: 388 mint, 420 pool, 452 crankers, 548 cap, 556 interval, 564 price (u128), 580 last buy, 588 reserved.
                bouncer_mint: Pubkey::new_from_array([0xC1; 32]), bouncer_pool: Pubkey::new_from_array([0xC2; 32]),
                burn_crankers: [Pubkey::new_from_array([0xD1; 32]), Pubkey::new_from_array([0xD2; 32]), Pubkey::new_from_array([0xD3; 32])],
                buy_cap_lamports: 11, buy_min_interval_secs: 13, buy_max_price_x64: 0x0F0E_0D0C_0B0A_0908_0706_0504_0302_0100, last_buy_ts: 17,
                _reserved: [0; 44],
            };
            let mut v = vec![0u8; 8];
            v.extend(anchor_lang::prelude::borsh::to_vec(&c).unwrap());
            assert_eq!(v.len(), Config::LEN);
            assert_eq!(&v[300..304], &[1, 2, 3, 4]);
            assert_eq!(v[308], 7);
            assert_eq!(v[316], 9);
            assert_eq!(&v[324..356], &[0xAA; 32]);
            assert_eq!(&v[356..388], &[0xBB; 32]);
            assert_eq!(&v[388..420], &[0xC1; 32]);
            assert_eq!(&v[420..452], &[0xC2; 32]);
            assert_eq!(&v[452..484], &[0xD1; 32]);
            assert_eq!(&v[516..548], &[0xD3; 32]);
            assert_eq!(v[548], 11);
            assert_eq!(v[556], 13);
            assert_eq!(&v[564..580], &[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
            assert_eq!(v[580], 17);
            assert_eq!(&v[588..632], &[0u8; 44]);
        }
        // v0.30: the record's `opened_ts` at 408, `opened_forced` at 416.
        {
            let s: SettlementRecord = zero(SettlementRecord::LEN);
            let s = SettlementRecord { opened_ts: 0x0807_0605_0403_0201, opened_forced: 1, ..s };
            let mut v = vec![0u8; 8];
            v.extend(anchor_lang::prelude::borsh::to_vec(&s).unwrap());
            assert_eq!(&v[408..416], &[1, 2, 3, 4, 5, 6, 7, 8]);
            assert_eq!(v[416], 1);
        }
        assert_eq!(Bid::LEN, 324);
        assert_eq!(Vault::LEN, 169);
        assert_eq!(SettlementRecord::LEN, 784);
        // Zero valued accounts through Borsh (the 0.18 reserves are wider than what derive(Default) covers);
        // try_from_slice insists on consuming every byte, so LEN and the struct must agree both ways.
        fn zero<T: anchor_lang::prelude::borsh::BorshDeserialize>(len: usize) -> T {
            T::try_from_slice(&vec![0u8; len - 8]).expect("a zero filled account of LEN bytes deserializes")
        }
        let c: Config = zero(Config::LEN);
        assert_eq!(8 + anchor_lang::prelude::borsh::to_vec(&c).unwrap().len(), Config::LEN);
        let v: Vault = zero(Vault::LEN);
        assert_eq!(8 + anchor_lang::prelude::borsh::to_vec(&v).unwrap().len(), Vault::LEN);
        let s: SettlementRecord = zero(SettlementRecord::LEN);
        assert_eq!(8 + anchor_lang::prelude::borsh::to_vec(&s).unwrap().len(), SettlementRecord::LEN);
        let b = Bid {
            version: 1, bump: 0, state: 0, flags: 0, bidder: Pubkey::default(), launch: Pubkey::default(),
            deposit: 0, placed_ts: 0, sealed: [0; 128], commitment: [0; 32], tick: 0, _pad2: [0; 6], processing_charge: 0, parked_tokens: 0, parked_lamports: 0, _reserved: [0; 40],
        };
        assert_eq!(8 + anchor_lang::prelude::borsh::to_vec(&b).unwrap().len(), Bid::LEN);
    }
}
