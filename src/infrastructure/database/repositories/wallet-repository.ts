import { WalletAlreadyExistsError } from '../../../application/errors';
import { type WalletRepository } from '../../../application/ports/persistence';
import { InvariantViolationError } from '../../../domain/shared/errors';
import { Wallet } from '../../../domain/wallet';
import { violatedConstraint } from '../database-errors';
import { date, int, money, query, type Row, type SqlExecutor, str } from '../sql';

const COLUMNS = `id, player_id, currency, balance::text AS balance, version, created_at, updated_at`;

function toWallet(row: Row): Wallet {
  const currency = str(row, 'currency');
  return Wallet.rehydrate({
    id: str(row, 'id'),
    playerId: str(row, 'player_id'),
    currency,
    balance: money(row, 'balance', currency),
    version: int(row, 'version'),
    createdAt: date(row, 'created_at'),
    updatedAt: date(row, 'updated_at'),
  });
}

export class PgWalletRepository implements WalletRepository {
  constructor(private readonly em: SqlExecutor) {}

  async findById(walletId: string): Promise<Wallet | undefined> {
    const rows = await query(this.em, `SELECT ${COLUMNS} FROM wallets WHERE id = ?`, [walletId]);
    return rows[0] ? toWallet(rows[0]) : undefined;
  }

  async lockById(walletId: string): Promise<Wallet | undefined> {
    const rows = await query(this.em, `SELECT ${COLUMNS} FROM wallets WHERE id = ? FOR UPDATE`, [
      walletId,
    ]);
    return rows[0] ? toWallet(rows[0]) : undefined;
  }

  async insert(wallet: Wallet): Promise<void> {
    try {
      await query(
        this.em,
        `INSERT INTO wallets (id, player_id, currency, balance, version, created_at, updated_at)
         VALUES (?, ?, ?, ?::numeric, ?, ?, ?)`,
        [
          wallet.id,
          wallet.playerId,
          wallet.currency,
          wallet.balance.toString(),
          wallet.version,
          wallet.createdAt,
          wallet.updatedAt,
        ],
      );
    } catch (error) {
      if (violatedConstraint(error) === 'uq_wallets_player_currency') {
        throw new WalletAlreadyExistsError(wallet.playerId, wallet.currency);
      }
      throw error;
    }
  }

  async saveMovement(wallet: Wallet, expectedVersion: number): Promise<void> {
    // The version predicate is defense in depth: the row is already locked by lockById.
    const rows = await query(
      this.em,
      `UPDATE wallets SET balance = ?::numeric, version = ?, updated_at = ?
        WHERE id = ? AND version = ?
        RETURNING id`,
      [wallet.balance.toString(), wallet.version, wallet.updatedAt, wallet.id, expectedVersion],
    );
    if (rows.length !== 1) {
      throw new InvariantViolationError(
        `Lost update prevented on wallet ${wallet.id}: expected version ${expectedVersion}`,
      );
    }
  }
}
