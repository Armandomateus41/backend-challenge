import { CurrencyMismatchError, DomainValidationError } from './shared/errors';

export interface MoneyProps {
  amount: string;
  currency: string;
}

export const MONEY_SCALE = 2;
const SCALE_FACTOR = 10n ** BigInt(MONEY_SCALE);

/** Mirrors the NUMERIC(20, 2) columns: at most 18 integer digits. */
const MAX_INTEGER_DIGITS = 18;

/**
 * Plain decimal notation only: no sign, no exponent, no leading zeros, no leading or trailing dot,
 * at most two fractional digits.
 */
const AMOUNT_PATTERN = /^(0|[1-9]\d*)(\.\d{1,2})?$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;

/**
 * Immutable monetary value with exact decimal arithmetic.
 *
 * The amount is held as an integer number of minor units (scale 2) in a `bigint`, so every
 * operation is exact. Values enter and leave the model as decimal strings with fixed scale 2.
 */
export class Money {
  private constructor(
    private readonly minorUnits: bigint,
    public readonly currency: string,
  ) {}

  /** Parses a contract value. Rejects negatives, exponents, non-finite values and scale above 2. */
  static from(props: MoneyProps): Money {
    const currency = Money.parseCurrency(props?.currency);
    const amount: unknown = props?.amount;
    if (typeof amount !== 'string') {
      throw new DomainValidationError('INVALID_AMOUNT', 'Amount must be a decimal string');
    }
    if (!AMOUNT_PATTERN.test(amount)) {
      throw new DomainValidationError(
        'INVALID_AMOUNT',
        `Amount "${amount}" must be a non-negative decimal with at most ${MONEY_SCALE} fractional digits`,
      );
    }
    const [integerPart = '0', fractionPart = ''] = amount.split('.');
    if (integerPart.length > MAX_INTEGER_DIGITS) {
      throw new DomainValidationError(
        'AMOUNT_OUT_OF_RANGE',
        `Amount exceeds ${MAX_INTEGER_DIGITS} integer digits`,
      );
    }
    const minorUnits =
      BigInt(integerPart) * SCALE_FACTOR + BigInt(fractionPart.padEnd(MONEY_SCALE, '0'));
    return new Money(minorUnits, currency);
  }

  static zero(currency: string): Money {
    return new Money(0n, Money.parseCurrency(currency));
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.minorUnits + other.minorUnits, this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.minorUnits - other.minorUnits, this.currency);
  }

  negate(): Money {
    return new Money(-this.minorUnits, this.currency);
  }

  isZero(): boolean {
    return this.minorUnits === 0n;
  }

  isPositive(): boolean {
    return this.minorUnits > 0n;
  }

  isNegative(): boolean {
    return this.minorUnits < 0n;
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.minorUnits < other.minorUnits;
  }

  isGreaterThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.minorUnits > other.minorUnits;
  }

  equals(other: Money): boolean {
    return this.currency === other.currency && this.minorUnits === other.minorUnits;
  }

  hasSameCurrency(other: Money): boolean {
    return this.currency === other.currency;
  }

  toJSON(): MoneyProps {
    return { amount: this.toString(), currency: this.currency };
  }

  /** Decimal string with exactly two fractional digits, e.g. "-25.00". */
  toString(): string {
    const negative = this.minorUnits < 0n;
    const absolute = negative ? -this.minorUnits : this.minorUnits;
    const integerPart = absolute / SCALE_FACTOR;
    const fractionPart = (absolute % SCALE_FACTOR).toString().padStart(MONEY_SCALE, '0');
    return `${negative ? '-' : ''}${integerPart.toString()}.${fractionPart}`;
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new CurrencyMismatchError(this.currency, other.currency);
    }
  }

  private static parseCurrency(currency: unknown): string {
    if (typeof currency !== 'string' || !CURRENCY_PATTERN.test(currency)) {
      throw new DomainValidationError(
        'INVALID_CURRENCY',
        'Currency must be a three-letter ISO-4217 code',
      );
    }
    return currency;
  }
}
