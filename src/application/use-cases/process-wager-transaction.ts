import { InboxMessage } from '../../domain/inbox-message';
import { type BackoffPolicy, exponentialBackoffMs } from '../../domain/shared/backoff';
import { WagerSettlement } from '../../domain/wager-settlement';
import { WagerTransaction, WagerTransactionStatus } from '../../domain/wager-transaction';
import { enrichContext } from '../../observability/context';
import { logger } from '../../observability/logger';
import { metrics } from '../../observability/metrics';
import { newId } from '../../shared/ids';
import {
  ExternalTransactionConflictError,
  IdempotencyConflictError,
  TransientInfrastructureError,
  WalletNotFoundError,
} from '../errors';
import { IdempotencyRaceError, type RepositoryScope, type UnitOfWork } from '../ports/persistence';
import { recordSettlement, resolveReference } from '../settlement-recorder';
import {
  type NormalizedWagerCommand,
  normalizeWagerCommand,
  type SubmitWagerTransactionCommand,
} from '../wager-transaction-command';
import { toWagerTransactionResult, type WagerTransactionResult } from '../wager-transaction-result';

export type EntryPoint = 'http' | 'sqs';

export interface ProcessContext {
  source: EntryPoint;
  correlationId: string;
  causationId?: string | undefined;
  /** Present for queue deliveries: recorded in the inbox in the same SQL transaction. */
  inbox?: { consumerName: string; messageId: string } | undefined;
}

export type ProcessOutcome =
  | { kind: 'settled'; result: WagerTransactionResult }
  /** The inbox already holds this message id: its effect is committed, nothing was done. */
  | { kind: 'duplicate_message'; result: WagerTransactionResult | undefined };

/** Bounded retries for lock conflicts and concurrent unique-key races inside one call. */
const MAX_ATTEMPTS = 3;

/**
 * Single entry for provider operations, used by both HTTP and SQS.
 *
 * Concurrency: the wallet row is locked with SELECT ... FOR UPDATE, which serializes every
 * operation on that wallet across all instances while other wallets proceed in parallel.
 * Idempotency: the persisted transaction row (unique idempotency key) is the source of truth;
 * the key is checked before and again after acquiring the lock.
 */
export class ProcessWagerTransaction {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly pendingReferenceBackoff: BackoffPolicy,
  ) {}

  async execute(
    command: SubmitWagerTransactionCommand,
    context: ProcessContext,
  ): Promise<ProcessOutcome> {
    const normalized = normalizeWagerCommand(command);
    // Validates the domain contract (kind, reference rules, amount) before touching the database.
    this.buildTransaction(normalized, new Date());
    enrichContext({
      providerId: command.providerId,
      walletId: command.walletId,
    });

    const startedAt = performance.now();
    let outcomeLabel = 'error';
    try {
      const outcome = await this.executeWithRetry(normalized, context);
      outcomeLabel = this.recordMetrics(outcome, normalized, context);
      return outcome;
    } catch (error) {
      if (error instanceof IdempotencyConflictError) {
        metrics.idempotencyConflicts.inc({ source: context.source });
        outcomeLabel = 'idempotency_conflict';
      }
      throw error;
    } finally {
      metrics.processingDuration.observe(
        { source: context.source, outcome: outcomeLabel },
        (performance.now() - startedAt) / 1000,
      );
    }
  }

  private async executeWithRetry(
    normalized: NormalizedWagerCommand,
    context: ProcessContext,
  ): Promise<ProcessOutcome> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.uow.transaction((scope) =>
          this.processInTransaction(scope, normalized, context),
        );
      } catch (error) {
        const retryable =
          error instanceof IdempotencyRaceError ||
          (error instanceof TransientInfrastructureError && error.reason === 'lock_conflict');
        if (!retryable || attempt >= MAX_ATTEMPTS) {
          throw error;
        }
        metrics.lockConflicts.inc({
          type: error instanceof IdempotencyRaceError ? 'unique_race' : 'lock',
        });
        metrics.retries.inc({ operation: 'process_transaction' });
        logger().warn({ attempt, reason: error.name }, 'retrying wager transaction');
      }
    }
  }

  private async processInTransaction(
    scope: RepositoryScope,
    normalized: NormalizedWagerCommand,
    context: ProcessContext,
  ): Promise<ProcessOutcome> {
    const { command, payloadHash } = normalized;
    const now = new Date();

    let inboxMessage: InboxMessage | undefined;
    if (context.inbox) {
      inboxMessage = InboxMessage.receive({ ...context.inbox, payloadHash, receivedAt: now });
      inboxMessage.markProcessed(now);
      if (!(await scope.inbox.tryRecord(inboxMessage))) {
        const existing = await scope.transactions.findByIdempotencyKey(command.idempotencyKey);
        return {
          kind: 'duplicate_message',
          result: existing ? toWagerTransactionResult(existing, true) : undefined,
        };
      }
    }

    const prior = await scope.transactions.findByIdempotencyKey(command.idempotencyKey);
    if (prior) {
      return this.replay(scope, prior, payloadHash, inboxMessage);
    }

    const wallet = await scope.wallets.lockById(command.walletId);
    if (!wallet) {
      throw new WalletNotFoundError(command.walletId);
    }
    // A concurrent request with the same key may have committed while this one waited for the lock.
    const committedMeanwhile = await scope.transactions.findByIdempotencyKey(
      command.idempotencyKey,
    );
    if (committedMeanwhile) {
      return this.replay(scope, committedMeanwhile, payloadHash, inboxMessage);
    }
    const sameExternalId = await scope.transactions.findByExternalId(
      command.providerId,
      command.externalTransactionId,
    );
    if (sameExternalId) {
      throw new ExternalTransactionConflictError(command.providerId, command.externalTransactionId);
    }

    const transaction = this.buildTransaction(normalized, now);
    enrichContext({ transactionId: transaction.id });
    const walletVersionBefore = wallet.version;
    const outcome = WagerSettlement.settle({
      transaction,
      wallet,
      reference: await resolveReference(scope, transaction),
      entryId: newId(),
      at: now,
      referenceWindowExhausted: false,
    });

    const pending = outcome.status === WagerTransactionStatus.PendingReference;
    await recordSettlement(scope, {
      transaction,
      wallet,
      walletVersionBefore,
      outcome,
      isNew: true,
      schedule: {
        resolutionAttempts: 0,
        retryDelayMs: pending ? exponentialBackoffMs(this.pendingReferenceBackoff, 1) : undefined,
      },
      correlationId: context.correlationId,
      causationId: context.causationId,
      at: now,
    });
    if (inboxMessage) {
      await scope.inbox.linkTransaction(inboxMessage, transaction.id);
    }
    return { kind: 'settled', result: toWagerTransactionResult(transaction, false) };
  }

  private async replay(
    scope: RepositoryScope,
    prior: WagerTransaction,
    payloadHash: string,
    inboxMessage: InboxMessage | undefined,
  ): Promise<ProcessOutcome> {
    if (!prior.matchesPayload(payloadHash)) {
      throw new IdempotencyConflictError(prior.idempotencyKey);
    }
    enrichContext({ transactionId: prior.id });
    if (inboxMessage) {
      await scope.inbox.linkTransaction(inboxMessage, prior.id);
    }
    return { kind: 'settled', result: toWagerTransactionResult(prior, true) };
  }

  private buildTransaction(normalized: NormalizedWagerCommand, now: Date): WagerTransaction {
    const { command } = normalized;
    return WagerTransaction.create({
      id: newId(),
      providerId: command.providerId,
      externalTransactionId: command.externalTransactionId,
      idempotencyKey: command.idempotencyKey,
      payloadHash: normalized.payloadHash,
      walletId: command.walletId,
      playerId: command.playerId,
      roundId: command.roundId,
      gameId: command.gameId,
      kind: command.kind,
      money: normalized.money,
      referenceExternalTransactionId: command.referenceExternalTransactionId,
      createdAt: now,
    });
  }

  private recordMetrics(
    outcome: ProcessOutcome,
    normalized: NormalizedWagerCommand,
    context: ProcessContext,
  ): string {
    if (outcome.kind === 'duplicate_message') {
      metrics.duplicates.inc({ type: 'inbox', source: context.source });
      return 'duplicate_message';
    }
    const { result } = outcome;
    if (result.idempotentReplay) {
      metrics.duplicates.inc({ type: 'idempotent_replay', source: context.source });
      return 'replay';
    }
    metrics.transactions.inc({
      status: result.status,
      kind: normalized.command.kind,
      source: context.source,
    });
    logger().info(
      { status: result.status, failureCode: result.failureCode, kind: normalized.command.kind },
      'wager transaction settled',
    );
    return result.status.toLowerCase();
  }
}
