import { type z } from 'zod';
import { ApplicationError } from '../../application/errors';
import { describeIssues } from '../contracts/wager-transaction-request';

export class RequestValidationError extends ApplicationError {
  readonly code: string;
  readonly kind = 'validation';

  constructor(
    message: string,
    readonly details: { path: string; message: string }[] = [],
    code = 'VALIDATION_ERROR',
  ) {
    super(message);
    this.code = code;
  }
}

export function parseRequest<T extends z.ZodType>(
  schema: T,
  input: unknown,
  what: string,
): z.infer<T> {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new RequestValidationError(`Invalid ${what}`, describeIssues(result.error));
  }
  return result.data;
}
