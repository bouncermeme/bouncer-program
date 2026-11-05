// The reveal round's identity on G1 and the hints `create_launch` takes, computed the way the
// program derives them (programs/bouncer/src/h2c.rs). Hand written, no dependencies: bigint
// arithmetic and a sha256 of its own, so it imports the same from the test harness (NodeNext,
// `../../idl/round-point.ts`) and from the site (`../../../../idl/round-point`) without either
// lane's node_modules being visible from this directory.
//
// RFC 9380 BLS12381G1_XMD:SHA-256_SSWU_RO_ with the domain tag drand quicknet signs under. The
// program cannot afford the four exponentiations of the derivation (two square roots, two
// inversions) in one transaction, so the client sends them as hints and the program verifies
// each with one multiplication; a wrong hint is refused (InvalidRoundPoint) and cannot steer the
// result. `roundPointArgs(round)` gives both arguments in the order `create_launch` takes them.
//
// Checked against @noble/curves' hashToCurve and against the program's host code
// (`cargo run -p bouncer --example round_hints`) for several rounds; see STATUS-program.md.

export const ROUND_HINTS_LEN = 192;
export const ROUND_POINT_LEN = 48;
export const DST = "BLS_SIG_BLS12381G1_XMD:SHA-256_SSWU_RO_NUL_";

const P = BigInt("0x1a0111ea397fe69a4b1ba7b6434bacd764774b84f38512bf6730d2a0f6b0f6241eabfffeb153ffffb9feffffffffaaab");
const SWU_A = BigInt("0x144698a3b8e9433d693a02c96d4982b0ea985383ee66a8d8e8981aefd881ac98936f8da0e0f97f5cf428082d584c1d");
const SWU_B = BigInt("0x12e2908d11688030018b12e8753eee3b2016c1f0f24f4070a0b9c14fcef35ef55a23215a316ceaa5d1cc48e98e172be0");
const SWU_Z = 11n;
const H_EFF = BigInt("0xd201000000010001");
const P_MINUS_3_OVER_4 = (P - 3n) / 4n;
const P_PLUS_1_OVER_4 = (P + 1n) / 4n;
const P_MINUS_2 = P - 2n;

// The 11-isogeny E' -> E, coefficients in ascending degree (RFC 9380 section 8.8.1, as
// @noble/curves carries them and as programs/bouncer/src/h2c_constants.rs holds them).
const ISO = {
  xNum: [
    "0x11a05f2b1e833340b809101dd99815856b303e88a2d7005ff2627b56cdb4e2c85610c2d5f2e62d6eaeac1662734649b7",
    "0x17294ed3e943ab2f0588bab22147a81c7c17e75b2f6a8417f565e33c70d1e86b4838f2a6f318c356e834eef1b3cb83bb",
    "0xd54005db97678ec1d1048c5d10a9a1bce032473295983e56878e501ec68e25c958c3e3d2a09729fe0179f9dac9edcb0",
    "0x1778e7166fcc6db74e0609d307e55412d7f5e4656a8dbf25f1b33289f1b330835336e25ce3107193c5b388641d9b6861",
    "0xe99726a3199f4436642b4b3e4118e5499db995a1257fb3f086eeb65982fac18985a286f301e77c451154ce9ac8895d9",
    "0x1630c3250d7313ff01d1201bf7a74ab5db3cb17dd952799b9ed3ab9097e68f90a0870d2dcae73d19cd13c1c66f652983",
    "0xd6ed6553fe44d296a3726c38ae652bfb11586264f0f8ce19008e218f9c86b2a8da25128c1052ecaddd7f225a139ed84",
    "0x17b81e7701abdbe2e8743884d1117e53356de5ab275b4db1a682c62ef0f2753339b7c8f8c8f475af9ccb5618e3f0c88e",
    "0x80d3cf1f9a78fc47b90b33563be990dc43b756ce79f5574a2c596c928c5d1de4fa295f296b74e956d71986a8497e317",
    "0x169b1f8e1bcfa7c42e0c37515d138f22dd2ecb803a0c5c99676314baf4bb1b7fa3190b2edc0327797f241067be390c9e",
    "0x10321da079ce07e272d8ec09d2565b0dfa7dccdde6787f96d50af36003b14866f69b771f8c285decca67df3f1605fb7b",
    "0x6e08c248e260e70bd1e962381edee3d31d79d7e22c837bc23c0bf1bc24c6b68c24b1b80b64d391fa9c8ba2e8ba2d229"
  ],
  xDen: [
    "0x8ca8d548cff19ae18b2e62f4bd3fa6f01d5ef4ba35b48ba9c9588617fc8ac62b558d681be343df8993cf9fa40d21b1c",
    "0x12561a5deb559c4348b4711298e536367041e8ca0cf0800c0126c2588c48bf5713daa8846cb026e9e5c8276ec82b3bff",
    "0xb2962fe57a3225e8137e629bff2991f6f89416f5a718cd1fca64e00b11aceacd6a3d0967c94fedcfcc239ba5cb83e19",
    "0x3425581a58ae2fec83aafef7c40eb545b08243f16b1655154cca8abc28d6fd04976d5243eecf5c4130de8938dc62cd8",
    "0x13a8e162022914a80a6f1d5f43e7a07dffdfc759a12062bb8d6b44e833b306da9bd29ba81f35781d539d395b3532a21e",
    "0xe7355f8e4e667b955390f7f0506c6e9395735e9ce9cad4d0a43bcef24b8982f7400d24bc4228f11c02df9a29f6304a5",
    "0x772caacf16936190f3e0c63e0596721570f5799af53a1894e2e073062aede9cea73b3538f0de06cec2574496ee84a3a",
    "0x14a7ac2a9d64a8b230b3f5b074cf01996e7f63c21bca68a81996e1cdf9822c580fa5b9489d11e2d311f7d99bbdcc5a5e",
    "0xa10ecf6ada54f825e920b3dafc7a3cce07f8d1d7161366b74100da67f39883503826692abba43704776ec3a79a1d641",
    "0x95fc13ab9e92ad4476d6e3eb3a56680f682b4ee96f7d03776df533978f31c1593174e4b4b7865002d6384d168ecdd0a",
    "0x000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000001"
  ],
  yNum: [
    "0x90d97c81ba24ee0259d1f094980dcfa11ad138e48a869522b52af6c956543d3cd0c7aee9b3ba3c2be9845719707bb33",
    "0x134996a104ee5811d51036d776fb46831223e96c254f383d0f906343eb67ad34d6c56711962fa8bfe097e75a2e41c696",
    "0xcc786baa966e66f4a384c86a3b49942552e2d658a31ce2c344be4b91400da7d26d521628b00523b8dfe240c72de1f6",
    "0x1f86376e8981c217898751ad8746757d42aa7b90eeb791c09e4a3ec03251cf9de405aba9ec61deca6355c77b0e5f4cb",
    "0x8cc03fdefe0ff135caf4fe2a21529c4195536fbe3ce50b879833fd221351adc2ee7f8dc099040a841b6daecf2e8fedb",
    "0x16603fca40634b6a2211e11db8f0a6a074a7d0d4afadb7bd76505c3d3ad5544e203f6326c95a807299b23ab13633a5f0",
    "0x4ab0b9bcfac1bbcb2c977d027796b3ce75bb8ca2be184cb5231413c4d634f3747a87ac2460f415ec961f8855fe9d6f2",
    "0x987c8d5333ab86fde9926bd2ca6c674170a05bfe3bdd81ffd038da6c26c842642f64550fedfe935a15e4ca31870fb29",
    "0x9fc4018bd96684be88c9e221e4da1bb8f3abd16679dc26c1e8b6e6a1f20cabe69d65201c78607a360370e577bdba587",
    "0xe1bba7a1186bdb5223abde7ada14a23c42a0ca7915af6fe06985e7ed1e4d43b9b3f7055dd4eba6f2bafaaebca731c30",
    "0x19713e47937cd1be0dfd0b8f1d43fb93cd2fcbcb6caf493fd1183e416389e61031bf3a5cce3fbafce813711ad011c132",
    "0x18b46a908f36f6deb918c143fed2edcc523559b8aaf0c2462e6bfe7f911f643249d9cdf41b44d606ce07c8a4d0074d8e",
    "0xb182cac101b9399d155096004f53f447aa7b12a3426b08ec02710e807b4633f06c851c1919211f20d4c04f00b971ef8",
    "0x245a394ad1eca9b72fc00ae7be315dc757b3b080d4c158013e6632d3c40659cc6cf90ad1c232a6442d9d3f5db980133",
    "0x5c129645e44cf1102a159f748c4a3fc5e673d81d7e86568d9ab0f5d396a7ce46ba1049b6579afb7866b1e715475224b",
    "0x15e6be4e990f03ce4ea50b3b42df2eb5cb181d8f84965a3957add4fa95af01b2b665027efec01c7704b456be69c8b604"
  ],
  yDen: [
    "0x16112c4c3a9c98b252181140fad0eae9601a6de578980be6eec3232b5be72e7a07f3688ef60c206d01479253b03663c1",
    "0x1962d75c2381201e1a0cbd6c43c348b885c84ff731c4d59ca4a10356f453e01f78a4260763529e3532f6102c2e49a03d",
    "0x58df3306640da276faaae7d6e8eb15778c4855551ae7f310c35a5dd279cd2eca6757cd636f96f891e2538b53dbf67f2",
    "0x16b7d288798e5395f20d23bf89edb4d1d115c5dbddbcd30e123da489e726af41727364f2c28297ada8d26d98445f5416",
    "0xbe0e079545f43e4b00cc912f8228ddcc6d19c9f0f69bbb0542eda0fc9dec916a20b15dc0fd2ededda39142311a5001d",
    "0x8d9e5297186db2d9fb266eaac783182b70152c65550d881c5ecd87b6f0f5a6449f38db9dfa9cce202c6477faaf9b7ac",
    "0x166007c08a99db2fc3ba8734ace9824b5eecfdfa8d0cf8ef5dd365bc400a0051d5fa9c01a58b1fb93d1a1399126a775c",
    "0x16a3ef08be3ea7ea03bcddfabba6ff6ee5a4375efa1f4fd7feb34fd206357132b920f5b00801dee460ee415a15812ed9",
    "0x1866c8ed336c61231a1be54fd1d74cc4f9fb0ce4c6af5920abc5750c4bf39b4852cfe2f7bb9248836b233d9d55535d4a",
    "0x167a55cda70a6e1cea820597d94a84903216f763e13d87bb5308592e7ea7d4fbc7385ea3d529b35e346ef48bb8913f55",
    "0x4d2f259eea405bd48f010a01ad2911d9c6dd039bb61a6290e591b36e636a5c871a5c29f4f83060400f8b49cba8f6aa8",
    "0xaccbb67481d033ff5852c1e48c50c477f94ff8aefce42d28c0f9a88cea7913516f968986f7ebbea9684b529e2561092",
    "0xad6b9514c767fe3c3613144b45f1496543346d98adf02267d5ceef9a00d9b8693000763e3b90ac11e99b138573345cc",
    "0x2660400eb2e4f3b628bdd0d53cd76f2bf565b94e72927c1cb748df27942480e420517bd8714cc80d1fadc1326ed06f7",
    "0xe0fa1d816ddc03e6b24255e0d7819c171c40f65e273b853324efcd6356caa205ca2f570f13497804415473a1d634b8f",
    "0x000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000001"
  ],
};

// ------------------------------------------------------------------ field arithmetic mod p

function mod(a: bigint): bigint {
  const r = a % P;
  return r < 0n ? r + P : r;
}
const add = (a: bigint, b: bigint): bigint => mod(a + b);
const sub = (a: bigint, b: bigint): bigint => mod(a - b);
const mul = (a: bigint, b: bigint): bigint => mod(a * b);
const neg = (a: bigint): bigint => mod(-a);
function pow(base: bigint, exp: bigint): bigint {
  let r = 1n;
  let b = mod(base);
  let e = exp;
  while (e > 0n) {
    if (e & 1n) r = mul(r, b);
    b = mul(b, b);
    e >>= 1n;
  }
  return r;
}
const inv = (a: bigint): bigint => pow(a, P_MINUS_2);
const sgn0 = (a: bigint): bigint => a & 1n;
const SWU_C2 = pow(neg(SWU_Z), P_PLUS_1_OVER_4); // sqrt(-Z)

function be48(x: bigint): Uint8Array {
  const out = new Uint8Array(48);
  let v = x;
  for (let i = 47; i >= 0; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}
function fromBe(b: Uint8Array): bigint {
  let v = 0n;
  for (const x of b) v = (v << 8n) | BigInt(x);
  return v;
}

// ------------------------------------------------------------------ sha256 (FIPS 180-4)

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

export function sha256(data: Uint8Array): Uint8Array {
  const h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const bitLen = data.length * 8;
  const padded = new Uint8Array(Math.ceil((data.length + 9) / 64) * 64);
  padded.set(data);
  padded[data.length] = 0x80;
  const dv = new DataView(padded.buffer);
  dv.setUint32(padded.length - 8, Math.floor(bitLen / 0x100000000));
  dv.setUint32(padded.length - 4, bitLen >>> 0);
  const w = new Uint32Array(64);
  const rotr = (x: number, n: number): number => (x >>> n) | (x << (32 - n));
  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + 4 * i);
    for (let i = 16; i < 64; i++) {
      // The schedule reads back into the 64 word array, always in range; the
      // assertions keep the reads typed as numbers under noUncheckedIndexedAccess.
      const w15 = w[i - 15]!;
      const w2 = w[i - 2]!;
      const s0 = rotr(w15, 7) ^ rotr(w15, 18) ^ (w15 >>> 3);
      const s1 = rotr(w2, 17) ^ rotr(w2, 19) ^ (w2 >>> 10);
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) >>> 0;
    }
    let a = h[0]!, b = h[1]!, c = h[2]!, d = h[3]!, e = h[4]!, f = h[5]!, g = h[6]!, hh = h[7]!;
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + S1 + ch + K[i]! + w[i]!) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      hh = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    h[0] = (h[0]! + a) >>> 0;
    h[1] = (h[1]! + b) >>> 0;
    h[2] = (h[2]! + c) >>> 0;
    h[3] = (h[3]! + d) >>> 0;
    h[4] = (h[4]! + e) >>> 0;
    h[5] = (h[5]! + f) >>> 0;
    h[6] = (h[6]! + g) >>> 0;
    h[7] = (h[7]! + hh) >>> 0;
  }
  const out = new Uint8Array(32);
  const odv = new DataView(out.buffer);
  for (let i = 0; i < 8; i++) odv.setUint32(4 * i, h[i]!);
  return out;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

// ------------------------------------------------------------------ hash to field

/** expand_message_xmd with sha256 to 128 bytes (RFC 9380 section 5.3.1). */
function expandMessageXmd128(msg: Uint8Array): Uint8Array {
  const dst = new TextEncoder().encode(DST);
  const dstPrime = concat(dst, new Uint8Array([dst.length]));
  const zPad = new Uint8Array(64);
  const b0 = sha256(concat(zPad, msg, new Uint8Array([0, 128, 0]), dstPrime));
  const blocks: Uint8Array[] = [];
  let prev = sha256(concat(b0, new Uint8Array([1]), dstPrime));
  blocks.push(prev);
  for (let i = 2; i <= 4; i++) {
    const x = new Uint8Array(32);
    for (let j = 0; j < 32; j++) x[j] = b0[j]! ^ prev[j]!;
    prev = sha256(concat(x, new Uint8Array([i]), dstPrime));
    blocks.push(prev);
  }
  return concat(...blocks);
}

/** Two field elements from a message (count 2, m 1, L 64). */
function hashToField(msg: Uint8Array): [bigint, bigint] {
  const e = expandMessageXmd128(msg);
  return [mod(fromBe(e.subarray(0, 64))), mod(fromBe(e.subarray(64, 128)))];
}

// ------------------------------------------------------------------ simplified SWU and the isogeny

type Prelude = { tv1: bigint; tv3: bigint; tv4: bigint; num: bigint; den: bigint };

/** The straight line of RFC 9380 F.2 up to the square root, exactly as h2c.rs computes it. */
function swuPrelude(u: bigint): Prelude {
  const tv1 = mul(SWU_Z, mul(u, u));
  let tv2 = add(mul(tv1, tv1), tv1);
  const tv3 = mul(SWU_B, add(tv2, 1n));
  const tv4 = mul(SWU_A, tv2 === 0n ? SWU_Z : neg(tv2));
  tv2 = mul(tv3, tv3);
  let tv6 = mul(tv4, tv4);
  let tv5 = mul(SWU_A, tv6);
  tv2 = mul(add(tv2, tv5), tv3);
  tv6 = mul(tv6, tv4);
  tv5 = mul(SWU_B, tv6);
  tv2 = add(tv2, tv5);
  return { tv1, tv3, tv4, num: tv2, den: tv6 };
}

/**
 * sqrt_ratio for p = 3 mod 4 (F.2.1.2), the root the program's host code produces (either root
 * is accepted on chain; this one matches `hints_for` byte for byte).
 */
function sqrtRatio(u: bigint, v: bigint): { isSquare: boolean; y: bigint } {
  const tv1 = mul(mul(v, v), mul(u, v));
  const y1 = mul(pow(tv1, P_MINUS_3_OVER_4), mul(u, v));
  const y2 = mul(y1, SWU_C2);
  const isSquare = mul(mul(y1, y1), v) === u;
  return { isSquare, y: isSquare ? y1 : y2 };
}

type SwuPoint = { xn: bigint; d: bigint; y: bigint; hint: bigint };

function mapToCurveSwu(u: bigint): SwuPoint {
  const pre = swuPrelude(u);
  const { isSquare, y: y1 } = sqrtRatio(pre.num, pre.den);
  let x = mul(pre.tv1, pre.tv3);
  let y = mul(mul(pre.tv1, u), y1);
  if (isSquare) {
    x = pre.tv3;
    y = y1;
  }
  if (sgn0(u) !== sgn0(y)) y = neg(y);
  return { xn: x, d: pre.tv4, y, hint: y1 };
}

function poly(coeffs: readonly string[], x: bigint): bigint {
  let acc = BigInt(coeffs[coeffs.length - 1]!);
  for (let i = coeffs.length - 2; i >= 0; i--) acc = add(mul(acc, x), BigInt(coeffs[i]!));
  return acc;
}

type Derivation = { hints: bigint[]; points: [bigint, bigint][] };

/** Everything the program derives for a message: the four hints and the two affine E points. */
function derive(msg: Uint8Array): Derivation {
  const [u0, u1] = hashToField(msg);
  const s0 = mapToCurveSwu(u0);
  const s1 = mapToCurveSwu(u1);
  const inv01 = inv(mul(s0.d, s1.d));
  const x0 = mul(mul(s0.xn, inv01), s1.d);
  const x1 = mul(mul(s1.xn, inv01), s0.d);
  const f = [
    { xn: poly(ISO.xNum, x0), xd: poly(ISO.xDen, x0), yn: mul(poly(ISO.yNum, x0), s0.y), yd: poly(ISO.yDen, x0) },
    { xn: poly(ISO.xNum, x1), xd: poly(ISO.xDen, x1), yn: mul(poly(ISO.yNum, x1), s1.y), yd: poly(ISO.yDen, x1) },
  ];
  const invAll = inv(mul(mul(f[0]!.xd, f[0]!.yd), mul(f[1]!.xd, f[1]!.yd)));
  const points: [bigint, bigint][] = f.map((fr) => [mul(fr.xn, inv(fr.xd)), mul(fr.yn, inv(fr.yd))]);
  return { hints: [s0.hint, s1.hint, inv01, invAll], points };
}

// ------------------------------------------------------------------ the group (affine, y^2 = x^3 + 4)

type Affine = { x: bigint; y: bigint } | null; // null is the point at infinity

function pointAdd(p: Affine, q: Affine): Affine {
  if (p === null) return q;
  if (q === null) return p;
  if (p.x === q.x) {
    if (p.y !== q.y || p.y === 0n) return null;
    const l = mul(mul(3n, mul(p.x, p.x)), inv(mul(2n, p.y)));
    const x = sub(mul(l, l), mul(2n, p.x));
    return { x, y: sub(mul(l, sub(p.x, x)), p.y) };
  }
  const l = mul(sub(q.y, p.y), inv(sub(q.x, p.x)));
  const x = sub(sub(mul(l, l), p.x), q.x);
  return { x, y: sub(mul(l, sub(p.x, x)), p.y) };
}

function pointMul(p: Affine, k: bigint): Affine {
  let r: Affine = null;
  let b = p;
  let e = k;
  while (e > 0n) {
    if (e & 1n) r = pointAdd(r, b);
    b = pointAdd(b, b);
    e >>= 1n;
  }
  return r;
}

/** Zcash compressed encoding: x, big endian, bit 7 set; bit 5 set when y is the larger root. */
function compress(p: Affine): Uint8Array {
  if (p === null) {
    const out = new Uint8Array(48);
    out[0] = 0xc0;
    return out;
  }
  const out = be48(p.x);
  out[0] = out[0]! | 0x80;
  if (p.y > (P - 1n) / 2n) out[0] = out[0]! | 0x20;
  return out;
}

// ------------------------------------------------------------------ public

/** The message quicknet signs for a round: sha256 of the round as a u64 big endian. */
export function roundMessage(round: bigint | number): Uint8Array {
  const r = BigInt(round);
  const b = new Uint8Array(8);
  for (let i = 7; i >= 0; i--) b[i] = Number((r >> BigInt(8 * (7 - i))) & 0xffn);
  return sha256(b);
}

/** The 192 byte hints `create_launch` takes for a round. */
export function roundHints(round: bigint | number): Uint8Array {
  const { hints } = derive(roundMessage(round));
  return concat(...hints.map(be48));
}

/** The round's identity on G1, compressed (48 bytes): hash_to_curve of its message. */
export function roundPoint(round: bigint | number): Uint8Array {
  const { points } = derive(roundMessage(round));
  const sum = pointAdd({ x: points[0]![0], y: points[0]![1] }, { x: points[1]![0], y: points[1]![1] });
  return compress(pointMul(sum, H_EFF));
}

/** Both `create_launch` arguments for a round, in the order the instruction takes them. */
export function roundPointArgs(round: bigint | number): { roundPoint: Uint8Array; roundHints: Uint8Array } {
  return { roundPoint: roundPoint(round), roundHints: roundHints(round) };
}

/**
 * The two affine E points before the group operations (x || y, 96 bytes each), for checking
 * against the program's host code.
 */
export function roundMappedPoints(round: bigint | number): [Uint8Array, Uint8Array] {
  const { points } = derive(roundMessage(round));
  return [concat(be48(points[0]![0]), be48(points[0]![1])), concat(be48(points[1]![0]), be48(points[1]![1]))];
}
