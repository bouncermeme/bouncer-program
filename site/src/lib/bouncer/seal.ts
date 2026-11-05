/*
  Sealing a bid, from INTERFACE.md "Sealed bid format" (unchanged since v0.3;
  the sizes come from SIZES in the pinned contract).

  Plaintext, 16 bytes: tick as u16 little endian, then 14 random bytes.
  Ciphertext, 128 bytes: raw drand IBE (Boneh Franklin with Fujisaki Okamoto)
  over BLS12-381 with quicknet's G1 signatures, laid out U (96, compressed G2)
  || V (16) || W (16). This is the primitive inside tlock without the age
  container. tlock-js ships it as crypto/ibe; encryptOnG2RFC9380 is the
  quicknet variant (scheme bls-unchained-g1-rfc9380). The identity is
  sha256(round as u64 big endian), the same as tlock's hashedRoundNumber.

  The sealed tick must be below TICK_COUNT. The program cannot see it at
  commit (it is sealed): a bid whose plaintext is out of range is found at
  reveal, marked Invalid and refunded in full. The range check here is the
  only guard, and "tick out of range" is this client's message, never the
  program's (checklist S-05).

  Also here: Launch.round_point and the genesis hints. Since INTERFACE v0.14
  the program derives the round's point on chain from the reveal round and
  verifies the four hints the creator sends (InvalidRoundPoint 6004 for any
  other), so a creator cannot store a published round's point. The genesis
  arguments come from the pinned round-point.ts (genesisRoundArgs). The site
  keeps its own independent hash to curve (roundPointFor, via noble) to check
  a launch's stored point before treating it as biddable; that guards launches
  created under older builds and costs nothing, and scripts/check-sealing.ts
  cross checks the two derivations against each other.

  scripts/check-sealing.ts round trips all of it against the live beacon. Only
  a real reveal on devnet proves the sealing opens under the verified
  signature (checklist X-03).

  Import this lazily from the bid flow. It pulls the curve arithmetic in.
*/

import { bls12_381 } from "@noble/curves/bls12-381.js";
import { decryptOnG2, encryptOnG2RFC9380, type Ciphertext } from "tlock-js/crypto/ibe";
import { hashedRoundNumber } from "tlock-js/drand/timelock-encrypter";
import { SIZES, TICK_COUNT } from "@contract/constants";
import { DST, ROUND_HINTS_LEN, roundPointArgs } from "@contract/round-point";
import { BEACON } from "./beacon";

export const SEALED_BID_LEN: number = SIZES.sealedBidLen;
export const PLAINTEXT_LEN = 16;
export const ROUND_POINT_LEN: number = SIZES.g1Compressed;
export const SIGNATURE_LEN: number = SIZES.g1Compressed;
export { ROUND_HINTS_LEN };
/* The quicknet scheme's G1 domain tag, the one the program and the pinned round-point.ts hash the round identity with. */
export const QUICKNET_G1_DST: string = DST;
const U_LEN = 96;
const V_LEN = 16;
const W_LEN = 16;

export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (clean.length % 2 !== 0) throw new Error("odd hex length");
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function bytesToHex(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}

const PUBLIC_KEY = hexToBytes(BEACON.publicKeyHex);

/* True when a tick can be sealed: an integer in 0..TICK_COUNT. The client's guard; the program never sees the tick before reveal. */
export function tickInRange(tick: number): boolean {
  return Number.isInteger(tick) && tick >= 0 && tick < TICK_COUNT;
}

/* tick u16 LE, then 14 random bytes. */
export function encodeTick(tick: number, random?: Uint8Array): Uint8Array {
  if (!tickInRange(tick)) throw new RangeError("tick out of range");
  const m = new Uint8Array(PLAINTEXT_LEN);
  m[0] = tick & 0xff;
  m[1] = (tick >> 8) & 0xff;
  const r = random ?? crypto.getRandomValues(new Uint8Array(PLAINTEXT_LEN - 2));
  if (r.length !== PLAINTEXT_LEN - 2) throw new RangeError("need 14 random bytes");
  m.set(r, 2);
  return m;
}

export function decodeTick(plain: Uint8Array): number {
  if (plain.length !== PLAINTEXT_LEN) throw new Error("plaintext must be 16 bytes");
  return plain[0] | (plain[1] << 8);
}

export function joinSealed(c: Ciphertext): Uint8Array {
  if (c.U.length !== U_LEN || c.V.length !== V_LEN || c.W.length !== W_LEN) {
    throw new Error(`unexpected ciphertext layout ${c.U.length}/${c.V.length}/${c.W.length}`);
  }
  const out = new Uint8Array(SEALED_BID_LEN);
  out.set(c.U, 0);
  out.set(c.V, U_LEN);
  out.set(c.W, U_LEN + V_LEN);
  return out;
}

export function splitSealed(sealed: Uint8Array): Ciphertext {
  if (sealed.length !== SEALED_BID_LEN) throw new Error("sealed bid must be 128 bytes");
  return {
    U: sealed.slice(0, U_LEN),
    V: sealed.slice(U_LEN, U_LEN + V_LEN),
    W: sealed.slice(U_LEN + V_LEN),
  };
}

/* Seal a tick to a quicknet round. Runs on the bidder's device. Two calls never produce the same bytes. */
export async function sealTick(tick: number, round: number | bigint, random?: Uint8Array): Promise<Uint8Array> {
  const id = hashedRoundNumber(Number(round));
  const c = await encryptOnG2RFC9380(PUBLIC_KEY, id, encodeTick(tick, random));
  return joinSealed(c);
}

/*
  Open a sealed bid with the round's 48 byte G1 signature. The program does
  this on chain with the BLS12-381 syscalls; the site only needs it to check
  its own output. Throws on the wrong round or a corrupt ciphertext.
*/
export async function unsealTick(sealed: Uint8Array, signature: Uint8Array): Promise<number> {
  if (signature.length !== SIGNATURE_LEN) throw new Error("quicknet signatures are 48 bytes");
  const plain = await decryptOnG2(signature, splitSealed(sealed));
  return decodeTick(plain);
}

/*
  The two genesis arguments for a reveal round, from the pinned module, in the
  order create_launch takes them: round_point (48 bytes) and round_hints (192
  bytes). The program derives the same point and refuses any other.
*/
export function genesisRoundArgs(round: number | bigint): { roundPoint: Uint8Array; roundHints: Uint8Array } {
  const args = roundPointArgs(round);
  if (args.roundPoint.length !== ROUND_POINT_LEN || args.roundHints.length !== ROUND_HINTS_LEN) throw new Error("The site could not prepare this launch. Nothing was sent; reload the page and try again.");
  return args;
}

/*
  Launch.round_point recomputed independently of the pinned module: hash to
  curve on G1 of sha256(round as u64 big endian), compressed, via noble. Every
  client checks a launch's stored point against this before treating it as
  biddable.
*/
export function roundPointFor(round: number | bigint): Uint8Array {
  const p = bls12_381.G1.hashToCurve(hashedRoundNumber(Number(round)), { DST: QUICKNET_G1_DST });
  return p.toBytes(true);
}

export function roundPointMatches(roundPoint: Uint8Array, round: number | bigint): boolean {
  if (roundPoint.length !== ROUND_POINT_LEN) return false;
  const want = roundPointFor(round);
  let diff = 0;
  for (let i = 0; i < ROUND_POINT_LEN; i++) diff |= roundPoint[i] ^ want[i];
  return diff === 0;
}

/*
  What post_beacon checks before storing a round signature:
  e(signature, G2 generator) == e(round_point, quicknet public key).
  False for another round's signature or a corrupt point.
*/
export function verifyBeaconSignature(signature: Uint8Array, roundPoint: Uint8Array): boolean {
  try {
    const sig = bls12_381.G1.Point.fromBytes(signature);
    const h = bls12_381.G1.Point.fromBytes(roundPoint);
    const pk = bls12_381.G2.Point.fromBytes(PUBLIC_KEY);
    const lhs = bls12_381.pairing(sig, bls12_381.G2.Point.BASE);
    const rhs = bls12_381.pairing(h, pk);
    return bls12_381.fields.Fp12.eql(lhs, rhs);
  } catch {
    return false;
  }
}
