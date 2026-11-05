//! Bouncer auction core.
//!
//! Pure functions and plain data. Nothing here touches Solana, Anchor, or any
//! account. The Anchor program calls into this crate; the test harness and the
//! frontend can call the same functions to predict what the program will do.
//!
//! Units used throughout:
//! - lamports: the only quote currency (SOL only, decided 2026-09-24). Always
//!   u64 on the wire, u128 while summing.
//! - token atoms: the mint's smallest unit, six decimals. The float is a fixed
//!   count of token atoms (`supply.rs`): half of a fixed supply.
//! - value: lamports that the whole float is worth at a given tick. Prices are
//!   never stored; a price is always value / float.
//!
//! Anything a person reads states token quantities in whole tokens; atoms stay
//! inside the code.

#![forbid(unsafe_code)]
#![deny(missing_docs)]

pub mod accounts;
pub mod beacon;
pub mod clearing;
pub mod close;
pub mod error;
pub mod grid;
pub mod params;
mod grid_table;
pub mod supply;

pub use clearing::{fill, settle, settle_lamports, Clearing, Fill, Settlement};
pub use close::{close_reason, process_bid, BidOutcome, CloseReason, RejectReason, WindowParams};
pub use error::Error;
pub use grid::{grid_top, tick_for_max_value, value_at_tick, BAND_EDGE_MULTIPLE, FINE_TICKS, MAX_FLOOR_VALUE, MAX_TICK, MIN_FLOOR_VALUE, TICK_COUNT};
pub use params::{ConfigValues, DEVNET, LAMPORTS_PER_SOL, MAINNET_CRANK_SUNK_LAMPORTS, MAX_CRANK_BOND_LAMPORTS, MAX_PROCESSING_CHARGE, MAX_RAISE_FEE_BPS, PRODUCTION};
pub use supply::{whole_tokens, FLOAT, POOL_RESERVE, TOKEN_DECIMALS, TOTAL_SUPPLY, TOTAL_SUPPLY_TOKENS};
