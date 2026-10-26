/**
 * How an adapter must treat a failure:
 * - validation: malformed input, never retry unchanged;
 * - not_found: referenced resource absent;
 * - conflict: request collides with persisted state (idempotency, uniqueness);
 * - transient: infrastructure hiccup, safe to retry with the same idempotency key.
 */
export type ApplicationErrorKind = 'validation' | 'not_found' | 'conflict' | 'transient';

export abstract class ApplicationError extends Error {
  abstract readonly code: string;
  abstract readonly kind: ApplicationErrorKind;

  protected constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class WalletNotFoundError extends ApplicationError {
  readonly code = 'WALLET_NOT_FOUND';
  readonly kind = 'not_found';

  constructor(walletId: string) {
    super(`Wallet ${walletId} not found`);
  }
}

export class TransactionNotFoundError extends ApplicationError {
  readonly code = 'TRANSACTION_NOT_FOUND';
  readonly kind = 'not_found';

  constructor(description: string) {
    super(`Transaction ${description} not found`);
  }
}

export class WalletAlreadyExistsError extends ApplicationError {
  readonly code = 'WALLET_ALREADY_EXISTS';
  readonly kind = 'conflict';

  constructor(playerId: string, currency: string) {
    super(`Player ${playerId} already has a ${currency} wallet`);
  }
}

export class UnsupportedCurrencyError extends ApplicationError {
  readonly code = 'UNSUPPORTED_CURRENCY';
  readonly kind = 'validation';

  constructor(currency: string) {
    super(`Currency ${currency} is not supported`);
  }
}

export class InvalidCursorError extends ApplicationError {
  readonly code = 'INVALID_CURSOR';
  readonly kind = 'validation';

  constructor() {
    super('Cursor is malformed');
  }
}

/** Same idempotency key reused with a different business payload. */
export class IdempotencyConflictError extends ApplicationError {
  readonly code = 'IDEMPOTENCY_KEY_CONFLICT';
  readonly kind = 'conflict';

  constructor(idempotencyKey: string) {
    super(`Idempotency key ${idempotencyKey} was already used with a different payload`);
  }
}

/** (providerId, externalTransactionId) already recorded under another idempotency key. */
export class ExternalTransactionConflictError extends ApplicationError {
  readonly code = 'EXTERNAL_TRANSACTION_CONFLICT';
  readonly kind = 'conflict';

  constructor(providerId: string, externalTransactionId: string) {
    super(
      `Transaction ${providerId}/${externalTransactionId} already exists under another idempotency key`,
    );
  }
}

/**
 * - lock_conflict: lock timeout, deadlock or serialization failure; retrying immediately is useful;
 * - unavailable: database or broker unreachable; retry later.
 */
export type TransientReason = 'lock_conflict' | 'unavailable';

export class TransientInfrastructureError extends ApplicationError {
  readonly code = 'SERVICE_UNAVAILABLE';
  readonly kind = 'transient';

  constructor(
    message: string,
    readonly reason: TransientReason,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}
