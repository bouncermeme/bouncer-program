/*
  The local test board (the founder, 2026-09-29): the site pointed at a local
  validator so launches at realistic sizes can be looked at, from a phone
  through a tunnel. Read-only: the wallet is off, the devnet banner gives way
  to a local one, and the RPC goes through the site's own read-only proxy
  (app/api/rpc). Off unless NEXT_PUBLIC_BOARD=local at build time, which only
  scripts/local-board.sh sets; the Vercel deploy never does.
*/
export const BOARD_LOCAL: boolean = process.env.NEXT_PUBLIC_BOARD === "local";
