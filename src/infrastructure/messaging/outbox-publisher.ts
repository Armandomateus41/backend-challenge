import { SendMessageBatchCommand } from '@aws-sdk/client-sqs';
import { type UnitOfWork } from '../../application/ports/persistence';
import { type OutboxMessage } from '../../domain/outbox-message';
import { type BackoffPolicy } from '../../domain/shared/backoff';
import { logger, serializeError } from '../../observability/logger';
import { metrics } from '../../observability/metrics';
import { type SqsQueues } from './sqs';

const SQS_BATCH_LIMIT = 10;

export interface OutboxPublisherOptions {
  /** Unique per publisher; identifies lease ownership. */
  owner: string;
  batchSize: number;
  leaseMs: number;
  retry: BackoffPolicy;
}

export interface PublishSummary {
  claimed: number;
  published: number;
  failed: number;
  leaseLost: number;
}

/**
 * Publishes committed outbox rows to wagering-events.fifo.
 *
 * Claiming leases rows with SKIP LOCKED so concurrent publishers split the work; a publisher that
 * dies after claiming leaves rows that become claimable once the lease expires. Delivery is
 * at-least-once: a crash after SendMessage and before the row is marked published republishes the
 * event with the same eventId, which SQS FIFO deduplicates (MessageDeduplicationId = eventId)
 * within its 5-minute window and consumers deduplicate by eventId beyond it.
 */
export class OutboxPublisher {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly queues: SqsQueues,
    private readonly options: OutboxPublisherOptions,
  ) {}

  async publishOnce(): Promise<PublishSummary> {
    const claimed = await this.uow.transaction((scope) =>
      scope.outbox.claimDue(this.options.owner, this.options.batchSize, this.options.leaseMs),
    );
    const summary: PublishSummary = {
      claimed: claimed.length,
      published: 0,
      failed: 0,
      leaseLost: 0,
    };
    for (let start = 0; start < claimed.length; start += SQS_BATCH_LIMIT) {
      const chunk = claimed.slice(start, start + SQS_BATCH_LIMIT);
      const failures = await this.send(chunk);
      const now = new Date();
      for (const message of chunk) {
        const failure = failures.get(message.id);
        if (failure === undefined) {
          message.markPublished(now);
        } else {
          message.scheduleRetry(now, this.options.retry, failure);
        }
      }
      const saved = await this.uow.transaction(async (scope) => {
        const results: boolean[] = [];
        for (const message of chunk) {
          results.push(await scope.outbox.saveDeliveryState(message, this.options.owner));
        }
        return results;
      });
      chunk.forEach((message, index) => {
        if (!saved[index]) {
          summary.leaseLost += 1;
          logger().warn({ eventId: message.id }, 'outbox lease lost; message may be republished');
        } else if (message.publishedAt) {
          summary.published += 1;
          metrics.outboxPublished.inc({ event_type: message.eventType });
        } else {
          summary.failed += 1;
          metrics.retries.inc({ operation: 'outbox_publish' });
        }
      });
    }
    return summary;
  }

  async refreshLagMetrics(): Promise<void> {
    const stats = await this.uow.read((scope) => scope.outbox.stats());
    metrics.outboxPending.set(stats.pending);
    metrics.outboxLag.set(stats.oldestPendingAgeSeconds);
  }

  /** Sends one SQS batch; returns the failure reason per message id. */
  private async send(chunk: OutboxMessage[]): Promise<Map<string, string>> {
    const failures = new Map<string, string>();
    try {
      const urls = await this.queues.resolve();
      const response = await this.queues.client.send(
        new SendMessageBatchCommand({
          QueueUrl: urls.events,
          Entries: chunk.map((message, index) => ({
            Id: String(index),
            MessageBody: JSON.stringify(message.payload),
            MessageGroupId: message.orderingKey,
            MessageDeduplicationId: message.id,
            MessageAttributes: {
              eventType: { DataType: 'String', StringValue: message.eventType },
              eventId: { DataType: 'String', StringValue: message.id },
            },
          })),
        }),
      );
      for (const failed of response.Failed ?? []) {
        const message = chunk[Number(failed.Id)];
        if (message) {
          failures.set(message.id, `${failed.Code ?? 'error'}: ${failed.Message ?? ''}`);
        }
      }
    } catch (error) {
      logger().error({ err: serializeError(error) }, 'outbox batch publish failed');
      for (const message of chunk) {
        failures.set(message.id, serializeError(error).message as string);
      }
    }
    return failures;
  }
}
