import { describe, expect, test } from 'bun:test';
import {
  WagerTransactionProcessed,
  WalletBalanceChanged,
} from '../../src/domain/events/wagering-events';
import { InboxMessage } from '../../src/domain/inbox-message';
import { LedgerDirection } from '../../src/domain/ledger-entry';
import { OutboxMessage } from '../../src/domain/outbox-message';
import { exponentialBackoffMs } from '../../src/domain/shared/backoff';
import { InvariantViolationError } from '../../src/domain/shared/errors';
import { WagerSettlement } from '../../src/domain/wager-settlement';
import { WagerTransactionStatus } from '../../src/domain/wager-transaction';
import { newId } from '../../src/shared/ids';
import { brl, transaction, walletWith } from '../support/builders';

describe('exponential backoff', () => {
  test('doubles from the base and caps at the maximum', () => {
    const policy = { baseDelayMs: 100, maxDelayMs: 1000 };
    expect([1, 2, 3, 4, 5, 6].map((attempt) => exponentialBackoffMs(policy, attempt))).toEqual([
      100, 200, 400, 800, 1000, 1000,
    ]);
    expect(exponentialBackoffMs(policy, 10_000)).toBe(1000);
  });
});

describe('integration events', () => {
  const ctx = { correlationId: 'corr-1', occurredAt: new Date(), newEventId: newId };

  test('envelopes carry decimal strings, never Money instances', () => {
    const wallet = walletWith('100.00');
    const bet = transaction(wallet, { money: brl('25.00') });
    const outcome = WagerSettlement.settle({
      transaction: bet,
      wallet,
      reference: undefined,
      entryId: newId(),
      at: new Date(),
      referenceWindowExhausted: false,
    });
    expect(outcome.status).toBe(WagerTransactionStatus.Processed);
    if (outcome.status !== WagerTransactionStatus.Processed || !outcome.entry) return;

    const processed = WagerTransactionProcessed.from(bet, ctx).toJSON();
    expect(processed.eventType).toBe('WagerTransactionProcessed');
    expect(processed.version).toBe(1);
    expect(processed.correlationId).toBe('corr-1');
    expect(processed.data.money).toEqual({ amount: '25.00', currency: 'BRL' });
    expect(processed.data.balance).toEqual({ amount: '75.00', currency: 'BRL' });

    const changed = WalletBalanceChanged.from(wallet, outcome.entry, ctx).toJSON();
    expect(changed.aggregateId).toBe(wallet.id);
    expect(changed.data).toEqual({
      walletId: wallet.id,
      transactionId: bet.id,
      direction: LedgerDirection.Debit,
      money: { amount: '25.00', currency: 'BRL' },
      balanceBefore: { amount: '100.00', currency: 'BRL' },
      balanceAfter: { amount: '75.00', currency: 'BRL' },
      walletVersion: 2,
    });
    expect(JSON.parse(JSON.stringify(changed))).toEqual(changed);
  });
});

describe('OutboxMessage', () => {
  const wallet = walletWith('100.00');
  const bet = transaction(wallet);
  bet.markProcessed(undefined, new Date(), brl('90.00'));
  const event = WagerTransactionProcessed.from(bet, {
    correlationId: 'c',
    occurredAt: new Date(),
    newEventId: newId,
  });

  test('enqueue uses the event id and a JSON snapshot payload', () => {
    const message = OutboxMessage.enqueue(event);
    expect(message.id).toBe(event.eventId);
    expect(message.orderingKey).toBe(wallet.id);
    expect(message.payload).toEqual(
      JSON.parse(JSON.stringify(event.toJSON())) as Record<string, unknown>,
    );
    expect(message.isPending()).toBe(true);
    expect(message.nextAttemptAt).toBeUndefined();
    expect(message.isDue(new Date())).toBe(true);
  });

  test('scheduleRetry increments attempts and pushes the next attempt with backoff', () => {
    const message = OutboxMessage.enqueue(event);
    const now = new Date('2026-01-01T00:00:00.000Z');
    const policy = { baseDelayMs: 1000, maxDelayMs: 60000 };
    message.scheduleRetry(now, policy, 'boom');
    expect(message.attempts).toBe(1);
    expect(message.nextAttemptAt?.toISOString()).toBe('2026-01-01T00:00:01.000Z');
    message.scheduleRetry(now, policy, 'boom');
    expect(message.nextAttemptAt?.toISOString()).toBe('2026-01-01T00:00:02.000Z');
    expect(message.isDue(now)).toBe(false);
  });

  test('a published message cannot be published or retried again', () => {
    const message = OutboxMessage.enqueue(event);
    message.markPublished(new Date());
    expect(message.isPending()).toBe(false);
    expect(() => message.markPublished(new Date())).toThrow(InvariantViolationError);
    expect(() => message.scheduleRetry(new Date(), { baseDelayMs: 1, maxDelayMs: 1 })).toThrow(
      InvariantViolationError,
    );
  });
});

describe('InboxMessage', () => {
  test('is processed exactly once', () => {
    const message = InboxMessage.receive({
      messageId: 'm1',
      consumerName: 'c',
      payloadHash: 'h',
      receivedAt: new Date(),
    });
    expect(message.isProcessed()).toBe(false);
    message.markProcessed(new Date());
    expect(message.isProcessed()).toBe(true);
    expect(() => message.markProcessed(new Date())).toThrow(InvariantViolationError);
  });
});
