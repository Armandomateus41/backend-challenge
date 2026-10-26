import {
  CreateQueueCommand,
  GetQueueAttributesCommand,
  GetQueueUrlCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { type AppConfig } from '../../config/app-config';

export function createSqsClient(config: AppConfig['aws']): SQSClient {
  return new SQSClient({
    region: config.region,
    ...(config.endpoint ? { endpoint: config.endpoint } : {}),
    ...(config.credentials ? { credentials: config.credentials } : {}),
    maxAttempts: 3,
  });
}

export interface QueueUrls {
  wager: string;
  dlq: string;
  events: string;
}

/** Resolves and caches queue URLs; also backs the readiness probe. */
export class SqsQueues {
  private urls: QueueUrls | undefined;

  constructor(
    readonly client: SQSClient,
    private readonly names: { wager: string; dlq: string; events: string },
  ) {}

  async resolve(): Promise<QueueUrls> {
    if (!this.urls) {
      const [wager, dlq, events] = await Promise.all([
        this.urlOf(this.names.wager),
        this.urlOf(this.names.dlq),
        this.urlOf(this.names.events),
      ]);
      this.urls = { wager, dlq, events };
    }
    return this.urls;
  }

  async ping(): Promise<void> {
    const urls = await this.resolve();
    await this.client.send(
      new GetQueueAttributesCommand({ QueueUrl: urls.wager, AttributeNames: ['QueueArn'] }),
    );
  }

  private async urlOf(name: string): Promise<string> {
    const result = await this.client.send(new GetQueueUrlCommand({ QueueName: name }));
    if (!result.QueueUrl) {
      throw new Error(`Queue ${name} not found`);
    }
    return result.QueueUrl;
  }
}

/**
 * Creates the FIFO queues if missing (CreateQueue is idempotent for identical attributes).
 * The redrive policy is a safety net for poison messages that crash the consumer before it can
 * route them; the consumer itself moves messages to the DLQ after `maxAttempts`.
 */
export async function ensureQueues(
  client: SQSClient,
  names: { wager: string; dlq: string; events: string },
  options: { maxAttempts: number; visibilityTimeoutSeconds: number },
): Promise<QueueUrls> {
  const fifo = { FifoQueue: 'true', ContentBasedDeduplication: 'false' };
  const dlq = await client.send(
    new CreateQueueCommand({
      QueueName: names.dlq,
      Attributes: { ...fifo, MessageRetentionPeriod: '1209600' },
    }),
  );
  const dlqUrl = dlq.QueueUrl!;
  const dlqAttributes = await client.send(
    new GetQueueAttributesCommand({ QueueUrl: dlqUrl, AttributeNames: ['QueueArn'] }),
  );
  const wager = await client.send(
    new CreateQueueCommand({
      QueueName: names.wager,
      Attributes: {
        ...fifo,
        VisibilityTimeout: String(options.visibilityTimeoutSeconds),
        RedrivePolicy: JSON.stringify({
          deadLetterTargetArn: dlqAttributes.Attributes?.QueueArn,
          maxReceiveCount: String(options.maxAttempts + 2),
        }),
      },
    }),
  );
  const events = await client.send(
    new CreateQueueCommand({ QueueName: names.events, Attributes: fifo }),
  );
  return { wager: wager.QueueUrl!, dlq: dlqUrl, events: events.QueueUrl! };
}
