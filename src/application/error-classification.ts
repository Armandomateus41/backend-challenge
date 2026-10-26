import { CurrencyMismatchError, DomainValidationError } from '../domain/shared/errors';
import { ApplicationError, type ApplicationErrorKind } from './errors';

export type ErrorCategory = ApplicationErrorKind | 'internal';

export interface ClassifiedError {
  category: ErrorCategory;
  code: string;
  message: string;
}

/**
 * Single mapping from thrown errors to categories, shared by the HTTP filter and the SQS consumer
 * so both entry points treat the same failure the same way. Unknown errors are `internal`.
 */
export function classifyError(error: unknown): ClassifiedError {
  if (error instanceof ApplicationError) {
    return { category: error.kind, code: error.code, message: error.message };
  }
  if (error instanceof DomainValidationError || error instanceof CurrencyMismatchError) {
    return { category: 'validation', code: error.code, message: error.message };
  }
  return { category: 'internal', code: 'INTERNAL_ERROR', message: 'Unexpected error' };
}
