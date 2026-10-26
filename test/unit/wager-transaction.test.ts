import { describe, expect, test } from 'bun:test';
import { FailureCode } from '../../src/domain/failure-code';
import { LedgerDirection } from '../../src/domain/ledger-entry';
import {
  DomainValidationError,
  InvalidTransactionStateError,
} from '../../src/domain/shared/errors';
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../src/domain/wager-transaction';
import { brl, transaction, walletWith } from '../support/builders';

describe('WagerTransaction creation', () => {
  const wallet = walletWith('100.00');

  test('is born PENDING', () => {
    const tx = transaction(wallet);
    expect(tx.status).toBe(WagerTransactionStatus.Pending);
    expect(tx.isTerminal()).toBe(false);
  });

  test('OPENING cannot be submitted', () => {
    expect(() => transaction(wallet, { kind: WagerTransactionKind.Opening })).toThrow(
      expect.objectContaining({ code: 'KIND_NOT_ALLOWED' }),
    );
  });

  test.each([WagerTransactionKind.Refund, WagerTransactionKind.Rollback])(
    '%s requires a reference',
    (kind) => {
      expect(() => transaction(wallet, { kind })).toThrow(
        expect.objectContaining({ code: 'REFERENCE_REQUIRED' }),
      );
    },
  );

  test('BET cannot carry a reference', () => {
    expect(() => transaction(wallet, { referenceExternalTransactionId: 'x' })).toThrow(
      expect.objectContaining({ code: 'REFERENCE_NOT_ALLOWED' }),
    );
  });

  test('a transaction cannot reference itself', () => {
    expect(() =>
      transaction(wallet, {
        kind: WagerTransactionKind.Refund,
        externalTransactionId: 'same',
        referenceExternalTransactionId: 'same',
      }),
    ).toThrow(expect.objectContaining({ code: 'REFERENCE_INVALID' }));
  });

  test('balance-moving kinds require a positive amount; LOSS accepts zero', () => {
    expect(() => transaction(wallet, { money: brl('0.00') })).toThrow(DomainValidationError);
    expect(
      transaction(wallet, { kind: WagerTransactionKind.Loss, money: brl('0.00') }).status,
    ).toBe(WagerTransactionStatus.Pending);
  });

  test('domain queries per kind', () => {
    const loss = transaction(wallet, { kind: WagerTransactionKind.Loss });
    expect(loss.affectsBalance()).toBe(false);
    expect(loss.ledgerDirectionFor()).toBeUndefined();
    const bet = transaction(wallet);
    expect(bet.ledgerDirectionFor()).toBe(LedgerDirection.Debit);
    const refund = transaction(wallet, {
      kind: WagerTransactionKind.Refund,
      referenceExternalTransactionId: bet.externalTransactionId,
    });
    expect(refund.requiresReference()).toBe(true);
    expect(refund.ledgerDirectionFor()).toBe(LedgerDirection.Credit);
    expect(refund.canReference(WagerTransactionKind.Bet)).toBe(true);
    expect(refund.canReference(WagerTransactionKind.Win)).toBe(false);
    const rollback = transaction(wallet, {
      kind: WagerTransactionKind.Rollback,
      referenceExternalTransactionId: bet.externalTransactionId,
    });
    expect(rollback.ledgerDirectionFor(bet)).toBe(LedgerDirection.Credit);
    const win = transaction(wallet, { kind: WagerTransactionKind.Win });
    expect(rollback.ledgerDirectionFor(win)).toBe(LedgerDirection.Debit);
    expect(rollback.canReference(WagerTransactionKind.Rollback)).toBe(false);
    expect(bet.matchesPayload('a'.repeat(64))).toBe(true);
    expect(bet.matchesPayload('b'.repeat(64))).toBe(false);
  });
});

describe('WagerTransaction transitions', () => {
  const wallet = walletWith('100.00');
  const at = new Date();

  test('PENDING -> PROCESSED is terminal', () => {
    const tx = transaction(wallet);
    tx.markProcessed(undefined, at, brl('90.00'));
    expect(tx.status).toBe(WagerTransactionStatus.Processed);
    expect(tx.processedAt).toBe(at);
    expect(tx.observedBalance?.toString()).toBe('90.00');
    expect(tx.isTerminal()).toBe(true);
    expect(() => tx.reject(FailureCode.InsufficientFunds, at, brl('1.00'))).toThrow(
      InvalidTransactionStateError,
    );
    expect(() => tx.fail(FailureCode.ProcessingError, at)).toThrow(InvalidTransactionStateError);
    expect(() => tx.markProcessed(undefined, at, brl('1.00'))).toThrow(
      InvalidTransactionStateError,
    );
  });

  test('PENDING -> REJECTED keeps the failure code and is terminal', () => {
    const tx = transaction(wallet);
    tx.reject(FailureCode.InsufficientFunds, at, brl('5.00'));
    expect(tx.status).toBe(WagerTransactionStatus.Rejected);
    expect(tx.failureCode).toBe(FailureCode.InsufficientFunds);
    expect(() => tx.markProcessed(undefined, at, brl('1.00'))).toThrow(
      InvalidTransactionStateError,
    );
  });

  test('PENDING -> FAILED is terminal', () => {
    const tx = transaction(wallet);
    tx.fail(FailureCode.ProcessingError, at);
    expect(tx.status).toBe(WagerTransactionStatus.Failed);
    expect(() => tx.markPendingReference(at, brl('1.00'))).toThrow(InvalidTransactionStateError);
  });

  test('PENDING_REFERENCE can still be processed, rejected or failed', () => {
    for (const settle of [
      (tx: WagerTransaction) => tx.markProcessed('ref', at, brl('1.00')),
      (tx: WagerTransaction) => tx.reject(FailureCode.ReferenceNotFound, at, brl('1.00')),
      (tx: WagerTransaction) => tx.fail(FailureCode.ProcessingError, at),
    ]) {
      const tx = transaction(wallet, {
        kind: WagerTransactionKind.Refund,
        referenceExternalTransactionId: 'missing',
      });
      tx.markPendingReference(at, brl('100.00'));
      expect(tx.status).toBe(WagerTransactionStatus.PendingReference);
      settle(tx);
      expect(tx.isTerminal()).toBe(true);
    }
  });

  test('PENDING_REFERENCE cannot be re-entered', () => {
    const tx = transaction(wallet, {
      kind: WagerTransactionKind.Refund,
      referenceExternalTransactionId: 'missing',
    });
    tx.markPendingReference(at, brl('100.00'));
    expect(() => tx.markPendingReference(at, brl('100.00'))).toThrow(InvalidTransactionStateError);
  });

  test('rehydrate does not re-run transition rules', () => {
    const tx = transaction(wallet);
    tx.markProcessed(undefined, at, brl('90.00'));
    const restored = WagerTransaction.rehydrate({
      ...tx,
      kind: tx.kind,
      money: tx.money,
      status: tx.status,
      referenceTransactionId: tx.referenceTransactionId,
      failureCode: tx.failureCode,
      processedAt: tx.processedAt,
      observedBalance: tx.observedBalance,
      updatedAt: tx.updatedAt,
    });
    expect(restored.status).toBe(WagerTransactionStatus.Processed);
    expect(restored.isTerminal()).toBe(true);
  });
});
