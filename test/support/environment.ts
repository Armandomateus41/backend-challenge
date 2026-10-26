import {
  DeleteQueueCommand,
  GetQueueUrlCommand,
  type Message,
  PurgeQueueCommand,
  DeleteMessageCommand,
  GetQueueAttributesCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import { type INestApplication } from '@nestjs/common';
import { type MikroORM } from '@mikro-orm/postgresql';
import { createApp } from '../../src/bootstrap';
import { type AppConfig, loadConfig } from '../../src/config/app-config';
import { createOrm } from '../../src/infrastructure/database/orm';
import {
  createSqsClient,
  ensureQueues,
  type QueueUrls,
} from '../../src/infrastructure/messaging/sqs';
import { newId } from '../../src/shared/ids';

export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://wagering:wagering@localhost:55432/wagering_test';

/** Environment for an app under test. Background loops are off unless a test enables them. */
export function testEnv(
  suffix: string,
  overrides: Record<string, string> = {},
): Record<string, string> {
  return {
    DATABASE_URL: TEST_DATABASE_URL,
    DATABASE_POOL_MAX: '20',
    DATABASE_LOCK_TIMEOUT_MS: '5000',
    HTTP_PORT: '0',
    INSTANCE_ID: `test-${suffix}`,
    LOG_LEVEL: process.env.TEST_LOG_LEVEL ?? 'silent',
    SUPPORTED_CURRENCIES: 'BRL',
    SHUTDOWN_TIMEOUT_MS: '10000',
    AWS_REGION: process.env.AWS_REGION ?? 'us-east-1',
    AWS_ENDPOINT_URL: process.env.AWS_ENDPOINT_URL ?? 'http://localhost:4566',
    AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID ?? 'test',
    AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY ?? 'test',
    SQS_WAGER_QUEUE_NAME: `wager-transactions-${suffix}.fifo`,
    SQS_WAGER_DLQ_NAME: `wager-transactions-dlq-${suffix}.fifo`,
    SQS_EVENTS_QUEUE_NAME: `wagering-events-${suffix}.fifo`,
    SQS_CONSUMER_ENABLED: 'false',
    SQS_CONSUMER_NAME: 'wager-transactions-consumer',
    SQS_MAX_ATTEMPTS: '3',
    SQS_WAIT_TIME_SECONDS: '1',
    SQS_VISIBILITY_TIMEOUT_SECONDS: '4',
    SQS_RETRY_BASE_DELAY_SECONDS: '1',
    SQS_RETRY_MAX_DELAY_SECONDS: '2',
    OUTBOX_PUBLISHER_ENABLED: 'false',
    OUTBOX_POLL_INTERVAL_MS: '100',
    OUTBOX_BATCH_SIZE: '50',
    OUTBOX_LEASE_MS: '2000',
    OUTBOX_RETRY_BASE_DELAY_MS: '200',
    OUTBOX_RETRY_MAX_DELAY_MS: '1000',
    PENDING_REFERENCE_WORKER_ENABLED: 'false',
    PENDING_REFERENCE_POLL_INTERVAL_MS: '100',
    PENDING_REFERENCE_BATCH_SIZE: '50',
    PENDING_REFERENCE_MAX_ATTEMPTS: '4',
    PENDING_REFERENCE_BASE_DELAY_MS: '100',
    PENDING_REFERENCE_MAX_DELAY_MS: '400',
    PENDING_REFERENCE_LEASE_MS: '2000',
    RETENTION_ENABLED: 'false',
    WALLET_GATE_ENABLED: 'true',
    ...overrides,
  };
}

export function testConfig(suffix: string, overrides: Record<string, string> = {}): AppConfig {
  return loadConfig(testEnv(suffix, overrides));
}

export function uniqueSuffix(): string {
  return newId().replaceAll('-', '').slice(-12);
}

/** Direct database access for arrange/assert steps; uses the same MikroORM setup as the app. */
export class TestDatabase {
  private constructor(readonly orm: MikroORM) {}

  static async connect(): Promise<TestDatabase> {
    const orm = await createOrm({ url: TEST_DATABASE_URL, poolMax: 10 });
    await orm.migrator.up();
    return new TestDatabase(orm);
  }

  async query<T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params: unknown[] = [],
  ): Promise<T[]> {
    return this.orm.em.fork().execute<T[]>(sql, params);
  }

  async reset(): Promise<void> {
    await this.query(
      'TRUNCATE inbox_messages, outbox_messages, wallet_ledger_entries, wager_transactions, wallets RESTART IDENTITY CASCADE',
    );
  }

  async walletState(walletId: string): Promise<{
    balance: string;
    version: number;
    ledgerBalance: string;
    entries: number;
    debits: number;
    credits: number;
    lastBalanceAfter: string | null;
  }> {
    const [row] = await this.query<{
      balance: string;
      version: number;
      ledger_balance: string;
      entries: number;
      debits: number;
      credits: number;
      last_balance_after: string | null;
    }>(
      `SELECT w.balance::text AS balance, w.version,
              COALESCE((SELECT SUM(CASE direction WHEN 'CREDIT' THEN amount ELSE -amount END)
                          FROM wallet_ledger_entries e WHERE e.wallet_id = w.id), 0)::numeric(22,2)::text AS ledger_balance,
              (SELECT COUNT(*)::int FROM wallet_ledger_entries e WHERE e.wallet_id = w.id) AS entries,
              (SELECT COUNT(*)::int FROM wallet_ledger_entries e WHERE e.wallet_id = w.id AND direction = 'DEBIT') AS debits,
              (SELECT COUNT(*)::int FROM wallet_ledger_entries e WHERE e.wallet_id = w.id AND direction = 'CREDIT') AS credits,
              (SELECT balance_after::text FROM wallet_ledger_entries e WHERE e.wallet_id = w.id
                ORDER BY wallet_version DESC LIMIT 1) AS last_balance_after
         FROM wallets w WHERE w.id = ?`,
      [walletId],
    );
    if (!row) {
      throw new Error(`wallet ${walletId} not found`);
    }
    return {
      balance: row.balance,
      version: row.version,
      ledgerBalance: row.ledger_balance,
      entries: row.entries,
      debits: row.debits,
      credits: row.credits,
      lastBalanceAfter: row.last_balance_after,
    };
  }

  /**
   * Central invariant, checked over every wallet: materialized balance equals the balance rebuilt
   * from the ledger, the version matches the last entry, and nothing is negative.
   */
  async inconsistentWallets(): Promise<Record<string, unknown>[]> {
    return this.query(
      `SELECT w.id, w.balance::text AS balance, w.version, l.total::text AS ledger_total, l.max_version
         FROM wallets w
         LEFT JOIN LATERAL (
           SELECT COALESCE(SUM(CASE direction WHEN 'CREDIT' THEN amount ELSE -amount END), 0) AS total,
                  MAX(wallet_version) AS max_version
             FROM wallet_ledger_entries e WHERE e.wallet_id = w.id) l ON true
        WHERE w.balance <> l.total
           OR w.balance < 0
           OR (l.max_version IS NOT NULL AND l.max_version <> w.version)
           OR (l.max_version IS NULL AND w.version <> 1)`,
    );
  }

  async close(): Promise<void> {
    await this.orm.close();
  }
}

export class TestQueues {
  private constructor(
    readonly client: SQSClient,
    readonly urls: QueueUrls,
  ) {}

  static async create(config: AppConfig): Promise<TestQueues> {
    const client = createSqsClient(config.aws);
    const urls = await ensureQueues(
      client,
      {
        wager: config.sqs.wagerQueueName,
        dlq: config.sqs.wagerDlqName,
        events: config.sqs.eventsQueueName,
      },
      {
        maxAttempts: config.sqs.maxAttempts,
        visibilityTimeoutSeconds: config.sqs.visibilityTimeoutSeconds,
      },
    );
    return new TestQueues(client, urls);
  }

  async sendWager(
    message: { messageId: string; data: Record<string, unknown> },
    options: { deduplicationId?: string } = {},
  ): Promise<void> {
    await this.client.send(
      new SendMessageCommand({
        QueueUrl: this.urls.wager,
        MessageBody: JSON.stringify({
          messageId: message.messageId,
          type: 'WagerTransactionRequested',
          occurredAt: new Date().toISOString(),
          data: message.data,
        }),
        MessageGroupId: typeof message.data.walletId === 'string' ? message.data.walletId : 'group',
        MessageDeduplicationId: options.deduplicationId ?? message.messageId,
      }),
    );
  }

  async sendRaw(body: string, groupId = 'raw'): Promise<void> {
    await this.client.send(
      new SendMessageCommand({
        QueueUrl: this.urls.wager,
        MessageBody: body,
        MessageGroupId: groupId,
        MessageDeduplicationId: newId(),
      }),
    );
  }

  /** Receives until `expected` messages are collected or the timeout elapses (deletes them). */
  async drain(queueUrl: string, expected: number, timeoutMs = 15000): Promise<Message[]> {
    const collected: Message[] = [];
    const deadline = Date.now() + timeoutMs;
    while (collected.length < expected && Date.now() < deadline) {
      const response = await this.client.send(
        new ReceiveMessageCommand({
          QueueUrl: queueUrl,
          MaxNumberOfMessages: 10,
          WaitTimeSeconds: 1,
          MessageAttributeNames: ['All'],
          MessageSystemAttributeNames: ['All'],
        }),
      );
      for (const message of response.Messages ?? []) {
        collected.push(message);
        await this.client.send(
          new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: message.ReceiptHandle }),
        );
      }
    }
    return collected;
  }

  /** Counts visible and in-flight messages. */
  async depth(queueUrl: string): Promise<{ visible: number; inFlight: number }> {
    const response = await this.client.send(
      new GetQueueAttributesCommand({
        QueueUrl: queueUrl,
        AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'],
      }),
    );
    return {
      visible: Number(response.Attributes?.ApproximateNumberOfMessages ?? 0),
      inFlight: Number(response.Attributes?.ApproximateNumberOfMessagesNotVisible ?? 0),
    };
  }

  async purgeAll(): Promise<void> {
    for (const url of [this.urls.wager, this.urls.dlq, this.urls.events]) {
      await this.client.send(new PurgeQueueCommand({ QueueUrl: url })).catch(() => undefined);
    }
  }

  async destroy(): Promise<void> {
    for (const url of [this.urls.wager, this.urls.dlq, this.urls.events]) {
      await this.client.send(new DeleteQueueCommand({ QueueUrl: url })).catch(() => undefined);
    }
    this.client.destroy();
  }

  async exists(name: string): Promise<boolean> {
    try {
      await this.client.send(new GetQueueUrlCommand({ QueueName: name }));
      return true;
    } catch {
      return false;
    }
  }
}

export interface RunningApp {
  app: INestApplication;
  baseUrl: string;
  config: AppConfig;
  close(): Promise<void>;
}

export async function startApp(config: AppConfig): Promise<RunningApp> {
  const app = await createApp(config);
  await app.listen(0, '127.0.0.1');
  const server = app.getHttpServer() as { address(): { port: number } };
  const address = server.address();
  return {
    app,
    config,
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => app.close(),
  };
}

/** Polls `check` until it returns true or the timeout elapses. */
export async function eventually(
  check: () => Promise<boolean>,
  timeoutMs = 15000,
  intervalMs = 100,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) {
      return;
    }
    await Bun.sleep(intervalMs);
  }
  throw new Error(`condition not met within ${timeoutMs}ms`);
}
