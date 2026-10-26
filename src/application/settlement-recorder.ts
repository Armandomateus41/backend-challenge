import { type EventContext, type IntegrationEvent } from '../domain/events/integration-event';
import {
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WalletBalanceChanged,
} from '../domain/events/wagering-events';
import { OutboxMessage } from '../domain/outbox-message';
import { type ReferenceResolution, type SettlementOutcome } from '../domain/wager-settlement';
import { type WagerTransaction, WagerTransactionStatus } from '../domain/wager-transaction';
import { type Wallet } from '../domain/wallet';
import { newId } from '../shared/ids';
import { type ReferenceSchedule, type RepositoryScope } from './ports/persistence';

export interface SettlementRecord {
  transaction: WagerTransaction;
  wallet: Wallet;
  walletVersionBefore: number;
  outcome: SettlementOutcome;
  isNew: boolean;
  schedule: ReferenceSchedule;
  correlationId: string;
  causationId?: string | undefined;
  at: Date;
}

/** Looks up the referenced transaction and whether it was already reversed. */
export async function resolveReference(
  scope: RepositoryScope,
  transaction: WagerTransaction,
): Promise<ReferenceResolution | undefined> {
  const externalId = transaction.referenceExternalTransactionId;
  if (!externalId) {
    return undefined;
  }
  const reference = await scope.transactions.findByExternalId(transaction.providerId, externalId);
  const alreadyReversed =
    reference !== undefined &&
    transaction.isReversal() &&
    (await scope.transactions.hasProcessedReversal(reference.id));
  return { transaction: reference, alreadyReversed };
}

/**
 * Persists the result of a settlement inside the caller's SQL transaction: transaction row,
 * wallet movement, ledger entry and outbox events. The write order matters: the transaction is
 * stored as PROCESSED before its ledger entry, which the ledger insert trigger verifies.
 */
export async function recordSettlement(
  scope: RepositoryScope,
  record: SettlementRecord,
): Promise<void> {
  const { transaction, wallet, outcome } = record;
  if (record.isNew) {
    await scope.transactions.insert(transaction, record.schedule, record.correlationId);
  } else {
    await scope.transactions.updateState(transaction, record.schedule);
  }

  const events: IntegrationEvent<unknown>[] = [];
  const ctx: EventContext = {
    correlationId: record.correlationId,
    causationId: record.causationId,
    occurredAt: record.at,
    newEventId: newId,
  };

  switch (outcome.status) {
    case WagerTransactionStatus.Processed:
      if (outcome.entry) {
        await scope.wallets.saveMovement(wallet, record.walletVersionBefore);
        await scope.ledger.insert(outcome.entry);
      }
      events.push(WagerTransactionProcessed.from(transaction, ctx));
      if (outcome.entry) {
        events.push(WalletBalanceChanged.from(wallet, outcome.entry, ctx));
      }
      await scope.transactions.wakeDependents(
        transaction.providerId,
        transaction.externalTransactionId,
      );
      break;
    case WagerTransactionStatus.Rejected:
      events.push(WagerTransactionRejected.from(transaction, ctx));
      break;
    case WagerTransactionStatus.PendingReference:
      if (outcome.newlyPending) {
        events.push(WagerTransactionPendingReference.from(transaction, ctx));
      }
      break;
  }

  if (events.length > 0) {
    await scope.outbox.enqueue(events.map((event) => OutboxMessage.enqueue(event)));
  }
}
