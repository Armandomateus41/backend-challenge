/**
 * Stable, machine-readable reasons attached to REJECTED and FAILED transactions.
 * Values are part of the public contract: never rename an existing code.
 */
export enum FailureCode {
  /** BET larger than the available balance. Provider may retry with a smaller stake. */
  InsufficientFunds = 'INSUFFICIENT_FUNDS',
  /** A REFUND/ROLLBACK that would make the balance negative. Requires operator follow-up. */
  ReversalInsufficientFunds = 'REVERSAL_INSUFFICIENT_FUNDS',
  /** Operation currency differs from the wallet currency. */
  CurrencyMismatch = 'CURRENCY_MISMATCH',
  /** playerId in the request does not own the target wallet. */
  WalletPlayerMismatch = 'WALLET_PLAYER_MISMATCH',
  /** Referenced transaction never arrived within the resolution window. */
  ReferenceNotFound = 'REFERENCE_NOT_FOUND',
  /** Referenced transaction exists but was rejected, failed, or never settled. */
  ReferenceNotProcessed = 'REFERENCE_NOT_PROCESSED',
  /** The referenced kind cannot be targeted by this operation (e.g. REFUND of a WIN). */
  ReferenceKindNotAllowed = 'REFERENCE_KIND_NOT_ALLOWED',
  ReferencePlayerMismatch = 'REFERENCE_PLAYER_MISMATCH',
  ReferenceWalletMismatch = 'REFERENCE_WALLET_MISMATCH',
  ReferenceCurrencyMismatch = 'REFERENCE_CURRENCY_MISMATCH',
  ReferenceRoundMismatch = 'REFERENCE_ROUND_MISMATCH',
  /** REFUND/ROLLBACK amount differs from the referenced amount (partial reversal unsupported). */
  ReferenceAmountMismatch = 'REFERENCE_AMOUNT_MISMATCH',
  /** The referenced transaction was already reversed by a processed REFUND or ROLLBACK. */
  ReferenceAlreadyReversed = 'REFERENCE_ALREADY_REVERSED',
  /** Permanent processing error recorded for audit (status FAILED). */
  ProcessingError = 'PROCESSING_ERROR',
}
