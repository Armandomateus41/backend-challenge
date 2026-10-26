import { LedgerDirection, WalletLedgerEntry } from './ledger-entry';
import { Money } from './money';
import { CurrencyMismatchError, InvariantViolationError } from './shared/errors';

export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

/** Identity of the ledger entry produced by a balance movement. */
export interface MovementContext {
  entryId: string;
  transactionId: string;
  at: Date;
}

export interface OpenWalletProps {
  id: string;
  playerId: string;
  initialBalance: Money;
  at: Date;
  /** Required when the initial balance is positive: identifies the OPENING movement. */
  opening?: { entryId: string; transactionId: string };
}

export interface OpenedWallet {
  wallet: Wallet;
  openingEntry: WalletLedgerEntry | undefined;
}

/**
 * Aggregate root for a player's balance in one currency.
 *
 * Every balance change goes through `credit`/`debit`, which return the matching ledger entry, so
 * balance and ledger cannot drift apart. `version` starts at 1 and increments only on movements.
 */
export class Wallet {
  private constructor(
    public readonly id: string,
    public readonly playerId: string,
    public readonly currency: string,
    private _balance: Money,
    private _version: number,
    public readonly createdAt: Date,
    private _updatedAt: Date,
  ) {}

  static open(props: OpenWalletProps): OpenedWallet {
    const { initialBalance } = props;
    if (initialBalance.isNegative()) {
      throw new InvariantViolationError('Initial balance must not be negative');
    }
    const wallet = new Wallet(
      props.id,
      props.playerId,
      initialBalance.currency,
      initialBalance,
      1,
      props.at,
      props.at,
    );
    if (initialBalance.isZero()) {
      return { wallet, openingEntry: undefined };
    }
    if (!props.opening) {
      throw new InvariantViolationError('A positive initial balance requires an opening movement');
    }
    const openingEntry = WalletLedgerEntry.create({
      id: props.opening.entryId,
      walletId: wallet.id,
      transactionId: props.opening.transactionId,
      direction: LedgerDirection.Credit,
      money: initialBalance,
      balanceBefore: Money.zero(initialBalance.currency),
      balanceAfter: initialBalance,
      walletVersion: 1,
      createdAt: props.at,
    });
    return { wallet, openingEntry };
  }

  /** Reconstruction from persistence: restores state without replaying transition rules. */
  static rehydrate(state: WalletState): Wallet {
    return new Wallet(
      state.id,
      state.playerId,
      state.currency,
      state.balance,
      state.version,
      state.createdAt,
      state.updatedAt,
    );
  }

  get balance(): Money {
    return this._balance;
  }

  get version(): number {
    return this._version;
  }

  get updatedAt(): Date {
    return this._updatedAt;
  }

  canDebit(money: Money): boolean {
    this.assertSameCurrency(money);
    return !this._balance.isLessThan(money);
  }

  credit(money: Money, context: MovementContext): WalletLedgerEntry {
    return this.move(LedgerDirection.Credit, money, context);
  }

  debit(money: Money, context: MovementContext): WalletLedgerEntry {
    if (!this.canDebit(money)) {
      throw new InvariantViolationError(
        `Debit of ${money.toString()} would make wallet ${this.id} negative`,
      );
    }
    return this.move(LedgerDirection.Debit, money, context);
  }

  private move(
    direction: LedgerDirection,
    money: Money,
    context: MovementContext,
  ): WalletLedgerEntry {
    this.assertSameCurrency(money);
    if (!money.isPositive()) {
      throw new InvariantViolationError('Wallet movements must have a positive amount');
    }
    const balanceBefore = this._balance;
    const balanceAfter =
      direction === LedgerDirection.Credit
        ? balanceBefore.add(money)
        : balanceBefore.subtract(money);
    const entry = WalletLedgerEntry.create({
      id: context.entryId,
      walletId: this.id,
      transactionId: context.transactionId,
      direction,
      money,
      balanceBefore,
      balanceAfter,
      walletVersion: this._version + 1,
      createdAt: context.at,
    });
    this._balance = balanceAfter;
    this._version = entry.walletVersion;
    this._updatedAt = context.at;
    return entry;
  }

  private assertSameCurrency(money: Money): void {
    if (money.currency !== this.currency) {
      throw new CurrencyMismatchError(this.currency, money.currency);
    }
  }
}
