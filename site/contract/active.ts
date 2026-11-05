/*
  The deployment this build is for (launch candidate, 2026-10-22, the founder: launch
  day is env flips and a redeploy, not code). Two records are committed:
  contract/deployment.json (devnet, written by scripts/pin-deployment.mjs) and
  contract/deployment.mainnet.json (pending until the mainnet deploy).
  NEXT_PUBLIC_BOUNCER_CLUSTER picks one ("devnet", the default, or "mainnet");
  then the environment may restate the record, and set only the two facts
  the deploy itself decides:

    NEXT_PUBLIC_PROGRAM_ID            must be the record's program (restated, never replaced)
    NEXT_PUBLIC_CONFIG_ADDRESS        must be the record's Config, the PDA ["config"] of the program
    NEXT_PUBLIC_PROGRAM_DATA_ACCOUNT  must be the record's program data account, the loader's PDA
    NEXT_PUBLIC_PROGRAM_SHA256        must be the record's sha256 (the reviewed fixture's)
    NEXT_PUBLIC_DEPLOYED_SLOT         the program's deploy slot (the pin check's key; a pending record's only source,
                                      bound to its program and sha256 by deploy-expect.json; otherwise only restated)
    NEXT_PUBLIC_UPGRADE_AUTHORITY     shown on the fees and verify panels (the deploy key, then Squad A's vault)

  Terra's T3 (2026-10-31): the program, its Config and data account, and the
  bytes' hash used to be replaceable from the environment, so whoever could
  write env could point a build that passed every check at another program.
  They are the reviewed record's now: a value that differs stops the build,
  and a different program needs a reviewed record (a commit). The slot and
  the authority are checked against the chain by the pin check and against
  deploy-expect.json by scripts/deploy-manifest.mjs.

  RPC is NEXT_PUBLIC_RPC_URL and RPC_UPSTREAM (chain/rpc.ts), the attestor signer
  BOUNCER_KMS_* (server/kmsSigner.ts; server/attest.ts signersFromEnv). Every value is checked here
  and a wrong one stops the build (it throws at import): a malformed key, a
  config or program-data address that is not the program's PDA, a slot that is
  not a number, a hash that is not 64 hex digits, an unknown cluster. A record
  with no deploy slot stays pending, and a pending pin signs nothing
  (chain/cluster.ts PIN). Next inlines NEXT_PUBLIC_* only where they are read
  by name, so ENV below names each one.
*/
import { PublicKey } from "@solana/web3.js";
import devnetRecord from "./deployment.json";
import mainnetRecord from "./deployment.mainnet.json";
import { CONFIG_DEVNET, CONFIG_PRODUCTION } from "./constants";

export type DeploymentRecord = typeof devnetRecord & { pending?: string; about?: string };
export interface DeploymentEnv {
  NEXT_PUBLIC_BOUNCER_CLUSTER?: string;
  NEXT_PUBLIC_PROGRAM_ID?: string;
  NEXT_PUBLIC_CONFIG_ADDRESS?: string;
  NEXT_PUBLIC_PROGRAM_DATA_ACCOUNT?: string;
  NEXT_PUBLIC_DEPLOYED_SLOT?: string;
  NEXT_PUBLIC_PROGRAM_SHA256?: string;
  NEXT_PUBLIC_UPGRADE_AUTHORITY?: string;
}
const ENV: DeploymentEnv = {
  NEXT_PUBLIC_BOUNCER_CLUSTER: process.env.NEXT_PUBLIC_BOUNCER_CLUSTER,
  NEXT_PUBLIC_PROGRAM_ID: process.env.NEXT_PUBLIC_PROGRAM_ID,
  NEXT_PUBLIC_CONFIG_ADDRESS: process.env.NEXT_PUBLIC_CONFIG_ADDRESS,
  NEXT_PUBLIC_PROGRAM_DATA_ACCOUNT: process.env.NEXT_PUBLIC_PROGRAM_DATA_ACCOUNT,
  NEXT_PUBLIC_DEPLOYED_SLOT: process.env.NEXT_PUBLIC_DEPLOYED_SLOT,
  NEXT_PUBLIC_PROGRAM_SHA256: process.env.NEXT_PUBLIC_PROGRAM_SHA256,
  NEXT_PUBLIC_UPGRADE_AUTHORITY: process.env.NEXT_PUBLIC_UPGRADE_AUTHORITY,
};

const LOADER = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");
const set = (v: string | undefined): string | null => (v && v.trim() ? v.trim() : null);
function key(name: string, v: string): string {
  try {
    return new PublicKey(v).toBase58();
  } catch {
    throw new Error(`contract/active.ts: ${name} is not a Solana address.`);
  }
}

/* Which record a cluster name selects; null for a name this site does not build for. */
export function clusterRecord(name: string | null): DeploymentRecord | null {
  if (name === null || name === "devnet") return devnetRecord as DeploymentRecord;
  if (name === "mainnet" || name === "mainnet-beta") return mainnetRecord as DeploymentRecord;
  return null;
}

export function resolveDeployment(env: DeploymentEnv): DeploymentRecord {
  const base = clusterRecord(set(env.NEXT_PUBLIC_BOUNCER_CLUSTER));
  if (!base) throw new Error("contract/active.ts: NEXT_PUBLIC_BOUNCER_CLUSTER must be devnet or mainnet.");
  const out: DeploymentRecord = JSON.parse(JSON.stringify(base));
  const program = set(env.NEXT_PUBLIC_PROGRAM_ID);
  if (program && key("NEXT_PUBLIC_PROGRAM_ID", program) !== out.program_id) throw new Error("contract/active.ts: NEXT_PUBLIC_PROGRAM_ID is not the reviewed record's program (another program needs a reviewed record, a commit).");
  const programKey = new PublicKey(out.program_id);
  /* The two PDAs follow the program; given ones must agree with it. */
  const configPda = PublicKey.findProgramAddressSync([Buffer.from("config")], programKey)[0].toBase58();
  const dataPda = PublicKey.findProgramAddressSync([programKey.toBytes()], LOADER)[0].toBase58();
  const cfg = set(env.NEXT_PUBLIC_CONFIG_ADDRESS);
  if (cfg && key("NEXT_PUBLIC_CONFIG_ADDRESS", cfg) !== configPda) throw new Error("contract/active.ts: NEXT_PUBLIC_CONFIG_ADDRESS is not the program's Config PDA.");
  const pd = set(env.NEXT_PUBLIC_PROGRAM_DATA_ACCOUNT);
  if (pd && key("NEXT_PUBLIC_PROGRAM_DATA_ACCOUNT", pd) !== dataPda) throw new Error("contract/active.ts: NEXT_PUBLIC_PROGRAM_DATA_ACCOUNT is not the program's data account.");
  if (out.config.address !== configPda || out.program_data_account !== dataPda) throw new Error("contract/active.ts: the record's Config or program data address is not its program's PDA.");
  const slot = set(env.NEXT_PUBLIC_DEPLOYED_SLOT);
  if (slot) {
    if (!/^[1-9]\d{0,19}$/.test(slot)) throw new Error("contract/active.ts: NEXT_PUBLIC_DEPLOYED_SLOT is not a slot number.");
    /* R2 (the 31c pre-check): a record with its own slot takes only that slot; a pending record's slot is bound to its program id and sha256 by deploy-expect.json, which the build guard (scripts/deploy-guard.mjs slotBinding) checks before next build. */
    if (!("pending" in base) && String(base.deployed_in_slot) !== "0" && slot !== String(base.deployed_in_slot)) throw new Error("contract/active.ts: NEXT_PUBLIC_DEPLOYED_SLOT is not the reviewed record's deploy slot (a new slot needs a re-pinned record, a commit).");
    out.deployed_in_slot = slot;
    delete out.pending;
  }
  const sha = set(env.NEXT_PUBLIC_PROGRAM_SHA256);
  if (sha) {
    if (!/^[0-9a-f]{64}$/.test(sha)) throw new Error("contract/active.ts: NEXT_PUBLIC_PROGRAM_SHA256 is not 64 hex digits.");
    if (sha !== out.on_chain.sha256 || sha !== out.build.sha256) throw new Error("contract/active.ts: NEXT_PUBLIC_PROGRAM_SHA256 is not the reviewed record's sha256 (other bytes need a reviewed record, a commit).");
  }
  const ua = set(env.NEXT_PUBLIC_UPGRADE_AUTHORITY);
  if (ua) out.upgrade_authority = key("NEXT_PUBLIC_UPGRADE_AUTHORITY", ua);
  return out;
}

export const DEPLOYMENT: DeploymentRecord = resolveDeployment(ENV);
/* The cluster's name as the pin writes it: "devnet" or "mainnet-beta". */
export const CLUSTER: string = DEPLOYMENT.cluster;
export const PROGRAM_ID: string = DEPLOYMENT.program_id;
export const CONFIG_ADDRESS: string = DEPLOYMENT.config.address;
export const ON_MAINNET_PIN: boolean = CLUSTER === "mainnet" || CLUSTER === "mainnet-beta";
/* The decided config for the cluster (its values before the first read lands). */
export const CONFIG_FOR_CLUSTER = ON_MAINNET_PIN ? CONFIG_PRODUCTION : CONFIG_DEVNET;
