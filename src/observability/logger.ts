import { type LoggerService } from '@nestjs/common';
import pino, { type Logger } from 'pino';
import { currentContext } from './context';

/**
 * JSON logger. Context identifiers (correlationId, messageId, transactionId, walletId,
 * providerId) are merged from AsyncLocalStorage into every line. Request bodies, money payloads
 * and headers are never logged; known secret-bearing paths are redacted defensively.
 */
export function createLogger(options: { level: string; instanceId: string }): Logger {
  return pino({
    level: options.level,
    base: { service: 'wagering-processor', instanceId: options.instanceId },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: { level: (label) => ({ level: label }) },
    mixin: () => ({ ...currentContext() }),
    redact: {
      paths: ['authorization', '*.authorization', 'headers', '*.headers', 'password', '*.password'],
      remove: true,
    },
  });
}

let rootLogger: Logger = createLogger({
  level: process.env.LOG_LEVEL ?? 'info',
  instanceId: 'boot',
});

export function configureLogger(options: { level: string; instanceId: string }): Logger {
  rootLogger = createLogger(options);
  return rootLogger;
}

export function logger(): Logger {
  return rootLogger;
}

export function serializeError(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code;
    return {
      type: error.name,
      message: error.message,
      ...(typeof code === 'string' ? { code } : {}),
    };
  }
  return { type: typeof error, message: String(error) };
}

/** Routes NestJS framework logs through the structured logger. */
export class NestPinoLogger implements LoggerService {
  log(message: unknown, context?: string): void {
    logger().info({ nestContext: context }, String(message));
  }

  error(message: unknown, trace?: string, context?: string): void {
    logger().error({ nestContext: context, trace }, String(message));
  }

  warn(message: unknown, context?: string): void {
    logger().warn({ nestContext: context }, String(message));
  }

  debug(message: unknown, context?: string): void {
    logger().debug({ nestContext: context }, String(message));
  }

  verbose(message: unknown, context?: string): void {
    logger().trace({ nestContext: context }, String(message));
  }
}
