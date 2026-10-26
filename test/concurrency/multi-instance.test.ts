import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { ProcessWagerTransaction } from '../../src/application/use-cases/process-wager-transaction';
import { CreateWallet } from '../../src/application/use-cases/wallets';
import { WagerTransactionKind } from '../../src/domain/wager-transaction';
import { MikroOrmUnitOfWork } from '../../src/infrastructure/database/mikro-orm-unit-of-work';
import { OutboxPublisher } from '../../src/infrastructure/messaging/outbox-publisher';
import { SqsQueues } from '../../src/infrastructure/messaging/sqs';
import { newId } from '../../src/shared/ids';
import { ApiClient, type WalletBody } from '../support/api-client';
import {
  eventually,
  testConfig,
  TestDatabase,
  testEnv,
  TestQueues,
  uniqueSuffix,
} from '../support/environment';
import { type ChildProcess, spawnApp, spawnScript } from '../support/processes';
import { eventIdOf } from '../support/assertions';

let db: TestDatabase;
const children: ChildProcess[] = [];
const queueSets: TestQueues[] = [];

beforeAll(async () => {
  db = await TestDatabase.connect();
  await db.reset();
});

afterEach(async () => {
  await Promise.all(children.splice(0).map((child) => child.kill()));
  await Promise.all(queueSets.splice(0).map((queues) => queues.destroy()));
});

afterAll(async () => {
  expect(await db.inconsistentWallets()).toEqual([]);
  await db.close();
});

async function queuesFor(env: Record<string, string>): Promise<TestQueues> {
  const queues = await TestQueues.create(testConfig('unused', env));
  queueSets.push(queues);
  return queues;
}

async function spawn(env: Record<string, string>) {
  const child = await spawnApp(env);
  children.push(child);
  return child;
}

function messageData(
  wallet: Pick<WalletBody, 'id' | 'playerId'>,
  kind: string,
  amount: string,
  extra: Record<string, string> = {},
) {
  const externalTransactionId = extra.externalTransactionId ?? `tx-${newId()}`;
  return {
    providerId: 'provider-a',
    externalTransactionId,
    idempotencyKey: `provider-a:${externalTransactionId}`,
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId: extra.roundId ?? 'round-1',
    gameId: 'fortune-chimp',
    kind,
    money: { amount, currency: 'BRL' },
    ...(extra.referenceExternalTransactionId
      ? { referenceExternalTransactionId: extra.referenceExternalTransactionId }
      : {}),
  };
}

async function countTransactions(walletId: string): Promise<number> {
  const [row] = await db.query<{ count: number }>(
    `SELECT COUNT(*)::int AS count FROM wager_transactions WHERE wallet_id = ? AND kind <> 'OPENING'`,
    [walletId],
  );
  return row?.count ?? 0;
}

describe('multiple instances', () => {
  test('three processes share a hot wallet over HTTP and SQS without duplicates or lost updates', async () => {
    const env = testEnv(uniqueSuffix(), {
      SQS_CONSUMER_ENABLED: 'true',
      OUTBOX_PUBLISHER_ENABLED: 'true',
      PENDING_REFERENCE_WORKER_ENABLED: 'true',
    });
    const queues = await queuesFor(env);
    const instances = await Promise.all(
      [1, 2, 3].map((n) => spawn({ ...env, INSTANCE_ID: `i${n}` })),
    );
    const clients = instances.map((instance) => new ApiClient(instance.baseUrl));

    const hot = await clients[0]!.createWallet('500.00');
    const others = await Promise.all([
      clients[1]!.createWallet('100.00'),
      clients[2]!.createWallet('100.00'),
    ]);

    // 60 distinct BETs of 5.00 on the hot wallet; each is sent to all three instances at once.
    const bets = Array.from({ length: 60 }, () =>
      ApiClient.transaction({
        playerId: hot.playerId,
        walletId: hot.id,
        kind: 'BET',
        money: { amount: '5.00', currency: 'BRL' },
      }),
    );
    const httpRequests = bets.flatMap((bet) =>
      clients.map((client) => client.submit(bet.payload, bet.key)),
    );
    // Meanwhile, 40 BETs of 1.00 for the other wallets arrive through the queue, each delivered twice.
    const queued = others.flatMap((wallet) =>
      Array.from({ length: 20 }, () => messageData(wallet, 'BET', '1.00')),
    );
    const queueSends = queued.flatMap((data) => {
      const messageId = `msg-${newId()}`;
      return [
        queues.sendWager({ messageId, data }, { deduplicationId: newId() }),
        queues.sendWager({ messageId, data }, { deduplicationId: newId() }),
      ];
    });
    const responses = await Promise.all(httpRequests);
    await Promise.all(queueSends);

    expect(responses.every((r) => r.status === 201)).toBe(true);
    for (const bet of bets) {
      const ids = new Set(
        responses
          .filter((r, index) => bets[Math.floor(index / 3)] === bet && r.body.transactionId)
          .map((r) => r.body.transactionId),
      );
      expect(ids.size).toBe(1);
    }
    expect(responses.filter((r) => !r.body.idempotentReplay)).toHaveLength(60);

    await eventually(async () => {
      const counts = await Promise.all(others.map((wallet) => countTransactions(wallet.id)));
      return counts.every((count) => count === 20);
    }, 60000);
    await eventually(async () => {
      const depth = await queues.depth(queues.urls.wager);
      return depth.visible === 0 && depth.inFlight === 0;
    }, 30000);

    expect(await db.walletState(hot.id)).toMatchObject({
      balance: '200.00',
      ledgerBalance: '200.00',
      debits: 60,
      version: 61,
    });
    for (const wallet of others) {
      expect(await db.walletState(wallet.id)).toMatchObject({
        balance: '80.00',
        ledgerBalance: '80.00',
        debits: 20,
      });
    }

    // Three publishers drained the outbox; every event reached the events queue exactly once.
    await eventually(async () => {
      const [row] = await db.query<{ pending: number }>(
        `SELECT COUNT(*)::int AS pending FROM outbox_messages WHERE published_at IS NULL`,
      );
      return row?.pending === 0;
    }, 30000);
    const [outbox] = await db.query<{ total: number }>(
      `SELECT COUNT(*)::int AS total FROM outbox_messages`,
    );
    const delivered = await queues.drain(queues.urls.events, outbox!.total, 30000);
    const eventIds = delivered.map((message) => eventIdOf(message));
    expect(eventIds).toHaveLength(outbox!.total);
    expect(new Set(eventIds).size).toBe(outbox!.total);
  }, 180000);

  test('a worker killed after commit and before ack causes no duplicate effect on redelivery', async () => {
    const env = testEnv(uniqueSuffix(), {
      SQS_CONSUMER_ENABLED: 'true',
      SQS_VISIBILITY_TIMEOUT_SECONDS: '3',
    });
    const queues = await queuesFor(env);
    const createWallet = new CreateWallet(new MikroOrmUnitOfWork(db.orm, 5000), ['BRL']);
    const wallet = await createWallet.execute(
      { playerId: `p-${newId()}`, initialBalance: { amount: '100.00', currency: 'BRL' } },
      'test',
    );
    const messageId = `msg-${newId()}`;
    const data = messageData(wallet, 'BET', '40.00');
    await queues.sendWager({ messageId, data });

    const crashing = spawnScript('test/fixtures/crash-after-commit-worker.ts', env);
    children.push(crashing);
    await crashing.proc.exited;
    expect(crashing.proc.signalCode ?? crashing.proc.exitCode).not.toBe(0);

    // The effect is committed, the inbox recorded it, but SQS never received the ack.
    expect(await db.walletState(wallet.id)).toMatchObject({ balance: '60.00', debits: 1 });
    expect(
      await db.query(`SELECT 1 FROM inbox_messages WHERE message_id = ?`, [messageId]),
    ).toHaveLength(1);
    const depth = await queues.depth(queues.urls.wager);
    expect(depth.visible + depth.inFlight).toBe(1);

    // A healthy instance receives the redelivery after the visibility timeout and acks it.
    await spawn(env);
    await eventually(async () => {
      const current = await queues.depth(queues.urls.wager);
      return current.visible === 0 && current.inFlight === 0;
    }, 30000);
    expect(await db.walletState(wallet.id)).toMatchObject({
      balance: '60.00',
      ledgerBalance: '60.00',
      debits: 1,
    });
    expect(await countTransactions(wallet.id)).toBe(1);
    expect(await queues.drain(queues.urls.dlq, 1, 1000)).toHaveLength(0);
  }, 90000);

  test('two publishers on the same outbox publish every event once', async () => {
    const config = testConfig(uniqueSuffix());
    const queues = await queuesFor(
      testEnv(uniqueSuffix(), {
        SQS_WAGER_QUEUE_NAME: config.sqs.wagerQueueName,
        SQS_WAGER_DLQ_NAME: config.sqs.wagerDlqName,
        SQS_EVENTS_QUEUE_NAME: config.sqs.eventsQueueName,
      }),
    );
    const uow = new MikroOrmUnitOfWork(db.orm, 5000);
    const createWallet = new CreateWallet(uow, ['BRL']);
    const processWager = new ProcessWagerTransaction(uow, { baseDelayMs: 100, maxDelayMs: 400 });
    await db.query(
      `UPDATE outbox_messages SET published_at = now(), locked_by = NULL WHERE published_at IS NULL`,
    );

    const wallets = await Promise.all(
      Array.from({ length: 10 }, () =>
        createWallet.execute(
          { playerId: `p-${newId()}`, initialBalance: { amount: '1000.00', currency: 'BRL' } },
          'test',
        ),
      ),
    );
    await Promise.all(
      wallets.flatMap((wallet) =>
        Array.from({ length: 15 }, () => {
          const externalTransactionId = `tx-${newId()}`;
          return processWager.execute(
            {
              idempotencyKey: `p:${externalTransactionId}`,
              providerId: 'p',
              externalTransactionId,
              playerId: wallet.playerId,
              walletId: wallet.id,
              roundId: 'r',
              gameId: 'g',
              kind: WagerTransactionKind.Bet,
              money: { amount: '1.00', currency: 'BRL' },
            },
            { source: 'http', correlationId: 'c' },
          );
        }),
      ),
    );
    const [pending] = await db.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM outbox_messages WHERE published_at IS NULL`,
    );
    const total = pending!.count;
    expect(total).toBe(10 * 2 + 10 * 15 * 2);

    const sqs = new SqsQueues(queues.client, {
      wager: config.sqs.wagerQueueName,
      dlq: config.sqs.wagerDlqName,
      events: config.sqs.eventsQueueName,
    });
    const publishers = ['a', 'b'].map(
      (name) =>
        new OutboxPublisher(uow, sqs, {
          owner: `publisher-${name}:${newId()}`,
          batchSize: 20,
          leaseMs: 10000,
          retry: { baseDelayMs: 100, maxDelayMs: 400 },
        }),
    );
    const published = [0, 0];
    await Promise.all(
      publishers.map(async (publisher, index) => {
        for (;;) {
          const summary = await publisher.publishOnce();
          published[index]! += summary.published;
          expect(summary.leaseLost).toBe(0);
          if (summary.claimed === 0) return;
        }
      }),
    );

    expect(published[0]! + published[1]!).toBe(total);
    // Both publishers took part in the work.
    expect(published[0]).toBeGreaterThan(0);
    expect(published[1]).toBeGreaterThan(0);
    const [row] = await db.query<{ count: number; max_attempts: number }>(
      `SELECT COUNT(*)::int AS count, MAX(attempts)::int AS max_attempts FROM outbox_messages WHERE published_at IS NOT NULL
         AND ordering_key IN (${wallets.map(() => '?').join(',')})`,
      wallets.map((wallet) => wallet.id),
    );
    expect(row).toEqual({ count: total, max_attempts: 1 });
    const delivered = await queues.drain(queues.urls.events, total, 30000);
    const ids = delivered.map((message) => eventIdOf(message));
    expect(ids).toHaveLength(total);
    expect(new Set(ids).size).toBe(total);
  }, 120000);

  test('REFUND and ROLLBACK delivered before their references converge across instances', async () => {
    const env = testEnv(uniqueSuffix(), {
      SQS_CONSUMER_ENABLED: 'true',
      PENDING_REFERENCE_WORKER_ENABLED: 'true',
    });
    const queues = await queuesFor(env);
    const instances = await Promise.all([1, 2].map((n) => spawn({ ...env, INSTANCE_ID: `r${n}` })));
    const api = new ApiClient(instances[0]!.baseUrl);
    const wallet = await api.createWallet('100.00');

    const rounds = 15;
    const sends: Promise<unknown>[] = [];
    for (let i = 0; i < rounds; i++) {
      const roundId = `round-${i}`;
      const betId = `bet-${newId()}`;
      const reversalKind = i % 2 === 0 ? 'REFUND' : 'ROLLBACK';
      const reversal = messageData(wallet, reversalKind, '4.00', {
        roundId,
        referenceExternalTransactionId: betId,
      });
      const bet = messageData(wallet, 'BET', '4.00', { roundId, externalTransactionId: betId });
      // The reversal goes first through the queue; the BET arrives later through HTTP.
      sends.push(
        queues.sendWager({ messageId: `msg-${newId()}`, data: reversal }).then(async () => {
          await Bun.sleep(150);
          const { idempotencyKey, ...payload } = bet;
          return new ApiClient(instances[i % 2]!.baseUrl).submit(payload, idempotencyKey);
        }),
      );
    }
    await Promise.all(sends);

    await eventually(async () => {
      const [row] = await db.query<{ settled: number }>(
        `SELECT COUNT(*)::int AS settled FROM wager_transactions
          WHERE wallet_id = ? AND kind IN ('REFUND', 'ROLLBACK') AND status = 'PROCESSED'`,
        [wallet.id],
      );
      return row?.settled === rounds;
    }, 60000);
    const [pendingHistory] = await db.query<{ count: number }>(
      `SELECT COUNT(DISTINCT aggregate_id)::int AS count FROM outbox_messages
        WHERE event_type = 'WagerTransactionPendingReference' AND ordering_key = ?`,
      [wallet.id],
    );
    // At least some reversals really arrived before their BET.
    expect(pendingHistory!.count).toBeGreaterThan(0);
    expect(await db.walletState(wallet.id)).toMatchObject({
      balance: '100.00',
      ledgerBalance: '100.00',
      debits: rounds,
      credits: rounds + 1,
    });
  }, 120000);

  test('restart after a hard kill: retried requests settle once and committed events are published', async () => {
    const env = testEnv(uniqueSuffix());
    const queues = await queuesFor(env);
    const first = await spawn({
      ...env,
      INSTANCE_ID: 'before-crash',
      OUTBOX_PUBLISHER_ENABLED: 'false',
    });
    const api = new ApiClient(first.baseUrl);
    const wallet = await api.createWallet('1000.00');
    const total = 400;
    const bets = Array.from({ length: total }, () =>
      ApiClient.transaction({
        playerId: wallet.playerId,
        walletId: wallet.id,
        kind: 'BET',
        money: { amount: '1.25', currency: 'BRL' },
      }),
    );

    // Kill the process while requests are in flight; some commit, some never reach the database.
    const inFlight = bets.map((bet) => api.submit(bet.payload, bet.key).catch(() => undefined));
    await eventually(async () => (await countTransactions(wallet.id)) >= 10, 30000, 5);
    await first.kill();
    await Promise.all(inFlight);
    const committedBeforeRestart = await countTransactions(wallet.id);
    expect(committedBeforeRestart).toBeGreaterThanOrEqual(10);
    expect(committedBeforeRestart).toBeLessThan(total);
    // Nothing is left half-written by the killed process.
    expect(await db.walletState(wallet.id)).toMatchObject({
      debits: committedBeforeRestart,
      version: committedBeforeRestart + 1,
    });
    const [unpublished] = await db.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM outbox_messages WHERE published_at IS NULL AND ordering_key = ?`,
      [wallet.id],
    );
    expect(unpublished?.count).toBe(2 + committedBeforeRestart * 2);

    const second = await spawn({
      ...env,
      INSTANCE_ID: 'after-restart',
      OUTBOX_PUBLISHER_ENABLED: 'true',
    });
    const retryClient = new ApiClient(second.baseUrl);
    const retried = await Promise.all(bets.map((bet) => retryClient.submit(bet.payload, bet.key)));
    expect(retried.every((r) => r.status === 201)).toBe(true);
    expect(retried.filter((r) => r.body.idempotentReplay).length).toBe(committedBeforeRestart);

    expect(await countTransactions(wallet.id)).toBe(total);
    expect(await db.walletState(wallet.id)).toMatchObject({
      balance: '500.00',
      ledgerBalance: '500.00',
      debits: total,
      version: total + 1,
    });
    // Events committed by the killed process are published by the new one.
    await eventually(async () => {
      const [row] = await db.query<{ pending: number }>(
        `SELECT COUNT(*)::int AS pending FROM outbox_messages WHERE published_at IS NULL AND ordering_key = ?`,
        [wallet.id],
      );
      return row?.pending === 0;
    }, 30000);
    // The new instance publishes the whole outbox, including events left pending by earlier tests.
    const [published] = await db.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM outbox_messages WHERE published_at > now() - interval '5 minutes'`,
    );
    const delivered = await queues.drain(queues.urls.events, published!.count, 30000);
    const walletEvents = delivered.filter((m) => m.Attributes?.MessageGroupId === wallet.id);
    const ids = walletEvents.map((m) => eventIdOf(m));
    expect(ids).toHaveLength(2 + total * 2);
    expect(new Set(ids).size).toBe(2 + total * 2);
  }, 120000);
});
