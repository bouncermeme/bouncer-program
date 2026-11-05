"use client";

/*
  A Wallet Standard wallet that lives in this page, for rehearsing what a
  real extension does to a bidder: decline, sit unanswered, switch account,
  disconnect, refuse the cluster, or report an error after it already sent.
  It registers itself the way Phantom does (the wallet-standard:register-wallet
  event), so the site's adapter, sheet and signer take exactly the path they
  take with Phantom; only the popup is missing. Off unless
  NEXT_PUBLIC_DEV_WALLET=1, named unsafe wherever it appears, devnet and the
  local validator only. Its two keypairs sit in localStorage.

  One knob, localStorage bouncer:rehearsal, read at each call:
    reject-connect        connect throws like a closed prompt
    locked                connect waits two seconds, then throws like a closed unlock prompt
    reject-sign           signing throws like the Reject button
    delay:<ms>            signing answers after that many milliseconds (past about 90 s the transaction has expired)
    switch                the wallet's active account changes while the prompt is open and it signs as the new one
    switch-then-sign      the active account changes, but the wallet still signs as the one asked
    disconnect            the wallet disconnects while the prompt is open
    disconnect-after-send the wallet signs, then disconnects a second later
    drop-send             (signAndSend only) the wallet broadcasts, then throws as if the network had failed
  Two are read once, when the wallet registers, so they need a reload:
    no-chain              the account offers solana:mainnet only
    send-only             the wallet offers signAndSendTransaction and no signTransaction
*/
import { Connection, Keypair, Transaction, VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58";
import type { Wallet, WalletAccount, WalletIcon } from "@wallet-standard/base";
import { registerWallet } from "@wallet-standard/wallet";
import { StandardConnect, StandardDisconnect, StandardEvents } from "@wallet-standard/features";
import { SolanaSignAndSendTransaction, SolanaSignTransaction } from "@solana/wallet-standard-features";

export const REHEARSAL_WALLET_NAME = "Rehearsal wallet (unsafe)";
const KNOB = "bouncer:rehearsal";
const KEY_A = "bouncer:rehearsal-key";
const KEY_B = "bouncer:rehearsal-key-2";

const ALL_CHAINS = ["solana:mainnet", "solana:devnet", "solana:testnet", "solana:localnet"] as const;
const ENDPOINT: Record<string, string> = {
  "solana:mainnet": "https://api.mainnet-beta.solana.com",
  "solana:devnet": "https://api.devnet.solana.com",
  "solana:testnet": "https://api.testnet.solana.com",
  "solana:localnet": "http://127.0.0.1:8899",
};

const TRUSTED = "bouncer:rehearsal-trusted";

function knobRead(name: string): string | null {
  try {
    return window.localStorage.getItem(name);
  } catch {
    return null;
  }
}
function knobWrite(name: string, value: string | null) {
  try {
    if (value === null) window.localStorage.removeItem(name);
    else window.localStorage.setItem(name, value);
  } catch {}
}
/* The knob may hold several words separated by commas, e.g. "send-only,drop-send". */
function knobs(): Set<string> {
  return new Set((knobRead(KNOB) ?? "").split(",").map((s) => s.trim()).filter(Boolean));
}
function has(word: string): boolean {
  return knobs().has(word);
}
function delayMs(): number {
  for (const k of knobs()) {
    const m = /^delay:(\d+)$/.exec(k);
    if (m) return Number(m[1]);
  }
  return 0;
}
function knob(): string {
  return knobRead(KNOB) ?? "";
}

function loadKey(name: string): Keypair {
  try {
    const raw = window.localStorage.getItem(name);
    if (raw) return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw) as number[]));
  } catch {}
  const kp = Keypair.generate();
  try {
    window.localStorage.setItem(name, JSON.stringify(Array.from(kp.secretKey)));
  } catch {}
  return kp;
}

const ICON: WalletIcon = `data:image/svg+xml;base64,${typeof btoa === "function" ? btoa('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 36 36"><rect width="36" height="36" rx="8" fill="#2a1f24"/><path d="M8 24l5-12 5 12M9.5 20h7" stroke="#e9d9c7" stroke-width="2.4" fill="none" stroke-linecap="round" stroke-linejoin="round"/><circle cx="26" cy="12" r="3" fill="#b8323f"/></svg>') : ""}`;

type Listener = (props: { accounts?: readonly WalletAccount[]; chains?: readonly string[]; features?: readonly string[] }) => void;

function makeAccount(kp: Keypair, chains: readonly string[], features: readonly string[]): WalletAccount {
  return { address: kp.publicKey.toBase58(), publicKey: kp.publicKey.toBytes(), chains: chains as WalletAccount["chains"], features: features as WalletAccount["features"], label: "Rehearsal" };
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

/* A serialized transaction is its signatures (a short count, then 64 bytes each) and then the message; a version 0 message starts with a byte whose high bit is set. */
function fromBytes(bytes: Uint8Array): Transaction | VersionedTransaction {
  let n = 0;
  let shift = 0;
  let i = 0;
  for (;;) {
    const b = bytes[i++];
    n |= (b & 0x7f) << shift;
    if ((b & 0x80) === 0) break;
    shift += 7;
  }
  return (bytes[i + 64 * n] & 0x80) !== 0 ? VersionedTransaction.deserialize(bytes) : Transaction.from(bytes);
}
function signBytes(bytes: Uint8Array, kp: Keypair): Uint8Array {
  const tx = fromBytes(bytes);
  if (tx instanceof VersionedTransaction) {
    tx.sign([kp]);
    return tx.serialize();
  }
  tx.partialSign(kp);
  return new Uint8Array(tx.serialize({ requireAllSignatures: false, verifySignatures: false }));
}
/* Every call of a signing feature is one prompt in a real wallet. Counted on window for the proof runs (2026-10-07, one prompt for the whole batch). */
function countPrompt(kind: string, n: number): number {
  const w = window as unknown as { __rehearsalPrompts?: number; __rehearsalPromptLog?: { kind: string; transactions: number; at: number }[] };
  w.__rehearsalPrompts = (w.__rehearsalPrompts ?? 0) + 1;
  (w.__rehearsalPromptLog ??= []).push({ kind, transactions: n, at: Date.now() });
  console.info(`[rehearsal wallet] prompt ${w.__rehearsalPrompts}: ${kind}, ${n} transaction${n === 1 ? "" : "s"}`);
  return w.__rehearsalPrompts;
}

export interface RehearsalHandle {
  addressA: string;
  addressB: string;
}

let installed: RehearsalHandle | null = null;

export function installRehearsalWallet(): RehearsalHandle {
  if (installed) return installed;
  const a = loadKey(KEY_A);
  const b = loadKey(KEY_B);
  const startKnob = knob();
  const chains: readonly string[] = has("no-chain") ? ["solana:mainnet"] : ALL_CHAINS;
  const sendOnly = has("send-only");
  const featureNames: string[] = sendOnly ? [SolanaSignAndSendTransaction] : [SolanaSignTransaction, SolanaSignAndSendTransaction];

  const listeners = new Set<Listener>();
  let accounts: WalletAccount[] = [];
  const emit = () => listeners.forEach((l) => l({ accounts }));
  const setActive = (kp: Keypair | null) => {
    accounts = kp ? [makeAccount(kp, chains, featureNames)] : [];
    emit();
  };
  const keyFor = (address: string): Keypair | null => (address === a.publicKey.toBase58() ? a : address === b.publicKey.toBase58() ? b : null);

  const signFeature = {
    version: "1.0.0",
    supportedTransactionVersions: ["legacy", 0] as const,
    signTransaction: async (...inputs: { account: WalletAccount; transaction: Uint8Array }[]) => {
      const mode = knob();
      countPrompt("sign", inputs.length);
      if (has("reject-sign")) throw new Error("User rejected the request.");
      if (delayMs() > 0) await sleep(delayMs());
      if (has("disconnect")) {
        setActive(null);
        throw new Error("Wallet disconnected.");
      }
      if (has("switch")) {
        /* The person switched accounts in the wallet while the prompt was open. The requested account is no longer active, so the wallet refuses to sign for it. */
        setActive(b);
        await sleep(300);
        throw new Error("The active account is not the one this request is for.");
      } else if (has("switch-then-sign")) {
        /* Same switch, but the wallet honours the request as made. */
        setActive(b);
        await sleep(300);
      }
      const out = inputs.map(({ account, transaction }) => {
        const kp = keyFor(account.address);
        if (!kp) throw new Error("Unknown account.");
        return { signedTransaction: signBytes(transaction, kp) };
      });
      if (has("disconnect-after-send")) setTimeout(() => setActive(null), 1000);
      void mode;
      return out;
    },
  };

  const sendFeature = {
    version: "1.0.0",
    supportedTransactionVersions: ["legacy", 0] as const,
    signAndSendTransaction: async (...inputs: { account: WalletAccount; chain: string; transaction: Uint8Array; options?: { preflightCommitment?: string; skipPreflight?: boolean } }[]) => {
      countPrompt("signAndSend", inputs.length);
      if (has("reject-sign")) throw new Error("User rejected the request.");
      if (delayMs() > 0) await sleep(delayMs());
      if (has("disconnect")) {
        setActive(null);
        throw new Error("Wallet disconnected.");
      }
      const out = [];
      for (const { account, chain, transaction } of inputs) {
        if (!account.chains.includes(chain as WalletAccount["chains"][number])) throw new Error(`This account does not offer ${chain}.`);
        const kp = keyFor(account.address);
        if (!kp) throw new Error("Unknown account.");
        /* A compliant wallet sends on the chain it was handed, whatever its own setting says. */
        const conn = new Connection(ENDPOINT[chain] ?? ENDPOINT["solana:mainnet"], "confirmed");
        const sig = await conn.sendRawTransaction(signBytes(transaction, kp), { skipPreflight: false, preflightCommitment: "confirmed" });
        if (has("drop-send")) throw new Error("Network request failed.");
        out.push({ signature: bs58.decode(sig) });
      }
      return out;
    },
  };

  const wallet = {
    version: "1.0.0" as const,
    name: REHEARSAL_WALLET_NAME,
    icon: ICON,
    get chains() {
      return chains as Wallet["chains"];
    },
    get accounts() {
      return accounts;
    },
    get features() {
      const f: Record<string, unknown> = {
        [StandardConnect]: {
          version: "1.0.0",
          connect: async (input?: { silent?: boolean }) => {
            /* Like Phantom: a silent connect succeeds only for a site the person approved before and has not disconnected from. */
            if (input?.silent) {
              if (accounts.length === 0 && knobRead(TRUSTED) !== "1") throw new Error("Not connected.");
              if (accounts.length === 0) setActive(has("use-b") ? b : a);
              return { accounts };
            }
            if (has("reject-connect")) throw new Error("User rejected the request.");
            if (has("locked")) {
              await sleep(2000);
              throw new Error("User rejected the request.");
            }
            /* use-b: the person picked the second account in the wallet before approving. */
            if (accounts.length === 0) setActive(has("use-b") ? b : a);
            knobWrite(TRUSTED, "1");
            return { accounts };
          },
        },
        [StandardDisconnect]: {
          version: "1.0.0",
          disconnect: async () => {
            knobWrite(TRUSTED, null);
            setActive(null);
          },
        },
        [StandardEvents]: {
          version: "1.0.0",
          on: (event: string, listener: Listener) => {
            if (event !== "change") return () => {};
            listeners.add(listener);
            console.info(`[rehearsal wallet] change listener added (${listeners.size})`);
            return () => {
              listeners.delete(listener);
              console.info(`[rehearsal wallet] change listener removed (${listeners.size})`);
            };
          },
        },
        [SolanaSignAndSendTransaction]: sendFeature,
      };
      if (!sendOnly) f[SolanaSignTransaction] = signFeature;
      return f as Wallet["features"];
    },
  };

  registerWallet(wallet as unknown as Wallet);
  installed = { addressA: a.publicKey.toBase58(), addressB: b.publicKey.toBase58() };
  (window as unknown as { __rehearsal?: RehearsalHandle }).__rehearsal = installed;
  (window as unknown as { __rehearsalWallet?: unknown }).__rehearsalWallet = wallet;
  (window as unknown as { __rehearsalDebug?: unknown }).__rehearsalDebug = () => ({ listeners: listeners.size, accounts: accounts.map((x) => x.address), knob: knob() });
  console.info(`[rehearsal wallet] registered; account A ${installed.addressA}, account B ${installed.addressB}; knob "${startKnob}"`);
  return installed;
}
