import { z } from 'zod';

const booleanFlag = z
  .enum(['true', 'false', '1', '0'])
  .transform((value) => value === 'true' || value === '1');

const positiveInt = z.coerce.number().int().positive();

const envSchema = z.object({
  DATABASE_URL: z.string().url(),
  DATABASE_POOL_MAX: positiveInt.default(20),
  DATABASE_LOCK_TIMEOUT_MS: positiveInt.default(5000),

  HTTP_PORT: z.coerce.number().int().min(0).max(65535).default(8080),
  INSTANCE_ID: z.string().min(1).default(`instance-${process.pid}`),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  SUPPORTED_CURRENCIES: z
    .string()
    .default('BRL')
    .transform((value) => value.split(',').map((currency) => currency.trim().toUpperCase()))
    .pipe(z.array(z.string().regex(/^[A-Z]{3}$/)).min(1)),
  SHUTDOWN_TIMEOUT_MS: positiveInt.default(20000),

  AWS_REGION: z.string().min(1).default('us-east-1'),
  AWS_ENDPOINT_URL: z.string().url().optional(),
  AWS_ACCESS_KEY_ID: z.string().optional(),
  AWS_SECRET_ACCESS_KEY: z.string().optional(),

  SQS_WAGER_QUEUE_NAME: z.string().endsWith('.fifo').default('wager-transactions.fifo'),
  SQS_WAGER_DLQ_NAME: z.string().endsWith('.fifo').default('wager-transactions-dlq.fifo'),
  SQS_EVENTS_QUEUE_NAME: z.string().endsWith('.fifo').default('wagering-events.fifo'),
  SQS_CONSUMER_ENABLED: booleanFlag.default(true),
  SQS_CONSUMER_NAME: z.string().min(1).default('wager-transactions-consumer'),
  SQS_MAX_ATTEMPTS: positiveInt.default(5),
  SQS_WAIT_TIME_SECONDS: z.coerce.number().int().min(0).max(20).default(10),
  SQS_VISIBILITY_TIMEOUT_SECONDS: positiveInt.default(30),
  SQS_RETRY_BASE_DELAY_SECONDS: positiveInt.default(2),
  SQS_RETRY_MAX_DELAY_SECONDS: positiveInt.max(43200).default(300),

  OUTBOX_PUBLISHER_ENABLED: booleanFlag.default(true),
  OUTBOX_POLL_INTERVAL_MS: positiveInt.default(500),
  OUTBOX_BATCH_SIZE: positiveInt.max(10_000).default(50),
  OUTBOX_LEASE_MS: positiveInt.default(30000),
  OUTBOX_RETRY_BASE_DELAY_MS: positiveInt.default(1000),
  OUTBOX_RETRY_MAX_DELAY_MS: positiveInt.default(60000),

  PENDING_REFERENCE_WORKER_ENABLED: booleanFlag.default(true),
  PENDING_REFERENCE_POLL_INTERVAL_MS: positiveInt.default(1000),
  PENDING_REFERENCE_BATCH_SIZE: positiveInt.default(50),
  PENDING_REFERENCE_MAX_ATTEMPTS: positiveInt.default(8),
  PENDING_REFERENCE_BASE_DELAY_MS: positiveInt.default(1000),
  PENDING_REFERENCE_MAX_DELAY_MS: positiveInt.default(60000),
  PENDING_REFERENCE_LEASE_MS: positiveInt.default(30000),
});

export interface AppConfig {
  database: { url: string; poolMax: number; lockTimeoutMs: number };
  http: { port: number };
  instanceId: string;
  logLevel: z.infer<typeof envSchema>['LOG_LEVEL'];
  supportedCurrencies: readonly string[];
  shutdownTimeoutMs: number;
  aws: {
    region: string;
    endpoint: string | undefined;
    credentials: { accessKeyId: string; secretAccessKey: string } | undefined;
  };
  sqs: {
    wagerQueueName: string;
    wagerDlqName: string;
    eventsQueueName: string;
    consumerEnabled: boolean;
    consumerName: string;
    maxAttempts: number;
    waitTimeSeconds: number;
    visibilityTimeoutSeconds: number;
    retryBaseDelaySeconds: number;
    retryMaxDelaySeconds: number;
  };
  outbox: {
    enabled: boolean;
    pollIntervalMs: number;
    batchSize: number;
    leaseMs: number;
    retryBaseDelayMs: number;
    retryMaxDelayMs: number;
  };
  pendingReference: {
    enabled: boolean;
    pollIntervalMs: number;
    batchSize: number;
    maxAttempts: number;
    baseDelayMs: number;
    maxDelayMs: number;
    leaseMs: number;
  };
}

export const APP_CONFIG = Symbol('APP_CONFIG');

/** Validates the environment once at startup and fails fast with every invalid variable listed. */
export function loadConfig(env: Record<string, string | undefined> = process.env): AppConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ');
    throw new Error(`Invalid configuration: ${issues}`);
  }
  const e = parsed.data;
  return {
    database: {
      url: e.DATABASE_URL,
      poolMax: e.DATABASE_POOL_MAX,
      lockTimeoutMs: e.DATABASE_LOCK_TIMEOUT_MS,
    },
    http: { port: e.HTTP_PORT },
    instanceId: e.INSTANCE_ID,
    logLevel: e.LOG_LEVEL,
    supportedCurrencies: e.SUPPORTED_CURRENCIES,
    shutdownTimeoutMs: e.SHUTDOWN_TIMEOUT_MS,
    aws: {
      region: e.AWS_REGION,
      endpoint: e.AWS_ENDPOINT_URL,
      credentials:
        e.AWS_ACCESS_KEY_ID && e.AWS_SECRET_ACCESS_KEY
          ? { accessKeyId: e.AWS_ACCESS_KEY_ID, secretAccessKey: e.AWS_SECRET_ACCESS_KEY }
          : undefined,
    },
    sqs: {
      wagerQueueName: e.SQS_WAGER_QUEUE_NAME,
      wagerDlqName: e.SQS_WAGER_DLQ_NAME,
      eventsQueueName: e.SQS_EVENTS_QUEUE_NAME,
      consumerEnabled: e.SQS_CONSUMER_ENABLED,
      consumerName: e.SQS_CONSUMER_NAME,
      maxAttempts: e.SQS_MAX_ATTEMPTS,
      waitTimeSeconds: e.SQS_WAIT_TIME_SECONDS,
      visibilityTimeoutSeconds: e.SQS_VISIBILITY_TIMEOUT_SECONDS,
      retryBaseDelaySeconds: e.SQS_RETRY_BASE_DELAY_SECONDS,
      retryMaxDelaySeconds: e.SQS_RETRY_MAX_DELAY_SECONDS,
    },
    outbox: {
      enabled: e.OUTBOX_PUBLISHER_ENABLED,
      pollIntervalMs: e.OUTBOX_POLL_INTERVAL_MS,
      batchSize: e.OUTBOX_BATCH_SIZE,
      leaseMs: e.OUTBOX_LEASE_MS,
      retryBaseDelayMs: e.OUTBOX_RETRY_BASE_DELAY_MS,
      retryMaxDelayMs: e.OUTBOX_RETRY_MAX_DELAY_MS,
    },
    pendingReference: {
      enabled: e.PENDING_REFERENCE_WORKER_ENABLED,
      pollIntervalMs: e.PENDING_REFERENCE_POLL_INTERVAL_MS,
      batchSize: e.PENDING_REFERENCE_BATCH_SIZE,
      maxAttempts: e.PENDING_REFERENCE_MAX_ATTEMPTS,
      baseDelayMs: e.PENDING_REFERENCE_BASE_DELAY_MS,
      maxDelayMs: e.PENDING_REFERENCE_MAX_DELAY_MS,
      leaseMs: e.PENDING_REFERENCE_LEASE_MS,
    },
  };
}
