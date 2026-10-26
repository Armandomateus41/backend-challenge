import { describe, expect, test } from 'bun:test';
import { FailureCode } from '../../src/domain/failure-code';
import { LedgerDirection } from '../../src/domain/ledger-entry';
import { Money } from '../../src/domain/money';
import { type ReferenceResolution, WagerSettlement } from '../../src/domain/wager-settlement';
import {
  type WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../src/domain/wager-transaction';
import { type Wallet } from '../../src/domain/wallet';
import { newId } from '../../src/shared/ids';
import { brl, transaction, walletWith } from '../support/builders';

function settle(
  tx: WagerTransaction,
  wallet: Wallet,
  reference?: ReferenceResolution,
  referenceWindowExhausted = false,
) {
  return WagerSettlement.settle({
    transaction: tx,
    wallet,
    reference,
    entryId: newId(),
    at: new Date(),
    referenceWindowExhausted,
  });
}

/** Settles a BET so it can be referenced. */
function processedBet(wallet: Wallet, amount = '10.00'): WagerTransaction {
  const bet = transaction(wallet, { money: brl(amount) });
  expect(settle(bet, wallet).status).toBe(WagerTransactionStatus.Processed);
  return bet;
}

function reversal(
  wallet: Wallet,
  kind: WagerTransactionKind,
  reference: WagerTransaction,
  amount = reference.money.toString(),
) {
  return transaction(wallet, {
    kind,
    money: brl(amount),
    referenceExternalTransactionId: reference.externalTransactionId,
  });
}

const found = (tx: WagerTransaction, alreadyReversed = false): ReferenceResolution => ({
  transaction: tx,
  alreadyReversed,
});

describe('BET', () => {
  test('debits the balance and produces one DEBIT entry', () => {
    const wallet = walletWith('100.00');
    const bet = transaction(wallet, { money: brl('25.00') });
    const outcome = settle(bet, wallet);
    expect(outcome.status).toBe(WagerTransactionStatus.Processed);
    if (outcome.status !== WagerTransactionStatus.Processed) return;
    expect(outcome.entry?.direction).toBe(LedgerDirection.Debit);
    expect(outcome.entry?.balanceAfter.toString()).toBe('75.00');
    expect(wallet.balance.toString()).toBe('75.00');
    expect(bet.observedBalance?.toString()).toBe('75.00');
  });

  test('is rejected with INSUFFICIENT_FUNDS and leaves the wallet untouched', () => {
    const wallet = walletWith('10.00');
    const bet = transaction(wallet, { money: brl('10.01') });
    const outcome = settle(bet, wallet);
    expect(outcome).toEqual({
      status: WagerTransactionStatus.Rejected,
      failureCode: FailureCode.InsufficientFunds,
    });
    expect(wallet.balance.toString()).toBe('10.00');
    expect(wallet.version).toBe(1);
    expect(bet.status).toBe(WagerTransactionStatus.Rejected);
  });

  test('currency conflict is rejected', () => {
    const wallet = walletWith('100.00');
    const bet = transaction(wallet, { money: Money.from({ amount: '1.00', currency: 'USD' }) });
    expect(settle(bet, wallet)).toEqual({
      status: WagerTransactionStatus.Rejected,
      failureCode: FailureCode.CurrencyMismatch,
    });
    expect(wallet.version).toBe(1);
  });

  test('player that does not own the wallet is rejected', () => {
    const wallet = walletWith('100.00');
    const bet = transaction(wallet, { playerId: 'someone-else' });
    expect(settle(bet, wallet)).toEqual({
      status: WagerTransactionStatus.Rejected,
      failureCode: FailureCode.WalletPlayerMismatch,
    });
  });

  test('settling a terminal transaction is a programming error', () => {
    const wallet = walletWith('100.00');
    const bet = processedBet(wallet);
    expect(() => settle(bet, wallet)).toThrow();
  });
});

describe('WIN and LOSS', () => {
  test('WIN credits the balance', () => {
    const wallet = walletWith('0.00');
    const win = transaction(wallet, { kind: WagerTransactionKind.Win, money: brl('50.00') });
    const outcome = settle(win, wallet);
    expect(outcome.status).toBe(WagerTransactionStatus.Processed);
    expect(wallet.balance.toString()).toBe('50.00');
    expect(wallet.version).toBe(2);
  });

  test('WIN may reference the BET of the same round', () => {
    const wallet = walletWith('100.00');
    const bet = processedBet(wallet);
    const win = transaction(wallet, {
      kind: WagerTransactionKind.Win,
      money: brl('30.00'),
      referenceExternalTransactionId: bet.externalTransactionId,
    });
    settle(win, wallet, found(bet));
    expect(win.status).toBe(WagerTransactionStatus.Processed);
    expect(win.referenceTransactionId).toBe(bet.id);
    expect(wallet.balance.toString()).toBe('120.00');
  });

  test('LOSS is processed without touching the balance or producing an entry', () => {
    const wallet = walletWith('100.00');
    const loss = transaction(wallet, { kind: WagerTransactionKind.Loss, money: brl('10.00') });
    const outcome = settle(loss, wallet);
    expect(outcome).toEqual({ status: WagerTransactionStatus.Processed, entry: undefined });
    expect(wallet.balance.toString()).toBe('100.00');
    expect(wallet.version).toBe(1);
    expect(loss.observedBalance?.toString()).toBe('100.00');
  });
});

describe('REFUND', () => {
  test('credits back a processed BET', () => {
    const wallet = walletWith('100.00');
    const bet = processedBet(wallet, '40.00');
    const refund = reversal(wallet, WagerTransactionKind.Refund, bet);
    const outcome = settle(refund, wallet, found(bet));
    expect(outcome.status).toBe(WagerTransactionStatus.Processed);
    expect(wallet.balance.toString()).toBe('100.00');
    expect(refund.referenceTransactionId).toBe(bet.id);
  });

  test('can only refund once', () => {
    const wallet = walletWith('100.00');
    const bet = processedBet(wallet);
    const refund = reversal(wallet, WagerTransactionKind.Refund, bet);
    expect(settle(refund, wallet, found(bet, true))).toEqual({
      status: WagerTransactionStatus.Rejected,
      failureCode: FailureCode.ReferenceAlreadyReversed,
    });
  });

  test('only references BET', () => {
    const wallet = walletWith('100.00');
    const win = transaction(wallet, { kind: WagerTransactionKind.Win });
    settle(win, wallet);
    const refund = reversal(wallet, WagerTransactionKind.Refund, win);
    expect(settle(refund, wallet, found(win))).toEqual({
      status: WagerTransactionStatus.Rejected,
      failureCode: FailureCode.ReferenceKindNotAllowed,
    });
  });

  test('amount must equal the referenced amount', () => {
    const wallet = walletWith('100.00');
    const bet = processedBet(wallet, '10.00');
    const refund = reversal(wallet, WagerTransactionKind.Refund, bet, '9.99');
    expect(settle(refund, wallet, found(bet))).toEqual({
      status: WagerTransactionStatus.Rejected,
      failureCode: FailureCode.ReferenceAmountMismatch,
    });
  });

  test('reference must be in the same round, wallet, player and currency', () => {
    const wallet = walletWith('100.00');
    const bet = processedBet(wallet);
    const cases: [Partial<Parameters<typeof transaction>[1]>, FailureCode, Wallet?][] = [
      [{ roundId: 'other-round' }, FailureCode.ReferenceRoundMismatch],
      [{ money: Money.from({ amount: '10.00', currency: 'USD' }) }, FailureCode.CurrencyMismatch],
    ];
    for (const [overrides, code] of cases) {
      const refund = transaction(wallet, {
        kind: WagerTransactionKind.Refund,
        money: brl('10.00'),
        referenceExternalTransactionId: bet.externalTransactionId,
        ...overrides,
      });
      expect(settle(refund, wallet, found(bet))).toEqual({
        status: WagerTransactionStatus.Rejected,
        failureCode: code,
      });
    }

    const otherWallet = walletWith('100.00');
    const crossWallet = reversal(otherWallet, WagerTransactionKind.Refund, bet);
    expect(settle(crossWallet, otherWallet, found(bet))).toEqual({
      status: WagerTransactionStatus.Rejected,
      failureCode: FailureCode.ReferenceWalletMismatch,
    });

    const otherPlayerWallet = walletWith('100.00', 'player-2');
    const crossPlayer = reversal(otherPlayerWallet, WagerTransactionKind.Refund, bet);
    expect(settle(crossPlayer, otherPlayerWallet, found(bet))).toEqual({
      status: WagerTransactionStatus.Rejected,
      failureCode: FailureCode.ReferencePlayerMismatch,
    });
  });

  test('a rejected reference cannot be refunded', () => {
    const wallet = walletWith('5.00');
    const bet = transaction(wallet, { money: brl('10.00') });
    settle(bet, wallet);
    expect(bet.status).toBe(WagerTransactionStatus.Rejected);
    const refund = reversal(wallet, WagerTransactionKind.Refund, bet);
    expect(settle(refund, wallet, found(bet))).toEqual({
      status: WagerTransactionStatus.Rejected,
      failureCode: FailureCode.ReferenceNotProcessed,
    });
    expect(wallet.balance.toString()).toBe('5.00');
  });
});

describe('ROLLBACK', () => {
  test('reverses a BET with a credit', () => {
    const wallet = walletWith('100.00');
    const bet = processedBet(wallet, '30.00');
    const rollback = reversal(wallet, WagerTransactionKind.Rollback, bet);
    const outcome = settle(rollback, wallet, found(bet));
    expect(outcome.status).toBe(WagerTransactionStatus.Processed);
    if (outcome.status !== WagerTransactionStatus.Processed) return;
    expect(outcome.entry?.direction).toBe(LedgerDirection.Credit);
    expect(wallet.balance.toString()).toBe('100.00');
  });

  test('reverses a WIN with a debit', () => {
    const wallet = walletWith('0.00');
    const win = transaction(wallet, { kind: WagerTransactionKind.Win, money: brl('50.00') });
    settle(win, wallet);
    const rollback = reversal(wallet, WagerTransactionKind.Rollback, win);
    const outcome = settle(rollback, wallet, found(win));
    expect(outcome.status).toBe(WagerTransactionStatus.Processed);
    if (outcome.status !== WagerTransactionStatus.Processed) return;
    expect(outcome.entry?.direction).toBe(LedgerDirection.Debit);
    expect(wallet.balance.toString()).toBe('0.00');
  });

  test('reverses a REFUND with a debit', () => {
    const wallet = walletWith('100.00');
    const bet = processedBet(wallet, '20.00');
    const refund = reversal(wallet, WagerTransactionKind.Refund, bet);
    settle(refund, wallet, found(bet));
    const rollback = reversal(wallet, WagerTransactionKind.Rollback, refund);
    settle(rollback, wallet, found(refund));
    expect(rollback.status).toBe(WagerTransactionStatus.Processed);
    expect(wallet.balance.toString()).toBe('80.00');
  });

  test('cannot reverse a LOSS or another ROLLBACK', () => {
    const wallet = walletWith('100.00');
    const loss = transaction(wallet, { kind: WagerTransactionKind.Loss });
    settle(loss, wallet);
    expect(
      settle(reversal(wallet, WagerTransactionKind.Rollback, loss), wallet, found(loss)),
    ).toEqual({
      status: WagerTransactionStatus.Rejected,
      failureCode: FailureCode.ReferenceKindNotAllowed,
    });
  });

  test('a reversal that would make the balance negative is rejected with its own code', () => {
    const wallet = walletWith('0.00');
    const win = transaction(wallet, { kind: WagerTransactionKind.Win, money: brl('50.00') });
    settle(win, wallet);
    wallet.debit(brl('40.00'), { entryId: newId(), transactionId: newId(), at: new Date() });
    const rollback = reversal(wallet, WagerTransactionKind.Rollback, win);
    expect(settle(rollback, wallet, found(win))).toEqual({
      status: WagerTransactionStatus.Rejected,
      failureCode: FailureCode.ReversalInsufficientFunds,
    });
    expect(FailureCode.ReversalInsufficientFunds).not.toBe(FailureCode.InsufficientFunds);
    expect(wallet.balance.toString()).toBe('10.00');
  });

  test('cannot be applied twice', () => {
    const wallet = walletWith('100.00');
    const bet = processedBet(wallet);
    const rollback = reversal(wallet, WagerTransactionKind.Rollback, bet);
    expect(settle(rollback, wallet, found(bet, true))).toEqual({
      status: WagerTransactionStatus.Rejected,
      failureCode: FailureCode.ReferenceAlreadyReversed,
    });
  });
});

describe('out-of-order references', () => {
  test('missing reference parks the transaction in PENDING_REFERENCE', () => {
    const wallet = walletWith('100.00');
    const refund = transaction(wallet, {
      kind: WagerTransactionKind.Refund,
      referenceExternalTransactionId: 'not-yet-arrived',
    });
    expect(settle(refund, wallet, { transaction: undefined, alreadyReversed: false })).toEqual({
      status: WagerTransactionStatus.PendingReference,
      newlyPending: true,
    });
    expect(refund.status).toBe(WagerTransactionStatus.PendingReference);
    expect(wallet.version).toBe(1);

    // Still missing on a later attempt: stays pending without a new transition.
    expect(settle(refund, wallet, { transaction: undefined, alreadyReversed: false })).toEqual({
      status: WagerTransactionStatus.PendingReference,
      newlyPending: false,
    });
  });

  test('pending transaction is processed once the reference arrives', () => {
    const wallet = walletWith('100.00');
    const refundFirst = transaction(wallet, {
      kind: WagerTransactionKind.Refund,
      money: brl('10.00'),
      referenceExternalTransactionId: 'bet-late',
    });
    settle(refundFirst, wallet, { transaction: undefined, alreadyReversed: false });
    const bet = transaction(wallet, { externalTransactionId: 'bet-late', money: brl('10.00') });
    settle(bet, wallet);
    settle(refundFirst, wallet, found(bet));
    expect(refundFirst.status).toBe(WagerTransactionStatus.Processed);
    expect(wallet.balance.toString()).toBe('100.00');
  });

  test('exhausted window rejects with REFERENCE_NOT_FOUND', () => {
    const wallet = walletWith('100.00');
    const rollback = transaction(wallet, {
      kind: WagerTransactionKind.Rollback,
      referenceExternalTransactionId: 'never',
    });
    settle(rollback, wallet, { transaction: undefined, alreadyReversed: false });
    expect(
      settle(rollback, wallet, { transaction: undefined, alreadyReversed: false }, true),
    ).toEqual({
      status: WagerTransactionStatus.Rejected,
      failureCode: FailureCode.ReferenceNotFound,
    });
    expect(rollback.isTerminal()).toBe(true);
  });
});
