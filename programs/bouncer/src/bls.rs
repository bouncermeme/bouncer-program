//! BLS12-381 syscall wrappers and the drand IBE decryption, written from the
//! kyber `encrypt/ibe` scheme as implemented by the Rust `tlock` crate
//! (version 0.0.10, `src/ibe.rs`), which interoperates with the Go and JS tlock.
//!
//! Everything is in the Zcash big endian layouts the `_BE` curve ids expect:
//! G1 compressed 48, G1 uncompressed 96 (x, y), G2 compressed 96, G2
//! uncompressed 192 (x.c1, x.c0, y.c1, y.c0), scalars 32 bytes big endian.
//!
//! Gt byte order, pinned on devnet 2026-09-24 (Agave 4.3.0) with real
//! transactions from program G3hP6yh7c3uzULCyyA7emg3kG6VveGeuDZZ3h2eq7hFc:
//! the big endian pairing syscall returns the 576 byte Fq12 as c1 then c0,
//! each Fq6 as c2, c1, c0, each Fq2 as c1, c0, each Fq big endian. That is
//! byte for byte the reverse of the arkworks canonical serialization, which is
//! exactly what the tlock crate (`r_gid.into_iter().rev()`) and tlock-js
//! (`fp12ToBytes`) feed to sha256 for H2. So the syscall output is hashed as
//! is, with no reordering. Evidence: e(G1 gen, G2 gen) logged on chain
//! (2JZ3UrMmhM7htj8B6aeUJVc4ojogatPh3PtR27EB9KpoNW5ZsCHhjkD7RGMGw879Q8cX886t8h5V8PLz36gg1SZs)
//! equals reverse(ark) limb for limb, and the identity mapping is the only one
//! of four candidates that opened a tlock-js 0.9.0 ciphertext
//! (pXXzZivRcJP8wwE9yDX6aCbjWete2QQRyJrtzbMp3C7NkeQQr9AqRVfUfx4qWuoiwXWLUHMHyYoTgcbqRpjtTe9)
//! and a tlock 0.0.10 ciphertext
//! (3sLtd7QQUiR7KXTH6ALsq5vGkrbDNYtg6Wr1FWosmxxPnhtEsCr3t9uaZK4jfLNsFpXPus9h9d5LuyTmWGqdQDn9)
//! to their known plaintexts under the round 32471560 signature.

use crate::curve_constants::{FR_ORDER_BE, G2_GENERATOR_UNCOMPRESSED};
use crate::errors::BouncerError;
use anchor_lang::prelude::*;

pub const BLS12_381_BE: u64 = 4 | 0x80;
pub const BLS12_381_G1_BE: u64 = 5 | 0x80;
pub const BLS12_381_G2_BE: u64 = 6 | 0x80;
pub const BLS12_381_LE: u64 = 4;
const ADD: u64 = 0;
const MUL: u64 = 2;

pub const G1_COMPRESSED: usize = 48;
pub const G1_UNCOMPRESSED: usize = 96;
pub const G2_COMPRESSED: usize = 96;
pub const G2_UNCOMPRESSED: usize = 192;
pub const GT_LEN: usize = 576;

#[cfg(target_os = "solana")]
mod sys {
    pub use solana_define_syscall::definitions::{sol_curve_decompress, sol_curve_group_op, sol_curve_pairing_map};
}

#[cfg(not(target_os = "solana"))]
mod sys {
    // Host builds (IDL generation, unit tests) never execute these.
    pub unsafe fn sol_curve_decompress(_c: u64, _p: *const u8, _r: *mut u8) -> u64 { 1 }
    pub unsafe fn sol_curve_group_op(_c: u64, _o: u64, _l: *const u8, _r: *const u8, _out: *mut u8) -> u64 { 1 }
    pub unsafe fn sol_curve_pairing_map(_c: u64, _n: u64, _g1: *const u8, _g2: *const u8, _out: *mut u8) -> u64 { 1 }
}

/// Decompress a G1 point. Fails for anything that is not a valid point in the
/// prime order subgroup.
pub fn g1_decompress(compressed: &[u8; G1_COMPRESSED]) -> Result<[u8; G1_UNCOMPRESSED]> {
    let mut out = [0u8; G1_UNCOMPRESSED];
    let rc = unsafe { sys::sol_curve_decompress(BLS12_381_G1_BE, compressed.as_ptr(), out.as_mut_ptr()) };
    require!(rc == 0, BouncerError::CurveSyscallFailed);
    Ok(out)
}

/// Decompress a G2 point.
pub fn g2_decompress(compressed: &[u8; G2_COMPRESSED]) -> Result<[u8; G2_UNCOMPRESSED]> {
    let mut out = [0u8; G2_UNCOMPRESSED];
    let rc = unsafe { sys::sol_curve_decompress(BLS12_381_G2_BE, compressed.as_ptr(), out.as_mut_ptr()) };
    require!(rc == 0, BouncerError::CurveSyscallFailed);
    Ok(out)
}

/// e(g1, g2) as the syscall returns it (big endian variant).
pub fn pairing(g1: &[u8; G1_UNCOMPRESSED], g2: &[u8; G2_UNCOMPRESSED]) -> Result<[u8; GT_LEN]> {
    let mut out = [0u8; GT_LEN];
    let rc = unsafe { sys::sol_curve_pairing_map(BLS12_381_BE, 1, g1.as_ptr(), g2.as_ptr(), out.as_mut_ptr()) };
    require!(rc == 0, BouncerError::CurveSyscallFailed);
    Ok(out)
}

/// point + point on G1, uncompressed in and out.
pub fn g1_add(a: &[u8; G1_UNCOMPRESSED], b: &[u8; G1_UNCOMPRESSED]) -> Result<[u8; G1_UNCOMPRESSED]> {
    let mut out = [0u8; G1_UNCOMPRESSED];
    let rc = unsafe { sys::sol_curve_group_op(BLS12_381_G1_BE, ADD, a.as_ptr(), b.as_ptr(), out.as_mut_ptr()) };
    require!(rc == 0, BouncerError::CurveSyscallFailed);
    Ok(out)
}

/// scalar * point on G1, uncompressed in and out.
pub fn g1_mul(scalar_be: &[u8; 32], point: &[u8; G1_UNCOMPRESSED]) -> Result<[u8; G1_UNCOMPRESSED]> {
    let mut out = [0u8; G1_UNCOMPRESSED];
    let rc = unsafe { sys::sol_curve_group_op(BLS12_381_G1_BE, MUL, scalar_be.as_ptr(), point.as_ptr(), out.as_mut_ptr()) };
    require!(rc == 0, BouncerError::CurveSyscallFailed);
    Ok(out)
}

/// The identity of a quicknet round on G1, uncompressed: hash_to_curve of the
/// round's message, the sum of the two mapped points with the cofactor cleared.
pub fn round_point(round: u64, hints: &[u8; crate::h2c::HINTS_LEN]) -> Result<[u8; G1_UNCOMPRESSED]> {
    let pts = crate::h2c::map_points(&crate::h2c::round_message(round), hints)
        .ok_or_else(|| error!(BouncerError::InvalidRoundPoint))?;
    let sum = g1_add(&pts[0], &pts[1])?;
    g1_clear_cofactor(&sum)
}

/// h_eff * point on G1 by double and add over the addition syscall. The
/// multiplication syscall checks its point for subgroup membership, and the
/// sum of the two mapped points is on the curve but not in the subgroup until
/// the cofactor is cleared (it was refused, CurveSyscallFailed, on the local
/// validator on 2026-09-24); addition skips that check. h_eff =
/// 0xd201000000010001 has 64 bits with 7 set: 63 doublings, 6 additions.
pub fn g1_clear_cofactor(point: &[u8; G1_UNCOMPRESSED]) -> Result<[u8; G1_UNCOMPRESSED]> {
    const H_EFF: u64 = 0xd201_0000_0001_0001;
    let mut acc = *point;
    for bit in (0..63).rev() {
        acc = g1_add(&acc, &acc)?;
        if (H_EFF >> bit) & 1 == 1 {
            acc = g1_add(&acc, point)?;
        }
    }
    Ok(acc)
}

/// scalar * point on G2, uncompressed in and out.
pub fn g2_mul(scalar_be: &[u8; 32], point: &[u8; G2_UNCOMPRESSED]) -> Result<[u8; G2_UNCOMPRESSED]> {
    let mut out = [0u8; G2_UNCOMPRESSED];
    let rc = unsafe { sys::sol_curve_group_op(BLS12_381_G2_BE, MUL, scalar_be.as_ptr(), point.as_ptr(), out.as_mut_ptr()) };
    require!(rc == 0, BouncerError::CurveSyscallFailed);
    Ok(out)
}

/// Check `e(signature, G2 generator) == e(round_point, quicknet public key)`,
/// which is what makes a 48 byte string the quicknet signature of a round.
pub fn verify_round_signature(
    signature: &[u8; G1_COMPRESSED],
    round_point: &[u8; G1_COMPRESSED],
    public_key_uncompressed: &[u8; G2_UNCOMPRESSED],
) -> Result<bool> {
    let sig = g1_decompress(signature)?;
    let rp = g1_decompress(round_point)?;
    let lhs = pairing(&sig, &G2_GENERATOR_UNCOMPRESSED)?;
    let rhs = pairing(&rp, public_key_uncompressed)?;
    Ok(lhs == rhs)
}

/// The syscall's Gt bytes are already in the layout tlock hashes for H2 (see
/// the module doc for the devnet pin), so this is the identity. It stays a
/// function so the one place the layout matters is named.
#[inline]
pub fn gt_to_tlock_layout(gt: &[u8; GT_LEN]) -> [u8; GT_LEN] {
    *gt
}

/// Result of decrypting one bid.
pub enum Opened {
    /// Ciphertext opened and the plaintext carried a tick under 512.
    Tick(u16),
    /// Did not open under the signature, or the tick was out of range.
    Invalid,
}

/// Decrypt one 128 byte sealed bid under the launch's verified round signature.
///
/// `signature_uncompressed` is the decompressed beacon signature (once per
/// transaction). Follows tlock `decrypt` step by step:
/// 1. sigma = V xor sha256("IBE-H2" || r_gid)[0..16], r_gid = e(sig, U) in tlock layout
/// 2. msg = W xor sha256("IBE-H4" || sigma)[0..16]
/// 3. r = expand(sha256("IBE-H3" || sigma || msg)); valid iff r * G2gen == U
pub fn open_bid(signature_uncompressed: &[u8; G1_UNCOMPRESSED], sealed: &[u8; 128]) -> Result<Opened> {
    let mut u_c = [0u8; G2_COMPRESSED];
    u_c.copy_from_slice(&sealed[0..96]);
    let v = &sealed[96..112];
    let w = &sealed[112..128];

    let u = match g2_decompress_soft(&u_c) {
        Some(u) => u,
        None => return Ok(Opened::Invalid),
    };
    let gt = pairing(signature_uncompressed, &u)?;
    let r_gid = gt_to_tlock_layout(&gt);

    let h2 = sha256(&[b"IBE-H2", &r_gid]);
    let mut sigma = [0u8; 16];
    for i in 0..16 {
        sigma[i] = v[i] ^ h2[i];
    }
    let h4 = sha256(&[b"IBE-H4", &sigma]);
    let mut msg = [0u8; 16];
    for i in 0..16 {
        msg[i] = w[i] ^ h4[i];
    }
    let h3 = sha256(&[b"IBE-H3", &sigma, &msg]);
    let r_be = match expand_h3(&h3) {
        Some(r) => r,
        None => return Ok(Opened::Invalid),
    };
    let u_check = g2_mul(&r_be, &G2_GENERATOR_UNCOMPRESSED)?;
    if u_check != u {
        return Ok(Opened::Invalid);
    }
    let tick = u16::from_le_bytes([msg[0], msg[1]]);
    if tick as usize >= auction_core::TICK_COUNT {
        return Ok(Opened::Invalid);
    }
    Ok(Opened::Tick(tick))
}

/// G2 decompress that reports failure instead of erroring, for ciphertexts
/// whose U is not a valid point: those bids are Invalid, not a transaction error.
fn g2_decompress_soft(compressed: &[u8; G2_COMPRESSED]) -> Option<[u8; G2_UNCOMPRESSED]> {
    let mut out = [0u8; G2_UNCOMPRESSED];
    let rc = unsafe { sys::sol_curve_decompress(BLS12_381_G2_BE, compressed.as_ptr(), out.as_mut_ptr()) };
    if rc == 0 {
        Some(out)
    } else {
        None
    }
}

/// drand's `expand_message` for H3: hash `i (u16 little endian) || h` for
/// i = 1, 2, ..., shift the first byte right by one, and take the first result
/// that is below the scalar field order when read big endian. Returns the
/// scalar big endian, which is what the `_BE` group op expects.
fn expand_h3(h: &[u8; 32]) -> Option<[u8; 32]> {
    for i in 1u16..=u16::MAX {
        let mut c = sha256(&[&i.to_le_bytes(), h]);
        c[0] >>= 1;
        if c.as_slice() < FR_ORDER_BE.as_slice() {
            return Some(c);
        }
    }
    None
}

/// sha256 over the concatenation of `parts`.
pub fn sha256(parts: &[&[u8]]) -> [u8; 32] {
    solana_sha256_hasher::hashv(parts).to_bytes()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn expand_h3_masks_and_bounds_like_tlock() {
        // The first candidate with its top bit cleared is below the order in the
        // overwhelming majority of cases; whatever is returned must be below it.
        let h = sha256(&[b"IBE-H3", &[7u8; 16], &[9u8; 16]]);
        let r = expand_h3(&h).unwrap();
        assert!(r.as_slice() < FR_ORDER_BE.as_slice());
        assert_eq!(r[0] >> 7, 0);
        let mut c = sha256(&[&1u16.to_le_bytes(), &h]);
        c[0] >>= 1;
        if c.as_slice() < FR_ORDER_BE.as_slice() {
            assert_eq!(r, c);
        }
    }

    #[test]
    fn sha256_matches_a_known_vector() {
        let d = sha256(&[b"abc"]);
        assert_eq!(d[0..4], [0xba, 0x78, 0x16, 0xbf]);
    }
}
