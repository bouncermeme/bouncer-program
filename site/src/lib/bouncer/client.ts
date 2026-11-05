/*
  Single place the pages get their data client from: the chain client
  against the pinned program on the cluster NEXT_PUBLIC_RPC_URL serves.
  There is no mock behind it.
*/

import { chainClient } from "./chain/chainClient";
import type { BouncerClient } from "./types";

export function getClient(): BouncerClient {
  return chainClient;
}

/* The dev key: a keypair kept in this browser's localStorage that signs like a wallet, for devnet work without an extension. Off unless the deployment says so. */
export const DEV_WALLET_ENABLED = process.env.NEXT_PUBLIC_DEV_WALLET === "1";

