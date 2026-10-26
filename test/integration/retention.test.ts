import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PurgeExpiredMessages } from '../../src/application/use-cases/purge-expired-messages';
import { MikroOrmUnitOfWork } from '../../src/infrastructure/database/mikro-orm-unit-of-work';
import { newId } from '../../src/shared/ids';
import { TestDatabase } from '../support/environment';

let db: TestDatabase;

beforeAll(async () => {
  db = await TestDatabase.connect();
  await db.reset();
});

afterAll(async () => {
  await db.close();
});

async function insertOutbox(publishedHoursAgo: number | null): Promise<string> {
  const id = newId();
  await db.query(
    `INSERT INTO outbox_messages (id, aggregate_id, ordering_key, event_type, payload, occurred_at, published_at)
     VALUES (?, 'a', 'k', 'TestEvent', '{}'::jsonb, now(),
             CASE WHEN ?::int IS NULL THEN NULL ELSE now() - (?::int * interval '1 hour') END)`,
    [id, publishedHoursAgo, publishedHoursAgo],
  );
  return id;
}

async function insertInbox(processedHoursAgo: number): Promise<string> {
  const id = `msg-${newId()}`;
  await db.query(
    `INSERT INTO inbox_messages (consumer_name, message_id, payload_hash, received_at, processed_at)
     VALUES ('c', ?, ?, now(), now() - (? * interval '1 hour'))`,
    [id, 'f'.repeat(64), processedHoursAgo],
  );
  return id;
}

describe('retention job', () => {
  test('removes only expired inbox rows and expired published outbox rows', async () => {
    const expiredOutbox = await Promise.all([1, 2, 3].map(() => insertOutbox(200)));
    const recentOutbox = await insertOutbox(1);
    const pendingOutbox = await insertOutbox(null);
    const expiredInbox = await Promise.all([1, 2, 3].map(() => insertInbox(400)));
    const recentInbox = await insertInbox(2);

    // A small batch size forces several batches per run.
    const purge = new PurgeExpiredMessages(new MikroOrmUnitOfWork(db.orm, 5000), {
      inboxRetentionHours: 336,
      outboxRetentionHours: 168,
      batchSize: 2,
    });
    expect(await purge.runOnce()).toEqual({ inbox: 3, outbox: 3 });

    const outboxIds = (await db.query<{ id: string }>(`SELECT id FROM outbox_messages`)).map(
      (row) => row.id,
    );
    expect(outboxIds.sort()).toEqual([recentOutbox, pendingOutbox].sort());
    expect(outboxIds).not.toContain(expiredOutbox[0]);
    const inboxIds = (
      await db.query<{ message_id: string }>(`SELECT message_id FROM inbox_messages`)
    ).map((row) => row.message_id);
    expect(inboxIds).toEqual([recentInbox]);
    expect(inboxIds).not.toContain(expiredInbox[0]);

    // Nothing left to purge: a second run is a no-op.
    expect(await purge.runOnce()).toEqual({ inbox: 0, outbox: 0 });
  });

  test('never deletes a pending outbox message, however old', async () => {
    await db.reset();
    const id = newId();
    await db.query(
      `INSERT INTO outbox_messages (id, aggregate_id, ordering_key, event_type, payload, occurred_at)
       VALUES (?, 'a', 'k', 'TestEvent', '{}'::jsonb, now() - interval '365 days')`,
      [id],
    );
    const purge = new PurgeExpiredMessages(new MikroOrmUnitOfWork(db.orm, 5000), {
      inboxRetentionHours: 1,
      outboxRetentionHours: 1,
      batchSize: 100,
    });
    expect(await purge.runOnce()).toEqual({ inbox: 0, outbox: 0 });
    expect(await db.query(`SELECT 1 FROM outbox_messages WHERE id = ?`, [id])).toHaveLength(1);
  });
});
