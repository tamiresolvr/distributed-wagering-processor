/** Domain errors carry a stable machine-readable `code`. */
export class DomainError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

/** Malformed input (HTTP 400 / permanent for the queue consumer). */
export class ValidationError extends DomainError {
  constructor(message: string, code = 'INVALID_PAYLOAD') {
    super(code, message);
  }
}

export class InvalidMoneyError extends ValidationError {
  constructor(message: string) {
    super(message, 'INVALID_MONEY');
  }
}

export class CurrencyMismatchError extends DomainError {
  constructor(a: string, b: string) {
    super('CURRENCY_MISMATCH', `currency mismatch: ${a} vs ${b}`);
  }
}

export class InsufficientFundsError extends DomainError {
  constructor() {
    super('INSUFFICIENT_FUNDS', 'wallet balance is insufficient');
  }
}

/** Programming error: transitioning a terminal transaction. */
export class InvalidTransactionStateError extends DomainError {
  constructor(message: string) {
    super('INVALID_TRANSACTION_STATE', message);
  }
}

export class IdempotencyConflictError extends DomainError {
  constructor(message: string) {
    super('IDEMPOTENCY_CONFLICT', message);
  }
}

export class WalletNotFoundError extends DomainError {
  constructor(id: string) {
    super('WALLET_NOT_FOUND', `wallet ${id} not found`);
  }
}

export class WalletAlreadyExistsError extends DomainError {
  constructor() {
    super('WALLET_ALREADY_EXISTS', 'a wallet already exists for this player and currency');
  }
}

export class TransactionNotFoundError extends DomainError {
  constructor() {
    super('TRANSACTION_NOT_FOUND', 'transaction not found');
  }
}

/** Internal: lost a race on a unique key; the whole DB tx is rolled back and retried. */
export class ConcurrentDuplicateError extends Error {}
/** Internal: optimistic version check failed; rolled back and retried. */
export class ConcurrentModificationError extends Error {}
