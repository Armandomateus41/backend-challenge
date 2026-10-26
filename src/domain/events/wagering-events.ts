import { type FailureCode } from '../failure-code';
import { type LedgerDirection, type WalletLedgerEntry } from '../ledger-entry';
import { type MoneyProps } from '../money';
import { InvariantViolationError } from '../shared/errors';
import { type WagerTransaction, type WagerTransactionKind } from '../wager-transaction';
import { type Wallet } from '../wallet';
import { type EventContext, IntegrationEvent } from './integration-event';

export interface WagerTransactionData {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
  referenceExternalTransactionId?: string;
}

export interface WagerTransactionProcessedData extends WagerTransactionData {
  referenceTransactionId?: string;
  balance: MoneyProps;
  processedAt: string;
}

export interface WagerTransactionRejectedData extends WagerTransactionData {
  failureCode: FailureCode;
  referenceTransactionId?: string;
  balance: MoneyProps;
}

export type WagerTransactionPendingReferenceData = WagerTransactionData;

export interface WalletBalanceChangedData {
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  walletVersion: number;
}

function transactionData(transaction: WagerTransaction): WagerTransactionData {
  return {
    transactionId: transaction.id,
    providerId: transaction.providerId,
    externalTransactionId: transaction.externalTransactionId,
    walletId: transaction.walletId,
    playerId: transaction.playerId,
    roundId: transaction.roundId,
    gameId: transaction.gameId,
    kind: transaction.kind,
    money: transaction.money.toJSON(),
    ...(transaction.referenceExternalTransactionId
      ? { referenceExternalTransactionId: transaction.referenceExternalTransactionId }
      : {}),
  };
}

function observedBalance(transaction: WagerTransaction): MoneyProps {
  const balance = transaction.observedBalance;
  if (!balance) {
    throw new InvariantViolationError(`Transaction ${transaction.id} has no observed balance`);
  }
  return balance.toJSON();
}

function envelope<T>(aggregateId: string, data: T, ctx: EventContext) {
  return {
    eventId: ctx.newEventId(),
    aggregateId,
    correlationId: ctx.correlationId,
    causationId: ctx.causationId,
    occurredAt: ctx.occurredAt,
    data,
  };
}

export class WagerTransactionProcessed extends IntegrationEvent<WagerTransactionProcessedData> {
  readonly eventType = 'WagerTransactionProcessed';
  readonly version = 1;

  static from(transaction: WagerTransaction, ctx: EventContext): WagerTransactionProcessed {
    const processedAt = transaction.processedAt;
    if (!processedAt) {
      throw new InvariantViolationError(`Transaction ${transaction.id} is not processed`);
    }
    return new WagerTransactionProcessed(
      envelope(
        transaction.id,
        {
          ...transactionData(transaction),
          ...(transaction.referenceTransactionId
            ? { referenceTransactionId: transaction.referenceTransactionId }
            : {}),
          balance: observedBalance(transaction),
          processedAt: processedAt.toISOString(),
        },
        ctx,
      ),
    );
  }

  orderingKey(): string {
    return this.data.walletId;
  }
}

export class WagerTransactionRejected extends IntegrationEvent<WagerTransactionRejectedData> {
  readonly eventType = 'WagerTransactionRejected';
  readonly version = 1;

  static from(transaction: WagerTransaction, ctx: EventContext): WagerTransactionRejected {
    const failureCode = transaction.failureCode;
    if (!failureCode) {
      throw new InvariantViolationError(`Transaction ${transaction.id} has no failure code`);
    }
    return new WagerTransactionRejected(
      envelope(
        transaction.id,
        {
          ...transactionData(transaction),
          failureCode,
          ...(transaction.referenceTransactionId
            ? { referenceTransactionId: transaction.referenceTransactionId }
            : {}),
          balance: observedBalance(transaction),
        },
        ctx,
      ),
    );
  }

  orderingKey(): string {
    return this.data.walletId;
  }
}

export class WagerTransactionPendingReference extends IntegrationEvent<WagerTransactionPendingReferenceData> {
  readonly eventType = 'WagerTransactionPendingReference';
  readonly version = 1;

  static from(transaction: WagerTransaction, ctx: EventContext): WagerTransactionPendingReference {
    return new WagerTransactionPendingReference(
      envelope(transaction.id, transactionData(transaction), ctx),
    );
  }

  orderingKey(): string {
    return this.data.walletId;
  }
}

export class WalletBalanceChanged extends IntegrationEvent<WalletBalanceChangedData> {
  readonly eventType = 'WalletBalanceChanged';
  readonly version = 1;

  static from(wallet: Wallet, entry: WalletLedgerEntry, ctx: EventContext): WalletBalanceChanged {
    if (entry.walletId !== wallet.id) {
      throw new InvariantViolationError('Ledger entry does not belong to the wallet');
    }
    return new WalletBalanceChanged(
      envelope(
        wallet.id,
        {
          walletId: wallet.id,
          transactionId: entry.transactionId,
          direction: entry.direction,
          money: entry.money.toJSON(),
          balanceBefore: entry.balanceBefore.toJSON(),
          balanceAfter: entry.balanceAfter.toJSON(),
          walletVersion: entry.walletVersion,
        },
        ctx,
      ),
    );
  }

  orderingKey(): string {
    return this.data.walletId;
  }
}
