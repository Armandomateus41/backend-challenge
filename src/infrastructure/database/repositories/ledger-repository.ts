import {
  type LedgerPage,
  type LedgerRepository,
  type LedgerSummary,
} from '../../../application/ports/persistence';
import { type LedgerDirection, WalletLedgerEntry } from '../../../domain/ledger-entry';
import { Money } from '../../../domain/money';
import { date, int, money, query, type Row, type SqlExecutor, str } from '../sql';

function toEntry(row: Row): WalletLedgerEntry {
  const currency = str(row, 'currency');
  return WalletLedgerEntry.rehydrate({
    id: str(row, 'id'),
    walletId: str(row, 'wallet_id'),
    transactionId: str(row, 'transaction_id'),
    direction: str(row, 'direction') as LedgerDirection,
    money: money(row, 'amount', currency),
    balanceBefore: money(row, 'balance_before', currency),
    balanceAfter: money(row, 'balance_after', currency),
    walletVersion: int(row, 'wallet_version'),
    createdAt: date(row, 'created_at'),
  });
}

/** Parses a possibly negative decimal string produced by an aggregate. */
function signedMoney(amount: string, currency: string): Money {
  return amount.startsWith('-')
    ? Money.from({ amount: amount.slice(1), currency }).negate()
    : Money.from({ amount, currency });
}

export class PgLedgerRepository implements LedgerRepository {
  constructor(private readonly em: SqlExecutor) {}

  async insert(entry: WalletLedgerEntry): Promise<void> {
    await query(
      this.em,
      `INSERT INTO wallet_ledger_entries (
         id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after,
         wallet_version, created_at)
       VALUES (?, ?, ?, ?, ?::numeric, ?, ?::numeric, ?::numeric, ?, ?)`,
      [
        entry.id,
        entry.walletId,
        entry.transactionId,
        entry.direction,
        entry.money.toString(),
        entry.money.currency,
        entry.balanceBefore.toString(),
        entry.balanceAfter.toString(),
        entry.walletVersion,
        entry.createdAt,
      ],
    );
  }

  async listByWallet(
    walletId: string,
    afterWalletVersion: number,
    limit: number,
  ): Promise<LedgerPage> {
    const rows = await query(
      this.em,
      `SELECT id, wallet_id, transaction_id, direction, amount::text AS amount, currency,
              balance_before::text AS balance_before, balance_after::text AS balance_after,
              wallet_version, created_at
         FROM wallet_ledger_entries
        WHERE wallet_id = ? AND wallet_version > ?
        ORDER BY wallet_version ASC
        LIMIT ?`,
      [walletId, afterWalletVersion, limit + 1],
    );
    const hasMore = rows.length > limit;
    return { entries: rows.slice(0, limit).map(toEntry), hasMore };
  }

  /** Rebuilds the balance from the ledger with exact NUMERIC arithmetic. */
  async summarize(walletId: string, currency: string): Promise<LedgerSummary> {
    const rows = await query(
      this.em,
      `SELECT COUNT(*)::int AS entry_count,
              COALESCE(SUM(CASE direction WHEN 'CREDIT' THEN amount ELSE -amount END), 0)::numeric(22, 2)::text AS total
         FROM wallet_ledger_entries
        WHERE wallet_id = ?`,
      [walletId],
    );
    const row = rows[0];
    if (!row) {
      return { calculatedBalance: Money.zero(currency), entryCount: 0 };
    }
    return {
      calculatedBalance: signedMoney(str(row, 'total'), currency),
      entryCount: int(row, 'entry_count'),
    };
  }
}
