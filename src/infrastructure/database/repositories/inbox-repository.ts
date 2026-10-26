import { type InboxRepository } from '../../../application/ports/persistence';
import { type InboxMessage } from '../../../domain/inbox-message';
import { query, type SqlExecutor } from '../sql';

export class PgInboxRepository implements InboxRepository {
  constructor(private readonly em: SqlExecutor) {}

  /**
   * ON CONFLICT DO NOTHING on the (consumer_name, message_id) primary key. A concurrent delivery
   * of the same message blocks on the unique index until the first transaction ends, then sees
   * the conflict: only one of them can commit the effect.
   */
  async tryRecord(message: InboxMessage): Promise<boolean> {
    const rows = await query(
      this.em,
      `INSERT INTO inbox_messages (consumer_name, message_id, payload_hash, received_at, processed_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (consumer_name, message_id) DO NOTHING
       RETURNING message_id`,
      [
        message.consumerName,
        message.messageId,
        message.payloadHash,
        message.receivedAt,
        message.processedAt ?? null,
      ],
    );
    return rows.length === 1;
  }

  async deleteProcessedBefore(retentionHours: number, limit: number): Promise<number> {
    const rows = await query<{ deleted: number }>(
      this.em,
      `WITH expired AS (
         DELETE FROM inbox_messages
          WHERE (consumer_name, message_id) IN (
            SELECT consumer_name, message_id FROM inbox_messages
             WHERE processed_at < now() - (? * interval '1 hour')
             LIMIT ?)
         RETURNING 1)
       SELECT COUNT(*)::int AS deleted FROM expired`,
      [retentionHours, limit],
    );
    return rows[0]?.deleted ?? 0;
  }

  async linkTransaction(message: InboxMessage, transactionId: string): Promise<void> {
    await query(
      this.em,
      `UPDATE inbox_messages SET transaction_id = ? WHERE consumer_name = ? AND message_id = ?`,
      [transactionId, message.consumerName, message.messageId],
    );
  }
}
