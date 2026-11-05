//! Anchor events, fields as in INTERFACE.md v0.5.

use anchor_lang::prelude::*;

#[event]
pub struct LaunchCreated {
    pub launch: Pubkey,
    pub token_mint: Pubkey,
    pub creator: Pubkey,
    pub float: u64,
    pub floor_value: u64,
    pub min_bid: u64,
    pub open_ts: i64,
    pub window_secs: i64,
    pub reveal_round: u64,
    /// The crank bond the creator posted, lamports (0.16).
    pub crank_bond: u64,
    /// 0.19: the mint's PDA salt and the metadata `create_pool` will write. The mint and its
    /// metadata account do not exist until then; this event and the launch account carry them.
    pub mint_salt: u64,
    pub name: String,
    pub symbol: String,
    pub uri: String,
    /// 0.25: the three terms the event lacked. With `floor_value`, `min_bid` and `crank_bond` above
    /// they are the six the creator signed in `create_launch` (`LaunchTerms`): the event records
    /// what was agreed, not only what happened.
    pub abort_after_secs: u64,
    pub delivery_fee_bps: u16,
    pub creator_lp_bps: u16,
    /// 0.28: the raise fee terms, the seventh and eighth the creator signed: basis points of the cleared raise
    /// taken when the pool opens, and the creator's share of that fee in basis points of the fee.
    pub raise_fee_bps: u16,
    pub raise_fee_creator_share_bps: u16,
    /// 0.29: 1 when every bid on this launch must carry a Bouncer attestation (`Config.attest_bids` at genesis;
    /// `admin_waive_attestation` can clear it later), the processing charge each bid pays (`Config.processing_charge`
    /// at genesis), and the lamports the creator paid for the histogram account, returned when it closes.
    pub attest_required: u8,
    pub processing_charge: u64,
    pub histogram_rent: u64,
    /// v0.30: the treasury the launch recorded, the reveal margin its round was sealed with, and the two operating
    /// values copied from the config at genesis.
    pub treasury: Pubkey,
    pub reveal_margin_secs: u32,
    pub delivery_reward: u64,
    pub metadata_reserve_lamports: u64,
}

#[event]
pub struct BidCommitted {
    pub launch: Pubkey,
    pub bid: Pubkey,
    pub bidder: Pubkey,
    pub creator: bool,
    pub deposit: u64,
    pub total_deposits: u64,
    pub bid_count: u32,
}

#[event]
pub struct LaunchClosed {
    pub launch: Pubkey,
    pub close_ts: i64,
    /// 0 WindowElapsed, 1 CapReached
    pub reason: u8,
    pub total_deposits: u64,
}

#[event]
pub struct LaunchFailed {
    pub launch: Pubkey,
    /// 0 at close, 1 at settle
    pub stage: u8,
    pub total_deposits: u64,
    pub revealed_deposits: u64,
}

#[event]
pub struct BeaconPosted {
    pub launch: Pubkey,
    pub reveal_round: u64,
    /// v0.30 (2026-10-27): the lag sample, record only. `posted_ts` is the chain clock at this instruction;
    /// `lag_secs` is the round's scheduled publish time less it (positive: the chain's clock was at least that far
    /// behind the world's, since the verified signature proves the key existed); `margin_secs` the launch's margin;
    /// `breach` whether the sample reached the margin (the chain was behind by a whole margin or more: the key may
    /// have been public while the book was open). Nothing is refused on it.
    pub posted_ts: i64,
    pub lag_secs: i64,
    pub margin_secs: u32,
    pub breach: bool,
}

#[event]
pub struct BidRevealed {
    pub launch: Pubkey,
    pub bid: Pubkey,
    pub tick: u16,
    pub deposit: u64,
    pub revealed_count: u32,
}

#[event]
pub struct BidInvalid {
    pub launch: Pubkey,
    pub bid: Pubkey,
    pub deposit: u64,
    pub invalid_count: u32,
}

#[event]
pub struct Settled {
    pub launch: Pubkey,
    pub clearing_tick: u16,
    pub marginal_tick: u16,
    pub float_value: u64,
    pub winning_deposits: u64,
    pub above_deposits: u64,
    pub at_deposits: u64,
    pub revealed_bids: u32,
    pub invalid_bids: u32,
    pub creator_deposit: u64,
    pub creator_tokens: u64,
    pub creator_cost: u64,
    pub creator_bid_state: u8,
    /// 0.28: the raise fee agreed here from the launch's own terms, lamports: the creator's part and the
    /// platform's. Paid by `create_pool`, so nothing of it moves if the launch never opens its pool.
    pub raise_fee_creator: u64,
    pub raise_fee_platform: u64,
}

#[event]
pub struct PoolCreated {
    pub launch: Pubkey,
    pub pool: Pubkey,
    pub float_value: u64,
    /// The crank bond paid from the vault to the payer, lamports (0.16).
    pub crank_bond: u64,
    /// Who landed the instruction and received the bond (0.16).
    pub cranker: Pubkey,
    /// The pool's SOL side at open, lamports (0.18): from 0.19 Meteora's rounded
    /// deposit plus any SOL strangers sent to the vault's address before the pool opened.
    pub pool_sol_at_open: u64,
    /// Meteora pool liquidity at open, all of it permanently locked in the platform position (0.19).
    pub liquidity: u128,
    /// Opening price, Q64.64 square root of lamports per token atom, read back from the pool (0.19).
    pub sqrt_price: u128,
    /// Reserve atoms the rounded deposit could not take, burned (0.19).
    pub dust_tokens_burned: u64,
    /// Proceeds lamports the rounded deposit could not take, paid to the cranker (0.19).
    pub dust_lamports: u64,
    /// The platform position's NFT mint, owned by the launch's pool creator PDA (0.19).
    pub platform_nft_mint: Pubkey,
    /// 0.28: the raise fee paid here, lamports, to the creator's wallet and to `Launch.lp_owner`; a part its
    /// destination could not hold rent exempt stayed in the proceeds and is 0 here. `pool_sol_in` is what went
    /// into the wrapped SOL pass through for the pool: `float_value` less the two parts paid.
    pub raise_fee_creator_paid: u64,
    pub raise_fee_platform_paid: u64,
    pub pool_sol_in: u64,
}

/// 0.24: `init_config` ran. `admin` is the program's upgrade authority, read from its ProgramData;
/// `payer` paid the rent and chose nothing. Creation starts paused, with no values and no fee destination.
#[event]
pub struct ConfigInitialized {
    pub admin: Pubkey,
    pub payer: Pubkey,
    pub ts: i64,
}

/// 0.24: `admin_update_config` ran, with every value before and after. `new.lp_owner` is the fee
/// destination in force (unchanged by an update); a different requested destination is `pending_lp_owner`,
/// which takes effect only when it signs `accept_lp_owner` (the default key: none pending).
#[event]
pub struct ConfigUpdated {
    pub admin: Pubkey,
    pub old: crate::ConfigArgs,
    pub new: crate::ConfigArgs,
    pub pending_lp_owner: Pubkey,
    pub ts: i64,
    /// v0.30: the treasury proposed by this update (the default key when none).
    pub pending_treasury: Pubkey,
}

/// v0.30: the proposed treasury accepted; the platform's raise fee part of every launch created from now on goes there.
#[event]
pub struct TreasuryChanged {
    pub old_treasury: Pubkey,
    pub new_treasury: Pubkey,
    pub ts: i64,
}

/// v0.30 (gate X): trading opened on the launch's pool: every bid delivered or refunded, the vault thawed, the mint's
/// freeze authority revoked for good.
#[event]
pub struct TradingOpened {
    pub launch: Pubkey,
    pub pool: Pubkey,
    pub opened_ts: i64,
    pub distributed_count: u32,
    pub bid_count: u32,
}

/// v0.30: the Squad's break-glass opened trading with bids still outstanding (`undelivered` of them).
#[event]
pub struct TradingForcedOpen {
    pub launch: Pubkey,
    pub pool: Pubkey,
    pub opened_ts: i64,
    pub undelivered: u32,
    pub admin: Pubkey,
}

/// v0.30: a `deliver` or `refund` found its bid account already closed (another push, or the bidder's own, landed
/// first) and did nothing. The transaction lands; the other items of a batch are unaffected.
#[event]
pub struct AlreadyDistributed {
    pub launch: Pubkey,
    pub bid: Pubkey,
    pub caller: Pubkey,
}

/// 0.24: the admin proposed a successor. Nothing changes until the proposed key signs `accept_admin`.
#[event]
pub struct AdminProposed {
    pub admin: Pubkey,
    pub proposed: Pubkey,
    pub ts: i64,
}

/// 0.24: the admin withdrew a pending proposal.
#[event]
pub struct AdminProposalCancelled {
    pub admin: Pubkey,
    pub cancelled: Pubkey,
    pub ts: i64,
}

/// 0.24: the proposed fee destination accepted by signing; it is now `lp_owner`.
#[event]
pub struct LpOwnerChanged {
    pub old_lp_owner: Pubkey,
    pub new_lp_owner: Pubkey,
    pub ts: i64,
}

/// 0.24: the proposed admin accepted; it is now the admin.
#[event]
pub struct AdminChanged {
    pub old_admin: Pubkey,
    pub new_admin: Pubkey,
    pub ts: i64,
}

#[event]
pub struct EmergencyUpdatePauseSet {
    /// 1 switched on, 0 switched off (0.18).
    pub on: bool,
    pub admin: Pubkey,
    pub ts: i64,
}

/// The platform position's fees, claimed from Meteora by the launch's pool
/// creator PDA and paid to the config's LP owner (0.19). `lamports` arrive as
/// wrapped SOL in the LP owner's associated token account; `token_atoms` is
/// the launch token side, zero under OnlyB, kept in the PDA's token account.
#[event]
pub struct PlatformFeesCollected {
    pub launch: Pubkey,
    pub pool: Pubkey,
    pub lp_owner: Pubkey,
    pub lamports: u64,
    pub token_atoms: u64,
}

#[event]
pub struct Delivered {
    pub launch: Pubkey,
    pub bid: Pubkey,
    pub bidder: Pubkey,
    pub tokens: u64,
    pub cost: u64,
    pub refund: u64,
    /// Tokens out of `tokens` that went to the pusher as the delivery fee. 0 on a claim.
    pub fee_tokens: u64,
}

#[event]
pub struct Refunded {
    pub launch: Pubkey,
    pub bid: Pubkey,
    pub bidder: Pubkey,
    pub amount: u64,
}

/// 0.23: `lock_liquidity`, the last operating step of a cleared launch, returned the unused operating
/// prepay to the creator. `held` stays in the vault for `burn_unsold`'s caller.
#[event]
pub struct PrepayReturned {
    pub launch: Pubkey,
    pub creator: Pubkey,
    pub amount: u64,
    /// What stays in the vault: `burn_unsold`'s allowance, plus (0.29 tenth candidate) `metadata_reserve`.
    pub held: u64,
    /// 0.29 tenth candidate (review finding N3): the part of `held` kept for `finish_mint`, 0 when the metadata was
    /// already written. Trailing.
    pub metadata_reserve: u64,
}

/// 0.29 twelfth candidate (review finding F2): `release_pool_cash` closed the wrapped SOL pass through and returned the pool
/// creator PDA's loan to the pool payer (`wsol_closed`, `loan_returned`, and `loan_repaid` from the prepay for the part
/// Meteora kept), ahead of the creator's split; the prepay's return, when it happened here, is its own
/// `PrepayReturned`.
#[event]
pub struct PoolCashReleased {
    pub launch: Pubkey,
    pub pool_payer: Pubkey,
    pub wsol_closed: u64,
    pub loan_returned: u64,
    pub loan_repaid: u64,
}

#[event]
pub struct Finalized {
    pub launch: Pubkey,
    pub burned_tokens: u64,
    pub largest_fill_tokens: u64,
    pub dust_lamports: u64,
    /// The crank bond returned to the creator, lamports: the bond after a failure or an abort, 0 after a clear (0.16).
    pub crank_bond_returned: u64,
    /// The opening's leftover reserve atoms burned here (0.21; burned by `create_pool` until 0.20).
    pub dust_tokens_burned: u64,
}

#[event]
pub struct Aborted {
    pub launch: Pubkey,
    pub slot: u64,
}

/// 0.29: the launch's histogram was grown to its full size by `grow_histogram` (the second instruction of the create
/// flow); `histogram_rent` is the account's lamports now, the launch cost the creator paid for the auction's permanent
/// receipt (`Launch.histogram_rent`).
#[event]
pub struct HistogramGrown {
    pub launch: Pubkey,
    pub histogram_rent: u64,
}

/// 0.29: the admin waived the bid attestation on one launch (`Launch.attest_required` 1 to 0, one direction only).
#[event]
pub struct AttestationWaived {
    pub launch: Pubkey,
    pub admin: Pubkey,
    pub ts: i64,
}

#[event]
pub struct LiquidityLocked {
    pub launch: Pubkey,
    pub pool: Pubkey,
    /// 0 the creator's position, 1 the platform's.
    pub which: u8,
    pub nft_owner: Pubkey,
    /// The position NFT's mint; the default key when the side's share was zero and nothing was locked.
    pub nft_mint: Pubkey,
    /// Meteora liquidity permanently locked in this position (0.19; LP tokens until 0.18).
    pub liquidity: u128,
}

/// 2026-10-21: `finish_mint` wrote the launch token's metadata and revoked its mint authority (out of
/// `create_pool` since the eighth 0.29 candidate), and repaid its payer `repaid` lamports from the prepay.
#[event]
pub struct MintFinished {
    pub launch: Pubkey,
    pub mint: Pubkey,
    pub metadata: Pubkey,
    pub payer: Pubkey,
    /// From the prepay while it is open, else from `Launch.metadata_reserve` (0.29 tenth candidate), capped by it.
    pub repaid: u64,
    /// 0.29 tenth candidate (review finding N3): what was left of the reserve after the payer, paid to the creator. Trailing.
    pub reserve_returned: u64,
}

/// 0.26: a pushed delivery on a launch with bid rent terms repaid its caller out of the delivered
/// bid's own account. `rent` is what the caller had just paid into the bidder's token account: its
/// whole rent when the account did not exist, less when someone had already sent it lamports, zero
/// when it existed. `reward` is `Launch.delivery_reward`, or less when the bidder's wallet needed the
/// difference to stay rent exempt. The rest of the bid account went to the bidder. Emitted after that
/// delivery's `Delivered`; never on a claim, and never on a launch created before 0.26.
#[event]
pub struct DeliveryRepaid {
    pub launch: Pubkey,
    pub bid: Pubkey,
    pub caller: Pubkey,
    pub rent: u64,
    pub reward: u64,
}

/// v0.30 (2026-10-27, the buy-and-burn folded into the core): what `collect_platform_fees` did with the fee
/// vault's wrapped SOL account after the claim: `held` (the claim and anything already there) split into the
/// treasury's native SOL (`treasury_lamports`) and the burn vault's wrapped SOL (`burn_lamports`), exact.
#[event]
pub struct PlatformFeesSplit {
    pub launch: Pubkey,
    pub pool: Pubkey,
    pub claimed: u64,
    pub held: u64,
    pub treasury: Pubkey,
    pub treasury_lamports: u64,
    pub burn_lamports: u64,
}

/// v0.30: one `buy_and_burn`: `lamports` of wrapped SOL swapped on the canonical pool, `atoms` of BOUNCER burned
/// (everything the burn vault's token account held after the swap), under the minimum output and the price limit.
#[event]
pub struct BoughtAndBurned {
    pub cranker: Pubkey,
    pub lamports: u64,
    pub atoms: u64,
    pub min_out: u64,
    pub max_price_x64: u128,
    pub ts: i64,
}

/// v0.30: the buy-and-burn's terms as `admin_set_buyback` wrote them.
#[event]
pub struct BuybackConfigured {
    pub admin: Pubkey,
    pub bouncer_mint: Pubkey,
    pub bouncer_pool: Pubkey,
    pub burn_crankers: [Pubkey; 3],
    pub buy_cap_lamports: u64,
    pub buy_min_interval_secs: u64,
    pub buy_max_price_x64: u128,
    pub ts: i64,
}

/// v0.30: the fee vault and the burn vault's wrapped SOL account created (`init_platform_vaults`).
#[event]
pub struct PlatformVaultsInitialized {
    pub payer: Pubkey,
    pub fee_vault: Pubkey,
    pub burn_vault: Pubkey,
    pub burn_vault_wsol: Pubkey,
}

/// v0.32: a payout that could not land was parked (`park_bid`). `reason`: 1 the bidder's token account is unusable,
/// 2 the bid's account cannot repay the delivery's rent, 4 the catch-all (`PARK_AFTER_SECS`). `tokens` stay in the
/// launch's token vault and `lamports` in the vault until the bidder collects or anyone pushes them; `reward` is what
/// the caller was paid out of the bid's own account.
#[event]
pub struct BidParked {
    pub launch: Pubkey,
    pub bid: Pubkey,
    pub bidder: Pubkey,
    pub caller: Pubkey,
    pub tokens: u64,
    pub lamports: u64,
    pub reason: u8,
    pub reward: u64,
}

/// v0.32: the bidder collected a parked payout to destinations it named (`collect_parked`).
#[event]
pub struct ParkedCollected {
    pub launch: Pubkey,
    pub bid: Pubkey,
    pub bidder: Pubkey,
    pub token_destination: Pubkey,
    pub destination: Pubkey,
    pub tokens: u64,
    pub lamports: u64,
}

/// v0.32: a parked payout pushed to the bidder's own token account and wallet (`push_parked`); `rent` is the token
/// account rent the caller fronted and was repaid out of the bid's own account.
#[event]
pub struct ParkedPushed {
    pub launch: Pubkey,
    pub bid: Pubkey,
    pub bidder: Pubkey,
    pub caller: Pubkey,
    pub tokens: u64,
    pub lamports: u64,
    pub rent: u64,
}
