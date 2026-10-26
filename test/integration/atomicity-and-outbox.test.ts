import { SendMessageBatchCommand } from '@aws-sdk/client-sqs';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import {
  type OutboxRepository,
  type RepositoryScope,
  type UnitOfWork,
} from '../../src/application/ports/persistence';
import { ProcessWagerTransaction } from '../../src/application/use-cases/process-wager-transaction';
import { CreateWallet, type WalletView } from '../../src/application/use-cases/wallets';
import { type AppConfig } from '../../src/config/app-config';
import { WagerTransactionKind } from '../../src/domain/wager-transaction';
import { MikroOrmUnitOfWork } from '../../src/infrastructure/database/mikro-orm-unit-of-work';
import { OutboxPublisher } from '../../src/infrastructure/messaging/outbox-publisher';
import { SqsQueues } from '../../src/infrastructure/messaging/sqs';
import { newId } from '../../src/shared/ids';
import { eventIdOf, rejectionOf } from '../support/assertions';
import { testConfig, TestDatabase, TestQueues, uniqueSuffix } from '../support/environment';

let db: TestDatabase;
let uow: MikroOrmUnitOfWork;
let config: AppConfig;
let queues: TestQueues;
let sqsQueues: SqsQueues;
let createWallet: CreateWallet;
let processWager: ProcessWagerTransaction;

const backoff = { baseDelayMs: 100, maxDelayMs: 400 };

/** Wraps a unit of work so that writing to the outbox fails after the financial writes ran. */
class CrashBeforeCommitUnitOfWork implements UnitOfWork {
  constructor(private readonly inner: UnitOfWork) {}

  transaction<T>(work: (scope: RepositoryScope) => Promise<T>): Promise<T> {
    return this.inner.transaction((scope) => {
      const failingOutbox = Object.create(scope.outbox) as OutboxRepository;
      failingOutbox.enqueue = () => Promise.reject(new Error('simulated crash before commit'));
      return work({ ...scope, outbox: failingOutbox });
    });
  }

  snapshot<T>(work: (scope: RepositoryScope) => Promise<T>): Promise<T> {
    return this.inner.snapshot(work);
  }

  read<T>(work: (scope: RepositoryScope) => Promise<T>): Promise<T> {
    return this.inner.read(work);
  }

  ping(): Promise<void> {
    return this.inner.ping();
  }
}

beforeAll(async () => {
  db = await TestDatabase.connect();
  uow = new MikroOrmUnitOfWork(db.orm, 5000);
  config = testConfig(uniqueSuffix());
  queues = await TestQueues.create(config);
  sqsQueues = new SqsQueues(queues.client, {
    wager: config.sqs.wagerQueueName,
    dlq: config.sqs.wagerDlqName,
    events: config.sqs.eventsQueueName,
  });
  createWallet = new CreateWallet(uow, ['BRL']);
  processWager = new ProcessWagerTransaction(uow, backoff);
});

beforeEach(async () => {
  await db.reset();
  await queues.purgeAll();
});

afterAll(async () => {
  expect(await db.inconsistentWallets()).toEqual([]);
  await queues.destroy();
  await db.close();
});

function bet(wallet: WalletView, amount: string) {
  const externalTransactionId = `tx-${newId()}`;
  return {
    idempotencyKey: `provider-a:${externalTransactionId}`,
    providerId: 'provider-a',
    externalTransactionId,
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId: 'round-1',
    gameId: 'game-1',
    kind: WagerTransactionKind.Bet,
    money: { amount, currency: 'BRL' },
  };
}

function publisher(owner: string, leaseMs = 1000): OutboxPublisher {
  return new OutboxPublisher(uow, sqsQueues, {
    owner,
    batchSize: 50,
    leaseMs,
    retry: { baseDelayMs: 100, maxDelayMs: 400 },
  });
}

async function outboxCounts(): Promise<{ total: number; published: number }> {
  const [row] = await db.query<{ total: number; published: number }>(
    `SELECT COUNT(*)::int AS total, COUNT(published_at)::int AS published FROM outbox_messages`,
  );
  return row ?? { total: 0, published: 0 };
}

describe('atomicity of wallet, transaction, ledger, inbox and outbox', () => {
  test('a failure after the balance and ledger writes rolls everything back', async () => {
    const wallet = await createWallet.execute(
      { playerId: `p-${newId()}`, initialBalance: { amount: '100.00', currency: 'BRL' } },
      'test',
    );
    const before = await db.walletState(wallet.id);
    const outboxBefore = await outboxCounts();
    const crashing = new ProcessWagerTransaction(new CrashBeforeCommitUnitOfWork(uow), backoff);
    const command = bet(wallet, '40.00');
    const messageId = `msg-${newId()}`;

    const failure = await rejectionOf(
      crashing.execute(command, {
        source: 'sqs',
        correlationId: 'c',
        inbox: { consumerName: 'test-consumer', messageId },
      }),
    );
    expect(failure).toHaveProperty('message', 'simulated crash before commit');

    expect(await db.walletState(wallet.id)).toEqual(before);
    expect(await outboxCounts()).toEqual(outboxBefore);
    expect(
      await db.query(`SELECT 1 FROM wager_transactions WHERE idempotency_key = ?`, [
        command.idempotencyKey,
      ]),
    ).toHaveLength(0);
    expect(
      await db.query(`SELECT 1 FROM inbox_messages WHERE message_id = ?`, [messageId]),
    ).toHaveLength(0);

    // The redelivery is processed normally: nothing from the failed attempt survived.
    const retried = await processWager.execute(command, {
      source: 'sqs',
      correlationId: 'c',
      inbox: { consumerName: 'test-consumer', messageId },
    });
    expect(retried.kind).toBe('settled');
    const after = await db.walletState(wallet.id);
    expect(after).toMatchObject({
      balance: '60.00',
      ledgerBalance: '60.00',
      debits: 1,
      version: 2,
    });
    expect(
      await db.query(`SELECT 1 FROM inbox_messages WHERE message_id = ?`, [messageId]),
    ).toHaveLength(1);
    const events = await db.query(
      `SELECT event_type FROM outbox_messages WHERE ordering_key = ? ORDER BY sequence`,
      [wallet.id],
    );
    expect(events.map((row) => row.event_type)).toEqual([
      'WagerTransactionProcessed',
      'WalletBalanceChanged',
      'WagerTransactionProcessed',
      'WalletBalanceChanged',
    ]);
  });

  test('WalletBalanceChanged is only emitted when the balance changes', async () => {
    const wallet = await createWallet.execute(
      { playerId: `p-${newId()}`, initialBalance: { amount: '10.00', currency: 'BRL' } },
      'test',
    );
    await processWager.execute(bet(wallet, '50.00'), { source: 'http', correlationId: 'c' });
    await processWager.execute(
      { ...bet(wallet, '1.00'), kind: WagerTransactionKind.Loss },
      { source: 'http', correlationId: 'c' },
    );
    const events = await db.query(
      `SELECT event_type FROM outbox_messages WHERE ordering_key = ? ORDER BY sequence`,
      [wallet.id],
    );
    expect(events.map((row) => row.event_type)).toEqual([
      'WagerTransactionProcessed',
      'WalletBalanceChanged',
      'WagerTransactionRejected',
      'WagerTransactionProcessed',
    ]);
  });
});

describe('transactional outbox recovery', () => {
  async function seedEvents(count: number): Promise<void> {
    const wallet = await createWallet.execute(
      { playerId: `p-${newId()}`, initialBalance: { amount: '1000.00', currency: 'BRL' } },
      'test',
    );
    for (let i = 0; i < count; i++) {
      await processWager.execute(bet(wallet, '1.00'), { source: 'http', correlationId: 'c' });
    }
  }

  test('events committed by a process that died before publishing are published by another instance', async () => {
    await seedEvents(5);
    const { total } = await outboxCounts();
    expect(total).toBe(12);

    const summary = await publisher(`instance-b:${newId()}`).publishOnce();
    expect(summary).toMatchObject({ claimed: 12, published: 12, failed: 0, leaseLost: 0 });
    expect(await outboxCounts()).toEqual({ total: 12, published: 12 });

    const delivered = await queues.drain(queues.urls.events, 12);
    const ids = delivered.map((message) => eventIdOf(message));
    const rows = await db.query<{ id: string }>(`SELECT id FROM outbox_messages`);
    expect(new Set(ids)).toEqual(new Set(rows.map((row) => row.id)));
  });

  test('rows leased by a crashed publisher are taken over after the lease expires', async () => {
    await seedEvents(2);
    // A publisher claimed every row and died without publishing.
    const dead = await uow.transaction((scope) =>
      scope.outbox.claimDue('dead-publisher', 100, 1500),
    );
    expect(dead).toHaveLength(6);

    const survivor = publisher(`instance-b:${newId()}`);
    expect((await survivor.publishOnce()).claimed).toBe(0);
    await Bun.sleep(1600);
    expect(await survivor.publishOnce()).toMatchObject({ claimed: 6, published: 6 });
    expect(await outboxCounts()).toEqual({ total: 6, published: 6 });
  });

  test('a publisher that sent but crashed before marking causes a duplicate send that stays harmless', async () => {
    await seedEvents(3);
    const claimed = await uow.transaction((scope) =>
      scope.outbox.claimDue('crashed-after-send', 100, 1000),
    );
    // The crashed publisher had already sent its batch to SQS.
    await queues.client.send(
      new SendMessageBatchCommand({
        QueueUrl: queues.urls.events,
        Entries: claimed.map((message, index) => ({
          Id: String(index),
          MessageBody: JSON.stringify(message.payload),
          MessageGroupId: message.orderingKey,
          MessageDeduplicationId: message.id,
        })),
      }),
    );
    await Bun.sleep(1100);
    expect(await publisher(`instance-b:${newId()}`).publishOnce()).toMatchObject({
      claimed: claimed.length,
      published: claimed.length,
    });

    // Same eventId, same deduplication id: the FIFO queue keeps a single copy of each event.
    const delivered = await queues.drain(queues.urls.events, claimed.length * 2, 5000);
    const ids = delivered.map((message) => eventIdOf(message));
    expect(ids).toHaveLength(claimed.length);
    expect(new Set(ids).size).toBe(claimed.length);
  });

  test('a lost lease is detected and the stale publisher does not overwrite the new owner', async () => {
    await seedEvents(1);
    const stale = await uow.transaction((scope) => scope.outbox.claimDue('stale', 100, 200));
    await Bun.sleep(300);
    const fresh = await uow.transaction((scope) => scope.outbox.claimDue('fresh', 100, 5000));
    expect(fresh).toHaveLength(stale.length);
    stale[0]!.markPublished(new Date());
    expect(
      await uow.transaction((scope) => scope.outbox.saveDeliveryState(stale[0]!, 'stale')),
    ).toBe(false);
  });

  test('publish failures are retried with backoff', async () => {
    await seedEvents(1);
    const broken = new OutboxPublisher(
      uow,
      new SqsQueues(queues.client, {
        wager: config.sqs.wagerQueueName,
        dlq: config.sqs.wagerDlqName,
        events: `missing-${uniqueSuffix()}.fifo`,
      }),
      {
        owner: 'broken',
        batchSize: 50,
        leaseMs: 1000,
        retry: { baseDelayMs: 300, maxDelayMs: 1000 },
      },
    );
    // The events queue does not exist: every send fails and is rescheduled, nothing is lost.
    const failed = await broken.publishOnce();
    expect(failed).toMatchObject({ claimed: 4, published: 0, failed: 4 });
    const [row] = await db.query<{ attempts: number; deferred: boolean; error: boolean }>(
      `SELECT MIN(attempts)::int AS attempts, BOOL_AND(next_attempt_at > now()) AS deferred,
              BOOL_AND(last_error IS NOT NULL) AS error
         FROM outbox_messages WHERE published_at IS NULL`,
    );
    expect(row).toEqual({ attempts: 1, deferred: true, error: true });

    const healthy = publisher(`healthy:${newId()}`);
    expect((await healthy.publishOnce()).claimed).toBe(0);
    await Bun.sleep(500);
    expect(await healthy.publishOnce()).toMatchObject({ claimed: 4, published: 4 });
    const [attempts] = await db.query<{ attempts: number }>(
      `SELECT MIN(attempts)::int AS attempts FROM outbox_messages`,
    );
    expect(attempts?.attempts).toBe(2);
  });
});
