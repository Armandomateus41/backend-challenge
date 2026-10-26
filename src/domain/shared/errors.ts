/**
 * Base class for errors raised by the domain model. Each error carries a stable,
 * machine-readable code so that adapters (HTTP, SQS) can map it without parsing messages.
 */
export abstract class DomainError extends Error {
  abstract readonly code: string;

  protected constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** Input that violates a domain contract (malformed money, missing reference, ...). */
export class DomainValidationError extends DomainError {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

/** Arithmetic or comparison between amounts of different currencies. */
export class CurrencyMismatchError extends DomainError {
  readonly code = 'CURRENCY_MISMATCH';

  constructor(expected: string, actual: string) {
    super(`Currency mismatch: expected ${expected}, received ${actual}`);
  }
}

/**
 * An invariant that the model guarantees was about to be broken. Reaching this error means a
 * programming defect, never a business outcome.
 */
export class InvariantViolationError extends DomainError {
  readonly code = 'INVARIANT_VIOLATION';

  constructor(message: string) {
    super(message);
  }
}

/** Attempt to transition a transaction that is already in a terminal state. */
export class InvalidTransactionStateError extends DomainError {
  readonly code = 'INVALID_TRANSACTION_STATE';

  constructor(transactionId: string, from: string, to: string) {
    super(`Transaction ${transactionId} cannot transition from ${from} to ${to}`);
  }
}
