/*
  Anchor events from transaction logs: "Program data: <base64>", eight bytes
  of discriminator then the Borsh fields. Discriminators and field layouts
  are EVENTS in the pin. Used for what the accounts do not keep and the
  transaction itself does not show: the step a bid opened at (BidRevealed),
  who opened the pool (PoolCreated.cranker), the lifecycle rows.

  A log is not chain state. Each RPC node records it and stops at its own
  size limit (--log-messages-bytes-limit, 10,000 bytes by default, so every
  node at the default cuts a batch of five deliveries), so a line can be
  missing from a transaction that landed. Nothing about money is read from a
  line: commits and payouts come from the transaction itself (history.ts);
  the BidCommitted, Delivered and Refunded decoders here serve the check
  scripts, which hold the transaction's figures against the program's own
  line wherever a node kept it. And any program can write a "Program data:"
  line, so a line counts only when this program wrote it.
*/
import { EVENTS } from "@contract/constants";
import { readI64, readPubkey, readU16, readU32, readU64, readU8 } from "./borsh";
import { PROGRAM } from "./pda";

export type EventValue = bigint | number | string | boolean;
export interface DecodedEvent {
  name: string;
  data: Record<string, EventValue>;
  signature: string;
  slot: number;
  blockTime: number | null;
  /* Where it was read: the program's own log line, the transaction's instructions and balances, or both and they agree. Absent on a line read before 2026-10-02. */
  from?: "log" | "tx" | "both";
}

interface EventLayout {
  discriminator: readonly number[];
  fields: readonly { name: string; type: string }[];
}
const LAYOUTS = EVENTS as unknown as Record<string, EventLayout>;

/*
  Events only ever grow at the end. These are the fields each version appended (INTERFACE events table), newest
  first: an event written before a version ends exactly where that version's fields start and decodes with them
  absent, so a pool opened under 0.27 still shows who opened it. Only those boundaries are accepted: an event that
  ends anywhere else is short and is skipped whole, as before, so no reader is handed a field it trusts as present,
  absent. 0.29 appended three fields to LaunchCreated and one to PrepayReturned (the eleventh candidate's
  metadata reserve); MintFinished is new in 0.29. v0.30 appended four to LaunchCreated (the treasury and the operating
  values the launch records), four to BeaconPosted (the reveal lag) and one to ConfigUpdated (the pending treasury);
  TradingOpened, TradingForcedOpen and the fee and burn events are new in 0.30.
*/
const APPENDED: readonly Record<string, readonly string[]>[] = [
  {
    LaunchCreated: ["treasury", "reveal_margin_secs", "delivery_reward", "metadata_reserve_lamports"],
    BeaconPosted: ["posted_ts", "lag_secs", "margin_secs", "breach"],
    ConfigUpdated: ["pending_treasury"],
  },
  { LaunchCreated: ["attest_required", "processing_charge", "histogram_rent"], PrepayReturned: ["metadata_reserve"] },
  {
    LaunchCreated: ["raise_fee_bps", "raise_fee_creator_share_bps"],
    Settled: ["raise_fee_creator", "raise_fee_platform"],
    PoolCreated: ["raise_fee_creator_paid", "raise_fee_platform_paid", "pool_sol_in"],
  },
];
/* The field indices where an older event of this name ends, newest version first; it stops at the first tail that is not the pin's own names. */
function olderEnds(name: string, layout: EventLayout): Set<number> {
  const ends = new Set<number>();
  let at = layout.fields.length;
  for (const tails of APPENDED) {
    const tail = tails[name];
    if (!tail) continue;
    at -= tail.length;
    if (at < 0 || !tail.every((n, i) => layout.fields[at + i]?.name === n)) break;
    ends.add(at);
  }
  return ends;
}
const PREFIX = "Program data: ";

function base64ToBytes(s: string): Uint8Array {
  if (typeof atob === "function") {
    const bin = atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  return Uint8Array.from(Buffer.from(s, "base64"));
}

function sizeOf(type: string): number {
  switch (type) {
    case "u8":
    case "bool":
      return 1;
    case "u16":
      return 2;
    case "u32":
      return 4;
    case "u64":
    case "i64":
      return 8;
    case "u128":
      return 16;
    case "pubkey":
      return 32;
    default:
      return -1;
  }
}

function readValue(type: string, d: Uint8Array, o: number): EventValue {
  switch (type) {
    case "u8":
      return readU8(d, o);
    case "bool":
      return d[o] !== 0;
    case "u16":
      return readU16(d, o);
    case "u32":
      return readU32(d, o);
    case "u64":
      return readU64(d, o);
    case "i64":
      return readI64(d, o);
    /* PoolCreated's liquidity and sqrt_price, LiquidityLocked's liquidity. Two little-endian u64 halves. */
    case "u128":
      return readU64(d, o) + (readU64(d, o + 8) << 64n);
    case "pubkey":
      return readPubkey(d, o);
    default:
      throw new Error(`event field type ${type} not handled`);
  }
}

/* The runtime's own lines around every program call. A program cannot write them: its messages come out as "Program log: ...". */
const INVOKE = /^Program ([1-9A-HJ-NP-Za-km-z]{32,44}) invoke \[\d+\]$/;
const RETURN = /^Program ([1-9A-HJ-NP-Za-km-z]{32,44}) (?:success|failed: .*)$/;

/* True when the node cut this log short: nothing after the cut was recorded, events included. */
export function logWasCut(logs: readonly string[]): boolean {
  return logs.length > 0 && logs[logs.length - 1] === "Log truncated";
}

/*
  Every pinned event this program wrote in a transaction's log lines. The
  call stack is followed through the runtime's invoke and return lines, and
  a data line counts only while this program is the one running: a
  transaction that names a launch and calls some other program could
  otherwise print a Delivered or PoolCreated line of its own (found
  2026-10-02; until then any "Program data:" line was taken).
*/
export function decodeEventsFromLogs(logs: readonly string[], program: string = PROGRAM.toBase58()): { name: string; data: Record<string, EventValue> }[] {
  const out: { name: string; data: Record<string, EventValue> }[] = [];
  const stack: string[] = [];
  for (const line of logs) {
    const inv = INVOKE.exec(line);
    if (inv) {
      stack.push(inv[1]);
      continue;
    }
    if (RETURN.test(line)) {
      stack.pop();
      continue;
    }
    if (!line.startsWith(PREFIX) || stack[stack.length - 1] !== program) continue;
    let bytes: Uint8Array;
    try {
      bytes = base64ToBytes(line.slice(PREFIX.length));
    } catch {
      continue;
    }
    if (bytes.length < 8) continue;
    for (const [name, layout] of Object.entries(LAYOUTS)) {
      let match = true;
      for (let i = 0; i < 8; i++) if (bytes[i] !== layout.discriminator[i]) match = false;
      if (!match) continue;
      let o = 8;
      const data: Record<string, EventValue> = {};
      let ok = true;
      const older = olderEnds(name, layout);
      for (const [i, f] of layout.fields.entries()) {
        /* A Borsh string: four bytes of length, then that many bytes of UTF-8 (LaunchCreated's name, symbol and uri; until 2026-10-02 the type was not handled and the genesis event was skipped whole). */
        if (f.type === "string") {
          if (o + 4 > bytes.length) {
            ok = false;
            break;
          }
          const len = readU32(bytes, o);
          if (o + 4 + len > bytes.length) {
            ok = false;
            break;
          }
          data[f.name] = new TextDecoder().decode(bytes.subarray(o + 4, o + 4 + len));
          o += 4 + len;
          continue;
        }
        /* An older event: it ends exactly where a later version's fields start (APPENDED). */
        if (o === bytes.length && older.has(i)) break;
        const n = sizeOf(f.type);
        /* A field type this decoder does not know skips that one event, never the whole history (2026-09-29: an unhandled u128 used to throw here, and every settled launch's history read failed with it). */
        if (n < 0 || o + n > bytes.length) {
          ok = false;
          break;
        }
        data[f.name] = readValue(f.type, bytes, o);
        o += n;
      }
      if (ok) out.push({ name, data });
      break;
    }
  }
  return out;
}
