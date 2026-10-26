import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  type Message,
  ReceiveMessageCommand,
  SendMessageCommand,
} from '@aws-sdk/client-sqs';
import { classifyError } from '../../application/error-classification';
import { type ProcessWagerTransaction } from '../../application/use-cases/process-wager-transaction';
import { exponentialBackoffMs } from '../../domain/shared/backoff';
import {
  wagerTransactionMessageSchema,
  type WagerTransactionMessage,
} from '../../interface/contracts/wager-transaction-request';
import { runWithContext } from '../../observability/context';
import { logger, serializeError } from '../../observability/logger';
import { metrics } from '../../observability/metrics';
import { sleep, withTimeout } from '../../shared/async';
import { type SqsQueues } from './sqs';

export interface ConsumerOptions {
  consumerName: string;
  maxAttempts: number;
  waitTimeSeconds: number;
  visibilityTimeoutSeconds: number;
  retryBaseDelaySeconds: number;
  retryMaxDelaySeconds: number;
}

export type MessageDisposition = 'acked' | 'retry_scheduled' | 'dead_lettered' | 'released';

/**
 * Consumes wager-transactions.fifo.
 *
 * - The message is deleted (acked) only after the SQL transaction that recorded the inbox row and
 *   the financial effect has committed. A crash in between leads to a redelivery that the inbox
 *   recognises as a duplicate.
 * - Business rejections are persisted as REJECTED and acked (terminal).
 * - Validation, not-found and idempotency conflicts are permanent: moved to the DLQ.
 * - Transient and unexpected errors are retried with exponential backoff via the visibility
 *   timeout, up to `maxAttempts` receives, then moved to the DLQ.
 */
export class SqsWagerConsumer {
  private readonly controller = new AbortController();
  private loop: Promise<void> | undefined;

  constructor(
    private readonly queues: SqsQueues,
    private readonly processWager: ProcessWagerTransaction,
    private readonly options: ConsumerOptions,
  ) {}

  start(): void {
    if (!this.loop) {
      this.loop = this.pollLoop();
      logger().info({ consumer: this.options.consumerName }, 'sqs consumer started');
    }
  }

  /**
   * Stops polling, lets in-flight messages finish within `timeoutMs`, and returns the visibility
   * of messages received but not started so another instance can take them immediately.
   */
  async stop(timeoutMs: number): Promise<void> {
    this.controller.abort();
    if (this.loop) {
      const finished = await withTimeout(
        this.loop.then(() => true),
        timeoutMs,
      );
      if (!finished) {
        logger().warn('sqs consumer did not drain before the shutdown timeout');
      }
    }
    logger().info({ consumer: this.options.consumerName }, 'sqs consumer stopped');
  }

  private get stopping(): boolean {
    return this.controller.signal.aborted;
  }

  private async pollLoop(): Promise<void> {
    const { client } = this.queues;
    while (!this.stopping) {
      let messages: Message[];
      try {
        const urls = await this.queues.resolve();
        const response = await client.send(
          new ReceiveMessageCommand({
            QueueUrl: urls.wager,
            MaxNumberOfMessages: 10,
            WaitTimeSeconds: this.options.waitTimeSeconds,
            VisibilityTimeout: this.options.visibilityTimeoutSeconds,
            MessageSystemAttributeNames: ['ApproximateReceiveCount', 'MessageGroupId'],
            MessageAttributeNames: ['All'],
          }),
          { abortSignal: this.controller.signal },
        );
        messages = response.Messages ?? [];
      } catch (error) {
        if (this.stopping) {
          break;
        }
        logger().error({ err: serializeError(error) }, 'sqs receive failed');
        await sleep(1000, this.controller.signal);
        continue;
      }
      try {
        await this.handleBatch(messages);
      } catch (error) {
        // Unacked messages reappear after their visibility timeout.
        logger().error({ err: serializeError(error) }, 'sqs batch handling failed');
      }
    }
  }

  /** Groups run in parallel; messages of one group run in order and stop at the first failure. */
  async handleBatch(messages: Message[]): Promise<void> {
    const groups = new Map<string, Message[]>();
    for (const message of messages) {
      const group = message.Attributes?.MessageGroupId ?? message.MessageId ?? 'default';
      groups.set(group, [...(groups.get(group) ?? []), message]);
    }
    await Promise.all(
      [...groups.values()].map(async (group) => {
        for (const [index, message] of group.entries()) {
          if (this.stopping) {
            await this.release(group.slice(index));
            return;
          }
          const disposition = await this.handleMessage(message);
          if (disposition === 'retry_scheduled') {
            // Keep group order: later messages wait until the failed one is retried.
            await this.release(group.slice(index + 1));
            return;
          }
        }
      }),
    );
  }

  async handleMessage(message: Message): Promise<MessageDisposition> {
    const receiveCount = Number(message.Attributes?.ApproximateReceiveCount ?? '1');
    const parsed = this.parse(message);
    if (!parsed.ok) {
      return runWithContext({ messageId: message.MessageId }, () =>
        this.deadLetter(message, 'INVALID_MESSAGE', parsed.reason, receiveCount),
      );
    }
    const envelope = parsed.envelope;
    const correlationId =
      message.MessageAttributes?.correlationId?.StringValue ?? envelope.messageId;
    return runWithContext(
      {
        correlationId,
        messageId: envelope.messageId,
        walletId: envelope.data.walletId,
        providerId: envelope.data.providerId,
      },
      async () => {
        try {
          const outcome = await this.processWager.execute(envelope.data, {
            source: 'sqs',
            correlationId,
            causationId: envelope.messageId,
            inbox: { consumerName: this.options.consumerName, messageId: envelope.messageId },
          });
          if (outcome.kind === 'duplicate_message') {
            logger().info('duplicate delivery acknowledged without effect');
          }
          await this.ack(message);
          return 'acked';
        } catch (error) {
          return this.handleFailure(message, error, receiveCount);
        }
      },
    );
  }

  private async handleFailure(
    message: Message,
    error: unknown,
    receiveCount: number,
  ): Promise<MessageDisposition> {
    const classified = classifyError(error);
    if (
      classified.category === 'validation' ||
      classified.category === 'not_found' ||
      classified.category === 'conflict'
    ) {
      return this.deadLetter(message, classified.code, classified.message, receiveCount);
    }
    if (receiveCount >= this.options.maxAttempts) {
      return this.deadLetter(message, 'MAX_ATTEMPTS_EXCEEDED', classified.code, receiveCount);
    }
    const delaySeconds = Math.round(
      exponentialBackoffMs(
        {
          baseDelayMs: this.options.retryBaseDelaySeconds * 1000,
          maxDelayMs: this.options.retryMaxDelaySeconds * 1000,
        },
        receiveCount,
      ) / 1000,
    );
    metrics.retries.inc({ operation: 'sqs_message' });
    logger().warn(
      { err: serializeError(error), receiveCount, delaySeconds },
      'message processing failed, retry scheduled',
    );
    await this.changeVisibility(message, delaySeconds);
    return 'retry_scheduled';
  }

  private parse(
    message: Message,
  ): { ok: true; envelope: WagerTransactionMessage } | { ok: false; reason: string } {
    let body: unknown;
    try {
      body = JSON.parse(message.Body ?? '');
    } catch {
      return { ok: false, reason: 'Body is not valid JSON' };
    }
    const result = wagerTransactionMessageSchema.safeParse(body);
    if (!result.success) {
      return {
        ok: false,
        reason: result.error.issues
          .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
          .join('; '),
      };
    }
    return { ok: true, envelope: result.data };
  }

  private async ack(message: Message): Promise<void> {
    const urls = await this.queues.resolve();
    await this.queues.client.send(
      new DeleteMessageCommand({ QueueUrl: urls.wager, ReceiptHandle: message.ReceiptHandle }),
    );
  }

  private async deadLetter(
    message: Message,
    reasonCode: string,
    detail: string,
    receiveCount: number,
  ): Promise<MessageDisposition> {
    const urls = await this.queues.resolve();
    await this.queues.client.send(
      new SendMessageCommand({
        QueueUrl: urls.dlq,
        MessageBody: message.Body ?? '',
        MessageGroupId: message.Attributes?.MessageGroupId ?? 'dead-letter',
        MessageDeduplicationId: message.MessageId,
        MessageAttributes: {
          deadLetterReason: { DataType: 'String', StringValue: reasonCode },
          deadLetterDetail: { DataType: 'String', StringValue: detail.slice(0, 1000) || '-' },
          receiveCount: { DataType: 'Number', StringValue: String(receiveCount) },
          sourceMessageId: { DataType: 'String', StringValue: message.MessageId ?? 'unknown' },
        },
      }),
    );
    await this.ack(message);
    metrics.dlqMessages.inc({ reason: reasonCode });
    logger().error({ reasonCode, receiveCount }, 'message moved to dead-letter queue');
    return 'dead_lettered';
  }

  private async changeVisibility(message: Message, seconds: number): Promise<void> {
    try {
      const urls = await this.queues.resolve();
      await this.queues.client.send(
        new ChangeMessageVisibilityCommand({
          QueueUrl: urls.wager,
          ReceiptHandle: message.ReceiptHandle,
          VisibilityTimeout: seconds,
        }),
      );
    } catch (error) {
      // The original visibility timeout still applies; the message comes back later anyway.
      logger().warn({ err: serializeError(error) }, 'could not change message visibility');
    }
  }

  private async release(messages: Message[]): Promise<void> {
    await Promise.all(messages.map((message) => this.changeVisibility(message, 0)));
  }
}
