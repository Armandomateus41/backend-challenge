import { type Money, type MoneyProps } from './money';
import { InvariantViolationError } from './shared/errors';

export enum LedgerDirection {
  Debit = 'DEBIT',
  Credit = 'CREDIT',
}

export interface CreateLedgerEntryProps {
  id: string;
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: Money;
  balanceBefore: Money;
  balanceAfter: Money;
  /** Wallet version produced by this movement; orders the ledger of a wallet. */
  walletVersion: number;
  createdAt: Date;
}

export type LedgerEntryState = CreateLedgerEntryProps;

/**
 * Immutable record of a single balance movement. There are no setters and no transition
 * methods: once created, an entry never changes (the database enforces the same rule).
 */
export class WalletLedgerEntry {
  private constructor(
    public readonly id: string,
    public readonly walletId: string,
    public readonly transactionId: string,
    public readonly direction: LedgerDirection,
    public readonly money: Money,
    public readonly balanceBefore: Money,
    public readonly balanceAfter: Money,
    public readonly walletVersion: number,
    public readonly createdAt: Date,
  ) {}

  static create(props: CreateLedgerEntryProps): WalletLedgerEntry {
    const entry = WalletLedgerEntry.rehydrate(props);
    if (!entry.money.isPositive()) {
      throw new InvariantViolationError('Ledger entry amount must be positive');
    }
    if (entry.balanceBefore.isNegative() || entry.balanceAfter.isNegative()) {
      throw new InvariantViolationError('Ledger entry balances must not be negative');
    }
    if (!Number.isInteger(entry.walletVersion) || entry.walletVersion < 1) {
      throw new InvariantViolationError('Ledger entry wallet version must be a positive integer');
    }
    if (!entry.isBalanced()) {
      throw new InvariantViolationError(
        `Unbalanced ledger entry: ${entry.balanceBefore.toString()} ${entry.direction} ${entry.money.toString()} != ${entry.balanceAfter.toString()}`,
      );
    }
    return entry;
  }

  static rehydrate(state: LedgerEntryState): WalletLedgerEntry {
    return new WalletLedgerEntry(
      state.id,
      state.walletId,
      state.transactionId,
      state.direction,
      state.money,
      state.balanceBefore,
      state.balanceAfter,
      state.walletVersion,
      state.createdAt,
    );
  }

  /** balanceBefore +/- money === balanceAfter, all in the same currency. */
  isBalanced(): boolean {
    if (
      !this.money.hasSameCurrency(this.balanceBefore) ||
      !this.money.hasSameCurrency(this.balanceAfter)
    ) {
      return false;
    }
    const expected =
      this.direction === LedgerDirection.Credit
        ? this.balanceBefore.add(this.money)
        : this.balanceBefore.subtract(this.money);
    return expected.equals(this.balanceAfter);
  }

  /** Signed effect of the entry on the wallet balance. */
  signedAmount(): Money {
    return this.direction === LedgerDirection.Credit ? this.money : this.money.negate();
  }

  toJSON(): {
    id: string;
    walletId: string;
    transactionId: string;
    direction: LedgerDirection;
    money: MoneyProps;
    balanceBefore: MoneyProps;
    balanceAfter: MoneyProps;
    walletVersion: number;
    createdAt: string;
  } {
    return {
      id: this.id,
      walletId: this.walletId,
      transactionId: this.transactionId,
      direction: this.direction,
      money: this.money.toJSON(),
      balanceBefore: this.balanceBefore.toJSON(),
      balanceAfter: this.balanceAfter.toJSON(),
      walletVersion: this.walletVersion,
      createdAt: this.createdAt.toISOString(),
    };
  }
}
