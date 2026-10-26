import { createApp } from './bootstrap';
import { loadConfig } from './config/app-config';
import { logger, serializeError } from './observability/logger';

async function main(): Promise<void> {
  const config = loadConfig();
  const app = await createApp(config);
  await app.listen(config.http.port);
  logger().info({ port: config.http.port }, 'wagering processor listening');
}

main().catch((error: unknown) => {
  logger().fatal({ err: serializeError(error) }, 'startup failed');
  process.exit(1);
});
