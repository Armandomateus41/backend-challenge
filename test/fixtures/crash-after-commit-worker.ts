/**
 * Runs the real SQS consumer, but the process kills itself (SIGKILL) at the moment the consumer
 * tries to delete a message: after the SQL transaction committed and before the ack reached SQS.
 */
import { DeleteMessageCommand } from '@aws-sdk/client-sqs';
import { ProcessWagerTransaction } from '../../src/application/use-cases/process-wager-transaction';
import { loadConfig } from '../../src/config/app-config';
import { MikroOrmUnitOfWork } from '../../src/infrastructure/database/mikro-orm-unit-of-work';
import { createOrm } from '../../src/infrastructure/database/orm';
import { createSqsClient, SqsQueues } from '../../src/infrastructure/messaging/sqs';
import { SqsWagerConsumer } from '../../src/infrastructure/messaging/sqs-wager-consumer';
import { configureLogger } from '../../src/observability/logger';

const config = loadConfig();
configureLogger({ level: config.logLevel, instanceId: config.instanceId });
const orm = await createOrm(config.database);
const uow = new MikroOrmUnitOfWork(orm, config.database.lockTimeoutMs);
const client = createSqsClient(config.aws);

const send = client.send.bind(client) as (...args: unknown[]) => Promise<unknown>;
(client as unknown as { send: (...args: unknown[]) => Promise<unknown> }).send = (
  command: unknown,
  ...rest: unknown[]
) => {
  if (command instanceof DeleteMessageCommand) {
    process.kill(process.pid, 'SIGKILL');
  }
  return send(command, ...rest);
};

const queues = new SqsQueues(client, {
  wager: config.sqs.wagerQueueName,
  dlq: config.sqs.wagerDlqName,
  events: config.sqs.eventsQueueName,
});
const consumer = new SqsWagerConsumer(
  queues,
  new ProcessWagerTransaction(uow, {
    baseDelayMs: config.pendingReference.baseDelayMs,
    maxDelayMs: config.pendingReference.maxDelayMs,
  }),
  config.sqs,
);
consumer.start();
