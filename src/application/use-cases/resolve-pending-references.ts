import { FailureCode } from '../../domain/failure-code';
import { type BackoffPolicy, exponentialBackoffMs } from '../../domain/shared/backoff';
import { WagerSettlement } from '../../domain/wager-settlement';
import { WagerTransactionStatus } from '../../domain/wager-transaction';
import { runWithContext } from '../../observability/context';
import { logger, serializeError } from '../../observability/logger';
import { metrics } from '../../observability/metrics';
import { newId } from '../../shared/ids';
import { ApplicationError } from '../errors';
import { type ClaimedPendingTransaction, type UnitOfWork } from '../ports/persistence';
import { recordSettlement, resolveReference } from '../settlement-recorder';

export interface PendingReferencePolicy extends BackoffPolicy {
  /** Resolution attempts before the transaction is rejected with REFERENCE_NOT_FOUND. */
  maxAttempts: number;
  batchSize: number;
  /** How long a claimed row is hidden from other workers. */
  leaseMs: number;
}

export type ResolutionResult = 'processed' | 'rejected' | 'still_pending' | 'skipped' | 'failed';

/**
 * Re-evaluates PENDING_REFERENCE transactions. Rows are claimed with SKIP LOCKED and a lease, so
 * several instances can run the worker concurrently without double-processing a row; each row is
 * then settled under the same wallet lock used by the online path.
 */
export class ResolvePendingReferences {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly policy: PendingReferencePolicy,
  ) {}

  async runOnce(): Promise<Record<ResolutionResult, number>> {
    const claimed = await this.uow.transaction((scope) =>
      scope.transactions.claimDuePending(this.policy.batchSize, this.policy.leaseMs),
    );
    const summary: Record<ResolutionResult, number> = {
      processed: 0,
      rejected: 0,
      still_pending: 0,
      skipped: 0,
      failed: 0,
    };
    for (const item of claimed) {
      const result = await runWithContext(
        { transactionId: item.transactionId, walletId: item.walletId },
        () => this.resolveSafely(item),
      );
      summary[result] += 1;
    }
    return summary;
  }

  private async resolveSafely(item: ClaimedPendingTransaction): Promise<ResolutionResult> {
    try {
      return await this.resolve(item);
    } catch (error) {
      if (error instanceof ApplicationError && error.kind === 'transient') {
        // The lease expires and another run picks the row up again.
        metrics.retries.inc({ operation: 'pending_reference' });
        logger().warn({ err: serializeError(error) }, 'pending reference resolution deferred');
        return 'still_pending';
      }
      logger().error({ err: serializeError(error) }, 'pending reference resolution failed');
      await this.markFailed(item);
      return 'failed';
    }
  }

  private resolve(item: ClaimedPendingTransaction): Promise<ResolutionResult> {
    return this.uow.transaction(async (scope) => {
      const wallet = await scope.wallets.lockById(item.walletId);
      const locked = await scope.transactions.lockPending(item.transactionId);
      if (
        !wallet ||
        !locked ||
        locked.transaction.status !== WagerTransactionStatus.PendingReference
      ) {
        return 'skipped';
      }
      const { transaction } = locked;
      const now = new Date();
      const attempts = locked.resolutionAttempts + 1;
      const walletVersionBefore = wallet.version;
      const outcome = WagerSettlement.settle({
        transaction,
        wallet,
        reference: await resolveReference(scope, transaction),
        entryId: newId(),
        at: now,
        referenceWindowExhausted: attempts >= this.policy.maxAttempts,
      });
      const stillPending = outcome.status === WagerTransactionStatus.PendingReference;
      await recordSettlement(scope, {
        transaction,
        wallet,
        walletVersionBefore,
        outcome,
        isNew: false,
        schedule: {
          resolutionAttempts: attempts,
          retryDelayMs: stillPending ? exponentialBackoffMs(this.policy, attempts + 1) : undefined,
        },
        correlationId: locked.correlationId ?? transaction.id,
        causationId: transaction.id,
        at: now,
      });

      if (stillPending) {
        metrics.retries.inc({ operation: 'pending_reference' });
        return 'still_pending';
      }
      metrics.transactions.inc({
        status: outcome.status,
        kind: transaction.kind,
        source: 'worker',
      });
      if (outcome.status === WagerTransactionStatus.Rejected) {
        if (
          outcome.failureCode === FailureCode.ReferenceNotFound ||
          outcome.failureCode === FailureCode.ReferenceNotProcessed
        ) {
          metrics.pendingReferenceExpired.inc();
        }
        logger().info(
          { failureCode: outcome.failureCode, attempts },
          'pending transaction rejected',
        );
        return 'rejected';
      }
      logger().info({ attempts }, 'pending transaction processed');
      return 'processed';
    });
  }

  /** Records a permanent processing error as FAILED so the row stops being retried. */
  private async markFailed(item: ClaimedPendingTransaction): Promise<void> {
    try {
      const failedKind = await this.uow.transaction(async (scope) => {
        await scope.wallets.lockById(item.walletId);
        const locked = await scope.transactions.lockPending(item.transactionId);
        if (!locked || locked.transaction.status !== WagerTransactionStatus.PendingReference) {
          return undefined;
        }
        locked.transaction.fail(FailureCode.ProcessingError, new Date());
        await scope.transactions.updateState(locked.transaction, {
          resolutionAttempts: locked.resolutionAttempts + 1,
          retryDelayMs: undefined,
        });
        return locked.transaction.kind;
      });
      if (failedKind) {
        metrics.transactions.inc({
          status: WagerTransactionStatus.Failed,
          kind: failedKind,
          source: 'worker',
        });
      }
    } catch (error) {
      logger().error({ err: serializeError(error) }, 'could not record FAILED status');
    }
  }
}
