"use client";

import { useWallet } from "@solana/wallet-adapter-react";
import { getWallets } from "@wallet-standard/app";
import { Keypair, VersionedTransaction } from "@solana/web3.js";
import { ed25519 } from "@noble/curves/ed25519.js";
import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import bs58 from "bs58";
import type { WalletAccount } from "@wallet-standard/base";
import { SolanaSignAndSendTransaction, SolanaSignMessage, type SolanaSignAndSendTransactionFeature, type SolanaSignMessageFeature } from "@solana/wallet-standard-features";
import { checkCluster, clusterLabel, onPinStale, pinStillCurrent, pinnedChain, shortError, type ClusterCheck } from "@/lib/bouncer/chain/cluster";
import { getConnection, RPC_URL, setScopeWallet } from "@/lib/bouncer/chain/rpc";
import type { AnyTx, TxSigner } from "@/lib/bouncer/chain/signer";
import { DEV_WALLET_ENABLED } from "@/lib/bouncer/client";
import { disconnectWithin } from "@/lib/bouncer/walletDisconnect";
import { WalletSheet } from "./WalletSheet";

export type AccountKind = "wallet" | "devkey";

export interface Account {
  address: string | null;
  kind: AccountKind | null;
  walletName: string | null;
  connecting: boolean;
  /* Signs through the connected wallet, or the dev key. Null when nothing is connected. The client broadcasts and confirms. */
  signer: TxSigner | null;
  /* Why nothing can be signed right now (the network check failed, the wallet does not offer this cluster), or null. Every signing button reads it. */
  signProblem: string | null;
  /* The site's check of the RPC against the pin. Null while it runs. */
  cluster: ClusterCheck | null;
  recheckCluster: () => void;
  /* The chains the connected wallet offers for this account, from the Wallet Standard, or null when the wallet does not say. */
  walletChains: readonly string[] | null;
  openConnect: () => void;
  closeConnect: () => void;
  disconnect: () => Promise<void>;
  useDevKey: () => void;
  devKeyEnabled: boolean;
}

/*
  The dev key: a keypair in this browser's localStorage, created on first use,
  signing real transactions on devnet so the site can be driven without a
  wallet extension. It is off unless NEXT_PUBLIC_DEV_WALLET=1, it is named as
  unsafe wherever it appears, and it exists for devnet work only.
*/
const DEV_KEY = "bouncer:dev-key";
const devListeners = new Set<() => void>();
let devKeypair: Keypair | null | undefined;

function readDevKey(): Keypair | null {
  if (!DEV_WALLET_ENABLED) return null;
  if (devKeypair !== undefined) return devKeypair;
  try {
    const raw = window.localStorage.getItem(DEV_KEY);
    devKeypair = raw ? Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw) as number[])) : null;
  } catch {
    devKeypair = null;
  }
  return devKeypair;
}
function writeDevKey(kp: Keypair | null) {
  try {
    if (kp) window.localStorage.setItem(DEV_KEY, JSON.stringify(Array.from(kp.secretKey)));
    else window.localStorage.removeItem(DEV_KEY);
  } catch {}
  devKeypair = kp;
  for (const fn of devListeners) fn();
}
function subscribeDev(fn: () => void) {
  devListeners.add(fn);
  return () => {
    devListeners.delete(fn);
  };
}

/*
  Two knobs on the dev key only, read from localStorage at signing time, so
  the wallet failures a real bidder meets can be produced on purpose:
  bouncer:dev-reject = 1 makes the signer refuse like a wallet's cancel button;
  bouncer:dev-delay-ms = N makes it wait N ms before signing, like a wallet
  left open until the transaction has expired. The rehearsal wallet
  (dev/rehearsalWallet.ts) covers the rest of what an extension can do.
*/
function devKnob(name: string): string | null {
  try {
    return window.localStorage.getItem(name);
  } catch {
    return null;
  }
}
function devSigner(kp: Keypair): TxSigner {
  const knobs = async () => {
    if (devKnob("bouncer:dev-reject") === "1") throw new Error("User rejected the request.");
    const delay = Number(devKnob("bouncer:dev-delay-ms") ?? 0);
    if (delay > 0) await new Promise((r) => setTimeout(r, delay));
  };
  const sign = <T extends AnyTx>(tx: T): T => {
    if (tx instanceof VersionedTransaction) tx.sign([kp]);
    else tx.partialSign(kp);
    return tx;
  };
  return {
    address: kp.publicKey.toBase58(),
    kind: "devkey",
    walletName: "Dev key (unsafe)",
    supportsV0: true,
    async signTransaction(tx) {
      await knobs();
      return sign(tx);
    },
    /* One prompt for the batch, like a wallet's signAllTransactions. */
    async signAllTransactions(txs) {
      await knobs();
      return txs.map(sign);
    },
    async signMessage(message) {
      await knobs();
      return ed25519.sign(message, kp.secretKey.slice(0, 32));
    },
  };
}

/* The chains a Wallet Standard wallet offers for an address, read from the registry the adapter reads. Null for wallets that are not standard wallets. */
function chainsOf(walletName: string | null, address: string | null): readonly string[] | null {
  if (!walletName || !address || typeof window === "undefined") return null;
  try {
    const w = getWallets()
      .get()
      .find((x) => x.name === walletName);
    const acct = w?.accounts.find((a) => a.address === address);
    return acct ? acct.chains : null;
  } catch {
    return null;
  }
}

/*
  The wallet's own send (the founder, 2026-10-15: wallet sends are in). A Wallet
  Standard wallet that offers solana:signAndSendTransaction signs and
  broadcasts through its own RPC; the site hands it the pin's chain, never
  one read off the RPC's address (the route is a path), and confirms from
  the returned signature over HTTP through the route, as a bid's send is
  confirmed. Read at the call, from the registry, so a wallet that changed
  since the render is seen as it is. Null when the wallet lacks the feature
  or the account: the site then signs here and broadcasts through the route.
*/
type SendFeature = SolanaSignAndSendTransactionFeature[typeof SolanaSignAndSendTransaction];
function sendFeatureOf(walletName: string | null, address: string | null): { send: SendFeature; account: WalletAccount } | null {
  if (!walletName || !address || typeof window === "undefined") return null;
  try {
    const w = getWallets()
      .get()
      .find((x) => x.name === walletName);
    const send = w?.features[SolanaSignAndSendTransaction] as SendFeature | undefined;
    const account = w?.accounts.find((a) => a.address === address);
    /* 24e (Astra's capacity review, P2): the selected account must list the feature too, not only the wallet. */
    return send && account && account.features.includes(SolanaSignAndSendTransaction) ? { send, account } : null;
  } catch {
    return null;
  }
}

/*
  B22 (PD8, 2026-11-04): the Wallet Standard's solana:signMessage answers the bytes the wallet signed beside the
  signature (a Ledger behind Phantom signs an off-chain envelope around the message); the adapter's signMessage keeps
  only the signature. Read at the call, like sendFeatureOf. Null when the wallet or the account lacks the feature.
*/
type SignFeature = SolanaSignMessageFeature[typeof SolanaSignMessage];
function signFeatureOf(walletName: string | null, address: string | null): { sign: SignFeature; account: WalletAccount } | null {
  if (!walletName || !address || typeof window === "undefined") return null;
  try {
    const w = getWallets()
      .get()
      .find((x) => x.name === walletName);
    const sign = w?.features[SolanaSignMessage] as SignFeature | undefined;
    const account = w?.accounts.find((a) => a.address === address);
    return sign && account && account.features.includes(SolanaSignMessage) ? { sign, account } : null;
  } catch {
    return null;
  }
}

const AccountContext = createContext<Account | null>(null);

/*
  The adapter's state as of the last render, for the signer's closures,
  which run long after the render that made them (a wallet prompt can sit
  open for minutes): they must read the wallet as it is then, not as it was.
  A module variable rather than a ref, written from an effect.
*/
let liveWallet: ReturnType<typeof useWallet> | null = null;

export function AccountProvider({ children }: { children: ReactNode }) {
  const wallet = useWallet();
  useEffect(() => {
    liveWallet = wallet;
  }, [wallet]);
  const [sheetOpen, setSheetOpen] = useState(false);
  const devKey = useSyncExternalStore(subscribeDev, readDevKey, () => null);
  const [cluster, setCluster] = useState<ClusterCheck | null>(null);
  const [clusterRun, setClusterRun] = useState(0);

  useEffect(() => {
    let live = true;
    checkCluster(getConnection(), RPC_URL)
      .then((c) => live && setCluster(c))
      .catch((e) => live && setCluster({ pinned: "", rpcUrl: RPC_URL, genesis: null, rpcCluster: "unknown", program: "unchecked", bytes: "unchecked", bytesSha256: null, deploySlot: null, config: "unchecked", ok: false, fault: "rpc", problem: `The network check itself failed: ${shortError(e)}. Nothing will be signed until it passes.`, checkedAt: Date.now() }));
    return () => {
      live = false;
    };
  }, [clusterRun]);
  const recheckCluster = useCallback(() => {
    setCluster(null);
    setClusterRun((n) => n + 1);
  }, []);
  /* The pre-send read found the program changed or its data account gone: run the whole check again (signing stays blocked meanwhile). */
  useEffect(() => onPinStale(recheckCluster), [recheckCluster]);
  /* A wallet or dev key change re-reads the program's deploy slot (8 bytes); a moved slot runs the whole check again (F1, 2026-10-09). */
  const walletKey = wallet.publicKey?.toBase58() ?? devKey?.publicKey.toBase58() ?? null;
  const clusterOk = cluster?.ok === true;
  /*
    The site's route judges reads by account; the connected wallet's own accounts on a launch are in scope (chain/rpc.ts, server/scope.ts).
    A layout effect, not an effect (B1, the e2e test of 2026-10-22): React runs a child's effects before its parent's, so the bid read a
    page starts when a wallet connects (MyBid, BidFlow) went out before this provider had named the wallet, and the route refused it
    ("could not be read just now" until Try again). Every layout effect runs before any effect, so the scope now holds the wallet first.
  */
  useLayoutEffect(() => {
    setScopeWallet(walletKey);
    return () => setScopeWallet(null);
  }, [walletKey]);
  useEffect(() => {
    if (!walletKey || !clusterOk) return;
    void pinStillCurrent(getConnection());
  }, [walletKey, clusterOk]);

  const useDevKey = useCallback(() => {
    writeDevKey(readDevKey() ?? Keypair.generate());
    setSheetOpen(false);
  }, []);

  const disconnect = useCallback(async () => {
    setSheetOpen(false);
    /* Rehearsal item 5: a wallet whose disconnect never returns (Phantom's in-app browser) is forgotten by the page after a few seconds (walletDisconnect.ts). */
    if (wallet.connected) await disconnectWithin(() => wallet.disconnect(), () => wallet.select(null));
    /* The dev key stays in storage (its devnet SOL would be lost otherwise); disconnecting only stops using it. */
    devKeypair = undefined;
    if (devKey) writeDevKey(null);
  }, [devKey, wallet]);

  const value = useMemo<Account>(() => {
    const real = wallet.publicKey?.toBase58() ?? null;
    const walletName = wallet.wallet?.adapter.name ?? null;
    const walletChains = real ? chainsOf(walletName, real) : null;
    const walletSigner: TxSigner | null =
      real && wallet.publicKey
        ? {
            address: real,
            kind: "wallet",
            walletName: walletName ?? "Wallet",
            /* Sign here, broadcast in the client. A wallet without signTransaction signs and sends itself, on the chain the adapter names from the RPC. */
            signTransaction: wallet.signTransaction
              ? (tx) => {
                  const w = liveWallet ?? wallet;
                  if (!w.signTransaction) throw new Error("The wallet no longer offers signing.");
                  return w.signTransaction(tx);
                }
              : undefined,
            /* Several in one prompt (the Wallet Standard's signTransaction takes many inputs; the adapter passes them in one call). */
            signAllTransactions: wallet.signAllTransactions
              ? (txs) => {
                  const w = liveWallet ?? wallet;
                  if (!w.signAllTransactions) throw new Error("The wallet no longer offers signing.");
                  return w.signAllTransactions(txs);
                }
              : undefined,
            /*
              Preferred: the wallet signs and sends itself (sendFeatureOf above); the client confirms from the signature. The extra
              keypairs (the mint at genesis) have signed the transaction before it reaches the wallet. A wallet without the standard
              feature and without signTransaction goes through the adapter's own send, as before.
            */
            signAndSend: sendFeatureOf(walletName, real)
              ? async (tx) => {
                  const s = sendFeatureOf(walletName, real);
                  /* 24k: refusals made here, before the wallet is asked, are marked so the signer knows nothing was sent (signer.ts beforeWalletSent). */
                  if (!s) throw Object.assign(new Error("The wallet no longer offers sending."), { beforeWallet: true });
                  const chain = pinnedChain();
                  if (!s.account.chains.includes(chain)) throw Object.assign(new Error(`${walletName ?? "This wallet"} does not offer ${chain} for this account.`), { name: "WalletConfigError", beforeWallet: true });
                  const bytes = tx instanceof VersionedTransaction ? tx.serialize() : new Uint8Array(tx.serialize({ requireAllSignatures: false, verifySignatures: false }));
                  const [out] = await s.send.signAndSendTransaction({ account: s.account, chain, transaction: bytes, options: { preflightCommitment: "confirmed", skipPreflight: false } });
                  return bs58.encode(out.signature);
                }
              : !wallet.signTransaction
                ? (tx, conn, extra) => (liveWallet ?? wallet).sendTransaction(tx, conn, { signers: extra, preflightCommitment: "confirmed" })
                : undefined,
            /* 23c: the creator sign-in's one plain message (no transaction). */
            signMessage: wallet.signMessage
              ? (message) => {
                  const w = liveWallet ?? wallet;
                  if (!w.signMessage) throw new Error("The wallet no longer offers message signing.");
                  return w.signMessage(message);
                }
              : undefined,
            /* B22: the signature with the bytes signed, straight from the standard feature (no await before the wallet's prompt). */
            signMessageWithBytes: signFeatureOf(walletName, real)
              ? async (message) => {
                  const s = signFeatureOf(walletName, real);
                  if (!s) throw new Error("The wallet no longer offers message signing.");
                  const [out] = await s.sign.signMessage({ account: s.account, message });
                  return { signature: out.signature, signedMessage: out.signedMessage };
                }
              : undefined,
            /*
              24e (the founder's capacity decisions, item 2): the wallet's own send only for a transaction it can take, decided before
              anything is sent: the selected account offers the feature and the pinned chain, and the feature lists the
              transaction's version. Otherwise the client signs here and sends through the route (the fallback).
            */
            canSignAndSend: (tx) => {
              const s = sendFeatureOf(walletName, real);
              if (!s) return !wallet.signTransaction;
              const version = tx instanceof VersionedTransaction ? tx.version : "legacy";
              const versions = s.send.supportedTransactionVersions ?? ["legacy"];
              return s.account.chains.includes(pinnedChain()) && versions.includes(version);
            },
            /* Version 0 transactions (the pool step's lookup table) only where the wallet says it takes them; legacy otherwise. */
            supportsV0: wallet.wallet?.adapter.supportedTransactionVersions?.has(0) ?? false,
            stillActive: () => {
              const now = (liveWallet ?? wallet).publicKey?.toBase58() ?? null;
              return now === real ? "yes" : now === null ? "disconnected" : "switched";
            },
          }
        : null;
    const signer = walletSigner ?? (devKey ? devSigner(devKey) : null);
    const address = real ?? devKey?.publicKey.toBase58() ?? null;
    const chain = pinnedChain();
    let signProblem: string | null = null;
    if (cluster === null) signProblem = "Checking the network.";
    else if (!cluster.ok) signProblem = cluster.problem;
    else if (walletSigner && walletChains && !walletChains.includes(chain)) {
      signProblem = `${walletName ?? "This wallet"} does not offer ${chain === "solana:localnet" ? "a local validator" : clusterLabel(cluster.pinned)} for this account (it offers ${walletChains.map((c) => c.replace("solana:", "")).join(", ")}), so it cannot sign here.`;
    }
    return {
      address,
      kind: real ? "wallet" : devKey ? "devkey" : null,
      walletName: real ? (walletName ?? "Wallet") : devKey ? "Dev key (unsafe)" : null,
      connecting: wallet.connecting,
      signer,
      signProblem,
      cluster,
      recheckCluster,
      walletChains,
      openConnect: () => setSheetOpen(true),
      closeConnect: () => setSheetOpen(false),
      disconnect,
      useDevKey,
      devKeyEnabled: DEV_WALLET_ENABLED,
    };
  }, [wallet, devKey, cluster, recheckCluster, disconnect, useDevKey]);

  /* The sheet closes itself the moment a real wallet connects. */
  const open = sheetOpen && !wallet.connected;

  return (
    <AccountContext.Provider value={value}>
      {children}
      <WalletSheet open={open} onClose={() => setSheetOpen(false)} />
    </AccountContext.Provider>
  );
}

export function useAccount(): Account {
  const ctx = useContext(AccountContext);
  if (!ctx) throw new Error("useAccount must be used inside AccountProvider");
  return ctx;
}
