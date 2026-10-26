import { z } from 'zod';
import { SUBMITTABLE_KINDS } from '../../domain/wager-transaction';

/** Shape only: amount format and scale are validated by Money in the domain. */
export const moneySchema = z.strictObject({
  amount: z.string().max(64),
  currency: z.string().max(8),
});

const identifier = (max: number) => z.string().trim().min(1).max(max);

/** Business fields of a provider operation, shared by the HTTP body and the SQS message data. */
export const wagerTransactionFields = {
  providerId: identifier(128),
  externalTransactionId: identifier(256),
  playerId: identifier(128),
  walletId: z.uuid(),
  roundId: identifier(256),
  gameId: identifier(128),
  // OPENING is internal: it is not part of the accepted enum.
  kind: z.enum(SUBMITTABLE_KINDS),
  money: moneySchema,
  referenceExternalTransactionId: identifier(256).optional(),
};

export const wagerTransactionBodySchema = z.strictObject(wagerTransactionFields);

export const idempotencyKeySchema = identifier(512);

export const wagerTransactionMessageSchema = z.strictObject({
  messageId: identifier(128),
  type: z.literal('WagerTransactionRequested'),
  occurredAt: z.iso.datetime(),
  data: z.strictObject({ ...wagerTransactionFields, idempotencyKey: idempotencyKeySchema }),
});

export type WagerTransactionMessage = z.infer<typeof wagerTransactionMessageSchema>;

export const createWalletBodySchema = z.strictObject({
  playerId: identifier(128),
  initialBalance: moneySchema,
});

/** Flattens zod issues into a stable, client-facing list. */
export function describeIssues(error: z.ZodError): { path: string; message: string }[] {
  return error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message }));
}
