import { Controller, Get, Header, Inject, Res } from '@nestjs/common';
import { type Response } from 'express';
import { UNIT_OF_WORK, type UnitOfWork } from '../../application/ports/persistence';
import { SqsQueues } from '../../infrastructure/messaging/sqs';
import { logger, serializeError } from '../../observability/logger';
import { metricsRegistry } from '../../observability/metrics';
import { withTimeout } from '../../shared/async';
import { Public } from './auth';

const PROBE_TIMEOUT_MS = 2000;

async function probe(check: () => Promise<void>): Promise<'up' | 'down'> {
  try {
    const result = await withTimeout(
      check().then(() => 'up' as const),
      PROBE_TIMEOUT_MS,
    );
    return result ?? 'down';
  } catch (error) {
    logger().warn({ err: serializeError(error) }, 'readiness probe failed');
    return 'down';
  }
}

@Public()
@Controller()
export class HealthController {
  constructor(
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
    @Inject(SqsQueues) private readonly queues: SqsQueues,
  ) {}

  /** Liveness: the process can serve requests. Does not touch dependencies. */
  @Get('health/live')
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  /** Readiness: PostgreSQL and SQS are reachable. */
  @Get('health/ready')
  async ready(@Res() response: Response): Promise<void> {
    const [database, sqs] = await Promise.all([
      probe(() => this.uow.ping()),
      probe(() => this.queues.ping()),
    ]);
    const ready = database === 'up' && sqs === 'up';
    response.status(ready ? 200 : 503).json({
      status: ready ? 'ok' : 'unavailable',
      checks: { database, sqs },
    });
  }

  @Get('metrics')
  @Header('Content-Type', metricsRegistry.contentType)
  metrics(): Promise<string> {
    return metricsRegistry.metrics();
  }
}
