import { type InboxMessage } from '../../domain/inbox-message';
import { type WalletLedgerEntry } from '../../domain/ledger-entry';
import { type Money } from '../../domain/money';
import { type OutboxMessage } from '../../domain/outbox-message';
import { type WagerTransaction } from '../../domain/wager-transaction';
import { type Wallet } from '../../domain/wallet';

export interface WalletRepository {
  findById(walletId: string): Promise<Wallet | undefined>;
  /** Loads the wallet holding an exclusive row lock until the transaction ends. */
  lockById(walletId: string): Promise<Wallet | undefined>;
  /** Throws WalletAlreadyExistsError on (playerId, currency) collision. */
  insert(wallet: Wallet): Promise<void>;
  /** Persists balance and version, guarded by the version read under lock. */
  saveMovement(wallet: Wallet, expectedVersion: number): Promise<void>;
}

/** Scheduling metadata of a PENDING_REFERENCE transaction. */
export interface ReferenceSchedule {
  resolutionAttempts: number;
  /**
   * Delay before the next resolution attempt, or undefined when no longer pending. Repositories
   * anchor it to the database clock, the same clock the claim query compares against.
   */
  retryDelayMs: number | undefined;
}

export interface LockedPendingTransaction {
  transaction: WagerTransaction;
  resolutionAttempts: number;
  correlationId: string | undefined;
}

export interface ClaimedPendingTransaction {
  transactionId: string;
  walletId: string;
}

export interface WagerTransactionRepository {
  findById(transactionId: string): Promise<WagerTransaction | undefined>;
  findByIdempotencyKey(idempotencyKey: string): Promise<WagerTransaction | undefined>;
  findByExternalId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransaction | undefined>;
  /** Whether a PROCESSED REFUND or ROLLBACK already targets the given transaction. */
  hasProcessedReversal(referenceTransactionId: string): Promise<boolean>;
  /** Throws IdempotencyRaceError when a unique key collides with a concurrent insert. */
  insert(
    transaction: WagerTransaction,
    schedule: ReferenceSchedule,
    correlationId: string,
  ): Promise<void>;
  updateState(transaction: WagerTransaction, schedule: ReferenceSchedule): Promise<void>;
  lockPending(transactionId: string): Promise<LockedPendingTransaction | undefined>;
  /** Leases due PENDING_REFERENCE rows (SKIP LOCKED) by pushing their next attempt forward. */
  claimDuePending(limit: number, leaseMs: number): Promise<ClaimedPendingTransaction[]>;
  /** Makes pending transactions waiting on this external id due immediately. */
  wakeDependents(providerId: string, externalTransactionId: string): Promise<number>;
}

export interface LedgerPage {
  entries: WalletLedgerEntry[];
  hasMore: boolean;
}

export interface LedgerSummary {
  calculatedBalance: Money;
  entryCount: number;
}

export interface LedgerRepository {
  insert(entry: WalletLedgerEntry): Promise<void>;
  listByWallet(walletId: string, afterWalletVersion: number, limit: number): Promise<LedgerPage>;
  summarize(walletId: string, currency: string): Promise<LedgerSummary>;
}

export interface InboxRepository {
  /** Inserts the inbox row; returns false when (consumerName, messageId) already exists. */
  tryRecord(message: InboxMessage): Promise<boolean>;
  linkTransaction(message: InboxMessage, transactionId: string): Promise<void>;
  /** Deletes up to `limit` rows processed more than `retentionHours` ago; returns the count. */
  deleteProcessedBefore(retentionHours: number, limit: number): Promise<number>;
}

export interface OutboxStats {
  pending: number;
  oldestPendingAgeSeconds: number;
}

export interface OutboxRepository {
  enqueue(messages: readonly OutboxMessage[]): Promise<void>;
  /** Leases due messages to `owner` (SKIP LOCKED); expired leases of dead owners are reclaimable. */
  claimDue(owner: string, limit: number, leaseMs: number): Promise<OutboxMessage[]>;
  /** Persists publish/retry state if `owner` still holds the lease; returns false otherwise. */
  saveDeliveryState(message: OutboxMessage, owner: string): Promise<boolean>;
  stats(): Promise<OutboxStats>;
  /** Deletes up to `limit` messages published more than `retentionHours` ago; returns the count. */
  deletePublishedBefore(retentionHours: number, limit: number): Promise<number>;
}

export interface RepositoryScope {
  wallets: WalletRepository;
  transactions: WagerTransactionRepository;
  ledger: LedgerRepository;
  inbox: InboxRepository;
  outbox: OutboxRepository;
}

export interface UnitOfWork {
  /** Runs `work` inside one SQL transaction; every repository in the scope shares it. */
  transaction<T>(work: (scope: RepositoryScope) => Promise<T>): Promise<T>;
  /** Consistent read-only snapshot (REPEATABLE READ) for multi-statement reads. */
  snapshot<T>(work: (scope: RepositoryScope) => Promise<T>): Promise<T>;
  /** Single-statement reads outside an explicit transaction. */
  read<T>(work: (scope: RepositoryScope) => Promise<T>): Promise<T>;
  ping(): Promise<void>;
}

export const UNIT_OF_WORK = Symbol('UNIT_OF_WORK');

/**
 * Raised by repositories when an insert collides on the idempotency key or on
 * (providerId, externalTransactionId) with a transaction committed concurrently. The use case
 * retries and resolves it as a replay or a conflict.
 */
export class IdempotencyRaceError extends Error {
  constructor(constraint: string) {
    super(`Concurrent insert collided on ${constraint}`);
    this.name = 'IdempotencyRaceError';
  }
}
