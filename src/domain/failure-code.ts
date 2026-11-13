/**
 * Stable, machine-readable failure taxonomy. Each code documents what the
 * provider should do (see ARCHITECTURE.md §7).
 */
export enum FailureCode {
  /** BET without funds. Provider: give up (or retry later with a NEW external id). */
  InsufficientFunds = 'INSUFFICIENT_FUNDS',
  /** REFUND/ROLLBACK debit would make balance negative. Distinct from a BET without funds. */
  ReversalInsufficientFunds = 'REVERSAL_INSUFFICIENT_FUNDS',
  /** Referenced transaction never arrived within the retry budget. Provider: resend after sending the reference. */
  ReferenceNotFound = 'REFERENCE_NOT_FOUND',
  /** Referenced transaction exists but is REJECTED/FAILED or never completed. Provider: give up. */
  ReferenceNotProcessed = 'REFERENCE_NOT_PROCESSED',
  /** Reference belongs to another player/wallet/round/currency. Provider: fix payload. */
  ReferenceMismatch = 'REFERENCE_MISMATCH',
  /** Reference kind not allowed for this operation. Provider: fix payload. */
  InvalidReferenceKind = 'INVALID_REFERENCE_KIND',
  /** Reversal amount differs from the reference amount. Provider: fix payload. */
  ReferenceAmountMismatch = 'REFERENCE_AMOUNT_MISMATCH',
  /** Reference was already reversed. Provider: nothing to do. */
  AlreadyReversed = 'ALREADY_REVERSED',
  /** Operation currency differs from the wallet currency. Provider: fix payload. */
  CurrencyMismatch = 'CURRENCY_MISMATCH',
  /** playerId does not own the wallet. Provider: fix payload. */
  WalletPlayerMismatch = 'WALLET_PLAYER_MISMATCH',
  /** Permanent infrastructure/internal failure (auditable). Provider: contact operator. */
  InternalError = 'INTERNAL_ERROR',
}
