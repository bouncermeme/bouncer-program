/*
  The reviewer packet is locked on mainnet (B20, F41: unconditional; docs/MAINNET-LAUNCH-PLAN.md). The packet names
  the founder, the AWS account and private paths, and the coming-soon gate is the only thing in front of it on devnet: the
  moment the gate lifts on bouncer.meme it would be public. So on a mainnet pin /review and /review/<slug> answer 404
  from the pages themselves, whatever the gate, the access cookie or the reviewer key says, and the proxy never
  accepts the reviewer key there. No key exception: there is no setting that opens it on mainnet.
  No imports: the proxy loads this file as it is.
*/

/* The pin's cluster as contract/active.ts or lib/indexing.ts clusterFromEnv names it. */
export function reviewPacketLocked(cluster: string): boolean {
  return cluster === "mainnet-beta" || cluster === "mainnet";
}

export function isReviewPath(path: string): boolean {
  return path === "/review" || path.startsWith("/review/");
}
