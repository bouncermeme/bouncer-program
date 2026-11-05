//! Error codes, named as in INTERFACE.md.

use anchor_lang::prelude::*;

#[error_code]
pub enum BouncerError {
    #[msg("the emergency update pause is on: no new launch can be created until the program update lands; launches already running are unaffected")]
    EmergencyUpdatePaused,
    #[msg("floor value outside the allowed range")]
    FloorValueOutOfRange,
    #[msg("config parameters are inconsistent (cap below floor, cap above the grid top, bad minimum bid)")]
    InvalidConfig,
    #[msg("window length must be between 300 and 3600 seconds")]
    InvalidWindow,
    #[msg("round point is not a valid G1 point")]
    InvalidRoundPoint,
    #[msg("launch is not open")]
    LaunchNotOpen,
    #[msg("bidding has not opened yet")]
    NotOpenYet,
    #[msg("deposit is below the minimum bid")]
    BelowMinimum,
    #[msg("retired 2026-09-24: deposits past the raise cap are accepted; the cap bounds proceeds at settle")]
    ExceedsRaiseCap,
    #[msg("this wallet already has a bid on this launch")]
    AlreadyBid,
    #[msg("launch is not closeable yet")]
    NotCloseable,
    #[msg("window is still open")]
    WindowStillOpen,
    #[msg("beacon signature already posted")]
    AlreadyPosted,
    #[msg("beacon signature does not verify for this launch's round")]
    SignatureInvalid,
    #[msg("launch failed: deposits did not cover the floor")]
    LaunchFailed,
    #[msg("beacon signature not posted yet")]
    BeaconNotPosted,
    #[msg("bid already revealed")]
    AlreadyRevealed,
    #[msg("not every bid has been revealed or marked invalid")]
    BidsNotAllRevealed,
    #[msg("launch is not closed")]
    LaunchNotClosed,
    #[msg("launch is not settled")]
    NotSettled,
    #[msg("pool is not live")]
    NotPoolLive,
    #[msg("bid is not refundable in this state")]
    NotRefundable,
    #[msg("bid already delivered or refunded")]
    AlreadyDone,
    #[msg("bid is not a winner")]
    NotAWinner,
    #[msg("bid is a winner; use deliver")]
    IsAWinner,
    #[msg("bidder asked to claim; push delivery refused")]
    ClaimOnly,
    #[msg("not every bid has been delivered or refunded")]
    NotAllDistributed,
    #[msg("too early to abort")]
    TooEarlyToAbort,
    #[msg("pool is already live; abort refused")]
    PoolAlreadyLive,
    #[msg("arithmetic overflow")]
    Overflow,
    #[msg("bid account does not belong to this launch")]
    WrongLaunch,
    #[msg("a BLS12-381 syscall failed")]
    CurveSyscallFailed,
    #[msg("name, symbol or uri too long")]
    MetadataTooLong,
    #[msg("unauthorized")]
    Unauthorized,
    #[msg("retired 0.19 (Raydium): the pool config refused new pools")]
    PoolConfigDisabled,
    #[msg("pool creation did not take the amounts computed from the proceeds and the reserve")]
    PoolAmountsMismatch,
    #[msg("retired 0.19 (Raydium): no LP tokens were received from the pool")]
    LpNotReceived,
    #[msg("reveal round is before the window end plus margin, or more than 20 rounds after it")]
    RevealRoundOutOfRange,
    #[msg("launch is already aborted or failed")]
    NotAbortable,
    #[msg("the creator placed a bid; settle needs the creator Bid account")]
    CreatorBidMissing,
    #[msg("the pool is not the one recorded at pool creation")]
    WrongPool,
    #[msg("retired 0.19 (Raydium): the lock NFT owner did not match its side")]
    WrongLockOwner,
    #[msg("that side of the LP is already locked")]
    LpAlreadyLocked,
    #[msg("both LP positions must be locked before the launch can finalize")]
    LpNotLocked,
    #[msg("retired 0.19 (Raydium): lock side must be 0 or 1")]
    InvalidLockSide,
    #[msg("the settlement record must be passed once the launch has one: to abort a settled launch, and since 0.17 to refund or claim any of its bids")]
    SettlementRequired,
    #[msg("retired 0.19 (Raydium): no creator fee had accrued to the pool")]
    NothingToSweep,
    #[msg("the pool or position is not the one this launch created (its creator or NFT owner is not the launch pool creator PDA)")]
    WrongPoolCreator,
    #[msg("platform fees are paid to the config LP owner WSOL associated token account only")]
    WrongFeeOwner,
    #[msg("retired 0.19 (Raydium): create_pool accepted AmmConfig index 0 only")]
    WrongAmmConfig,
    #[msg("burn_unsold must be given the launch's creator, who receives the crank bond back")]
    WrongCreator,
    #[msg("create_pool accepts Meteora config AeLtDKgw only, and only while it is public, 1 percent flat with no dynamic fee, OnlyB, static, timestamp activated and full range")]
    WrongMeteoraConfig,
    #[msg("the proceeds and the reserve give an opening price outside Meteora bounds")]
    OpeningPriceOutOfRange,
    #[msg("the pool Meteora created does not read back as asked: mints, vaults, range, price, liquidity, fee mode or creator")]
    PoolReadbackMismatch,
    #[msg("a Meteora position does not read back as expected after the lock or split")]
    PositionReadbackMismatch,
    #[msg("the platform position must be locked (create_pool) before the creator side")]
    PlatformNotLocked,
    #[msg("the token mint and token vault must be passed once the pool exists; they do not exist before create_pool (0.19)")]
    TokenAccountsRequired,
    #[msg("lock_liquidity must be given the create_pool payer recorded in the settlement, who gets the unused rent loan back (0.20)")]
    WrongPoolPayer,
    #[msg("the platform position must never be delegated: its NFT account has an SPL delegate or the position has delegate permissions (0.20)")]
    PlatformPositionDelegated,
    #[msg("the creator's split has not run: lock_liquidity records it, and the platform's fees cannot be collected before it (0.21)")]
    SplitNotDone,
    #[msg("the launch's recovery deadline (scheduled close plus the recovery delay) has passed: it can no longer progress, and every deposit is recoverable (0.22)")]
    RecoveryDeadlinePassed,
    #[msg("the reveal round leaves less than MIN_PROCESSING_SECS between its publication and the recovery deadline (0.22)")]
    ScheduleTooTight,
    #[msg("the program has no upgrade authority: init_config derives the admin from it and cannot run on an immutable program (0.24)")]
    NoUpgradeAuthority,
    #[msg("accept_lp_owner must be signed by the proposed fee destination, and one must have been proposed (0.24)")]
    NotProposedLpOwner,
    #[msg("accept_admin must be signed by the proposed admin, and an admin must have been proposed (0.24)")]
    NotProposedAdmin,
    #[msg("the config is not complete: its values and an accepted fee destination must be set before creation can start (0.24)")]
    ConfigIncomplete,
    #[msg("the terms stated in create_launch are not the config's: the config changed after the creator signed; read it again and sign again (0.25)")]
    TermsChanged,
    #[msg("the processing charge is above the maximum the bidder stated in commit (0.25)")]
    ProcessingChargeAboveMaximum,
    #[msg("the delivery fee must be 0: a pushed delivery is repaid from the bid account's rent and takes no tokens; set the config's delivery_fee_bps to 0 (0.26)")]
    TokenFeeRetired,
    #[msg("the bid account's rent does not cover the token account rent the caller paid and leave the bidder's wallet rent exempt; nothing was taken, and the bidder can claim (0.26)")]
    BidRentTooSmall,
    #[msg("the raise fee is above its bound: at most MAX_RAISE_FEE_BPS of the cleared raise, and the creator's share at most 10,000 of the fee (0.28)")]
    RaiseFeeTooHigh,
    #[msg("the launch's histogram is not at its full size yet: grow_histogram must land before any bid (0.29)")]
    HistogramNotReady,
    #[msg("the launch's histogram is already at its full size (0.29: grow_histogram lands once)")]
    HistogramAlreadyGrown,
    #[msg("the attestation is signed by a key that is not one of the config's attestors (0.29)")]
    AttestorUnknown,
    #[msg("the attestation's message is not this program, this launch and this bidder under the bid attestation tag (0.29)")]
    AttestationMismatch,
    #[msg("the attestation has expired (0.29)")]
    AttestationExpired,
    #[msg("the attestation's expiry is further ahead than ATTEST_MAX_LIFE_SECS allows (0.29)")]
    AttestationTooLong,
    #[msg("this launch requires a bid attestation: the instruction before commit must be the Ed25519 program verifying one signature, key, signature and 125-byte message in its own data (0.29)")]
    AttestationMissing,
    #[msg("the launch account is not this build's layout: a launch created under 0.28 or earlier is stranded by the 0.29 layout change (INTERFACE.md, the layout rule)")]
    LaunchLayoutUnknown,
    #[msg("the attestation is already waived on this launch, or was never required (0.29: the waiver is one way and lands once)")]
    AttestationAlreadyWaived,
    #[msg("finish_mint already landed on this launch: the mint authority is revoked (2026-10-21)")]
    MintAlreadyFinished,
    #[msg("release_pool_cash already ran on this launch (0.29 twelfth candidate)")]
    CashAlreadyReleased,
    #[msg("release_pool_cash waits POOL_CASH_RELEASE_SECS after settlement for the creator's split (0.29 twelfth candidate)")]
    ReleaseTooEarly,
    #[msg("self-claim is removed (v0.30): the claim flag (bit 0) is refused; every winner is pushed")]
    ClaimRemoved,
    #[msg("this launch's pool has no trading gate: it was created under 0.29 or earlier, or it does not exist yet (v0.30)")]
    TradingGateNone,
    #[msg("trading cannot open yet: a bid is still undelivered or unrefunded (v0.30)")]
    TradingNotOpenable,
    #[msg("trading is already open on this launch (v0.30)")]
    TradingAlreadyOpen,
    #[msg("trading has not opened on this launch: open_trading must land before finalize (v0.30)")]
    TradingNotOpen,
    #[msg("the pool's launch token vault is not frozen (v0.30)")]
    VaultNotFrozen,
    #[msg("the signer is not the proposed treasury (v0.30)")]
    NotProposedTreasury,
    #[msg("the treasury account is not the one this launch recorded at genesis (v0.30)")]
    WrongTreasury,
    #[msg("the reveal margin is outside its hard bounds, 60 to 300 seconds (v0.30)")]
    RevealMarginOutOfRange,
    #[msg("the creator LP share and the raise fee are program constants since v0.30 (2,188 bps of the LP; 100 bps of the raise, 5,000 bps of it to the creator)")]
    TermsPinned,
    #[msg("the delivery reward or the metadata reserve is outside its bounds (v0.30)")]
    OperatingValueOutOfRange,
    #[msg("the bid account is neither an open bid of this launch for this bidder nor a closed one (v0.30)")]
    NotABid,
    #[msg("the buy-and-burn's BOUNCER mint and pool are not set yet; the burn vault accumulates (v0.30)")]
    BuybackPoolNotSet,
    #[msg("the signer is not one of the burn crankers the config lists (v0.30)")]
    NotABurnCranker,
    #[msg("too soon after the last buy-and-burn: Config.buy_min_interval_secs has not passed (v0.30)")]
    BuybackTooSoon,
    #[msg("the burn vault holds nothing to buy with (v0.30)")]
    NothingToBuy,
    #[msg("the buy-and-burn's cap or price limit is unset, or the limit leaves no minimum output (v0.30)")]
    BuybackLimitUnset,
    #[msg("the account is not the burn vault, or not its token account for this mint (v0.30)")]
    WrongBurnVault,
    #[msg("a fee-vault launch's collect needs the config, the burn vault's wrapped SOL account and the treasury as remaining accounts, writable (v0.30)")]
    SplitAccountsMissing,
    #[msg("the pool is not the configured BOUNCER pool with the mint as token A and wrapped SOL as token B (v0.30)")]
    WrongBuybackPool,
    #[msg("the close is under 240 s away at landing: rebuild with a later close (v0.31)")]
    CloseTooSoon,
    #[msg("this payout can still land: a bid is parked only when its token account is unusable, its account cannot repay the delivery, or 600 s after the pool, or after the close of a failed or aborted launch (v0.32)")]
    NotParkable,
    #[msg("the bid is not parked (v0.32)")]
    NotParked,
    #[msg("the account is not the bidder's associated token account for this launch's mint (v0.32)")]
    WrongBidderToken,
}
