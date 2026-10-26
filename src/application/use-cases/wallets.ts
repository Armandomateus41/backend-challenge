import {
  WagerTransactionProcessed,
  WalletBalanceChanged,
} from '../../domain/events/wagering-events';
import { type EventContext } from '../../domain/events/integration-event';
import { type WalletLedgerEntry } from '../../domain/ledger-entry';
import { Money, type MoneyProps } from '../../domain/money';
import { OutboxMessage } from '../../domain/outbox-message';
import { WagerTransaction } from '../../domain/wager-transaction';
import { Wallet } from '../../domain/wallet';
import { logger } from '../../observability/logger';
import { metrics } from '../../observability/metrics';
import { newId } from '../../shared/ids';
import { InvalidCursorError, UnsupportedCurrencyError, WalletNotFoundError } from '../errors';
import { hashCanonical } from '../idempotency/payload-hash';
import { type UnitOfWork } from '../ports/persistence';

export interface WalletView {
  id: string;
  playerId: string;
  balance: MoneyProps;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export function toWalletView(wallet: Wallet): WalletView {
  return {
    id: wallet.id,
    playerId: wallet.playerId,
    balance: wallet.balance.toJSON(),
    version: wallet.version,
    createdAt: wallet.createdAt.toISOString(),
    updatedAt: wallet.updatedAt.toISOString(),
  };
}

export interface CreateWalletCommand {
  playerId: string;
  initialBalance: MoneyProps;
}

/**
 * Opens a wallet. A positive initial balance creates the internal OPENING transaction and its
 * CREDIT entry in the same SQL transaction as the wallet row.
 */
export class CreateWallet {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly supportedCurrencies: readonly string[],
  ) {}

  async execute(command: CreateWalletCommand, correlationId: string): Promise<WalletView> {
    const initialBalance = Money.from(command.initialBalance);
    if (!this.supportedCurrencies.includes(initialBalance.currency)) {
      throw new UnsupportedCurrencyError(initialBalance.currency);
    }
    const now = new Date();
    const walletId = newId();
    const openingTransactionId = newId();
    const { wallet, openingEntry } = Wallet.open({
      id: walletId,
      playerId: command.playerId,
      initialBalance,
      at: now,
      opening: { entryId: newId(), transactionId: openingTransactionId },
    });

    await this.uow.transaction(async (scope) => {
      await scope.wallets.insert(wallet);
      if (!openingEntry) {
        return;
      }
      const opening = WagerTransaction.createOpening({
        id: openingTransactionId,
        walletId,
        playerId: command.playerId,
        money: initialBalance,
        payloadHash: hashCanonical({ walletId, initialBalance: initialBalance.toJSON() }),
        createdAt: now,
      });
      opening.markProcessed(undefined, now, wallet.balance);
      await scope.transactions.insert(
        opening,
        { resolutionAttempts: 0, retryDelayMs: undefined },
        correlationId,
      );
      await scope.ledger.insert(openingEntry);
      const ctx: EventContext = { correlationId, occurredAt: now, newEventId: newId };
      await scope.outbox.enqueue([
        OutboxMessage.enqueue(WagerTransactionProcessed.from(opening, ctx)),
        OutboxMessage.enqueue(WalletBalanceChanged.from(wallet, openingEntry, ctx)),
      ]);
    });
    logger().info({ walletId }, 'wallet created');
    return toWalletView(wallet);
  }
}

export class GetWallet {
  constructor(private readonly uow: UnitOfWork) {}

  async execute(walletId: string): Promise<WalletView> {
    const wallet = await this.uow.read((scope) => scope.wallets.findById(walletId));
    if (!wallet) {
      throw new WalletNotFoundError(walletId);
    }
    return toWalletView(wallet);
  }
}

export interface LedgerPageView {
  walletId: string;
  entries: ReturnType<WalletLedgerEntry['toJSON']>[];
  nextCursor: string | null;
}

/** Opaque cursor: base64url of the last returned wallet version. Stable under concurrent writes. */
export function encodeLedgerCursor(walletVersion: number): string {
  return Buffer.from(JSON.stringify({ v: walletVersion }), 'utf8').toString('base64url');
}

export function decodeLedgerCursor(cursor: string | undefined): number {
  if (!cursor) {
    return 0;
  }
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { v?: unknown };
    if (typeof parsed.v === 'number' && Number.isInteger(parsed.v) && parsed.v >= 0) {
      return parsed.v;
    }
  } catch {
    // Falls through to the error below.
  }
  throw new InvalidCursorError();
}

export class GetWalletLedger {
  constructor(private readonly uow: UnitOfWork) {}

  async execute(
    walletId: string,
    cursor: string | undefined,
    limit: number,
  ): Promise<LedgerPageView> {
    const afterVersion = decodeLedgerCursor(cursor);
    return this.uow.read(async (scope) => {
      const wallet = await scope.wallets.findById(walletId);
      if (!wallet) {
        throw new WalletNotFoundError(walletId);
      }
      const page = await scope.ledger.listByWallet(walletId, afterVersion, limit);
      const last = page.entries.at(-1);
      return {
        walletId,
        entries: page.entries.map((entry) => entry.toJSON()),
        nextCursor: page.hasMore && last ? encodeLedgerCursor(last.walletVersion) : null,
      };
    });
  }
}

export interface ReconciliationView {
  walletId: string;
  storedBalance: MoneyProps;
  calculatedBalance: MoneyProps;
  difference: MoneyProps;
  consistent: boolean;
  checkedEntries: number;
}

/**
 * Compares the materialized balance with the balance rebuilt from the ledger, reading both from
 * the same REPEATABLE READ snapshot. Divergences are reported, logged and counted, never fixed.
 */
export class ReconcileWallet {
  constructor(private readonly uow: UnitOfWork) {}

  async execute(walletId: string): Promise<ReconciliationView> {
    const view = await this.uow.snapshot(async (scope) => {
      const wallet = await scope.wallets.findById(walletId);
      if (!wallet) {
        throw new WalletNotFoundError(walletId);
      }
      const summary = await scope.ledger.summarize(walletId, wallet.currency);
      const difference = wallet.balance.subtract(summary.calculatedBalance);
      return {
        walletId,
        storedBalance: wallet.balance.toJSON(),
        calculatedBalance: summary.calculatedBalance.toJSON(),
        difference: difference.toJSON(),
        consistent: difference.isZero(),
        checkedEntries: summary.entryCount,
      };
    });
    if (!view.consistent) {
      metrics.reconciliationMismatches.inc();
      logger().error(
        { walletId, difference: view.difference.amount, checkedEntries: view.checkedEntries },
        'wallet balance diverges from ledger',
      );
    }
    return view;
  }
}
