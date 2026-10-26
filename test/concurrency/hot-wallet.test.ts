import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { ApiClient } from '../support/api-client';
import {
  type RunningApp,
  startApp,
  testConfig,
  TestDatabase,
  TestQueues,
  uniqueSuffix,
} from '../support/environment';

let db: TestDatabase;
let queues: TestQueues;
let running: RunningApp;
let api: ApiClient;

beforeAll(async () => {
  db = await TestDatabase.connect();
  await db.reset();
  // The in-memory wallet gate is off so that concurrent requests reach PostgreSQL together and
  // the tests exercise the database row lock itself, not the per-process queue in front of it.
  const config = testConfig(uniqueSuffix(), {
    DATABASE_POOL_MAX: '40',
    WALLET_GATE_ENABLED: 'false',
  });
  queues = await TestQueues.create(config);
  running = await startApp(config);
  api = new ApiClient(running.baseUrl);
});

afterAll(async () => {
  await running.close();
  await queues.destroy();
  expect(await db.inconsistentWallets()).toEqual([]);
  await db.close();
});

describe('concurrency on a single wallet', () => {
  test('the same BET sent 50 times in parallel debits exactly once', async () => {
    const wallet = await api.createWallet('100.00');
    const { key, payload } = ApiClient.transaction({
      playerId: wallet.playerId,
      walletId: wallet.id,
      kind: 'BET',
      money: { amount: '10.00', currency: 'BRL' },
    });

    const responses = await Promise.all(Array.from({ length: 50 }, () => api.submit(payload, key)));

    expect(responses.map((r) => r.status)).toEqual(Array<number>(50).fill(201));
    expect(new Set(responses.map((r) => r.body.transactionId)).size).toBe(1);
    expect(responses.filter((r) => !r.body.idempotentReplay)).toHaveLength(1);
    // Every replay returns the balance observed by the original processing.
    expect(new Set(responses.map((r) => r.body.balance?.amount))).toEqual(new Set(['90.00']));

    const state = await db.walletState(wallet.id);
    expect(state).toMatchObject({
      balance: '90.00',
      ledgerBalance: '90.00',
      debits: 1,
      version: 2,
    });
    const [count] = await db.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM wager_transactions WHERE idempotency_key = ?`,
      [key],
    );
    expect(count?.count).toBe(1);
  });

  test('two concurrent BETs of 80.00 on 100.00: one PROCESSED, one REJECTED, balance 20.00', async () => {
    // Repeated on independent wallets to exercise many interleavings.
    const rounds = 20;
    const wallets = await Promise.all(
      Array.from({ length: rounds }, () => api.createWallet('100.00')),
    );
    const results = await Promise.all(
      wallets.map(async (wallet) => {
        const bets = [0, 1].map(() =>
          ApiClient.transaction({
            playerId: wallet.playerId,
            walletId: wallet.id,
            kind: 'BET',
            money: { amount: '80.00', currency: 'BRL' },
          }),
        );
        const responses = await Promise.all(bets.map((bet) => api.submit(bet.payload, bet.key)));
        // Provider retries of both requests must not duplicate the debit.
        const retries = await Promise.all(bets.map((bet) => api.submit(bet.payload, bet.key)));
        return { wallet, responses, retries };
      }),
    );

    for (const { wallet, responses, retries } of results) {
      const statuses = responses.map((r) => r.body.status).sort();
      expect(statuses).toEqual(['PROCESSED', 'REJECTED']);
      expect(responses.find((r) => r.body.status === 'REJECTED')?.body.failureCode).toBe(
        'INSUFFICIENT_FUNDS',
      );
      expect(responses.map((r) => r.status).sort()).toEqual([201, 422]);
      expect(retries.every((r) => r.body.idempotentReplay)).toBe(true);
      expect(retries.map((r) => r.body.status).sort()).toEqual(['PROCESSED', 'REJECTED']);

      const state = await db.walletState(wallet.id);
      expect(state).toMatchObject({
        balance: '20.00',
        ledgerBalance: '20.00',
        debits: 1,
        version: 2,
      });
    }
  });

  test('200 concurrent BETs of 1.00 on 100.00: exactly 100 accepted, balance never negative', async () => {
    const wallet = await api.createWallet('100.00');
    const responses = await Promise.all(
      Array.from({ length: 200 }, () =>
        api.submitInput({
          playerId: wallet.playerId,
          walletId: wallet.id,
          kind: 'BET',
          money: { amount: '1.00', currency: 'BRL' },
        }),
      ),
    );
    expect(responses.filter((r) => r.body.status === 'PROCESSED')).toHaveLength(100);
    expect(responses.filter((r) => r.body.failureCode === 'INSUFFICIENT_FUNDS')).toHaveLength(100);
    expect(responses.every((r) => r.status === 201 || r.status === 422)).toBe(true);
    const state = await db.walletState(wallet.id);
    expect(state).toMatchObject({
      balance: '0.00',
      ledgerBalance: '0.00',
      debits: 100,
      version: 101,
    });

    // The ledger chain is gap-free and every step is arithmetically consistent.
    const chain = await db.query<{ ok: boolean }>(
      `SELECT bool_and(prev_after IS NULL OR prev_after = balance_before) AS ok FROM (
         SELECT balance_before, LAG(balance_after) OVER (ORDER BY wallet_version) AS prev_after
           FROM wallet_ledger_entries WHERE wallet_id = ?) chain`,
      [wallet.id],
    );
    expect(chain[0]?.ok).toBe(true);
  });
});

describe('concurrency across wallets', () => {
  test('different wallets are processed in parallel without interference', async () => {
    const walletCount = 25;
    const operationsPerWallet = 20;
    const wallets = await Promise.all(
      Array.from({ length: walletCount }, () => api.createWallet('100.00')),
    );
    const startedAt = performance.now();
    await Promise.all(
      wallets.flatMap((wallet) =>
        Array.from({ length: operationsPerWallet }, (_, i) =>
          api.submitInput({
            playerId: wallet.playerId,
            walletId: wallet.id,
            kind: i % 2 === 0 ? 'BET' : 'WIN',
            money: { amount: i % 2 === 0 ? '3.00' : '1.50', currency: 'BRL' },
          }),
        ),
      ),
    );
    const elapsedMs = performance.now() - startedAt;

    for (const wallet of wallets) {
      const state = await db.walletState(wallet.id);
      // 10 bets of 3.00 and 10 wins of 1.50.
      expect(state).toMatchObject({
        balance: '85.00',
        ledgerBalance: '85.00',
        debits: 10,
        credits: 11,
        version: 21,
      });
    }
    expect(elapsedMs).toBeLessThan(60000);
  });
});
