import { type FailureCode } from './failure-code';
import { LedgerDirection } from './ledger-entry';
import { type Money } from './money';
import {
  DomainValidationError,
  InvalidTransactionStateError,
  InvariantViolationError,
} from './shared/errors';

export enum WagerTransactionKind {
  /** Internal: opening credit of a wallet. Never accepted from API or queue. */
  Opening = 'OPENING',
  Bet = 'BET',
  Win = 'WIN',
  Loss = 'LOSS',
  Refund = 'REFUND',
  Rollback = 'ROLLBACK',
}

export enum WagerTransactionStatus {
  Pending = 'PENDING',
  PendingReference = 'PENDING_REFERENCE',
  Processed = 'PROCESSED',
  Rejected = 'REJECTED',
  Failed = 'FAILED',
}

export const SUBMITTABLE_KINDS = [
  WagerTransactionKind.Bet,
  WagerTransactionKind.Win,
  WagerTransactionKind.Loss,
  WagerTransactionKind.Refund,
  WagerTransactionKind.Rollback,
] as const;

const TERMINAL_STATUSES: ReadonlySet<WagerTransactionStatus> = new Set([
  WagerTransactionStatus.Processed,
  WagerTransactionStatus.Rejected,
  WagerTransactionStatus.Failed,
]);

/** Kinds each operation may reference. Absent key means the kind cannot carry a reference. */
const REFERENCEABLE_KINDS: Partial<Record<WagerTransactionKind, readonly WagerTransactionKind[]>> =
  {
    [WagerTransactionKind.Win]: [WagerTransactionKind.Bet],
    [WagerTransactionKind.Loss]: [WagerTransactionKind.Bet],
    [WagerTransactionKind.Refund]: [WagerTransactionKind.Bet],
    [WagerTransactionKind.Rollback]: [
      WagerTransactionKind.Bet,
      WagerTransactionKind.Win,
      WagerTransactionKind.Refund,
    ],
  };

export const OPENING_PROVIDER_ID = 'internal';

export interface CreateWagerTransactionProps {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string | undefined;
  createdAt: Date;
}

export interface WagerTransactionState extends CreateWagerTransactionProps {
  status: WagerTransactionStatus;
  referenceTransactionId: string | undefined;
  failureCode: FailureCode | undefined;
  processedAt: Date | undefined;
  /** Wallet balance observed when the transaction reached its current status. */
  observedBalance: Money | undefined;
  updatedAt: Date;
}

/**
 * A provider operation on a wallet. Born PENDING; PROCESSED, REJECTED and FAILED are terminal.
 *
 * Valid transitions:
 *   PENDING           -> PROCESSED | REJECTED | FAILED | PENDING_REFERENCE
 *   PENDING_REFERENCE -> PROCESSED | REJECTED | FAILED
 */
export class WagerTransaction {
  private constructor(
    public readonly id: string,
    public readonly providerId: string,
    public readonly externalTransactionId: string,
    public readonly idempotencyKey: string,
    public readonly payloadHash: string,
    public readonly walletId: string,
    public readonly playerId: string,
    public readonly roundId: string,
    public readonly gameId: string,
    public readonly kind: WagerTransactionKind,
    public readonly money: Money,
    /** Provider-side id of the referenced operation, not the internal id. */
    public readonly referenceExternalTransactionId: string | undefined,
    public readonly createdAt: Date,
    private _status: WagerTransactionStatus,
    private _updatedAt: Date,
    private _referenceTransactionId?: string,
    private _failureCode?: FailureCode,
    private _processedAt?: Date,
    private _observedBalance?: Money,
  ) {}

  /** Creates a provider-submitted transaction in PENDING. OPENING is rejected here. */
  static create(props: CreateWagerTransactionProps): WagerTransaction {
    if (props.kind === WagerTransactionKind.Opening) {
      throw new DomainValidationError(
        'KIND_NOT_ALLOWED',
        'OPENING is internal and cannot be submitted',
      );
    }
    WagerTransaction.assertReferenceContract(props);
    WagerTransaction.assertAmount(props.kind, props.money);
    return WagerTransaction.newPending(props);
  }

  /** Internal opening credit of a wallet, created together with the wallet. */
  static createOpening(props: {
    id: string;
    walletId: string;
    playerId: string;
    money: Money;
    payloadHash: string;
    createdAt: Date;
  }): WagerTransaction {
    if (!props.money.isPositive()) {
      throw new InvariantViolationError('Opening transactions require a positive amount');
    }
    const externalId = `wallet-opening:${props.walletId}`;
    return WagerTransaction.newPending({
      ...props,
      providerId: OPENING_PROVIDER_ID,
      externalTransactionId: externalId,
      idempotencyKey: `${OPENING_PROVIDER_ID}:${externalId}`,
      roundId: externalId,
      gameId: OPENING_PROVIDER_ID,
      kind: WagerTransactionKind.Opening,
      referenceExternalTransactionId: undefined,
    });
  }

  /** Reconstruction from persistence: restores state without replaying transition rules. */
  static rehydrate(state: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(
      state.id,
      state.providerId,
      state.externalTransactionId,
      state.idempotencyKey,
      state.payloadHash,
      state.walletId,
      state.playerId,
      state.roundId,
      state.gameId,
      state.kind,
      state.money,
      state.referenceExternalTransactionId,
      state.createdAt,
      state.status,
      state.updatedAt,
      state.referenceTransactionId,
      state.failureCode,
      state.processedAt,
      state.observedBalance,
    );
  }

  get status(): WagerTransactionStatus {
    return this._status;
  }

  get referenceTransactionId(): string | undefined {
    return this._referenceTransactionId;
  }

  get failureCode(): FailureCode | undefined {
    return this._failureCode;
  }

  get processedAt(): Date | undefined {
    return this._processedAt;
  }

  get observedBalance(): Money | undefined {
    return this._observedBalance;
  }

  get updatedAt(): Date {
    return this._updatedAt;
  }

  markProcessed(
    referenceTransactionId: string | undefined,
    at: Date,
    observedBalance: Money,
  ): void {
    this.transitionTo(WagerTransactionStatus.Processed, at, observedBalance);
    this._referenceTransactionId = referenceTransactionId;
    this._processedAt = at;
  }

  markPendingReference(at: Date, observedBalance: Money): void {
    if (this._status !== WagerTransactionStatus.Pending) {
      throw new InvalidTransactionStateError(
        this.id,
        this._status,
        WagerTransactionStatus.PendingReference,
      );
    }
    this.transitionTo(WagerTransactionStatus.PendingReference, at, observedBalance);
  }

  reject(
    code: FailureCode,
    at: Date,
    observedBalance: Money,
    referenceTransactionId?: string,
  ): void {
    this.transitionTo(WagerTransactionStatus.Rejected, at, observedBalance);
    this._failureCode = code;
    this._referenceTransactionId = referenceTransactionId;
  }

  fail(code: FailureCode, at: Date): void {
    this.transitionTo(WagerTransactionStatus.Failed, at, this._observedBalance);
    this._failureCode = code;
  }

  isTerminal(): boolean {
    return TERMINAL_STATUSES.has(this._status);
  }

  affectsBalance(): boolean {
    return this.kind !== WagerTransactionKind.Loss;
  }

  requiresReference(): boolean {
    return this.isReversal();
  }

  isReversal(): boolean {
    return this.kind === WagerTransactionKind.Refund || this.kind === WagerTransactionKind.Rollback;
  }

  /** Whether this operation is allowed to target a transaction of the given kind. */
  canReference(kind: WagerTransactionKind): boolean {
    return REFERENCEABLE_KINDS[this.kind]?.includes(kind) ?? false;
  }

  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  /**
   * Direction of the balance movement this transaction produces. ROLLBACK inverts the direction
   * of its reference. Returns undefined for LOSS, which never moves the balance.
   */
  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection | undefined {
    switch (this.kind) {
      case WagerTransactionKind.Bet:
        return LedgerDirection.Debit;
      case WagerTransactionKind.Opening:
      case WagerTransactionKind.Win:
      case WagerTransactionKind.Refund:
        return LedgerDirection.Credit;
      case WagerTransactionKind.Loss:
        return undefined;
      case WagerTransactionKind.Rollback: {
        const referenced = reference?.ledgerDirectionFor();
        if (!referenced) {
          throw new InvariantViolationError('ROLLBACK requires a reference that moved the balance');
        }
        return referenced === LedgerDirection.Debit
          ? LedgerDirection.Credit
          : LedgerDirection.Debit;
      }
    }
  }

  private transitionTo(
    next: WagerTransactionStatus,
    at: Date,
    observedBalance: Money | undefined,
  ): void {
    if (this.isTerminal()) {
      throw new InvalidTransactionStateError(this.id, this._status, next);
    }
    this._status = next;
    this._updatedAt = at;
    this._observedBalance = observedBalance;
  }

  private static newPending(props: CreateWagerTransactionProps): WagerTransaction {
    return new WagerTransaction(
      props.id,
      props.providerId,
      props.externalTransactionId,
      props.idempotencyKey,
      props.payloadHash,
      props.walletId,
      props.playerId,
      props.roundId,
      props.gameId,
      props.kind,
      props.money,
      props.referenceExternalTransactionId,
      props.createdAt,
      WagerTransactionStatus.Pending,
      props.createdAt,
    );
  }

  private static assertReferenceContract(props: CreateWagerTransactionProps): void {
    const reference = props.referenceExternalTransactionId;
    const isReversal =
      props.kind === WagerTransactionKind.Refund || props.kind === WagerTransactionKind.Rollback;
    if (isReversal && !reference) {
      throw new DomainValidationError(
        'REFERENCE_REQUIRED',
        `${props.kind} requires referenceExternalTransactionId`,
      );
    }
    if (reference && !REFERENCEABLE_KINDS[props.kind]) {
      throw new DomainValidationError(
        'REFERENCE_NOT_ALLOWED',
        `${props.kind} cannot reference another transaction`,
      );
    }
    if (reference && reference === props.externalTransactionId) {
      throw new DomainValidationError('REFERENCE_INVALID', 'A transaction cannot reference itself');
    }
  }

  private static assertAmount(kind: WagerTransactionKind, money: Money): void {
    if (money.isNegative()) {
      throw new DomainValidationError('INVALID_AMOUNT', 'Amount must not be negative');
    }
    if (kind !== WagerTransactionKind.Loss && !money.isPositive()) {
      throw new DomainValidationError('INVALID_AMOUNT', `${kind} requires a positive amount`);
    }
  }
}
