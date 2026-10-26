import {
  type ClaimedPendingTransaction,
  IdempotencyRaceError,
  type LockedPendingTransaction,
  type ReferenceSchedule,
  type WagerTransactionRepository,
} from '../../../application/ports/persistence';
import { type FailureCode } from '../../../domain/failure-code';
import {
  WagerTransaction,
  type WagerTransactionKind,
  type WagerTransactionStatus,
} from '../../../domain/wager-transaction';
import { violatedConstraint } from '../database-errors';
import {
  date,
  int,
  money,
  optionalDate,
  optionalMoney,
  optionalStr,
  query,
  type Row,
  type SqlExecutor,
  str,
} from '../sql';

const COLUMNS = `
  id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id,
  round_id, game_id, kind, amount::text AS amount, currency, reference_external_transaction_id,
  reference_transaction_id, status, failure_code, observed_balance::text AS observed_balance,
  resolution_attempts, correlation_id, created_at, updated_at, processed_at`;

/** Next attempt anchored to the database clock: NULL when the delay is undefined. */
const DUE_AT = `CASE WHEN ?::int IS NULL THEN NULL ELSE now() + (?::int * interval '1 millisecond') END`;

function dueAtParams(schedule: ReferenceSchedule): [number | null, number | null] {
  const delay = schedule.retryDelayMs ?? null;
  return [delay, delay];
}

const RACE_CONSTRAINTS = new Set([
  'uq_wager_transactions_idempotency_key',
  'uq_wager_transactions_provider_external',
  'uq_wager_transactions_single_reversal',
]);

function toTransaction(row: Row): WagerTransaction {
  const currency = str(row, 'currency');
  return WagerTransaction.rehydrate({
    id: str(row, 'id'),
    providerId: str(row, 'provider_id'),
    externalTransactionId: str(row, 'external_transaction_id'),
    idempotencyKey: str(row, 'idempotency_key'),
    payloadHash: str(row, 'payload_hash'),
    walletId: str(row, 'wallet_id'),
    playerId: str(row, 'player_id'),
    roundId: str(row, 'round_id'),
    gameId: str(row, 'game_id'),
    kind: str(row, 'kind') as WagerTransactionKind,
    money: money(row, 'amount', currency),
    referenceExternalTransactionId: optionalStr(row, 'reference_external_transaction_id'),
    referenceTransactionId: optionalStr(row, 'reference_transaction_id'),
    status: str(row, 'status') as WagerTransactionStatus,
    failureCode: optionalStr(row, 'failure_code') as FailureCode | undefined,
    observedBalance: optionalMoney(row, 'observed_balance', currency),
    processedAt: optionalDate(row, 'processed_at'),
    createdAt: date(row, 'created_at'),
    updatedAt: date(row, 'updated_at'),
  });
}

export class PgWagerTransactionRepository implements WagerTransactionRepository {
  constructor(private readonly em: SqlExecutor) {}

  async findById(transactionId: string): Promise<WagerTransaction | undefined> {
    return this.findOne(`id = ?`, [transactionId]);
  }

  async findByIdempotencyKey(idempotencyKey: string): Promise<WagerTransaction | undefined> {
    return this.findOne(`idempotency_key = ?`, [idempotencyKey]);
  }

  async findByExternalId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransaction | undefined> {
    return this.findOne(`provider_id = ? AND external_transaction_id = ?`, [
      providerId,
      externalTransactionId,
    ]);
  }

  async hasProcessedReversal(referenceTransactionId: string): Promise<boolean> {
    const rows = await query(
      this.em,
      `SELECT 1 FROM wager_transactions
        WHERE reference_transaction_id = ? AND kind IN ('REFUND', 'ROLLBACK') AND status = 'PROCESSED'
        LIMIT 1`,
      [referenceTransactionId],
    );
    return rows.length > 0;
  }

  async insert(
    transaction: WagerTransaction,
    schedule: ReferenceSchedule,
    correlationId: string,
  ): Promise<void> {
    try {
      await query(
        this.em,
        `INSERT INTO wager_transactions (
           id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id,
           player_id, round_id, game_id, kind, amount, currency, reference_external_transaction_id,
           reference_transaction_id, status, failure_code, observed_balance, resolution_attempts,
           next_attempt_at, correlation_id, created_at, updated_at, processed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?::numeric, ?, ?, ?, ?, ?, ?::numeric, ?, ${DUE_AT}, ?, ?, ?, ?)`,
        [
          transaction.id,
          transaction.providerId,
          transaction.externalTransactionId,
          transaction.idempotencyKey,
          transaction.payloadHash,
          transaction.walletId,
          transaction.playerId,
          transaction.roundId,
          transaction.gameId,
          transaction.kind,
          transaction.money.toString(),
          transaction.money.currency,
          transaction.referenceExternalTransactionId ?? null,
          transaction.referenceTransactionId ?? null,
          transaction.status,
          transaction.failureCode ?? null,
          transaction.observedBalance?.toString() ?? null,
          schedule.resolutionAttempts,
          ...dueAtParams(schedule),
          correlationId,
          transaction.createdAt,
          transaction.updatedAt,
          transaction.processedAt ?? null,
        ],
      );
    } catch (error) {
      const constraint = violatedConstraint(error);
      if (constraint && RACE_CONSTRAINTS.has(constraint)) {
        throw new IdempotencyRaceError(constraint);
      }
      throw error;
    }
  }

  async updateState(transaction: WagerTransaction, schedule: ReferenceSchedule): Promise<void> {
    try {
      await query(
        this.em,
        `UPDATE wager_transactions
            SET status = ?, failure_code = ?, reference_transaction_id = ?,
                observed_balance = ?::numeric, processed_at = ?, updated_at = ?,
                resolution_attempts = ?, next_attempt_at = ${DUE_AT}
          WHERE id = ?`,
        [
          transaction.status,
          transaction.failureCode ?? null,
          transaction.referenceTransactionId ?? null,
          transaction.observedBalance?.toString() ?? null,
          transaction.processedAt ?? null,
          transaction.updatedAt,
          schedule.resolutionAttempts,
          ...dueAtParams(schedule),
          transaction.id,
        ],
      );
    } catch (error) {
      const constraint = violatedConstraint(error);
      if (constraint && RACE_CONSTRAINTS.has(constraint)) {
        throw new IdempotencyRaceError(constraint);
      }
      throw error;
    }
  }

  async lockPending(transactionId: string): Promise<LockedPendingTransaction | undefined> {
    const rows = await query(
      this.em,
      `SELECT ${COLUMNS} FROM wager_transactions WHERE id = ? FOR UPDATE`,
      [transactionId],
    );
    const row = rows[0];
    if (!row) {
      return undefined;
    }
    return {
      transaction: toTransaction(row),
      resolutionAttempts: int(row, 'resolution_attempts'),
      correlationId: optionalStr(row, 'correlation_id'),
    };
  }

  async claimDuePending(limit: number, leaseMs: number): Promise<ClaimedPendingTransaction[]> {
    const rows = await query(
      this.em,
      `UPDATE wager_transactions
          SET next_attempt_at = now() + (? * interval '1 millisecond')
        WHERE id IN (
          SELECT id FROM wager_transactions
           WHERE status = 'PENDING_REFERENCE' AND next_attempt_at <= now()
           ORDER BY next_attempt_at
           LIMIT ?
           FOR UPDATE SKIP LOCKED)
        RETURNING id, wallet_id`,
      [leaseMs, limit],
    );
    return rows.map((row) => ({ transactionId: str(row, 'id'), walletId: str(row, 'wallet_id') }));
  }

  /** Uses the database clock, like the claim query that consumes the result. */
  async wakeDependents(providerId: string, externalTransactionId: string): Promise<number> {
    const rows = await query(
      this.em,
      `UPDATE wager_transactions SET next_attempt_at = now()
        WHERE provider_id = ? AND reference_external_transaction_id = ?
          AND status = 'PENDING_REFERENCE' AND next_attempt_at > now()
        RETURNING id`,
      [providerId, externalTransactionId],
    );
    return rows.length;
  }

  private async findOne(where: string, params: unknown[]): Promise<WagerTransaction | undefined> {
    const rows = await query(
      this.em,
      `SELECT ${COLUMNS} FROM wager_transactions WHERE ${where}`,
      params,
    );
    return rows[0] ? toTransaction(rows[0]) : undefined;
  }
}
