import { type ArgumentsHost, Catch, type ExceptionFilter, HttpException } from '@nestjs/common';
import { type Response } from 'express';
import { classifyError, type ErrorCategory } from '../../application/error-classification';
import { logger, serializeError } from '../../observability/logger';
import { RequestValidationError } from './request-validation';

/**
 * Status mapping shared by every endpoint:
 *   400 invalid payload | 401 missing or invalid token | 403 provider mismatch
 *   404 unknown resource | 409 idempotency or uniqueness conflict
 *   503 transient infrastructure failure (safe to retry with the same Idempotency-Key)
 *   500 unexpected error.
 * Business rejections (422) and pending processing (202) are successful handlings and are
 * returned by the controller, not by this filter.
 */
const STATUS_BY_CATEGORY: Record<ErrorCategory, number> = {
  validation: 400,
  unauthenticated: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  transient: 503,
  internal: 500,
};

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      response.status(status).json({
        error: { code: `HTTP_${status}`, message: exception.message },
      });
      return;
    }

    const classified = classifyError(exception);
    const status = STATUS_BY_CATEGORY[classified.category];
    if (classified.category === 'internal') {
      logger().error(
        { err: serializeError(exception), stack: (exception as Error)?.stack },
        'unhandled error',
      );
    } else if (classified.category === 'transient') {
      logger().warn({ err: serializeError(exception) }, 'transient failure');
      response.setHeader('Retry-After', '1');
    } else if (classified.category === 'unauthenticated') {
      response.setHeader('WWW-Authenticate', 'Bearer');
    }
    response.status(status).json({
      error: {
        code: classified.code,
        message: classified.message,
        ...(exception instanceof RequestValidationError && exception.details.length > 0
          ? { details: exception.details }
          : {}),
      },
    });
  }
}
