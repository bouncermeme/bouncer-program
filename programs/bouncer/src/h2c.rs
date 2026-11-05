//! Hash to curve for drand quicknet rounds on BLS12-381 G1, on chain.
//!
//! RFC 9380 suite BLS12381G1_XMD:SHA-256_SSWU_RO_ with the DST quicknet signs
//! under, exactly as tlock, tlock-js and @noble/curves compute the identity of
//! a round: `hash_to_curve(sha256(round as u64 big endian))`. Until 2026-09-24
//! the program trusted the creator supplied `round_point`, and a creator who
//! stored the point of some other round opened only his own bid (the
//! adversarial pass, finding 4). Now `create_launch` derives the point from
//! `reveal_round` here and refuses a launch whose supplied point differs.
//!
//! The runtime has no hash to curve syscall and no big integer one usable
//! on devnet (the `sol_big_mod_exp` syscall of SIMD-0529 is active only on a
//! fresh test validator), so the field arithmetic is software: 6 limb
//! Montgomery form, about 4,000 compute units a multiplication on Agave
//! 4.3.0. The four exponentiations of the derivation (two square roots, two
//! inversions, some 570 multiplications each) do not fit a transaction, so
//! the caller supplies them as hints, 192 bytes, and the program verifies
//! each with one multiplication: a square root by squaring, an inverse by
//! multiplying. A wrong hint is refused; a hint cannot steer the result
//! (either square root gives the same point after the sign rule). The
//! rest, about 160 multiplications, runs on chain. Only the two group
//! operations at the end (adding the two mapped points, clearing the
//! cofactor) use the curve syscalls, through `bls.rs`. Everything here is
//! host testable; `tests` below check every intermediate against
//! @noble/curves, and `hints_for` (host only) is the reference hint maker.
//!
//! Layout of the work: expand_message_xmd (five sha256) -> two field elements
//! -> simplified SWU onto the isogenous curve E' (one sqrt_ratio each, an
//! exponentiation) -> the 11-isogeny to E (four polynomials, one batched
//! inversion for both points) -> two affine points, x || y big endian.

use crate::h2c_constants::*;

/// A base field element in Montgomery form, six little endian limbs, always
/// fully reduced below p.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct Fp(pub [u64; 6]);

/// The 128 bit product of two limbs as (low, high), from four 32 bit half
/// products. SBPF has no 128 bit multiply; written with u128 this compiled to
/// a library call and a Montgomery multiplication cost 4,775 compute units
/// (measured 2026-09-24 on Agave 4.3.0). This form keeps every operation a
/// native 64 bit one.
#[inline(always)]
fn mul_wide(a: u64, b: u64) -> (u64, u64) {
    let (a0, a1) = (a & 0xffff_ffff, a >> 32);
    let (b0, b1) = (b & 0xffff_ffff, b >> 32);
    // Half products never overflow 64 bits; wrapping ops keep the compiler
    // from emitting an overflow branch and a high half product for each.
    let p00 = a0.wrapping_mul(b0);
    let p01 = a0.wrapping_mul(b1);
    let p10 = a1.wrapping_mul(b0);
    let p11 = a1.wrapping_mul(b1);
    let mid = (p00 >> 32).wrapping_add(p01 & 0xffff_ffff).wrapping_add(p10 & 0xffff_ffff);
    let lo = (p00 & 0xffff_ffff) | (mid << 32);
    let hi = p11.wrapping_add(p01 >> 32).wrapping_add(p10 >> 32).wrapping_add(mid >> 32);
    (lo, hi)
}

/// a + b * c + carry as (low, high); the sum always fits in 128 bits.
#[inline(always)]
fn mac(a: u64, b: u64, c: u64, carry: u64) -> (u64, u64) {
    let (lo, hi) = mul_wide(b, c);
    let (s1, c1) = lo.overflowing_add(a);
    let (s2, c2) = s1.overflowing_add(carry);
    (s2, hi.wrapping_add(c1 as u64).wrapping_add(c2 as u64))
}

#[inline(always)]
fn adc(a: u64, b: u64, carry: u64) -> (u64, u64) {
    let (s1, c1) = a.overflowing_add(b);
    let (s2, c2) = s1.overflowing_add(carry);
    (s2, (c1 as u64).wrapping_add(c2 as u64))
}

#[inline(always)]
fn sbb(a: u64, b: u64, borrow: u64) -> (u64, u64) {
    let (d1, b1) = a.overflowing_sub(b);
    let (d2, b2) = d1.overflowing_sub(borrow);
    (d2, (b1 | b2) as u64)
}

impl Fp {
    pub const ZERO: Fp = Fp([0; 6]);
    pub const ONE: Fp = Fp(ONE);

    /// Subtract p once if the value is at or above it.
    #[inline(always)]
    fn reduce_once(v: [u64; 6]) -> Fp {
        let mut r = [0u64; 6];
        let mut borrow = 0u64;
        for i in 0..6 {
            let (d, b) = sbb(v[i], P[i], borrow);
            r[i] = d;
            borrow = b;
        }
        if borrow == 0 {
            Fp(r)
        } else {
            Fp(v)
        }
    }

    pub fn add(&self, o: &Fp) -> Fp {
        let mut r = [0u64; 6];
        let mut carry = 0u64;
        for i in 0..6 {
            let (s, c) = adc(self.0[i], o.0[i], carry);
            r[i] = s;
            carry = c;
        }
        // p < 2^381, so the sum of two reduced values never overflows 384 bits.
        Fp::reduce_once(r)
    }

    pub fn sub(&self, o: &Fp) -> Fp {
        let mut r = [0u64; 6];
        let mut borrow = 0u64;
        for i in 0..6 {
            let (d, b) = sbb(self.0[i], o.0[i], borrow);
            r[i] = d;
            borrow = b;
        }
        if borrow != 0 {
            let mut carry = 0u64;
            for i in 0..6 {
                let (s, c) = adc(r[i], P[i], carry);
                r[i] = s;
                carry = c;
            }
        }
        Fp(r)
    }

    pub fn neg(&self) -> Fp {
        Fp::ZERO.sub(self)
    }

    pub fn is_zero(&self) -> bool {
        self.0 == [0; 6]
    }

    /// Montgomery reduction of a 12 limb product: t * 2^-384 mod p.
    fn montgomery_reduce(t: [u64; 12]) -> Fp {
        let mut t = t;
        for i in 0..6 {
            let k = t[i].wrapping_mul(INV);
            let (_, mut carry) = mac(t[i], k, P[0], 0);
            for j in 1..6 {
                let (v, c) = mac(t[i + j], k, P[j], carry);
                t[i + j] = v;
                carry = c;
            }
            let mut j = i + 6;
            while j < 12 {
                let (v, c) = adc(t[j], 0, carry);
                t[j] = v;
                carry = c;
                if carry == 0 {
                    break;
                }
                j += 1;
            }
        }
        Fp::reduce_once([t[6], t[7], t[8], t[9], t[10], t[11]])
    }

    /// Product of two Montgomery values (a * b * 2^-384). Also reduces a raw
    /// integer below 2^384 when the other operand is R2 or R3. (Measured on
    /// Agave 4.3.0: about 4,000 compute units; a fully unrolled CIOS form was
    /// slower, 5,500, from register spills.)
    pub fn mul(&self, o: &Fp) -> Fp {
        let a = &self.0;
        let b = &o.0;
        let mut t = [0u64; 12];
        for i in 0..6 {
            let mut carry = 0u64;
            for j in 0..6 {
                let (v, c) = mac(t[i + j], a[i], b[j], carry);
                t[i + j] = v;
                carry = c;
            }
            t[i + 6] = carry;
        }
        Fp::montgomery_reduce(t)
    }

    pub fn square(&self) -> Fp {
        self.mul(self)
    }

    /// self ^ exp, exp as six little endian limbs, square and multiply. Host
    /// only: on chain an exponentiation costs over two million compute
    /// units, which is why the derivation takes hints.
    #[cfg(not(target_os = "solana"))]
    pub fn pow(&self, exp: &[u64; 6]) -> Fp {
        let mut r = Fp::ONE;
        for i in (0..6).rev() {
            for bit in (0..64).rev() {
                r = r.square();
                if (exp[i] >> bit) & 1 == 1 {
                    r = r.mul(self);
                }
            }
        }
        r
    }

    /// Inverse by Fermat; zero maps to zero. Host only (see `pow`).
    #[cfg(not(target_os = "solana"))]
    pub fn invert(&self) -> Fp {
        self.pow(&P_MINUS_2)
    }

    /// Canonical (non Montgomery) limbs.
    fn canonical(&self) -> [u64; 6] {
        let mut t = [0u64; 12];
        t[..6].copy_from_slice(&self.0);
        Fp::montgomery_reduce(t).0
    }

    /// sgn0 of RFC 9380 for a prime field: the parity of the canonical value.
    pub fn sgn0(&self) -> u64 {
        self.canonical()[0] & 1
    }

    /// From 48 big endian bytes; None when not below p.
    pub fn from_be_bytes(b: &[u8; 48]) -> Option<Fp> {
        let mut raw = [0u64; 6];
        for i in 0..6 {
            let mut limb = [0u8; 8];
            limb.copy_from_slice(&b[48 - 8 * (i + 1)..48 - 8 * i]);
            raw[i] = u64::from_be_bytes(limb);
        }
        let mut borrow = 0u64;
        for i in 0..6 {
            let (_, bb) = sbb(raw[i], P[i], borrow);
            borrow = bb;
        }
        if borrow == 0 {
            return None;
        }
        Some(Fp(raw).mul(&Fp(R2)))
    }

    /// 48 big endian bytes of the canonical value.
    pub fn to_be_bytes(&self) -> [u8; 48] {
        let c = self.canonical();
        let mut out = [0u8; 48];
        for i in 0..6 {
            out[48 - 8 * (i + 1)..48 - 8 * i].copy_from_slice(&c[i].to_be_bytes());
        }
        out
    }

    /// A 64 byte big endian integer reduced mod p (OS2IP then mod, as
    /// hash_to_field wants): n = hi * 2^384 + lo, so mont(n) = lo * R2 + hi * R3
    /// through the Montgomery product.
    pub fn from_wide_be(b: &[u8; 64]) -> Fp {
        let mut lo = [0u64; 6];
        for i in 0..6 {
            let mut limb = [0u8; 8];
            limb.copy_from_slice(&b[64 - 8 * (i + 1)..64 - 8 * i]);
            lo[i] = u64::from_be_bytes(limb);
        }
        let mut hi = [0u64; 6];
        for i in 0..2 {
            let mut limb = [0u8; 8];
            limb.copy_from_slice(&b[16 - 8 * (i + 1)..16 - 8 * i]);
            hi[i] = u64::from_be_bytes(limb);
        }
        Fp(lo).mul(&Fp(R2)).add(&Fp(hi).mul(&Fp(R3)))
    }
}

/// sha256 over the concatenation of the parts. The syscall on chain, the
/// software hasher on the host, through solana_sha256_hasher.
fn sha256(parts: &[&[u8]]) -> [u8; 32] {
    solana_sha256_hasher::hashv(parts).to_bytes()
}

/// expand_message_xmd(msg, DST, 128) with SHA-256: four blocks.
pub fn expand_message_xmd_128(msg: &[u8]) -> [u8; 128] {
    let dst_len = [DST.len() as u8];
    let z_pad = [0u8; 64];
    let l_i_b = [0u8, 128u8];
    let b0 = sha256(&[&z_pad, msg, &l_i_b, &[0u8], DST, &dst_len]);
    let mut out = [0u8; 128];
    let mut prev = sha256(&[&b0, &[1u8], DST, &dst_len]);
    out[..32].copy_from_slice(&prev);
    for i in 2..=4u8 {
        let mut x = [0u8; 32];
        for j in 0..32 {
            x[j] = b0[j] ^ prev[j];
        }
        prev = sha256(&[&x, &[i], DST, &dst_len]);
        out[32 * (i as usize - 1)..32 * i as usize].copy_from_slice(&prev);
    }
    out
}

/// hash_to_field(msg, 2): two field elements.
pub fn hash_to_field(msg: &[u8]) -> [Fp; 2] {
    let b = expand_message_xmd_128(msg);
    let mut u0 = [0u8; 64];
    let mut u1 = [0u8; 64];
    u0.copy_from_slice(&b[..64]);
    u1.copy_from_slice(&b[64..]);
    [Fp::from_wide_be(&u0), Fp::from_wide_be(&u1)]
}

/// Length of the hints `map_points` takes: four field elements, 48 bytes
/// big endian each: the sqrt_ratio outputs for u0 and u1, then the inverse
/// of d0 * d1 (the two SSWU x denominators), then the inverse of
/// xd0 * yd0 * xd1 * yd1 (the four isogeny denominators).
pub const HINTS_LEN: usize = 192;

/// sqrt_ratio for p = 3 mod 4 (RFC 9380 F.2.1.2), from a hint: (true, y)
/// when y * y * v == u (u / v is a square), (false, y) when
/// y * y * v == Z * u (it is not, and y is sqrt(Z * u / v)); None otherwise.
/// Exactly one of the two can hold since Z is not a square, and both square
/// roots satisfy the same equation, so the hint cannot choose the outcome.
fn sqrt_ratio_hinted(u: &Fp, v: &Fp, y: &Fp) -> Option<(bool, Fp)> {
    let yyv = y.square().mul(v);
    if yyv == *u {
        Some((true, *y))
    } else if yyv == Fp(SWU_Z).mul(u) {
        Some((false, *y))
    } else {
        None
    }
}

/// The reference sqrt_ratio, by exponentiation (host only: the hint maker).
#[cfg(not(target_os = "solana"))]
fn sqrt_ratio_host(u: &Fp, v: &Fp) -> Fp {
    let tv1 = v.square();
    let tv2 = u.mul(v);
    let tv1 = tv1.mul(&tv2);
    let y1 = tv1.pow(&P_MINUS_3_OVER_4).mul(&tv2);
    let y2 = y1.mul(&Fp(SWU_C2));
    let tv3 = y1.square().mul(v);
    if tv3 == *u {
        y1
    } else {
        y2
    }
}

/// A point on the isogenous curve E', as x = xn / d and y (affine y already
/// divided out is not needed: the isogeny takes affine coordinates, so the
/// caller divides x by d with the batched inversion).
struct SwuPoint {
    xn: Fp,
    d: Fp,
    y: Fp,
}

/// The simplified SWU straight line (RFC 9380 F.2) up to the square root:
/// tv1, tv3, tv4 and the fraction num / den whose root is wanted.
struct SwuPrelude {
    tv1: Fp,
    tv3: Fp,
    tv4: Fp,
    num: Fp,
    den: Fp,
}

fn swu_prelude(u: &Fp) -> SwuPrelude {
    let a = Fp(SWU_A);
    let b = Fp(SWU_B);
    let z = Fp(SWU_Z);
    let tv1 = z.mul(&u.square());
    let tv2 = tv1.square().add(&tv1);
    let tv3 = b.mul(&tv2.add(&Fp::ONE));
    let tv4 = a.mul(&if tv2.is_zero() { z } else { tv2.neg() });
    let tv2 = tv3.square();
    let tv6 = tv4.square();
    let tv5 = a.mul(&tv6);
    let tv2 = tv2.add(&tv5).mul(&tv3);
    let tv6 = tv6.mul(&tv4);
    let tv5 = b.mul(&tv6);
    let tv2 = tv2.add(&tv5);
    SwuPrelude { tv1, tv3, tv4, num: tv2, den: tv6 }
}

/// The rest of the straight line after sqrt_ratio. Returns x as a fraction so
/// the division can be batched with the isogeny's.
fn swu_finish(u: &Fp, pre: &SwuPrelude, is_gx1_square: bool, y1: &Fp) -> SwuPoint {
    let x = pre.tv1.mul(&pre.tv3);
    let y = pre.tv1.mul(u).mul(y1);
    let (x, y) = if is_gx1_square { (pre.tv3, *y1) } else { (x, y) };
    let y = if u.sgn0() == y.sgn0() { y } else { y.neg() };
    SwuPoint { xn: x, d: pre.tv4, y }
}

/// Simplified SWU map onto E' with the square root supplied as a hint.
fn map_to_curve_swu(u: &Fp, hint: &Fp) -> Option<SwuPoint> {
    let pre = swu_prelude(u);
    let (is_gx1_square, y1) = sqrt_ratio_hinted(&pre.num, &pre.den, hint)?;
    Some(swu_finish(u, &pre, is_gx1_square, &y1))
}

/// Simplified SWU map onto E' with the square root computed (host only).
/// Returns the point and the hint a caller must supply for it.
#[cfg(not(target_os = "solana"))]
fn map_to_curve_swu_host(u: &Fp) -> (SwuPoint, Fp) {
    let pre = swu_prelude(u);
    let y1 = sqrt_ratio_host(&pre.num, &pre.den);
    let is_gx1_square = y1.square().mul(&pre.den) == pre.num;
    (swu_finish(u, &pre, is_gx1_square, &y1), y1)
}

/// Horner evaluation of a polynomial with ascending coefficients.
fn poly(coeffs: &[[u64; 6]], x: &Fp) -> Fp {
    let mut acc = Fp(coeffs[coeffs.len() - 1]);
    for c in coeffs[..coeffs.len() - 1].iter().rev() {
        acc = acc.mul(x).add(&Fp(*c));
    }
    acc
}

/// Numerators and denominators of the 11-isogeny at an affine E' point.
struct IsoFractions {
    xn: Fp,
    xd: Fp,
    yn: Fp,
    yd: Fp,
}

fn iso_fractions(x: &Fp, y: &Fp) -> IsoFractions {
    IsoFractions {
        xn: poly(&ISO_X_NUM, x),
        xd: poly(&ISO_X_DEN, x),
        yn: poly(&ISO_Y_NUM, x).mul(y),
        yd: poly(&ISO_Y_DEN, x),
    }
}

/// The inverse of `prod` from a hint: the hint when hint * prod == 1.
fn inverse_hinted(prod: &Fp, hint: &Fp) -> Option<Fp> {
    if hint.mul(prod) == Fp::ONE {
        Some(*hint)
    } else {
        None
    }
}

fn hint_at(hints: &[u8; HINTS_LEN], i: usize) -> Option<Fp> {
    let mut b = [0u8; 48];
    b.copy_from_slice(&hints[48 * i..48 * (i + 1)]);
    Fp::from_be_bytes(&b)
}

/// The two affine points on E (x || y, 96 bytes big endian each) whose sum,
/// with the cofactor cleared, is hash_to_curve(msg). Six divisions in total,
/// done with two hinted inversions. None when a hint is wrong or not a
/// field element.
pub fn map_points(msg: &[u8], hints: &[u8; HINTS_LEN]) -> Option<[[u8; 96]; 2]> {
    let u = hash_to_field(msg);
    let s0 = map_to_curve_swu(&u[0], &hint_at(hints, 0)?)?;
    let s1 = map_to_curve_swu(&u[1], &hint_at(hints, 1)?)?;
    // x on E' = xn / d for each point: batch the two divisions.
    let d01 = s0.d.mul(&s1.d);
    let inv01 = inverse_hinted(&d01, &hint_at(hints, 2)?)?;
    let x0 = s0.xn.mul(&inv01).mul(&s1.d);
    let x1 = s1.xn.mul(&inv01).mul(&s0.d);
    let f0 = iso_fractions(&x0, &s0.y);
    let f1 = iso_fractions(&x1, &s1.y);
    // Four more divisions with one inversion: prod = xd0 * yd0 * xd1 * yd1.
    let a = f0.xd.mul(&f0.yd);
    let b = f1.xd.mul(&f1.yd);
    let inv = inverse_hinted(&a.mul(&b), &hint_at(hints, 3)?)?;
    let inv_a = inv.mul(&b);
    let inv_b = inv.mul(&a);
    let p0 = (f0.xn.mul(&inv_a).mul(&f0.yd), f0.yn.mul(&inv_a).mul(&f0.xd));
    let p1 = (f1.xn.mul(&inv_b).mul(&f1.yd), f1.yn.mul(&inv_b).mul(&f1.xd));
    let mut out = [[0u8; 96]; 2];
    out[0][..48].copy_from_slice(&p0.0.to_be_bytes());
    out[0][48..].copy_from_slice(&p0.1.to_be_bytes());
    out[1][..48].copy_from_slice(&p1.0.to_be_bytes());
    out[1][48..].copy_from_slice(&p1.1.to_be_bytes());
    Some(out)
}

/// The hints `map_points` needs for a message, computed with the software
/// exponentiations: the reference every client helper must match (host only).
#[cfg(not(target_os = "solana"))]
pub fn hints_for(msg: &[u8]) -> [u8; HINTS_LEN] {
    let u = hash_to_field(msg);
    let (s0, y0) = map_to_curve_swu_host(&u[0]);
    let (s1, y1) = map_to_curve_swu_host(&u[1]);
    let inv01 = s0.d.mul(&s1.d).invert();
    let x0 = s0.xn.mul(&inv01).mul(&s1.d);
    let x1 = s1.xn.mul(&inv01).mul(&s0.d);
    let f0 = iso_fractions(&x0, &s0.y);
    let f1 = iso_fractions(&x1, &s1.y);
    let inv = f0.xd.mul(&f0.yd).mul(&f1.xd).mul(&f1.yd).invert();
    let mut out = [0u8; HINTS_LEN];
    for (i, h) in [y0, y1, inv01, inv].iter().enumerate() {
        out[48 * i..48 * (i + 1)].copy_from_slice(&h.to_be_bytes());
    }
    out
}

/// The message quicknet signs for a round: sha256 of the round as a u64 big endian.
pub fn round_message(round: u64) -> [u8; 32] {
    sha256(&[&round.to_be_bytes()])
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hex(s: &str) -> Vec<u8> {
        (0..s.len()).step_by(2).map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap()).collect()
    }
    fn fp(s: &str) -> Fp {
        let v = hex(s);
        let mut b = [0u8; 48];
        b.copy_from_slice(&v);
        Fp::from_be_bytes(&b).unwrap()
    }

#[test]
    fn field_basics() {
        let two = Fp::ONE.add(&Fp::ONE);
        assert_eq!(two.mul(&two.invert()), Fp::ONE);
        assert_eq!(Fp::ONE.neg().add(&Fp::ONE), Fp::ZERO);
        assert_eq!(Fp::ONE.sgn0(), 1);
        assert_eq!(two.sgn0(), 0);
        let z = Fp(SWU_Z);
        assert_eq!(Fp(SWU_C2).square(), z.neg());
        let mut one = [0u8; 48];
        one[47] = 1;
        assert_eq!(Fp::from_be_bytes(&one).unwrap(), Fp::ONE);
        assert_eq!(Fp::ONE.to_be_bytes(), one);
        let mut pb = [0u8; 48];
        for i in 0..6 {
            pb[48 - 8 * (i + 1)..48 - 8 * i].copy_from_slice(&P[i].to_be_bytes());
        }
        assert!(Fp::from_be_bytes(&pb).is_none());
    }

    #[test]
    fn matches_noble_for_real_rounds() {
        // programs/bouncer/tests/h2c_vectors.txt: one line per round from h2c_vectors.js
        // (@noble/curves 1.9, cross checked there against its own hashToCurve).
        let text = include_str!("../tests/h2c_vectors.txt");
        let mut seen = 0;
        for line in text.lines().filter(|l| !l.starts_with('#') && !l.trim().is_empty()) {
            let f: Vec<&str> = line.split_whitespace().collect();
            assert_eq!(f.len(), 15, "vector line shape");
            let round: u64 = f[0].parse().unwrap();
            let msg = round_message(round);
            assert_eq!(msg.to_vec(), hex(f[1]), "round message {round}");
            assert_eq!(expand_message_xmd_128(&msg).to_vec(), hex(f[2]), "expand_message_xmd {round}");
            let u = hash_to_field(&msg);
            assert_eq!(u[0], fp(f[3]), "u0 {round}");
            assert_eq!(u[1], fp(f[4]), "u1 {round}");
            let (s0, _) = map_to_curve_swu_host(&u[0]);
            assert_eq!(s0.xn.mul(&s0.d.invert()), fp(f[5]), "swu x0 {round}");
            assert_eq!(s0.y, fp(f[6]), "swu y0 {round}");
            let (s1, _) = map_to_curve_swu_host(&u[1]);
            assert_eq!(s1.xn.mul(&s1.d.invert()), fp(f[7]), "swu x1 {round}");
            assert_eq!(s1.y, fp(f[8]), "swu y1 {round}");
            let hints = hints_for(&msg);
            let pts = map_points(&msg, &hints).expect("the reference hints verify");
            assert_eq!(pts[0][..48].to_vec(), hex(f[9]), "iso x0 {round}");
            assert_eq!(pts[0][48..].to_vec(), hex(f[10]), "iso y0 {round}");
            assert_eq!(pts[1][..48].to_vec(), hex(f[11]), "iso x1 {round}");
            assert_eq!(pts[1][48..].to_vec(), hex(f[12]), "iso y1 {round}");
            seen += 1;
        }
        assert!(seen >= 5, "vectors present");
    }

    #[test]
    fn hints_are_verified_not_trusted() {
        let msg = round_message(32493094);
        let hints = hints_for(&msg);
        let good = map_points(&msg, &hints).unwrap();
        // Any byte of any hint changed: refused.
        for i in [0usize, 47, 48, 95, 96, 143, 144, 191] {
            let mut bad = hints;
            bad[i] ^= 0x01;
            assert!(map_points(&msg, &bad).is_none(), "hint byte {i} changed must be refused");
        }
        // A hint at or above p is not a field element: refused.
        let mut bad = hints;
        for i in 0..6 {
            bad[48 - 8 * (i + 1)..48 - 8 * i].copy_from_slice(&P[i].to_be_bytes());
        }
        assert!(map_points(&msg, &bad).is_none());
        // The other square root is an equally valid hint and gives the same points.
        for k in 0..2 {
            let mut b = [0u8; 48];
            b.copy_from_slice(&hints[48 * k..48 * (k + 1)]);
            let neg = Fp::from_be_bytes(&b).unwrap().neg().to_be_bytes();
            let mut other = hints;
            other[48 * k..48 * (k + 1)].copy_from_slice(&neg);
            assert_eq!(map_points(&msg, &other).unwrap(), good, "negated sqrt hint {k}");
        }
        // The hints of another round do not verify for this one.
        let other_round = hints_for(&round_message(32493095));
        assert!(map_points(&msg, &other_round).is_none());
    }
}
