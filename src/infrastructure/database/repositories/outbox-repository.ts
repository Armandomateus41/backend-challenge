import { type OutboxRepository, type OutboxStats } from '../../../application/ports/persistence';
import { OutboxMessage } from '../../../domain/outbox-message';
import {
  date,
  int,
  optionalDate,
  optionalStr,
  query,
  type Row,
  type SqlExecutor,
  str,
} from '../sql';

const COLUMNS = `id, sequence, aggregate_id, ordering_key, event_type, payload, occurred_at, attempts,
                 next_attempt_at, published_at, last_error`;

function toMessage(row: Row): OutboxMessage {
  const payload = row.payload;
  return OutboxMessage.rehydrate({
    id: str(row, 'id'),
    aggregateId: str(row, 'aggregate_id'),
    orderingKey: str(row, 'ordering_key'),
    eventType: str(row, 'event_type'),
    payload: (typeof payload === 'string' ? JSON.parse(payload) : payload) as Record<
      string,
      unknown
    >,
    occurredAt: date(row, 'occurred_at'),
    attempts: int(row, 'attempts'),
    nextAttemptAt: optionalDate(row, 'next_attempt_at'),
    publishedAt: optionalDate(row, 'published_at'),
    lastError: optionalStr(row, 'last_error'),
  });
}

export class PgOutboxRepository implements OutboxRepository {
  constructor(private readonly em: SqlExecutor) {}

  async enqueue(messages: readonly OutboxMessage[]): Promise<void> {
    if (messages.length === 0) {
      return;
    }
    const placeholders = messages.map(() => '(?, ?, ?, ?, ?::jsonb, ?, ?, ?)').join(', ');
    const params = messages.flatMap((message) => [
      message.id,
      message.aggregateId,
      message.orderingKey,
      message.eventType,
      JSON.stringify(message.payload),
      message.occurredAt,
      message.attempts,
      message.nextAttemptAt ?? null,
    ]);
    await query(
      this.em,
      `INSERT INTO outbox_messages (id, aggregate_id, ordering_key, event_type, payload, occurred_at,
                                    attempts, next_attempt_at)
       VALUES ${placeholders}`,
      params,
    );
  }

  /**
   * Leases a batch: rows locked by another publisher's claim are skipped (SKIP LOCKED), and rows
   * whose lease expired (publisher crashed between claim and publish) become claimable again.
   */
  async claimDue(owner: string, limit: number, leaseMs: number): Promise<OutboxMessage[]> {
    const rows = await query(
      this.em,
      `UPDATE outbox_messages
          SET locked_by = ?, locked_until = now() + (? * interval '1 millisecond')
        WHERE id IN (
          SELECT id FROM outbox_messages
           WHERE published_at IS NULL
             AND (next_attempt_at IS NULL OR next_attempt_at <= now())
             AND (locked_until IS NULL OR locked_until < now())
           ORDER BY sequence
           LIMIT ?
           FOR UPDATE SKIP LOCKED)
        RETURNING ${COLUMNS}`,
      [owner, leaseMs, limit],
    );
    return rows
      .sort((a, b) => Number(a.sequence) - Number(b.sequence))
      .map((row) => toMessage(row));
  }

  async saveDeliveryState(message: OutboxMessage, owner: string): Promise<boolean> {
    const rows = await query(
      this.em,
      `UPDATE outbox_messages
          SET attempts = ?,
              next_attempt_at = CASE WHEN ?::int IS NULL THEN NULL
                                     ELSE now() + (?::int * interval '1 millisecond') END,
              published_at = ?, last_error = ?, locked_by = NULL, locked_until = NULL
        WHERE id = ? AND locked_by = ? AND published_at IS NULL
        RETURNING id`,
      [
        message.attempts,
        message.retryDelayMs ?? null,
        message.retryDelayMs ?? null,
        message.publishedAt ?? null,
        message.lastError?.slice(0, 1000) ?? null,
        message.id,
        owner,
      ],
    );
    return rows.length === 1;
  }

  async stats(): Promise<OutboxStats> {
    const rows = await query(
      this.em,
      `SELECT COUNT(*)::int AS pending,
              COALESCE(EXTRACT(EPOCH FROM (now() - MIN(occurred_at))), 0)::float8 AS lag
         FROM outbox_messages
        WHERE published_at IS NULL`,
    );
    const row = rows[0];
    return {
      pending: row ? int(row, 'pending') : 0,
      oldestPendingAgeSeconds: row ? Number(row.lag) : 0,
    };
  }
}
