import { type FailureCode } from '../domain/failure-code';
import { type MoneyProps } from '../domain/money';
import { type WagerTransaction, type WagerTransactionStatus } from '../domain/wager-transaction';

export interface WagerTransactionResult {
  transactionId: string;
  status: WagerTransactionStatus;
  failureCode?: FailureCode;
  /** Wallet balance observed when the transaction reached its current status. */
  balance: MoneyProps | null;
  idempotentReplay: boolean;
}

export function toWagerTransactionResult(
  transaction: WagerTransaction,
  idempotentReplay: boolean,
): WagerTransactionResult {
  return {
    transactionId: transaction.id,
    status: transaction.status,
    ...(transaction.failureCode ? { failureCode: transaction.failureCode } : {}),
    balance: transaction.observedBalance?.toJSON() ?? null,
    idempotentReplay,
  };
}

export interface WagerTransactionView {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: MoneyProps;
  referenceExternalTransactionId: string | null;
  referenceTransactionId: string | null;
  status: WagerTransactionStatus;
  failureCode: FailureCode | null;
  observedBalance: MoneyProps | null;
  createdAt: string;
  processedAt: string | null;
}

export function toWagerTransactionView(transaction: WagerTransaction): WagerTransactionView {
  return {
    id: transaction.id,
    providerId: transaction.providerId,
    externalTransactionId: transaction.externalTransactionId,
    idempotencyKey: transaction.idempotencyKey,
    walletId: transaction.walletId,
    playerId: transaction.playerId,
    roundId: transaction.roundId,
    gameId: transaction.gameId,
    kind: transaction.kind,
    money: transaction.money.toJSON(),
    referenceExternalTransactionId: transaction.referenceExternalTransactionId ?? null,
    referenceTransactionId: transaction.referenceTransactionId ?? null,
    status: transaction.status,
    failureCode: transaction.failureCode ?? null,
    observedBalance: transaction.observedBalance?.toJSON() ?? null,
    createdAt: transaction.createdAt.toISOString(),
    processedAt: transaction.processedAt?.toISOString() ?? null,
  };
}
