import { Money, type MoneyProps } from '../domain/money';
import { type WagerTransactionKind } from '../domain/wager-transaction';
import { hashCanonical } from './idempotency/payload-hash';

/** Input shared by the HTTP and SQS entry points. Shape is validated by the adapters. */
export interface SubmitWagerTransactionCommand {
  idempotencyKey: string;
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
  referenceExternalTransactionId?: string | undefined;
}

export interface NormalizedWagerCommand {
  command: SubmitWagerTransactionCommand;
  money: Money;
  payloadHash: string;
}

/**
 * Parses the money and computes the payload hash: SHA-256 of the canonical JSON of the business
 * fields only. The idempotency key and transport metadata are excluded; the amount is normalized
 * to scale 2 first, so "25.5" and "25.50" hash identically.
 */
export function normalizeWagerCommand(
  command: SubmitWagerTransactionCommand,
): NormalizedWagerCommand {
  const money = Money.from(command.money);
  const payloadHash = hashCanonical({
    providerId: command.providerId,
    externalTransactionId: command.externalTransactionId,
    playerId: command.playerId,
    walletId: command.walletId,
    roundId: command.roundId,
    gameId: command.gameId,
    kind: command.kind,
    money: money.toJSON(),
    referenceExternalTransactionId: command.referenceExternalTransactionId,
  });
  return { command, money, payloadHash };
}
