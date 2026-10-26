import { loadConfig } from '../src/config/app-config';
import { createSqsClient, ensureQueues } from '../src/infrastructure/messaging/sqs';

const config = loadConfig();
const client = createSqsClient(config.aws);
try {
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
  console.log(JSON.stringify({ queues: urls }));
} finally {
  client.destroy();
}
