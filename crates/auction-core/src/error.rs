//! Error type shared by every pure function in this crate.

/// Reasons a pure function refuses to produce a result.
///
/// The program maps these onto Anchor error codes. None of them should be
/// reachable with parameters that passed [`crate::WindowParams::validate`]
/// and [`crate::grid::validate_floor_value`], which is what the tests assert.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Error {
    /// A tick outside 0..=511 was supplied.
    TickOutOfRange,
    /// Floor value is below [`crate::MIN_FLOOR_VALUE`] or above [`crate::MAX_FLOOR_VALUE`].
    FloorValueOutOfRange,
    /// The float is zero.
    ZeroFloat,
    /// A checked arithmetic step overflowed. Unreachable within the validated ranges.
    Overflow,
    /// Window length is outside the allowed bounds.
    InvalidWindow,
    /// Protocol parameters copied from the config are inconsistent with each
    /// other (cap below the floor, cap above the top of the grid, zero minimum
    /// bid, minimum bid above the cap).
    InvalidConfig,
    /// A timestamp is before the beacon genesis.
    BeforeGenesis,
}
