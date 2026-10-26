import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { metrics } from '../../src/observability/metrics';
import { newId } from '../../src/shared/ids';
import { ApiClient, type WalletBody } from '../support/api-client';
import {
  eventually,
  type RunningApp,
  startApp,
  testConfig,
  TestDatabase,
  TestQueues,
  uniqueSuffix,
} from '../support/environment';

let db: TestDatabase;
const opened: { app?: RunningApp; queues?: TestQueues }[] = [];

beforeAll(async () => {
  db = await TestDatabase.connect();
  await db.reset();
});

afterEach(async () => {
  while (opened.length > 0) {
    const item = opened.pop();
    await item?.app?.close();
    await item?.queues?.destroy();
  }
});

afterAll(async () => {
  expect(await db.inconsistentWallets()).toEqual([]);
  await db.close();
});

async function environment(overrides: Record<string, string> = {}) {
  const config = testConfig(uniqueSuffix(), { SQS_CONSUMER_ENABLED: 'true', ...overrides });
  const queues = await TestQueues.create(config);
  const app = await startApp(config);
  opened.push({ app, queues });
  return { config, queues, app, api: new ApiClient(app.baseUrl) };
}

function betData(wallet: WalletBody, amount: string, extra: Record<string, unknown> = {}) {
  const externalTransactionId = `tx-${newId()}`;
  return {
    providerId: 'provider-a',
    externalTransactionId,
    idempotencyKey: `provider-a:${externalTransactionId}`,
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId: 'round-1',
    gameId: 'fortune-chimp',
    kind: 'BET',
    money: { amount, currency: 'BRL' },
    ...extra,
  };
}

/** Inbox duplicates counted by this process (apps under test run in-process). */
async function inboxDuplicates(): Promise<number> {
  const { values } = await metrics.duplicates.get();
  return values
    .filter((value) => value.labels.type === 'inbox' && value.labels.source === 'sqs')
    .reduce((sum, value) => sum + value.value, 0);
}

async function transactionCount(walletId: string): Promise<number> {
  const [row] = await db.query<{ count: number }>(
    `SELECT COUNT(*)::int AS count FROM wager_transactions WHERE wallet_id = ? AND kind <> 'OPENING'`,
    [walletId],
  );
  return row?.count ?? 0;
}

describe('SQS consumer', () => {
  test('processes a message, records the inbox in the same transaction and acks it', async () => {
    const { queues, api } = await environment();
    const wallet = await api.createWallet('100.00');
    const messageId = `msg-${newId()}`;
    const data = betData(wallet, '30.00');
    await queues.sendWager({ messageId, data });

    await eventually(async () => (await db.walletState(wallet.id)).balance === '70.00');
    const [inbox] = await db.query(
      `SELECT i.consumer_name, t.external_transaction_id, i.processed_at IS NOT NULL AS processed
         FROM inbox_messages i JOIN wager_transactions t ON t.id = i.transaction_id
        WHERE i.message_id = ?`,
      [messageId],
    );
    expect(inbox).toEqual({
      consumer_name: 'wager-transactions-consumer',
      external_transaction_id: data.externalTransactionId,
      processed: true,
    });
    await eventually(async () => {
      const depth = await queues.depth(queues.urls.wager);
      return depth.visible === 0 && depth.inFlight === 0;
    });
  });

  test('redelivered and duplicated messages have no extra effect', async () => {
    const { queues, api } = await environment();
    const wallet = await api.createWallet('100.00');
    const data = betData(wallet, '10.00');
    const messageId = `msg-${newId()}`;
    const inboxDuplicatesBefore = await inboxDuplicates();
    // Same envelope messageId under distinct SQS deduplication ids: the broker delivers both.
    await queues.sendWager({ messageId, data }, { deduplicationId: newId() });
    await queues.sendWager({ messageId, data }, { deduplicationId: newId() });
    // Different messageId, same idempotency key: resolved as an idempotent replay.
    const otherMessageId = `msg-${newId()}`;
    await queues.sendWager({ messageId: otherMessageId, data }, { deduplicationId: newId() });
    // The same operation through HTTP is also a replay: one use case for both entry points.
    const http = await api.submit(
      Object.fromEntries(Object.entries(data).filter(([key]) => key !== 'idempotencyKey')),
      data.idempotencyKey,
    );

    await eventually(async () => {
      const [row] = await db.query<{ count: number }>(
        `SELECT COUNT(*)::int AS count FROM inbox_messages
          WHERE message_id IN (?, ?) AND transaction_id IS NOT NULL`,
        [messageId, otherMessageId],
      );
      const depth = await queues.depth(queues.urls.wager);
      return row?.count === 2 && depth.visible === 0 && depth.inFlight === 0;
    });
    expect(http.status).toBe(201);
    const [linked] = await db.query<{ count: number }>(
      `SELECT COUNT(DISTINCT transaction_id)::int AS count FROM inbox_messages WHERE message_id IN (?, ?)`,
      [messageId, otherMessageId],
    );
    expect(linked?.count).toBe(1);
    // The second delivery of the same message id was stopped by the inbox, before any lock.
    expect((await inboxDuplicates()) - inboxDuplicatesBefore).toBe(1);
    expect(await transactionCount(wallet.id)).toBe(1);
    expect(await db.walletState(wallet.id)).toMatchObject({
      balance: '90.00',
      ledgerBalance: '90.00',
      debits: 1,
    });
  });

  test('business rejections are persisted and acknowledged, not dead-lettered', async () => {
    const { queues, api } = await environment();
    const wallet = await api.createWallet('5.00');
    await queues.sendWager({ messageId: `msg-${newId()}`, data: betData(wallet, '50.00') });
    await eventually(async () => (await transactionCount(wallet.id)) === 1);
    const [row] = await db.query(
      `SELECT status, failure_code FROM wager_transactions WHERE wallet_id = ? AND kind = 'BET'`,
      [wallet.id],
    );
    expect(row).toEqual({ status: 'REJECTED', failure_code: 'INSUFFICIENT_FUNDS' });
    await eventually(async () => (await queues.depth(queues.urls.wager)).inFlight === 0);
    expect(await queues.drain(queues.urls.dlq, 1, 2000)).toHaveLength(0);
  });

  test('permanent errors go to the DLQ with a reason', async () => {
    const { queues, api } = await environment();
    const wallet = await api.createWallet('100.00');
    const conflicting = betData(wallet, '1.00');
    await queues.sendRaw('{not json', 'g1');
    await queues.sendWager({
      messageId: `msg-${newId()}`,
      data: { ...betData(wallet, '1.00'), kind: 'OPENING' },
    });
    await queues.sendWager({
      messageId: `msg-${newId()}`,
      data: betData({ ...wallet, id: newId() }, '1.00'),
    });
    await queues.sendWager({ messageId: `msg-${newId()}`, data: conflicting });
    await queues.sendWager({
      messageId: `msg-${newId()}`,
      data: { ...conflicting, money: { amount: '2.00', currency: 'BRL' } },
    });

    const deadLetters = await queues.drain(queues.urls.dlq, 4, 20000);
    const reasons = deadLetters
      .map((message) => message.MessageAttributes?.deadLetterReason?.StringValue)
      .sort();
    expect(reasons).toEqual([
      'IDEMPOTENCY_KEY_CONFLICT',
      'INVALID_MESSAGE',
      'INVALID_MESSAGE',
      'WALLET_NOT_FOUND',
    ]);
    expect(await transactionCount(wallet.id)).toBe(1);
    expect(await db.walletState(wallet.id)).toMatchObject({ balance: '99.00', debits: 1 });
  });

  test('transient failures are retried with backoff, then dead-lettered after max attempts', async () => {
    const { queues, api } = await environment({
      DATABASE_LOCK_TIMEOUT_MS: '200',
      SQS_MAX_ATTEMPTS: '2',
    });
    const wallet = await api.createWallet('100.00');

    // Hold the wallet row lock from another connection: every attempt hits lock_timeout (55P03).
    let release: () => void = () => undefined;
    const holding = db.orm.em.fork().transactional(async (em) => {
      await em.execute('SELECT id FROM wallets WHERE id = ? FOR UPDATE', [wallet.id]);
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    });
    await Bun.sleep(200);

    const blocked = betData(wallet, '10.00');
    await queues.sendWager({ messageId: `msg-${newId()}`, data: blocked });
    const deadLetters = await queues.drain(queues.urls.dlq, 1, 30000);
    release();
    await holding;

    expect(deadLetters).toHaveLength(1);
    expect(deadLetters[0]?.MessageAttributes?.deadLetterReason?.StringValue).toBe(
      'MAX_ATTEMPTS_EXCEEDED',
    );
    expect(deadLetters[0]?.MessageAttributes?.receiveCount?.StringValue).toBe('2');
    expect(await transactionCount(wallet.id)).toBe(0);
    expect(await db.walletState(wallet.id)).toMatchObject({ balance: '100.00', entries: 1 });
  }, 60000);

  test('a transient failure that clears is processed on retry', async () => {
    const { queues, api } = await environment({
      DATABASE_LOCK_TIMEOUT_MS: '200',
      SQS_MAX_ATTEMPTS: '5',
    });
    const wallet = await api.createWallet('100.00');
    let release: () => void = () => undefined;
    const holding = db.orm.em.fork().transactional(async (em) => {
      await em.execute('SELECT id FROM wallets WHERE id = ? FOR UPDATE', [wallet.id]);
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    });
    await Bun.sleep(200);
    await queues.sendWager({ messageId: `msg-${newId()}`, data: betData(wallet, '10.00') });
    await Bun.sleep(2500);
    expect(await transactionCount(wallet.id)).toBe(0);
    release();
    await holding;
    await eventually(async () => (await db.walletState(wallet.id)).balance === '90.00', 20000);
    expect(await queues.drain(queues.urls.dlq, 1, 1000)).toHaveLength(0);
  }, 60000);

  test('graceful shutdown leaves no message stuck in flight and a new instance finishes the work', async () => {
    const { queues, api, config } = await environment();
    const wallets = [await api.createWallet('1000.00'), await api.createWallet('1000.00')];
    const total = 30;
    for (let i = 0; i < total; i++) {
      const wallet = wallets[i % 2]!;
      await queues.sendWager({ messageId: `msg-${newId()}`, data: betData(wallet, '1.00') });
    }
    await eventually(async () => (await transactionCount(wallets[0]!.id)) > 0);
    const first = opened.pop()!;
    await first.app!.close();
    const processedAtClose =
      (await transactionCount(wallets[0]!.id)) + (await transactionCount(wallets[1]!.id));
    // The shutdown must happen with work left, otherwise the scenario is not exercised.
    expect(processedAtClose).toBeLessThan(total);
    const depth = await queues.depth(queues.urls.wager);
    expect(depth.inFlight).toBe(0);

    const second = await startApp(config);
    opened.push({ app: second, queues });
    await eventually(
      async () =>
        (await transactionCount(wallets[0]!.id)) + (await transactionCount(wallets[1]!.id)) ===
        total,
      30000,
    );
    for (const wallet of wallets) {
      const state = await db.walletState(wallet.id);
      expect(state.balance).toBe(state.ledgerBalance);
      expect(state.debits).toBe(total / 2);
      expect(state.balance).toBe('985.00');
    }
  }, 60000);
});
