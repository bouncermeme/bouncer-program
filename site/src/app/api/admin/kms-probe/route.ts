/*
  POST /api/admin/kms-probe (the independent review of 2026-10-30, finding 5; server/kmsProbe.ts): signs one
  never-usable creation-permit message with each configured attestor key in turn, main then backup, and answers per key
  whether KMS signed, the signature verifies under the configured key, and that key is one of the Config's attestors.
  The main key is never disabled; each key is asked on its own.

  Closed (404) unless KMS_PROBE_SECRET is set (32 characters or more); then the header x-kms-probe-secret must equal
  it, or 401. Behind the coming-soon gate like every /api route. the founder sets the secret for the probe and removes it
  after. On mainnet the keys are the production set through the deployment's role; on devnet only the rehearsal's test
  keys (ATTEST_KMS_DEVNET_REHEARSAL=1), never the env key. Answers 200 when every check passes, 503 otherwise, the
  reasons in `why`. Never cached; the answer and the log carry public keys, slots and codes only.
*/
import { createHash, timingSafeEqual } from "node:crypto";
import { CLUSTER } from "@contract/active";
import { decodeConfig } from "@/lib/bouncer/chain/decode";
import { signersFromEnv } from "@/lib/bouncer/server/attest";
import { probeKeys } from "@/lib/bouncer/server/kmsProbe";
import { answer, fail, log, route } from "@/lib/bouncer/server/output";
import { readConfig, serverHasRpc } from "@/lib/bouncer/server/snapshot";

export const maxDuration = 20;

const SECRET_MIN = 32;
const digest = (s: string) => createHash("sha256").update(s).digest();

async function readAttestors(): Promise<readonly string[] | null> {
  if (!serverHasRpc()) return null;
  try {
    const s = await readConfig();
    const config = s.config ? decodeConfig(s.config.address, Uint8Array.from(Buffer.from(s.config.data, "base64"))) : null;
    return config ? config.attestors : null;
  } catch {
    return null;
  }
}

export const POST = route(async (req: Request): Promise<Response> => {
  const secret = (process.env.KMS_PROBE_SECRET ?? "").trim();
  if (secret.length < SECRET_MIN) return fail("notFound");
  if (!timingSafeEqual(digest(req.headers.get("x-kms-probe-secret") ?? ""), digest(secret))) return fail("unauthorized");
  const signers = signersFromEnv(process.env, CLUSTER).filter((s) => (s.label ?? "").startsWith("kms-"));
  const r = await probeKeys(signers, await readAttestors(), { cluster: CLUSTER, nowSec: Math.floor(Date.now() / 1000) });
  log("info", { event: "KMS_PROBE", ok: r.ok, keys: r.keys.map((k) => `${k.slot}:${k.signed ? (k.verifies ? "verified" : "unverified") : k.failure}:${k.inConfig === null ? "config?" : k.inConfig ? "in-config" : "not-in-config"}`) });
  return answer(r, { status: r.ok ? 200 : 503, cache: "no-store" });
});
