/*
  Is the RPC this site reads the cluster the pin was deployed to, and does
  the program there match the pin? Checked when the site loads and on
  demand; and before every send a short read of the program's deploy slot
  confirms nothing was upgraded since. A wallet's own network setting
  cannot route a transaction here: the site broadcasts through this RPC and
  a wallet that broadcasts itself is handed the chain by name. So the thing
  to catch is the RPC being the wrong cluster, or the program at it being
  absent or a different build, and the check names which. A build is told
  by its deploy slot (the 45-byte header of the program data account, since
  2026-10-15), never by reading its 900 KB of bytes on every page load.

  It fails closed (the founder, 2026-10-09, the 0.28 triage's F1): anything that
  stops the site confirming the pinned build (an RPC error, a read that
  takes too long, an account that is not there) blocks signing with a sentence that says which, and "Check again"
  runs it once more. Before, four of those passed as "unchecked". The
  sentences name the RPC's host only, never its full address (a keyed
  endpoint carries its key in the query).

  The genesis hashes of the public clusters were read from the clusters'
  own RPCs on 2026-09-26 (getGenesisHash), not remembered.
*/
import { Connection, PublicKey } from "@solana/web3.js";
import { INTERFACE_VERSION } from "@contract/constants";
import { CLUSTER, PROGRAM_ID, DEPLOYMENT as deployment } from "@contract/active";

/*
  The pinned build, from deployment.json. 0.29: an interface is pinned before
  its deploy with a pending record (deploy slot "0", a "pending" note), which
  never matches a cluster, so the site signs nothing until the deploy is
  recorded (idl/record-deployment.mjs, then scripts/pin-deployment.mjs).
*/
export interface Pin {
  slot: string;
  sha256: string;
  pending: boolean;
}
export const PIN: Pin = {
  slot: String(deployment.deployed_in_slot),
  sha256: deployment.on_chain.sha256,
  pending: "pending" in (deployment as object) || String(deployment.deployed_in_slot) === "0",
};

export const GENESIS_HASH: Readonly<Record<"mainnet-beta" | "devnet" | "testnet", string>> = {
  "mainnet-beta": "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d",
  devnet: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
  testnet: "4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY",
};

export type RpcCluster = "mainnet-beta" | "devnet" | "testnet" | "local" | "unknown";
/* rpc: a read failed or took too long. cluster: another cluster. program: absent, not executable, or another build. config: never initialised. check: this browser cannot do the check at all. */
export type ClusterFault = "rpc" | "cluster" | "program" | "config" | "check";

/* The banner's and the wallet menu's heading for each fault. */
export const FAULT_HEADING: Record<ClusterFault, string> = {
  rpc: "No answer from the RPC.",
  cluster: "Wrong network.",
  program: "Wrong program.",
  config: "Program not initialised.",
  check: "Cannot check the program here.",
};

/* The first line of an RPC error, without the JSON body a public RPC attaches to a refusal, and without web3.js's "failed to get info about account <address>: " in front of the node's own reason (it pushed the reason past the cut). getAccountInfo puts that prefix on twice, the second time over "SolanaJSONRPCError: ". A URL in it shows as its host (a keyed endpoint's query holds its key). At most 80 characters, cut at a word. */
export function shortError(e: unknown): string {
  const m = (e instanceof Error ? e.message : String(e)).replace(/https?:\/\/[^\s"'()<>,]+/g, (u) => hostOf(u));
  /* web3.js writes "<status> <text>: " and then the body, and a body that begins with a space leaves two ("403 Forbidden:  {"): any run of spaces before the brace. */
  const first = m.split(/ ?:\s+\{|\n/)[0].trim();
  let reason = first;
  for (let i = 0; i < 4; i++) {
    const next = reason.replace(/^failed to [^:]*: (SolanaJSONRPCError: )?/i, "").trim();
    if (!next || next === reason) break;
    reason = next;
  }
  if (reason.length <= 80) return reason;
  const cut = reason.slice(0, 80);
  const space = cut.lastIndexOf(" ");
  return `${space > 40 ? cut.slice(0, space) : cut}...`;
}

export interface ClusterCheck {
  /* The cluster the pin names. */
  pinned: string;
  rpcUrl: string;
  genesis: string | null;
  rpcCluster: RpcCluster;
  program: "found" | "missing" | "not-executable" | "unchecked";
  /* The deployed build against the pin, by its deploy slot. "unchecked" only on a failed check: a passed check always matched. */
  bytes: "match" | "mismatch" | "unchecked";
  /* The pinned build's sha256 (deployment.json), which the pinned deploy slot identifies; null unless the slot matched. */
  bytesSha256: string | null;
  /* The slot the program was last deployed in, from its program data account; the pre-send check compares against it. */
  deploySlot: number | null;
  config: "found" | "missing" | "unchecked";
  /* True when transactions may be built against this RPC. Only a complete check that matched the pin sets it. */
  ok: boolean;
  /* What kind of thing is wrong. Null when ok. */
  fault: ClusterFault | null;
  /* One sentence naming what is wrong, null when ok. */
  problem: string | null;
  checkedAt: number;
}

const LOADER = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");
/* The program data account's header: a 4-byte state tag, the 8-byte deploy slot, then the upgrade authority option (1 + 32). The program's bytes follow. */
const PD_HEADER = 45;
const PD_SLOT_OFFSET = 4;
/* UpgradeableLoaderState::ProgramData. */
const PD_TAG = 3;

/* How long each read may take before the check gives up on it and fails closed, in ms. programData is the 45-byte header read. */
export const READ_LIMIT_MS = { small: 15_000, programData: 15_000, slot: 10_000 } as const;

function programDataAddress(): PublicKey {
  return PublicKey.findProgramAddressSync([new PublicKey(PROGRAM_ID).toBytes()], LOADER)[0];
}

/* A read that takes longer than `ms` is a failure, named as such. */
export function within<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`no answer within ${Math.round(ms / 1000)} s`)), ms);
  });
  return Promise.race([p, late]).finally(() => clearTimeout(timer));
}

/* The RPC's host for a sentence: the query of a keyed endpoint holds its key. */
export function hostOf(url: string): string {
  try {
    return new URL(url).host || "this RPC";
  } catch {
    return "this RPC";
  }
}

function isLocalUrl(url: string): boolean {
  try {
    const h = new URL(url).hostname;
    return h === "localhost" || h === "127.0.0.1" || h === "[::1]" || h.endsWith(".localhost");
  } catch {
    return false;
  }
}

/* The Wallet Standard chain name for this RPC, the way the adapter derives it, so the wallet's offered chains can be compared. */
export type WalletChain = "solana:mainnet" | "solana:devnet" | "solana:testnet" | "solana:localnet";

export function chainForEndpoint(url: string): WalletChain {
  if (url.includes("https://api.mainnet-beta.solana.com")) return "solana:mainnet";
  if (/\bdevnet\b/i.test(url)) return "solana:devnet";
  if (/\btestnet\b/i.test(url)) return "solana:testnet";
  if (/\blocalhost\b/i.test(url) || /\b127\.0\.0\.1\b/.test(url)) return "solana:localnet";
  return "solana:mainnet";
}

/*
  The chain a wallet is handed, from the pin, never from the RPC's address
  (2026-10-15): the site's own route is a path, which names no cluster, and
  reading it as mainnet would send a devnet transaction to a wallet's mainnet
  RPC. Nothing is signed until the check above has matched the RPC's genesis
  to this pin, so the pin's chain is the RPC's.
*/
export function pinnedChain(): WalletChain {
  const c = CLUSTER as string;
  if (c === "mainnet-beta" || c === "mainnet") return "solana:mainnet";
  if (c === "devnet") return "solana:devnet";
  if (c === "testnet") return "solana:testnet";
  return "solana:localnet";
}

export function clusterLabel(c: RpcCluster | string): string {
  return c === "mainnet-beta" ? "mainnet" : c;
}

function slotAt(data: Uint8Array, offset: number): number {
  return Number(new DataView(data.buffer, data.byteOffset + offset, 8).getBigUint64(0, true));
}

/*
  The last check that passed, kept for the pre-send read: the endpoint it read
  through and the deploy slot it saw. Cleared when a check starts, so a send
  can never ride on a check that is being redone or that failed; only the
  newest check may set it (an older one that passes after a newer one failed
  does not), and a send through any other endpoint is refused.
*/
let confirmed: { endpoint: string; slot: number } | null = null;
let generation = 0;
const staleListeners = new Set<() => void>();

/* Called when the pre-send read finds the program changed or its data account gone, so the page runs the full check again. A read that only failed refuses that send and leaves the check standing: it learned nothing new, and the next send reads again. */
export function onPinStale(fn: () => void): () => void {
  staleListeners.add(fn);
  return () => staleListeners.delete(fn);
}

export async function checkCluster(connection: Connection, rpcUrl: string, limits: { small: number; programData: number } = READ_LIMIT_MS, pin: Pin = PIN): Promise<ClusterCheck> {
  const gen = ++generation;
  confirmed = null;
  const pinned = CLUSTER;
  const base: ClusterCheck = { pinned, rpcUrl, genesis: null, rpcCluster: "unknown", program: "unchecked", bytes: "unchecked", bytesSha256: null, deploySlot: null, config: "unchecked", ok: false, fault: null, problem: null, checkedAt: Date.now() };
  const fail = (fault: ClusterFault, problem: string, patch: Partial<ClusterCheck> = {}): ClusterCheck => ({ ...base, ...patch, ok: false, fault, problem, checkedAt: Date.now() });
  const host = hostOf(rpcUrl);
  const noAnswer = (what: string, e: unknown) => fail("rpc", `The RPC at ${host} did not answer for ${what} (${shortError(e)}). Nothing will be signed until it does.`);

  let genesis: string;
  try {
    genesis = await within(connection.getGenesisHash(), limits.small);
  } catch (e) {
    return fail("rpc", `The RPC at ${host} did not answer (${shortError(e)}). Nothing can be read or signed until it does.`);
  }
  const known = (Object.entries(GENESIS_HASH) as [keyof typeof GENESIS_HASH, string][]).find(([, h]) => h === genesis)?.[0];
  const rpcCluster: RpcCluster = known ?? (isLocalUrl(rpcUrl) ? "local" : "unknown");
  base.genesis = genesis;
  base.rpcCluster = rpcCluster;

  if (known && known !== pinned) {
    return fail("cluster", `This site is pinned to ${clusterLabel(pinned)}, but the RPC it reads (${host}) is ${clusterLabel(known)}. Nothing will be signed against it.`);
  }
  if (!known && rpcCluster === "unknown") {
    return fail("cluster", `The RPC at ${host} is not ${clusterLabel(pinned)}: its genesis hash ${genesis.slice(0, 8)} is not the ${clusterLabel(pinned)} one. Nothing will be signed against it.`);
  }

  const program = new PublicKey(PROGRAM_ID);
  let info: Awaited<ReturnType<Connection["getAccountInfo"]>>;
  try {
    info = await within(connection.getAccountInfo(program, "confirmed"), limits.small);
  } catch (e) {
    return noAnswer("the program", e);
  }
  if (!info) return fail("program", `The program ${PROGRAM_ID} is not deployed on the RPC at ${host}${rpcCluster === "local" ? " (a local validator without it)" : ""}.`, { program: "missing" });
  if (!info.executable || !info.owner.equals(LOADER)) return fail("program", `The account ${PROGRAM_ID} on ${host} is not an upgradeable program.`, { program: "not-executable" });
  base.program = "found";

  /*
    The deployed build against the pin, by its deploy slot: the 45-byte header
    of the program data account, not its 900 KB of bytes (2026-10-15; the whole
    account was 1.2 MB on every page load). The pin records the slot the
    build was deployed in and the sha256 of the bytes read at that slot
    (deployment.json, matches_on_chain). The loader moves the slot on every
    upgrade and every extend, so the pinned slot means the pinned bytes.
  */
  let pd: Awaited<ReturnType<Connection["getAccountInfo"]>>;
  try {
    pd = await within(connection.getAccountInfo(programDataAddress(), { commitment: "confirmed", dataSlice: { offset: 0, length: PD_HEADER } }), limits.programData);
  } catch (e) {
    return noAnswer("the program's deploy slot", e);
  }
  if (!pd) return fail("program", `The program's data account is missing on ${host}. Nothing will be signed.`);
  const data = new Uint8Array(pd.data);
  const tag = data.length >= 4 ? new DataView(data.buffer, data.byteOffset, 4).getUint32(0, true) : -1;
  if (tag !== PD_TAG || !pd.owner.equals(LOADER) || data.length < PD_SLOT_OFFSET + 8) {
    return fail("program", `The program's data account on ${host} is not an upgradeable program's (state ${tag}). Nothing will be signed.`, { bytes: "mismatch" });
  }
  const slot = slotAt(data, PD_SLOT_OFFSET);
  if (pin.pending) {
    return fail("program", `This site is built for INTERFACE ${INTERFACE_VERSION} (sha256 ${pin.sha256.slice(0, 8)}), which is not deployed on ${clusterLabel(pinned)} yet; the program at ${host} was deployed at slot ${slot.toLocaleString("en-US")}. Nothing will be signed until it is.`, { bytes: "mismatch", deploySlot: slot });
  }
  if (String(slot) !== pin.slot) {
    return fail("program", `The program at ${host} was deployed at slot ${slot.toLocaleString("en-US")}; the pinned build (${pin.sha256.slice(0, 8)}) was deployed at slot ${Number(pin.slot).toLocaleString("en-US")}. The site's types may not describe it, so nothing will be signed.`, { bytes: "mismatch", deploySlot: slot });
  }
  base.bytes = "match";
  base.bytesSha256 = pin.sha256;
  base.deploySlot = slot;

  let cfg: Awaited<ReturnType<Connection["getAccountInfo"]>>;
  try {
    cfg = await within(connection.getAccountInfo(new PublicKey(deployment.config.address), "confirmed"), limits.small);
  } catch (e) {
    return noAnswer("the program's config", e);
  }
  if (!cfg) return fail("config", `The program's config account is missing on ${host}: the program is deployed there but was never initialised.`, { config: "missing" });
  base.config = "found";

  if (gen === generation) confirmed = { endpoint: connection.rpcEndpoint, slot: base.deploySlot };
  return { ...base, ok: true, fault: null, problem: null, checkedAt: Date.now() };
}

/*
  Before every send in the browser: the program's deploy slot, 8 bytes read
  from its program data account, must still be the one the last passed check
  saw. An upgrade always moves it. Throws a sentence when there is no passed
  check, when the read fails, or when the slot moved; when the slot moved or
  the account is gone the page is told to run the full check again.
*/
/*
  24e (the founder's capacity decisions, item 2): `sharedSlot` is the deploy slot as the site's shared send context read it
  (server/sendContext.ts, kept a second), in place of this client's own read of the program data account. When it fails,
  reads nothing or reads another slot, the client reads the account itself as before.
*/
export async function confirmPinBeforeSend(connection: Connection, limitMs: number = READ_LIMIT_MS.slot, sharedSlot?: () => Promise<number | null>): Promise<void> {
  const seen = confirmed;
  if (!seen || seen.endpoint !== connection.rpcEndpoint) throw new Error("The site has not confirmed the program on this network yet, so nothing was sent. Wait for the check, or press Check again.");
  /* The shared read can only pass a send: a slot that differs (an upgrade, or a cached answer from just before the page's own check) is read again here before anything is refused. */
  const shared = sharedSlot ? await within(sharedSlot(), limitMs).catch(() => null) : null;
  if (shared !== null && shared === seen.slot) return;
  let slice: Awaited<ReturnType<Connection["getAccountInfo"]>>;
  try {
    slice = await within(connection.getAccountInfo(programDataAddress(), { commitment: "confirmed", dataSlice: { offset: PD_SLOT_OFFSET, length: 8 } }), limitMs);
  } catch (e) {
    throw new Error(`The RPC did not answer when the site checked the program before sending (${shortError(e)}). Nothing was sent.`);
  }
  const slot = slice && slice.data.length >= 8 ? slotAt(new Uint8Array(slice.data), 0) : null;
  if (slot === seen.slot) return;
  if (confirmed === seen) confirmed = null;
  staleListeners.forEach((fn) => fn());
  throw new Error(
    slot === null
      ? "The program's data account could not be read before sending, so nothing was sent. The page is checking the program again."
      : `The program on ${clusterLabel(CLUSTER)} was upgraded (slot ${slot.toLocaleString("en-US")}) since this page checked it, so nothing was sent. The page is checking it again.`,
  );
}

/* For the account provider when the wallet changes: whether the program's deploy slot is still the one the last check saw. Never throws. */
export async function pinStillCurrent(connection: Connection): Promise<boolean> {
  try {
    await confirmPinBeforeSend(connection);
    return true;
  } catch {
    return false;
  }
}
