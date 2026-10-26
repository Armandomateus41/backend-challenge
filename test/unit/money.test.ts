import { describe, expect, test } from 'bun:test';
import { Money } from '../../src/domain/money';
import { CurrencyMismatchError, DomainValidationError } from '../../src/domain/shared/errors';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });

describe('Money parsing', () => {
  test.each([
    ['0', '0.00'],
    ['0.5', '0.50'],
    ['25', '25.00'],
    ['25.5', '25.50'],
    ['25.05', '25.05'],
    ['999999999999999999.99', '999999999999999999.99'],
  ])('accepts %p and serializes with scale 2 as %p', (input, expected) => {
    expect(brl(input).toString()).toBe(expected);
    expect(brl(input).toJSON()).toEqual({ amount: expected, currency: 'BRL' });
  });

  test.each([
    ['', 'empty string'],
    [' 1.00', 'leading whitespace'],
    ['1.00 ', 'trailing whitespace'],
    ['1.001', 'more than two decimals'],
    ['0.000', 'three zero decimals'],
    ['1e3', 'scientific notation'],
    ['1E-2', 'scientific notation with sign'],
    ['NaN', 'NaN'],
    ['Infinity', 'Infinity'],
    ['-1.00', 'negative value'],
    ['+1.00', 'explicit plus sign'],
    ['01.00', 'leading zero'],
    ['.50', 'missing integer part'],
    ['1.', 'trailing dot'],
    ['1,00', 'comma separator'],
    ['0x10', 'hex literal'],
  ])('rejects %p (%s)', (amount) => {
    expect(() => brl(amount)).toThrow(DomainValidationError);
  });

  test('rejects non-string amounts', () => {
    expect(() => Money.from({ amount: 10 as unknown as string, currency: 'BRL' })).toThrow(
      DomainValidationError,
    );
    expect(() => Money.from({ amount: null as unknown as string, currency: 'BRL' })).toThrow(
      DomainValidationError,
    );
  });

  test('rejects amounts above the NUMERIC(20,2) range', () => {
    expect(() => brl('1000000000000000000.00')).toThrow(
      expect.objectContaining({ code: 'AMOUNT_OUT_OF_RANGE' }),
    );
  });

  test.each(['brl', 'BR', 'BRLL', '', '123'])('rejects invalid currency %p', (currency) => {
    expect(() => Money.from({ amount: '1.00', currency })).toThrow(
      expect.objectContaining({ code: 'INVALID_CURRENCY' }),
    );
  });
});

describe('Money arithmetic', () => {
  test('adds and subtracts exactly where binary floats would drift', () => {
    expect(brl('0.10').add(brl('0.20')).toString()).toBe('0.30');
    expect(brl('100.00').subtract(brl('80.00')).toString()).toBe('20.00');
    expect(brl('0.01').subtract(brl('0.02')).toString()).toBe('-0.01');
  });

  test('adding many cents stays exact', () => {
    let total = Money.zero('BRL');
    for (let i = 0; i < 1000; i++) {
      total = total.add(brl('0.01'));
    }
    expect(total.toString()).toBe('10.00');
  });

  test('handles the largest supported values without precision loss', () => {
    const big = brl('999999999999999999.99');
    expect(big.subtract(brl('0.01')).toString()).toBe('999999999999999999.98');
    expect(big.add(big).toString()).toBe('1999999999999999999.98');
  });

  test('negate flips the sign and keeps the currency', () => {
    expect(brl('25.00').negate().toString()).toBe('-25.00');
    expect(brl('25.00').negate().negate().equals(brl('25.00'))).toBe(true);
    expect(Money.zero('BRL').negate().isZero()).toBe(true);
  });

  test('is immutable: operations return new instances', () => {
    const a = brl('10.00');
    const b = a.add(brl('5.00'));
    expect(a.toString()).toBe('10.00');
    expect(b.toString()).toBe('15.00');
    expect(b).not.toBe(a);
  });

  test('predicates and comparisons', () => {
    expect(Money.zero('BRL').isZero()).toBe(true);
    expect(brl('0.01').isPositive()).toBe(true);
    expect(brl('0.01').negate().isNegative()).toBe(true);
    expect(brl('1.00').isLessThan(brl('1.01'))).toBe(true);
    expect(brl('1.01').isLessThan(brl('1.01'))).toBe(false);
    expect(brl('2.00').isGreaterThan(brl('1.99'))).toBe(true);
    expect(brl('1.5').equals(brl('1.50'))).toBe(true);
  });

  test('equality considers currency', () => {
    expect(brl('1.00').equals(Money.from({ amount: '1.00', currency: 'USD' }))).toBe(false);
  });

  test('operations across currencies throw a domain error', () => {
    const usd = Money.from({ amount: '1.00', currency: 'USD' });
    expect(() => brl('1.00').add(usd)).toThrow(CurrencyMismatchError);
    expect(() => brl('1.00').subtract(usd)).toThrow(CurrencyMismatchError);
    expect(() => brl('1.00').isLessThan(usd)).toThrow(CurrencyMismatchError);
    expect(() => brl('1.00').isGreaterThan(usd)).toThrow(CurrencyMismatchError);
  });
});
