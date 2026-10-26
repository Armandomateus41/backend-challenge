import { logger } from '../../observability/logger';
import { metrics } from '../../observability/metrics';
import { type UnitOfWork } from '../ports/persistence';

export interface RetentionPolicy {
  /**
   * How long processed inbox rows are kept. Must exceed the longest time a message can still be
   * redelivered (queue and DLQ retention). After that window, duplicates are still stopped by the
   * idempotency key, which is never deleted.
   */
  inboxRetentionHours: number;
  /** How long published outbox rows are kept for audit. Pending rows are never deleted. */
  outboxRetentionHours: number;
  batchSize: number;
}

/** Bound per run so one instance never holds a long series of deletes. */
const MAX_BATCHES_PER_RUN = 50;

/**
 * Deletes expired inbox rows and published outbox rows in small batches, each in its own short
 * transaction. Safe to run on several instances at once: overlapping deletes simply find fewer rows.
 */
export class PurgeExpiredMessages {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly policy: RetentionPolicy,
  ) {}

  async runOnce(): Promise<{ inbox: number; outbox: number }> {
    const inbox = await this.purge('inbox', (limit) =>
      this.uow.transaction((scope) =>
        scope.inbox.deleteProcessedBefore(this.policy.inboxRetentionHours, limit),
      ),
    );
    const outbox = await this.purge('outbox', (limit) =>
      this.uow.transaction((scope) =>
        scope.outbox.deletePublishedBefore(this.policy.outboxRetentionHours, limit),
      ),
    );
    if (inbox + outbox > 0) {
      logger().info({ inbox, outbox }, 'expired messages purged');
    }
    return { inbox, outbox };
  }

  private async purge(table: string, deleteBatch: (limit: number) => Promise<number>) {
    let total = 0;
    for (let batch = 0; batch < MAX_BATCHES_PER_RUN; batch++) {
      const deleted = await deleteBatch(this.policy.batchSize);
      total += deleted;
      if (deleted < this.policy.batchSize) {
        break;
      }
    }
    metrics.retentionDeleted.inc({ table }, total);
    return total;
  }
}
