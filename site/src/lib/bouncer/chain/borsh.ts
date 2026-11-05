/*
  The little endian reads and Borsh writes the decoders and instruction
  builders need. Small on purpose: every layout comes from the pin, only the
  byte order and the string prefix are here.
*/
import { PublicKey } from "@solana/web3.js";

export function readU8(d: Uint8Array, o: number): number {
  return d[o];
}
export function readU16(d: Uint8Array, o: number): number {
  return d[o] | (d[o + 1] << 8);
}
export function readU32(d: Uint8Array, o: number): number {
  return (d[o] | (d[o + 1] << 8) | (d[o + 2] << 16) | (d[o + 3] << 24)) >>> 0;
}
export function readU64(d: Uint8Array, o: number): bigint {
  let v = 0n;
  for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(d[o + i]);
  return v;
}
/* Signed 64 bit, returned as a number: every i64 the program stores is a unix timestamp or a window length. */
export function readI64(d: Uint8Array, o: number): number {
  const u = readU64(d, o);
  const s = u >= 1n << 63n ? u - (1n << 64n) : u;
  return Number(s);
}
export function readPubkey(d: Uint8Array, o: number): string {
  return new PublicKey(d.subarray(o, o + 32)).toBase58();
}
export function readBytes(d: Uint8Array, o: number, len: number): Uint8Array {
  return Uint8Array.from(d.subarray(o, o + len));
}
export function isZero(d: Uint8Array, o: number, len: number): boolean {
  for (let i = o; i < o + len; i++) if (d[i] !== 0) return false;
  return true;
}

/* Borsh writer for instruction data. */
export class Writer {
  private parts: number[] = [];
  u8(v: number): this {
    this.parts.push(v & 0xff);
    return this;
  }
  u16(v: number): this {
    this.parts.push(v & 0xff, (v >>> 8) & 0xff);
    return this;
  }
  u32(v: number): this {
    this.parts.push(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff);
    return this;
  }
  u64(v: bigint): this {
    if (v < 0n || v >= 1n << 64n) throw new Error("u64 out of range");
    let x = v;
    for (let i = 0; i < 8; i++) {
      this.parts.push(Number(x & 0xffn));
      x >>= 8n;
    }
    return this;
  }
  i64(v: bigint | number): this {
    let x = BigInt(v);
    if (x < 0n) x += 1n << 64n;
    return this.u64(x);
  }
  bytes(b: Uint8Array, len?: number): this {
    if (len !== undefined && b.length !== len) throw new Error(`expected ${len} bytes, got ${b.length}`);
    for (const x of b) this.parts.push(x);
    return this;
  }
  string(s: string): this {
    const b = new TextEncoder().encode(s);
    this.u32(b.length);
    return this.bytes(b);
  }
  toBytes(): Uint8Array {
    return Uint8Array.from(this.parts);
  }
}
