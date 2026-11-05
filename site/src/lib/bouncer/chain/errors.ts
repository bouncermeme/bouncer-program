/*
  What a refusal means to the person reading it. The numbers come from
  ERROR_CODE in the pin; the sentences are the checklist's section 7. Anything
  the pin does not name is shown with its name from errorName and the raw
  message, never hidden.
*/
import { ERROR_CODE, errorName } from "@contract/constants";

const MEANING: Partial<Record<keyof typeof ERROR_CODE, string>> = {
  EmergencyUpdatePaused: "Launch creation is paused for a program update. Launches already running are unaffected.",
  InvalidRoundPoint: "The launch's unsealing setup was rejected. That is a fault in the site, not in your wallet. Reload the page and try creating the launch again.",
  BelowMinimum: "The deposit is under the launch's minimum bid.",
  NotRefundable: "Nothing leaves the vault before the launch settles or fails.",
  TooEarlyToAbort: "The valve is not open yet. Nobody can end this launch before it.",
  PoolAlreadyLive: "The pool is already live; this launch cannot be ended.",
  MetadataTooLong: "The name, ticker or URI is over the program's byte limit.",
  RevealRoundOutOfRange: "The launch timing is no longer valid. Try again to rebuild it. If this keeps happening, check the clock on this device.",
  /* v0.31: the close the page set is under 240 s away at landing: the wallet held the approval past the 60 s grace. Pending the founder's approval of the sentence (review/2026-10-27-v030/mocks-v031). */
  CloseTooSoon: "Your wallet took over a minute to approve, so the launch was not created.",
  NotAbortable: "This launch is past the point where it can be ended.",
  SettlementRequired: "The settlement record was not passed with this call. That is a bug in the site.",
  LaunchNotOpen: "The book is not open.",
  /* 0.29, the ninth candidate: also a bid at the margin whose share rounded to no tokens, held until the pool (Astra's F9). */
  IsAWinner: "This bid is paid once the pool opens: its tokens, or for a bid at the margin that rounded to none, its refund. Take it then, or wait for the push.",
  TermsChanged: "The launch terms changed while you were signing, so nothing was created. Read the current terms and create again if you still agree.",
  ProcessingChargeAboveMaximum: "The charge for opening a bid is now higher than the one this page showed you, so your bid was not placed and nothing was taken. Reload the page to see the current charge.",
  /* 0.29: the two-step genesis and the bot check (design sections 4 and 11). */
  HistogramNotReady: "This launch is still finishing setup, so it takes no bids yet. Its creator's second step has not landed.",
  HistogramAlreadyGrown: "This launch's setup is already finished.",
  /* Since the seventh candidate the same refusals guard creation too (the creation permit), so they name no action. */
  AttestorUnknown: "The bot check was signed by a key the program no longer accepts. Complete the check again and try again.",
  AttestationMismatch: "The bot check was issued for another launch, wallet or set of terms. Complete the check again and try again.",
  AttestationExpired: "The bot check expired before your transaction landed. Complete the check again and try again.",
  AttestationTooLong: "The bot check's expiry was set too far ahead, a fault in the check service. Try again in a minute.",
  AttestationMissing: "The bot check is required, and the transaction did not carry it. Complete the check and try again.",
  LaunchLayoutUnknown: "This launch was created under an older program version and cannot be used.",
  /* The ninth candidate: finish_mint runs once. */
  MintAlreadyFinished: "The token's name is already on chain.",
};

/* Refusals a person can hit through no fault of their own (0.25), and the two create_launch refusals whose names are internal (Astra's review of 045df22): the sentence stands alone, with no name or number after it. The code stays in TxFailure.detail. */
const PLAIN: ReadonlySet<string> = new Set(["TermsChanged", "ProcessingChargeAboveMaximum", "InvalidRoundPoint", "RevealRoundOutOfRange", "CloseTooSoon", "HistogramNotReady", "HistogramAlreadyGrown", "AttestorUnknown", "AttestationMismatch", "AttestationExpired", "AttestationTooLong", "AttestationMissing", "LaunchLayoutUnknown", "MintAlreadyFinished"]);

/* Whether a program error code's refusal reads as its own sentence (TxState shows it without "The program refused it"). */
export function isPlainRefusal(code: number | null | undefined): boolean {
  if (code === null || code === undefined) return false;
  const name = errorName(code);
  return !!name && PLAIN.has(name);
}

export class ProgramError extends Error {
  constructor(
    public readonly code: number,
    public readonly name: string,
    message: string,
  ) {
    super(message);
  }
}

/* Finds a custom program error code in the shapes web3.js reports: a simulation's err object, or a send error's message. */
export function programErrorCode(e: unknown): number | null {
  const s = typeof e === "string" ? e : e instanceof Error ? e.message : JSON.stringify(e);
  const hex = /custom program error: 0x([0-9a-fA-F]+)/.exec(s);
  if (hex) return parseInt(hex[1], 16);
  const custom = /"Custom":\s*(\d+)/.exec(s);
  if (custom) return parseInt(custom[1], 10);
  return null;
}

/* The message a page shows for a failed transaction. */
export function explainError(e: unknown): string {
  const code = programErrorCode(e);
  const raw = e instanceof Error ? e.message : String(e);
  if (code !== null) {
    const name = errorName(code);
    if (name) {
      const meaning = MEANING[name as keyof typeof ERROR_CODE];
      if (meaning && PLAIN.has(name)) return meaning;
      return meaning ? `${meaning} (${name}, ${code})` : `The program refused: ${name} (${code}).`;
    }
    if (code === 3003) return "This launch was created under an older program version and cannot be used.";
    if (code === 3012) return "That account does not exist on this cluster.";
    if (code === 0 && /system program|11111111111111111111111111111111/i.test(raw)) return "One bid per wallet: this wallet already has a bid on this launch.";
    return `The program refused with code ${code}.`;
  }
  if (/insufficient (funds|lamports)/i.test(raw) || /Attempt to debit an account but found no record of a prior credit/i.test(raw)) return "Not enough SOL in this wallet for the deposit, the rent and the fee.";
  if (/User rejected|rejected the request|user declined/i.test(raw)) return "Your wallet declined to sign. Nothing was sent.";
  if (/block height exceeded|expired/i.test(raw)) return "The transaction expired before it landed. Nothing was sent; try again.";
  if (/already been processed/i.test(raw)) return "This transaction was already processed.";
  return raw;
}
