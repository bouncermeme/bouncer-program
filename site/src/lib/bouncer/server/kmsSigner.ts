/*
  The attestor's mainnet signer: Ed25519 keys held in AWS KMS (launch candidate,
  2026-10-22, the founder: AWS KMS replaces Turnkey; docs/AWS-KMS-SETUP.md is his setup,
  step by step). Each key is the AttestSigner of server/attest.ts: a public key and
  sign(message) for the 125-byte bid and 40-byte creation messages. Server only:
  nothing here may be imported by a page or a client component.

  How the site reaches AWS (the founder, 2026-10-22): Vercel OIDC first. The function's
  Vercel OIDC token is exchanged for a role's short-lived credentials through STS
  AssumeRoleWithWebIdentity (fromWebToken); the role's trust is scoped to the
  team, the project and the production environment, and its only policy is
  BouncerAttestorSignOnly. No AWS secret sits in the environment. The token comes
  from the request's header or VERCEL_OIDC_TOKEN only, never refreshed: no disk
  cache, no Vercel CLI (fresh review 22e2 M1).
  An access key pair is an optional fallback, used only when no role is set; a role
  and a key pair together are refused (set one, not both). Every name is prefixed
  BOUNCER_: Vercel injects AWS_REGION (the function's own region, not the keys'),
  AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY and AWS_SESSION_TOKEN into every
  function, and none of them is read here. The keys live in us-east-2; the region
  is BOUNCER_KMS_REGION, and a key given as an ARN must name that region.

  The keys: KeySpec ECC_NIST_EDWARDS25519, KeyUsage SIGN_VERIFY, created in KMS and
  never exportable (KMS has no export for an asymmetric private key). Two of them,
  main and backup, both listed in the program Config's attestors: the permit names
  the key that signed it (the Ed25519 instruction carries the public key, and the
  program accepts any of the Config's three; lib.rs check_attestation), so the
  backup's permit is as good as the main's. attest.ts tries the main key, then the
  backup once, in the same request (signFirst).

  The call is kms:Sign with SigningAlgorithm ED25519_SHA_512 and MessageType RAW:
  RFC 8032 Ed25519 over the message itself (pure EdDSA; the hash inside is the
  algorithm's own SHA-512). The answer is 64 raw bytes, R || S.

  Nothing KMS says is trusted. The configured public key (base58, what goes into
  the Config) is the key: GetPublicKey's DER SubjectPublicKeyInfo must be the
  Ed25519 SPKI exactly (the OID 1.3.101.112 prefix, 44 bytes) and hold that key,
  once per process per key; Sign then names the canonical key ARN GetPublicKey
  answered (KeyId), so an alias moved later cannot change the key; every
  signature must be 64 bytes and verify here, with Node's own Ed25519, against
  that key over the exact message.

  Fail closed. Anything short of that throws a KmsSignerError: an error from KMS,
  no answer within the deadline (3 s for a key, its public key read included), a
  public key of another shape or another key, a signature of the wrong length or
  by another key. attest.ts turns a throw into the next key, then "signer-down".
  The errors carry a fixed code and sentence; KMS's own text, the request and every
  environment value stay out of them.
*/
import { createPublicKey, verify as edVerify } from "node:crypto";
import bs58 from "bs58";
import { GetPublicKeyCommand, KMSClient, SignCommand } from "@aws-sdk/client-kms";
import { fromWebToken } from "@aws-sdk/credential-provider-web-identity";
import { getVercelOidcTokenSync } from "@vercel/oidc";
import type { AttestSigner } from "./attest";

export const KMS_TIMEOUT_MS = 3_000;
/* The DER prefix of an Ed25519 SubjectPublicKeyInfo: SEQUENCE(42) { SEQUENCE(5) { OID 1.3.101.112 }, BIT STRING(33) 0x00 }, then the 32 bytes. */
export const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
export const KMS_KEY_SPEC = "ECC_NIST_EDWARDS25519";
export const KMS_SIGNING_ALGORITHM = "ED25519_SHA_512";

/*
  The variables. Mainnet reads the first set only. Devnet reads the second set
  only, and only when ATTEST_KMS_DEVNET_REHEARSAL is "1" (attest.ts signersFromEnv):
  a separate devnet TEST key and its own role (Astra L5), never the production ones.
*/
export const KMS_ENV = {
  region: "BOUNCER_KMS_REGION",
  mainnet: {
    roleArn: "BOUNCER_AWS_ROLE_ARN",
    accessKeyId: "BOUNCER_AWS_ACCESS_KEY_ID",
    secretAccessKey: "BOUNCER_AWS_SECRET_ACCESS_KEY",
    mainKeyId: "BOUNCER_KMS_ATTESTOR_KEY_ID",
    mainPubkey: "BOUNCER_KMS_ATTESTOR_PUBKEY",
    backupKeyId: "BOUNCER_KMS_ATTESTOR_BACKUP_KEY_ID",
    backupPubkey: "BOUNCER_KMS_ATTESTOR_BACKUP_PUBKEY",
  },
  devnet: {
    roleArn: "BOUNCER_AWS_DEVNET_ROLE_ARN",
    accessKeyId: "BOUNCER_AWS_DEVNET_ACCESS_KEY_ID",
    secretAccessKey: "BOUNCER_AWS_DEVNET_SECRET_ACCESS_KEY",
    mainKeyId: "BOUNCER_KMS_DEVNET_ATTESTOR_KEY_ID",
    mainPubkey: "BOUNCER_KMS_DEVNET_ATTESTOR_PUBKEY",
    backupKeyId: "BOUNCER_KMS_DEVNET_ATTESTOR_BACKUP_KEY_ID",
    backupPubkey: "BOUNCER_KMS_DEVNET_ATTESTOR_BACKUP_PUBKEY",
  },
} as const;
export const KMS_DEVNET_REHEARSAL = "ATTEST_KMS_DEVNET_REHEARSAL";
/*
  The production keys (the founder's account 000000000000, us-east-2, created
  2026-10-22): bouncer-attestor-main and bouncer-attestor-backup, and the production
  role. A devnet set naming either key, by bare id or inside an ARN, or that role,
  is refused whatever else the project's environment holds (the devnet project
  never carries the mainnet variables, so a comparison with them alone would never
  fire there). An alias can name a production key without its id, so the devnet
  set takes no alias at all, and its signer refuses a key whose canonical ARN
  (GetPublicKey's KeyId) holds a production id (fresh review 22e2 L1, Astra L1).
*/
export const PRODUCTION_KMS_KEY_IDS = ["d95d8fde-3014-43b8-8a88-11f278bd76eb", "ba3902e8-6b39-4b77-850c-d999ff314c19"] as const;
export const PRODUCTION_ROLE_ARNS = ["arn:aws:iam::000000000000:role/bouncer-attestor-mainnet"] as const;
const isProductionKeyId = (keyId: string): boolean => PRODUCTION_KMS_KEY_IDS.some((id) => keyId.toLowerCase().includes(id));
export const OIDC_SESSION_NAME = "bouncer-attestor";
export const OIDC_SESSION_SECONDS = 900;

export type KmsSet = "mainnet" | "devnet";
export type KeySlot = "main" | "backup";
/* The environment as this module reads it: names to values (process.env, or a test's plain object). */
export type KmsEnv = Readonly<Record<string, string | undefined>>;

export interface KmsKey {
  slot: KeySlot;
  keyId: string;
  /* The base58 Ed25519 public key the program's Config lists: the key, whatever KMS says. */
  publicKey: string;
}
/* oidc: the role assumed with the function's Vercel OIDC token (primary). keys: the fallback access key pair. */
export type KmsAuth = { kind: "oidc"; roleArn: string } | { kind: "keys"; accessKeyId: string; secretAccessKey: string };
export interface KmsConfig {
  region: string;
  auth: KmsAuth;
  /* main first, then the backup when configured. */
  keys: KmsKey[];
  timeoutMs: number;
}
/* What the environment lacks or holds unusable, by variable name only. */
export type KmsConfigResult = { ok: true; cfg: KmsConfig } | { ok: false; missing: string[]; invalid: string[] };

/* A key id, an alias, or the ARN of either (KMS accepts all four for Sign and GetPublicKey). */
const KEY_ID_RE = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|mrk-[0-9a-f]{32}|alias\/[A-Za-z0-9/_-]{1,250}|arn:aws[a-z-]*:kms:[a-z0-9-]+:\d{12}:(?:key\/(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|mrk-[0-9a-f]{32})|alias\/[A-Za-z0-9/_-]{1,250}))$/;
const REGION_RE = /^[a-z]{2}(?:-gov)?-[a-z]+-\d$/;
const ACCESS_KEY_RE = /^(?:AKIA|ASIA)[A-Z0-9]{16}$/;
const SECRET_RE = /^[A-Za-z0-9/+=]{40}$/;
const ROLE_ARN_RE = /^arn:aws(?:-us-gov|-cn)?:iam::\d{12}:role\/[A-Za-z0-9+=,.@_/-]{1,512}$/;
/* A key ARN, the canonical form GetPublicKey answers in KeyId (never an alias). */
const KEY_ARN_RE = /^arn:aws[a-z-]*:kms:[a-z0-9-]+:\d{12}:key\/(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|mrk-[0-9a-f]{32})$/;
const isAlias = (keyId: string): boolean => keyId.startsWith("alias/") || /^arn:[^:]*:kms:[^:]*:[^:]*:alias\//.test(keyId);
/* The region an ARN names (arn:partition:kms:REGION:...), or null for a bare id or an alias. */
const arnRegion = (keyId: string): string | null => (keyId.startsWith("arn:") ? (keyId.split(":")[3] ?? "") : null);

export function isEd25519Address(s: string): boolean {
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s)) return false;
  try {
    return bs58.decode(s).length === 32;
  } catch {
    return false;
  }
}

export function kmsConfigFromEnv(env: KmsEnv = process.env, set: KmsSet = "mainnet", timeoutMs: number = KMS_TIMEOUT_MS): KmsConfigResult {
  const get = (name: string) => (env[name] ?? "").trim();
  const missing: string[] = [];
  const invalid: string[] = [];
  const need = (name: string, ok: (v: string) => boolean): string => {
    const v = get(name);
    if (!v) missing.push(name);
    else if (!ok(v)) invalid.push(name);
    return v;
  };
  const names = KMS_ENV[set];
  const region = need(KMS_ENV.region, (v) => REGION_RE.test(v));
  /* The role first. The key pair only when no role is set, both halves; a role and a key pair together refuse. */
  let auth: KmsAuth;
  const role = get(names.roleArn);
  const kId = get(names.accessKeyId);
  const kSecret = get(names.secretAccessKey);
  if (role) {
    const roleArn = need(names.roleArn, (v) => ROLE_ARN_RE.test(v));
    if (kId) invalid.push(names.accessKeyId);
    if (kSecret) invalid.push(names.secretAccessKey);
    auth = { kind: "oidc", roleArn };
  } else if (kId || kSecret) {
    const accessKeyId = need(names.accessKeyId, (v) => ACCESS_KEY_RE.test(v));
    const secretAccessKey = need(names.secretAccessKey, (v) => SECRET_RE.test(v));
    auth = { kind: "keys", accessKeyId, secretAccessKey };
  } else {
    missing.push(names.roleArn);
    auth = { kind: "oidc", roleArn: "" };
  }
  const mainKeyId = need(names.mainKeyId, (v) => KEY_ID_RE.test(v));
  const mainPubkey = need(names.mainPubkey, isEd25519Address);
  const keys: KmsKey[] = [{ slot: "main", keyId: mainKeyId, publicKey: mainPubkey }];
  /* The backup is optional, but both halves or neither: a half-set backup is a typo that would show only on the day the main key fails. */
  const bId = get(names.backupKeyId);
  const bPub = get(names.backupPubkey);
  if (bId || bPub) {
    const backupKeyId = need(names.backupKeyId, (v) => KEY_ID_RE.test(v));
    const backupPubkey = need(names.backupPubkey, isEd25519Address);
    if (backupPubkey && backupPubkey === mainPubkey) invalid.push(names.backupPubkey);
    if (backupKeyId && backupKeyId === mainKeyId) invalid.push(names.backupKeyId);
    keys.push({ slot: "backup", keyId: backupKeyId, publicKey: backupPubkey });
  }
  /* A key given as an ARN names its region: it must be the configured one (the keys are single-region, us-east-2). */
  for (const k of keys) {
    const r = arnRegion(k.keyId);
    if (r !== null && region && r !== region) invalid.push(k.slot === "main" ? names.mainKeyId : names.backupKeyId);
  }
  /*
    A devnet rehearsal never runs on the production keys or the production role: an
    alias or alias ARN (the TEST key has a bare id), a production key id (built in,
    or the same key id or public key as the mainnet set), or the production role
    (built in, or the mainnet role ARN) refuses it. The mainnet names are read here
    only to refuse.
  */
  if (set === "devnet") {
    const prod = KMS_ENV.mainnet;
    const prodIds = [get(prod.mainKeyId), get(prod.backupKeyId)].filter(Boolean);
    const prodPubs = [get(prod.mainPubkey), get(prod.backupPubkey)].filter(Boolean);
    for (const k of keys) {
      if (isAlias(k.keyId) || prodIds.includes(k.keyId) || isProductionKeyId(k.keyId)) invalid.push(k.slot === "main" ? names.mainKeyId : names.backupKeyId);
      if (prodPubs.includes(k.publicKey)) invalid.push(k.slot === "main" ? names.mainPubkey : names.backupPubkey);
    }
    const prodRoles = [...PRODUCTION_ROLE_ARNS, get(prod.roleArn)].filter(Boolean).map((r) => r.toLowerCase());
    if (auth.kind === "oidc" && auth.roleArn && prodRoles.includes(auth.roleArn.toLowerCase())) invalid.push(names.roleArn);
  }
  if (missing.length || invalid.length) return { ok: false, missing, invalid: [...new Set(invalid)] };
  return { ok: true, cfg: { region, auth, keys, timeoutMs } };
}

/* ---------------- the client ---------------- */

/* The two calls this signer makes, so a test can stand in for KMS. */
export interface KmsLike {
  getPublicKey(keyId: string, signal: AbortSignal): Promise<{ KeyId?: string; PublicKey?: Uint8Array; KeySpec?: string; KeyUsage?: string }>;
  sign(keyId: string, message: Uint8Array, signal: AbortSignal): Promise<{ Signature?: Uint8Array; SigningAlgorithm?: string }>;
}
/* What the SDK client offers: send(command, { abortSignal }). A test passes its own to read the commands. */
export interface KmsSend {
  send(command: unknown, options?: { abortSignal?: AbortSignal }): Promise<unknown>;
}

/* The commands exactly as sent: Sign with ED25519_SHA_512 over the raw message, GetPublicKey by key id. */
export function kmsLike(sdk: KmsSend): KmsLike {
  return {
    async getPublicKey(keyId, signal) {
      return (await sdk.send(new GetPublicKeyCommand({ KeyId: keyId }), { abortSignal: signal })) as { KeyId?: string; PublicKey?: Uint8Array; KeySpec?: string; KeyUsage?: string };
    },
    async sign(keyId, message, signal) {
      return (await sdk.send(new SignCommand({ KeyId: keyId, Message: message, MessageType: "RAW", SigningAlgorithm: KMS_SIGNING_ALGORITHM }), { abortSignal: signal })) as { Signature?: Uint8Array; SigningAlgorithm?: string };
    },
  };
}

/*
  The credentials the KMS client signs with. oidc: a provider the SDK calls when it
  needs credentials (and again when they expire): the function's Vercel OIDC token
  (the request's x-vercel-oidc-token header, or VERCEL_OIDC_TOKEN) for a 15-minute
  role session from STS in the keys' region, one attempt inside the same deadline.
  No token: KmsSignerError "request" before STS is asked. The token is never
  refreshed (getVercelOidcToken would read a disk cache or run the Vercel CLI).
  keys: the static pair, no session token (never the injected AWS_SESSION_TOKEN).
*/
export function kmsCredentials(cfg: Pick<KmsConfig, "region" | "auth" | "timeoutMs">, opts: { stsEndpoint?: string } = {}) {
  if (cfg.auth.kind === "keys") return { accessKeyId: cfg.auth.accessKeyId, secretAccessKey: cfg.auth.secretAccessKey };
  const roleArn = cfg.auth.roleArn;
  return async (props?: Parameters<ReturnType<typeof fromWebToken>>[0]) => {
    let webIdentityToken: string;
    try {
      webIdentityToken = getVercelOidcTokenSync();
    } catch {
      throw new KmsSignerError("request");
    }
    return fromWebToken({
      roleArn,
      roleSessionName: OIDC_SESSION_NAME,
      durationSeconds: OIDC_SESSION_SECONDS,
      webIdentityToken,
      clientConfig: {
        region: cfg.region,
        maxAttempts: 1,
        requestHandler: { connectionTimeout: Math.min(1_000, cfg.timeoutMs), requestTimeout: cfg.timeoutMs },
        ...(opts.stsEndpoint ? { endpoint: opts.stsEndpoint } : {}),
      },
    })(props);
  };
}

/* One SDK client per region and identity per process (the route builds its deps on every request; the client keeps the role session until it expires). One attempt: the backup key is the retry. */
const clients = new Map<string, KMSClient>();
export function kmsSdkClient(cfg: Pick<KmsConfig, "region" | "auth" | "timeoutMs">, opts: { endpoint?: string; stsEndpoint?: string } = {}): KMSClient {
  const who = cfg.auth.kind === "oidc" ? `role:${cfg.auth.roleArn}` : `key:${cfg.auth.accessKeyId}`;
  const k = `${cfg.region}|${who}|${opts.endpoint ?? ""}|${opts.stsEndpoint ?? ""}`;
  let c = clients.get(k);
  if (!c) {
    c = new KMSClient({
      region: cfg.region,
      credentials: kmsCredentials(cfg, opts),
      maxAttempts: 1,
      requestHandler: { connectionTimeout: Math.min(1_000, cfg.timeoutMs), requestTimeout: cfg.timeoutMs },
      /* Only the check script sets an endpoint (a loopback server); the environment never can. */
      ...(opts.endpoint ? { endpoint: opts.endpoint } : {}),
    });
    clients.set(k, c);
  }
  return c;
}

/* ---------------- the signer ---------------- */

export type KmsFailure = "timeout" | "request" | "public-key" | "key-mismatch" | "no-signature" | "bad-signature";
const SENTENCE: Record<KmsFailure, string> = {
  timeout: "KMS did not answer in time; nothing was signed.",
  request: "KMS refused or failed the request; nothing was signed.",
  "public-key": "KMS's public key is not an Ed25519 key; nothing was signed.",
  "key-mismatch": "KMS's public key is not the configured attestor key; nothing was signed.",
  "no-signature": "KMS's answer held no 64-byte signature; nothing was signed.",
  "bad-signature": "KMS's signature does not verify for the attestor key; nothing was signed.",
};
export class KmsSignerError extends Error {
  readonly code: KmsFailure;
  constructor(code: KmsFailure) {
    super(SENTENCE[code]);
    this.name = "KmsSignerError";
    this.code = code;
  }
}

export function ed25519Verifies(publicKey: string, message: Uint8Array, signature: Uint8Array): boolean {
  if (signature.length !== 64) return false;
  try {
    const key = createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(bs58.decode(publicKey))]), format: "der", type: "spki" });
    return edVerify(null, Buffer.from(message), key, Buffer.from(signature));
  } catch {
    return false;
  }
}

/* The 32 bytes of an Ed25519 SubjectPublicKeyInfo, or a throw: exactly 44 bytes, exactly the Ed25519 prefix. */
export function spkiToEd25519(der: Uint8Array | undefined | null): Uint8Array {
  if (!der || der.length !== ED25519_SPKI_PREFIX.length + 32) throw new KmsSignerError("public-key");
  if (!Buffer.from(der.subarray(0, ED25519_SPKI_PREFIX.length)).equals(ED25519_SPKI_PREFIX)) throw new KmsSignerError("public-key");
  return new Uint8Array(der.subarray(ED25519_SPKI_PREFIX.length));
}

/* The public keys KMS has shown to be the configured ones, per process: "set|keyId|publicKey" to the key ARN Sign names. */
const confirmed = new Map<string, string>();
export function resetKmsCache(): void {
  confirmed.clear();
  clients.clear();
}

/*
  set: "devnet" for the rehearsal's keys. There GetPublicKey must answer a key ARN
  (KeyId) and it must not hold a production key id: key-mismatch otherwise, and
  Sign is never asked. Mainnet signs with the answered key ARN, or the configured
  id when KMS names none; a KeyId that is not a key ARN is refused on either set.
*/
export function kmsSigner(key: KmsKey, client: KmsLike, timeoutMs: number = KMS_TIMEOUT_MS, set: KmsSet = "mainnet"): AttestSigner {
  return {
    publicKey: key.publicKey,
    label: `kms-${key.slot}`,
    async sign(message: Uint8Array): Promise<Uint8Array> {
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      /* One deadline for the key: its public key read (the first time) and the signature. */
      const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new KmsSignerError("timeout"));
        }, timeoutMs);
      });
      const within = <T>(p: Promise<T>): Promise<T> =>
        Promise.race([
          p.catch((e: unknown) => {
            throw e instanceof KmsSignerError ? e : controller.signal.aborted ? new KmsSignerError("timeout") : new KmsSignerError("request");
          }),
          deadline,
        ]);
      try {
        const cacheKey = `${set}|${key.keyId}|${key.publicKey}`;
        let signWith = confirmed.get(cacheKey);
        if (signWith === undefined) {
          const pk = await within(client.getPublicKey(key.keyId, controller.signal));
          if (pk?.KeySpec !== undefined && pk.KeySpec !== KMS_KEY_SPEC) throw new KmsSignerError("public-key");
          if (pk?.KeyUsage !== undefined && pk.KeyUsage !== "SIGN_VERIFY") throw new KmsSignerError("public-key");
          const raw = spkiToEd25519(pk?.PublicKey);
          if (!Buffer.from(raw).equals(Buffer.from(bs58.decode(key.publicKey)))) throw new KmsSignerError("key-mismatch");
          const canonical = pk?.KeyId;
          if (canonical !== undefined && !(typeof canonical === "string" && KEY_ARN_RE.test(canonical))) throw new KmsSignerError("key-mismatch");
          if (set === "devnet" && (canonical === undefined || isProductionKeyId(canonical))) throw new KmsSignerError("key-mismatch");
          signWith = canonical ?? key.keyId;
          confirmed.set(cacheKey, signWith);
        }
        const out = await within(client.sign(signWith, message, controller.signal));
        if (out?.SigningAlgorithm !== undefined && out.SigningAlgorithm !== KMS_SIGNING_ALGORITHM) throw new KmsSignerError("no-signature");
        const sig = out?.Signature;
        if (!(sig instanceof Uint8Array) || sig.length !== 64) throw new KmsSignerError("no-signature");
        const signature = new Uint8Array(sig);
        if (!ed25519Verifies(key.publicKey, message, signature)) throw new KmsSignerError("bad-signature");
        return signature;
      } finally {
        if (timer) clearTimeout(timer);
      }
    },
  };
}

/* The deployment's KMS signers for one set (main, then backup), or none when the environment does not configure that set completely. */
export function kmsSignersFromEnv(env: KmsEnv = process.env, set: KmsSet = "mainnet", client?: KmsLike): AttestSigner[] {
  const c = kmsConfigFromEnv(env, set);
  if (!c.ok) return [];
  const kms = client ?? kmsLike(kmsSdkClient(c.cfg));
  return c.cfg.keys.map((k) => kmsSigner(k, kms, c.cfg.timeoutMs, set));
}
