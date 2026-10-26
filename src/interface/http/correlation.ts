import { type NextFunction, type Request, type Response } from 'express';
import { runWithContext } from '../../observability/context';
import { logger } from '../../observability/logger';
import { newId } from '../../shared/ids';

export const CORRELATION_HEADER = 'x-correlation-id';
const CORRELATION_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

interface CorrelatedRequest extends Request {
  correlationId?: string;
}

export function correlationIdOf(request: Request): string {
  return (request as CorrelatedRequest).correlationId ?? newId();
}

/**
 * Express middleware: assigns the correlation id (client-provided when well-formed), opens the
 * logging context for the whole request, echoes the id back and writes one access log line
 * without bodies or headers.
 */
export function correlationMiddleware(
  request: Request,
  response: Response,
  next: NextFunction,
): void {
  const provided = request.header(CORRELATION_HEADER);
  const correlationId = provided && CORRELATION_PATTERN.test(provided) ? provided : newId();
  (request as CorrelatedRequest).correlationId = correlationId;
  response.setHeader(CORRELATION_HEADER, correlationId);
  const startedAt = performance.now();
  runWithContext({ correlationId }, () => {
    response.on('finish', () => {
      logger().info(
        {
          method: request.method,
          path: request.route ? String((request.route as { path: unknown }).path) : request.path,
          status: response.statusCode,
          durationMs: Math.round(performance.now() - startedAt),
        },
        'http request completed',
      );
    });
    next();
  });
}
