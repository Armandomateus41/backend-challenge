import { describe, expect, test } from 'bun:test';
import { LedgerDirection, WalletLedgerEntry } from '../../src/domain/ledger-entry';
import { Money } from '../../src/domain/money';
import { CurrencyMismatchError, InvariantViolationError } from '../../src/domain/shared/errors';
import { Wallet } from '../../src/domain/wallet';
import { newId } from '../../src/shared/ids';
import { brl, walletWith } from '../support/builders';

const movement = () => ({ entryId: newId(), transactionId: newId(), at: new Date() });

describe('Wallet', () => {
  test('opens at version 1 with an OPENING credit entry for a positive balance', () => {
    const { wallet, openingEntry } = Wallet.open({
      id: newId(),
      playerId: 'p1',
      initialBalance: brl('1000.00'),
      at: new Date(),
      opening: { entryId: newId(), transactionId: newId() },
    });
    expect(wallet.version).toBe(1);
    expect(wallet.balance.toString()).toBe('1000.00');
    expect(wallet.currency).toBe('BRL');
    expect(openingEntry?.direction).toBe(LedgerDirection.Credit);
    expect(openingEntry?.balanceBefore.toString()).toBe('0.00');
    expect(openingEntry?.balanceAfter.toString()).toBe('1000.00');
    expect(openingEntry?.walletVersion).toBe(1);
  });

  test('opens with zero balance and no ledger entry', () => {
    const { wallet, openingEntry } = Wallet.open({
      id: newId(),
      playerId: 'p1',
      initialBalance: Money.zero('BRL'),
      at: new Date(),
    });
    expect(wallet.version).toBe(1);
    expect(wallet.balance.isZero()).toBe(true);
    expect(openingEntry).toBeUndefined();
  });

  test('requires an opening movement for a positive balance', () => {
    expect(() =>
      Wallet.open({ id: newId(), playerId: 'p1', initialBalance: brl('1.00'), at: new Date() }),
    ).toThrow(InvariantViolationError);
  });

  test('debit and credit move the balance, bump the version and return the matching entry', () => {
    const wallet = walletWith('100.00');
    const debit = wallet.debit(brl('30.00'), movement());
    expect(wallet.balance.toString()).toBe('70.00');
    expect(wallet.version).toBe(2);
    expect(debit.direction).toBe(LedgerDirection.Debit);
    expect(debit.balanceBefore.toString()).toBe('100.00');
    expect(debit.balanceAfter.toString()).toBe('70.00');
    expect(debit.walletVersion).toBe(2);

    const credit = wallet.credit(brl('5.50'), movement());
    expect(wallet.balance.toString()).toBe('75.50');
    expect(wallet.version).toBe(3);
    expect(credit.balanceBefore.equals(debit.balanceAfter)).toBe(true);
  });

  test('never goes negative', () => {
    const wallet = walletWith('10.00');
    expect(wallet.canDebit(brl('10.01'))).toBe(false);
    expect(() => wallet.debit(brl('10.01'), movement())).toThrow(InvariantViolationError);
    expect(wallet.balance.toString()).toBe('10.00');
    expect(wallet.version).toBe(1);
  });

  test('allows debiting the whole balance', () => {
    const wallet = walletWith('10.00');
    wallet.debit(brl('10.00'), movement());
    expect(wallet.balance.isZero()).toBe(true);
  });

  test('rejects movements in another currency without changing state', () => {
    const wallet = walletWith('10.00');
    const usd = Money.from({ amount: '1.00', currency: 'USD' });
    expect(() => wallet.credit(usd, movement())).toThrow(CurrencyMismatchError);
    expect(() => wallet.debit(usd, movement())).toThrow(CurrencyMismatchError);
    expect(wallet.version).toBe(1);
  });

  test('rejects zero-amount movements so version only changes with the balance', () => {
    const wallet = walletWith('10.00');
    expect(() => wallet.credit(brl('0.00'), movement())).toThrow(InvariantViolationError);
    expect(wallet.version).toBe(1);
  });

  test('rehydrate restores persisted state as is', () => {
    const now = new Date();
    const wallet = Wallet.rehydrate({
      id: 'w1',
      playerId: 'p1',
      currency: 'BRL',
      balance: brl('42.00'),
      version: 7,
      createdAt: now,
      updatedAt: now,
    });
    expect(wallet.balance.toString()).toBe('42.00');
    expect(wallet.version).toBe(7);
  });
});

describe('WalletLedgerEntry', () => {
  const base = {
    id: 'e1',
    walletId: 'w1',
    transactionId: 't1',
    walletVersion: 2,
    createdAt: new Date(),
  };

  test('validates arithmetic for credits and debits', () => {
    const credit = WalletLedgerEntry.create({
      ...base,
      direction: LedgerDirection.Credit,
      money: brl('5.00'),
      balanceBefore: brl('10.00'),
      balanceAfter: brl('15.00'),
    });
    expect(credit.isBalanced()).toBe(true);
    expect(credit.signedAmount().toString()).toBe('5.00');

    const debit = WalletLedgerEntry.create({
      ...base,
      direction: LedgerDirection.Debit,
      money: brl('5.00'),
      balanceBefore: brl('10.00'),
      balanceAfter: brl('5.00'),
    });
    expect(debit.signedAmount().toString()).toBe('-5.00');
  });

  test('rejects unbalanced entries', () => {
    expect(() =>
      WalletLedgerEntry.create({
        ...base,
        direction: LedgerDirection.Credit,
        money: brl('5.00'),
        balanceBefore: brl('10.00'),
        balanceAfter: brl('14.99'),
      }),
    ).toThrow(InvariantViolationError);
  });

  test('rejects non-positive amounts and negative balances', () => {
    expect(() =>
      WalletLedgerEntry.create({
        ...base,
        direction: LedgerDirection.Credit,
        money: brl('0.00'),
        balanceBefore: brl('10.00'),
        balanceAfter: brl('10.00'),
      }),
    ).toThrow(InvariantViolationError);
    expect(() =>
      WalletLedgerEntry.create({
        ...base,
        direction: LedgerDirection.Debit,
        money: brl('5.00'),
        balanceBefore: brl('1.00'),
        balanceAfter: brl('1.00').subtract(brl('5.00')),
      }),
    ).toThrow(InvariantViolationError);
  });

  test('entries are structurally immutable', () => {
    const entry = WalletLedgerEntry.create({
      ...base,
      direction: LedgerDirection.Credit,
      money: brl('5.00'),
      balanceBefore: brl('0.00'),
      balanceAfter: brl('5.00'),
    });
    const prototype = Object.getPrototypeOf(entry) as object;
    const methods = Object.getOwnPropertyNames(prototype);
    expect(methods.filter((name) => /^(set|mark|update|apply)/i.test(name))).toEqual([]);
  });
});
