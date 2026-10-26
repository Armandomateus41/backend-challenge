import { TransientInfrastructureError } from '../../application/errors';

/** PostgreSQL SQLSTATE codes. */
export const PgErrorCode = {
  UniqueViolation: '23505',
  SerializationFailure: '40001',
  DeadlockDetected: '40P01',
  LockNotAvailable: '55P03',
  QueryCanceled: '57014',
  AdminShutdown: '57P01',
  CrashShutdown: '57P02',
  CannotConnectNow: '57P03',
  TooManyConnections: '53300',
} as const;

const LOCK_CONFLICT_CODES = new Set<string>([
  PgErrorCode.SerializationFailure,
  PgErrorCode.DeadlockDetected,
  PgErrorCode.LockNotAvailable,
]);

const UNAVAILABLE_CODES = new Set<string>([
  PgErrorCode.AdminShutdown,
  PgErrorCode.CrashShutdown,
  PgErrorCode.CannotConnectNow,
  PgErrorCode.TooManyConnections,
  PgErrorCode.QueryCanceled,
]);

const NETWORK_ERROR_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EPIPE',
  'ENOTFOUND',
  'EAI_AGAIN',
]);

interface DriverErrorShape {
  code?: unknown;
  constraint?: unknown;
  message?: unknown;
}

function shape(error: unknown): DriverErrorShape {
  return typeof error === 'object' && error !== null ? error : {};
}

export function sqlState(error: unknown): string | undefined {
  const code = shape(error).code;
  return typeof code === 'string' ? code : undefined;
}

export function violatedConstraint(error: unknown): string | undefined {
  if (sqlState(error) !== PgErrorCode.UniqueViolation) {
    return undefined;
  }
  const constraint = shape(error).constraint;
  return typeof constraint === 'string' ? constraint : undefined;
}

/**
 * Maps driver failures that are safe to retry to TransientInfrastructureError. Everything else
 * (constraint violations, programming errors) is returned unchanged.
 */
export function classifyDatabaseError(error: unknown): unknown {
  if (error instanceof TransientInfrastructureError) {
    return error;
  }
  const code = sqlState(error);
  if (code && LOCK_CONFLICT_CODES.has(code)) {
    return new TransientInfrastructureError('Database lock conflict', 'lock_conflict', {
      cause: error,
    });
  }
  const rawMessage = shape(error).message;
  const message = typeof rawMessage === 'string' ? rawMessage : '';
  if (
    (code &&
      (UNAVAILABLE_CODES.has(code) || NETWORK_ERROR_CODES.has(code) || code.startsWith('08'))) ||
    /Connection terminated|connection timeout|timeout exceeded when trying to connect|Client has encountered a connection error/i.test(
      message,
    )
  ) {
    return new TransientInfrastructureError('Database unavailable', 'unavailable', {
      cause: error,
    });
  }
  return error;
}
