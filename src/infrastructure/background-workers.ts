import { type PurgeExpiredMessages } from '../application/use-cases/purge-expired-messages';
import { type ResolvePendingReferences } from '../application/use-cases/resolve-pending-references';
import { type AppConfig } from '../config/app-config';
import { logger, serializeError } from '../observability/logger';
import { PollingLoop } from '../shared/async';
import { type OutboxPublisher } from './messaging/outbox-publisher';
import { type SqsWagerConsumer } from './messaging/sqs-wager-consumer';

/**
 * Owns the background loops of one instance: SQS consumer, outbox publisher, the
 * PENDING_REFERENCE worker and the retention job. Each loop is enabled independently through
 * configuration, and all of them are safe to run on any number of instances at the same time.
 */
export class BackgroundWorkers {
  private readonly loops: PollingLoop[] = [];

  constructor(
    private readonly config: AppConfig,
    private readonly consumer: SqsWagerConsumer,
    private readonly outboxPublisher: OutboxPublisher,
    private readonly pendingReferences: ResolvePendingReferences,
    private readonly retention: PurgeExpiredMessages,
  ) {}

  start(): void {
    const onError = (name: string, error: unknown) =>
      logger().error(
        { err: serializeError(error), loop: name },
        'background loop iteration failed',
      );

    if (this.config.outbox.enabled) {
      this.loops.push(
        new PollingLoop(
          'outbox-publisher',
          async () => {
            const summary = await this.outboxPublisher.publishOnce();
            await this.outboxPublisher.refreshLagMetrics();
            return summary.claimed > 0;
          },
          this.config.outbox.pollIntervalMs,
          onError,
        ),
      );
    }
    if (this.config.pendingReference.enabled) {
      this.loops.push(
        new PollingLoop(
          'pending-reference-worker',
          async () => {
            const summary = await this.pendingReferences.runOnce();
            return Object.values(summary).some((count) => count > 0);
          },
          this.config.pendingReference.pollIntervalMs,
          onError,
        ),
      );
    }
    if (this.config.retention.enabled) {
      this.loops.push(
        new PollingLoop(
          'retention',
          async () => {
            await this.retention.runOnce();
            return false;
          },
          this.config.retention.intervalMs,
          onError,
        ),
      );
    }
    this.loops.forEach((loop) => loop.start());
    if (this.config.sqs.consumerEnabled) {
      this.consumer.start();
    }
    logger().info(
      {
        sqsConsumer: this.config.sqs.consumerEnabled,
        outboxPublisher: this.config.outbox.enabled,
        pendingReferenceWorker: this.config.pendingReference.enabled,
        retention: this.config.retention.enabled,
      },
      'background workers started',
    );
  }

  /** Stops intake first, then waits for in-flight work to complete. */
  async stop(): Promise<void> {
    await Promise.all([
      this.config.sqs.consumerEnabled
        ? this.consumer.stop(this.config.shutdownTimeoutMs)
        : Promise.resolve(),
      ...this.loops.map((loop) => loop.stop()),
    ]);
    logger().info('background workers stopped');
  }
}
