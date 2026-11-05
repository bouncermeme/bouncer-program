/*
  The attestor keys' probe (the independent review of 2026-10-30, finding 5; build lane 2). It proves, without
  disabling the main key, that each KMS key the deployment is configured with (main and backup):
    - is enabled: KMS signs with it (Sign on a disabled or pending-deletion key is refused);
    - is the configured key: kmsSigner's own GetPublicKey check (the DER SubjectPublicKeyInfo holds exactly the
      configured base58 key, the key spec and usage are Ed25519 SIGN_VERIFY);
    - is allowed by the role this deployment runs as: the call goes through the same credentials as a permit
      (Vercel OIDC and BOUNCER_AWS_ROLE_ARN on mainnet), so a role whose policy omits the key fails here;
    - gives a program-valid signature: over a real 40-byte creation-permit message (attest.ts createAttestMessage,
      the program's own layout), verified here with Ed25519 against the configured key, and that key one of the
      Config's attestors.
  Each key is asked on its own, so the backup is proven while the main key stays enabled; no failover is involved.

  The message can never be used: its creator is the all-zero key (no one can sign as it), its launch the all-ones
  key, and it expires 60 s after it is made. Nothing is written anywhere and no counter is touched.
*/
import { PublicKey } from "@solana/web3.js";
import { createAttestMessage } from "../attest";
import type { AttestSigner } from "./attest";
import { ed25519Verifies, KmsSignerError } from "./kmsSigner";

export const PROBE_CREATOR = new PublicKey(new Uint8Array(32));
export const PROBE_LAUNCH = new PublicKey(new Uint8Array(32).fill(1));
/* The create_launch data the message hashes: a discriminator's worth of zeros, never a real launch's. */
export const PROBE_DATA = new Uint8Array(8);
export const PROBE_LIFE_SECS = 60;

export interface KeyProbe {
  slot: string;
  publicKey: string;
  signed: boolean;
  failure: string | null;
  verifies: boolean;
  inConfig: boolean | null;
  ms: number;
}
export interface ProbeResult {
  ok: boolean;
  cluster: string;
  expected: number;
  keys: KeyProbe[];
  configRead: boolean;
  messageBytes: number;
  why: string[];
}

/* Each signer once, in order; attestors null when the Config could not be read (then nothing passes). */
export async function probeKeys(signers: readonly AttestSigner[], attestors: readonly string[] | null, o: { cluster: string; nowSec: number; expected?: number; clock?: () => number }): Promise<ProbeResult> {
  const expected = o.expected ?? 2;
  const clock = o.clock ?? Date.now;
  const message = await createAttestMessage(PROBE_CREATOR, PROBE_LAUNCH, PROBE_DATA, o.nowSec + PROBE_LIFE_SECS);
  const keys: KeyProbe[] = [];
  for (const [i, s] of signers.entries()) {
    const started = clock();
    let signature: Uint8Array | null = null;
    let failure: string | null = null;
    try {
      signature = await s.sign(message);
    } catch (e) {
      failure = e instanceof KmsSignerError ? e.code : "request";
    }
    const verifies = signature !== null && signature.length === 64 && ed25519Verifies(s.publicKey, message, signature);
    keys.push({ slot: (s.label ?? `signer${i}`).replace(/^kms-/, ""), publicKey: s.publicKey, signed: signature !== null, failure, verifies, inConfig: attestors ? attestors.includes(s.publicKey) : null, ms: Math.max(0, clock() - started) });
  }
  const why: string[] = [];
  if (keys.length !== expected) why.push(`${keys.length} keys configured, ${expected} expected`);
  if (new Set(keys.map((k) => k.publicKey)).size !== keys.length) why.push("two slots hold the same public key");
  if (!attestors) why.push("the Config could not be read");
  for (const k of keys) {
    if (!k.signed) why.push(`${k.slot}: did not sign (${k.failure})`);
    else if (!k.verifies) why.push(`${k.slot}: the signature does not verify`);
    if (k.inConfig === false) why.push(`${k.slot}: not one of the Config's attestors`);
  }
  return { ok: why.length === 0, cluster: o.cluster, expected, keys, configRead: attestors !== null, messageBytes: message.length, why };
}
