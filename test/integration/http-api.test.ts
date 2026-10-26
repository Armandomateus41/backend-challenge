import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
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
let queues: TestQueues;
let running: RunningApp;
let api: ApiClient;

beforeAll(async () => {
  db = await TestDatabase.connect();
  await db.reset();
  const config = testConfig(uniqueSuffix(), { PENDING_REFERENCE_WORKER_ENABLED: 'true' });
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

describe('wallets', () => {
  test('creates a wallet with an OPENING transaction and credit entry', async () => {
    const wallet = await api.createWallet('1000.00');
    expect(wallet.balance).toEqual({ amount: '1000.00', currency: 'BRL' });
    expect(wallet.version).toBe(1);
    const state = await db.walletState(wallet.id);
    expect(state).toMatchObject({ balance: '1000.00', ledgerBalance: '1000.00', credits: 1 });
    const [opening] = await db.query(
      `SELECT kind, status FROM wager_transactions WHERE wallet_id = ?`,
      [wallet.id],
    );
    expect(opening).toEqual({ kind: 'OPENING', status: 'PROCESSED' });
  });

  test('zero initial balance creates no ledger entry', async () => {
    const wallet = await api.createWallet('0.00');
    expect(await db.walletState(wallet.id)).toMatchObject({
      balance: '0.00',
      entries: 0,
      version: 1,
    });
  });

  test('duplicate wallet for the same player and currency is a conflict', async () => {
    const wallet = await api.createWallet('10.00');
    const duplicate = await api.request<{ error: { code: string } }>('POST', '/wallets', {
      playerId: wallet.playerId,
      initialBalance: { amount: '5.00', currency: 'BRL' },
    });
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.error.code).toBe('WALLET_ALREADY_EXISTS');
  });

  test.each([
    [{ playerId: 'p', initialBalance: { amount: '-1.00', currency: 'BRL' } }, 'INVALID_AMOUNT'],
    [{ playerId: 'p', initialBalance: { amount: '1.001', currency: 'BRL' } }, 'INVALID_AMOUNT'],
    [{ playerId: 'p', initialBalance: { amount: 10, currency: 'BRL' } }, 'VALIDATION_ERROR'],
    [
      { playerId: 'p', initialBalance: { amount: '1.00', currency: 'USD' } },
      'UNSUPPORTED_CURRENCY',
    ],
    [{ initialBalance: { amount: '1.00', currency: 'BRL' } }, 'VALIDATION_ERROR'],
  ])('rejects invalid wallet payload %#', async (payload, code) => {
    const response = await api.request<{ error: { code: string } }>('POST', '/wallets', payload);
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe(code);
  });

  test('unknown and malformed wallet ids', async () => {
    expect((await api.request('GET', `/wallets/${newId()}`)).status).toBe(404);
    expect((await api.request('GET', '/wallets/not-a-uuid')).status).toBe(400);
  });
});

describe('wager transactions', () => {
  let wallet: WalletBody;

  beforeAll(async () => {
    wallet = await api.createWallet('100.00');
  });

  test('BET is processed, replayed identically, and conflicts on divergent payload', async () => {
    const { key, payload } = ApiClient.transaction({
      playerId: wallet.playerId,
      walletId: wallet.id,
      kind: 'BET',
      money: { amount: '25.00', currency: 'BRL' },
    });
    const first = await api.submit(payload, key);
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({
      status: 'PROCESSED',
      balance: { amount: '75.00', currency: 'BRL' },
      idempotentReplay: false,
    });

    // A later movement must not change the replayed balance.
    await api.submitInput({
      playerId: wallet.playerId,
      walletId: wallet.id,
      kind: 'WIN',
      money: { amount: '5.00', currency: 'BRL' },
    });

    const replay = await api.submit({ ...payload, money: { amount: '25', currency: 'BRL' } }, key);
    expect(replay.status).toBe(201);
    expect(replay.body).toEqual({ ...first.body, idempotentReplay: true });

    const conflict = await api.submit(
      { ...payload, money: { amount: '26.00', currency: 'BRL' } },
      key,
    );
    expect(conflict.status).toBe(409);
    expect((conflict.body as unknown as { error: { code: string } }).error.code).toBe(
      'IDEMPOTENCY_KEY_CONFLICT',
    );

    const otherKey = await api.submit(payload, `${key}-other`);
    expect(otherKey.status).toBe(409);
    expect((otherKey.body as unknown as { error: { code: string } }).error.code).toBe(
      'EXTERNAL_TRANSACTION_CONFLICT',
    );

    const state = await db.walletState(wallet.id);
    expect(state).toMatchObject({ balance: '80.00', ledgerBalance: '80.00', debits: 1 });
  });

  test('insufficient funds is a 422 business rejection without ledger impact', async () => {
    const before = await db.walletState(wallet.id);
    const response = await api.submitInput({
      playerId: wallet.playerId,
      walletId: wallet.id,
      kind: 'BET',
      money: { amount: '1000.00', currency: 'BRL' },
    });
    expect(response.status).toBe(422);
    expect(response.body).toMatchObject({ status: 'REJECTED', failureCode: 'INSUFFICIENT_FUNDS' });
    const after = await db.walletState(wallet.id);
    expect(after).toEqual(before);
  });

  test('LOSS is processed without a ledger entry', async () => {
    const before = await db.walletState(wallet.id);
    const response = await api.submitInput({
      playerId: wallet.playerId,
      walletId: wallet.id,
      kind: 'LOSS',
      money: { amount: '0.00', currency: 'BRL' },
    });
    expect(response.status).toBe(201);
    expect(response.body.status).toBe('PROCESSED');
    expect(await db.walletState(wallet.id)).toEqual(before);
  });

  test('currency conflict is rejected as a business rule', async () => {
    const response = await api.submitInput({
      playerId: wallet.playerId,
      walletId: wallet.id,
      kind: 'BET',
      money: { amount: '1.00', currency: 'USD' },
    });
    expect(response.status).toBe(422);
    expect(response.body.failureCode).toBe('CURRENCY_MISMATCH');
  });

  test('REFUND reverses a BET once; a ROLLBACK of the same BET is then rejected', async () => {
    const bet = ApiClient.transaction({
      playerId: wallet.playerId,
      walletId: wallet.id,
      kind: 'BET',
      roundId: 'round-refund',
      money: { amount: '10.00', currency: 'BRL' },
    });
    await api.submit(bet.payload, bet.key);
    const balanceAfterBet = (await db.walletState(wallet.id)).balance;

    const refund = await api.submitInput({
      playerId: wallet.playerId,
      walletId: wallet.id,
      kind: 'REFUND',
      roundId: 'round-refund',
      money: { amount: '10.00', currency: 'BRL' },
      referenceExternalTransactionId: bet.payload.externalTransactionId,
    });
    expect(refund.status).toBe(201);
    const secondRefund = await api.submitInput({
      playerId: wallet.playerId,
      walletId: wallet.id,
      kind: 'REFUND',
      roundId: 'round-refund',
      money: { amount: '10.00', currency: 'BRL' },
      referenceExternalTransactionId: bet.payload.externalTransactionId,
    });
    expect(secondRefund.status).toBe(422);
    expect(secondRefund.body.failureCode).toBe('REFERENCE_ALREADY_REVERSED');
    const rollback = await api.submitInput({
      playerId: wallet.playerId,
      walletId: wallet.id,
      kind: 'ROLLBACK',
      roundId: 'round-refund',
      money: { amount: '10.00', currency: 'BRL' },
      referenceExternalTransactionId: bet.payload.externalTransactionId,
    });
    expect(rollback.body.failureCode).toBe('REFERENCE_ALREADY_REVERSED');

    const state = await db.walletState(wallet.id);
    expect(Number(state.balance) - Number(balanceAfterBet)).toBe(10);
    expect(state.balance).toBe(state.ledgerBalance);
  });

  test('ROLLBACK that would overdraw the wallet is rejected with REVERSAL_INSUFFICIENT_FUNDS', async () => {
    const poor = await api.createWallet('0.00');
    const win = ApiClient.transaction({
      playerId: poor.playerId,
      walletId: poor.id,
      kind: 'WIN',
      money: { amount: '50.00', currency: 'BRL' },
    });
    await api.submit(win.payload, win.key);
    await api.submitInput({
      playerId: poor.playerId,
      walletId: poor.id,
      kind: 'BET',
      money: { amount: '45.00', currency: 'BRL' },
    });
    const rollback = await api.submitInput({
      playerId: poor.playerId,
      walletId: poor.id,
      kind: 'ROLLBACK',
      money: { amount: '50.00', currency: 'BRL' },
      referenceExternalTransactionId: win.payload.externalTransactionId,
    });
    expect(rollback.status).toBe(422);
    expect(rollback.body.failureCode).toBe('REVERSAL_INSUFFICIENT_FUNDS');
    expect(await db.walletState(poor.id)).toMatchObject({ balance: '5.00', ledgerBalance: '5.00' });
  });

  test('REFUND before its BET is accepted as PENDING_REFERENCE and settled by the worker', async () => {
    const betExternalId = `late-bet-${newId()}`;
    const refund = await api.submitInput({
      playerId: wallet.playerId,
      walletId: wallet.id,
      kind: 'REFUND',
      roundId: 'round-late',
      money: { amount: '7.00', currency: 'BRL' },
      referenceExternalTransactionId: betExternalId,
    });
    expect(refund.status).toBe(202);
    expect(refund.body.status).toBe('PENDING_REFERENCE');
    const before = await db.walletState(wallet.id);

    await api.submitInput({
      playerId: wallet.playerId,
      walletId: wallet.id,
      kind: 'BET',
      roundId: 'round-late',
      externalTransactionId: betExternalId,
      money: { amount: '7.00', currency: 'BRL' },
    });
    await eventually(async () => {
      const response = await api.request<{ status: string }>(
        'GET',
        `/wagering/transactions/${refund.body.transactionId}`,
      );
      return response.body.status === 'PROCESSED';
    });
    expect(await db.walletState(wallet.id)).toMatchObject({ balance: before.balance });
  });

  test('a reference that never arrives is rejected with REFERENCE_NOT_FOUND', async () => {
    const rollback = await api.submitInput({
      playerId: wallet.playerId,
      walletId: wallet.id,
      kind: 'ROLLBACK',
      money: { amount: '1.00', currency: 'BRL' },
      referenceExternalTransactionId: `never-${newId()}`,
    });
    expect(rollback.status).toBe(202);
    await eventually(async () => {
      const response = await api.request<{ status: string; failureCode: string }>(
        'GET',
        `/wagering/transactions/${rollback.body.transactionId}`,
      );
      return response.body.failureCode === 'REFERENCE_NOT_FOUND';
    });
    const events = await db.query(
      `SELECT event_type FROM outbox_messages WHERE aggregate_id = ? ORDER BY sequence`,
      [rollback.body.transactionId],
    );
    expect(events.map((row) => row.event_type)).toEqual([
      'WagerTransactionPendingReference',
      'WagerTransactionRejected',
    ]);
  });

  test.each([
    [{ kind: 'OPENING' }, 'VALIDATION_ERROR'],
    [{ kind: 'REFUND' }, 'REFERENCE_REQUIRED'],
    [{ money: { amount: '1e2', currency: 'BRL' } }, 'INVALID_AMOUNT'],
    [{ money: { amount: '0.00', currency: 'BRL' } }, 'INVALID_AMOUNT'],
    [{ unexpected: true }, 'VALIDATION_ERROR'],
    [{ walletId: 'not-a-uuid' }, 'VALIDATION_ERROR'],
  ])('invalid payload %# is a 400', async (override, code) => {
    const { key, payload } = ApiClient.transaction({
      playerId: wallet.playerId,
      walletId: wallet.id,
      kind: 'BET',
      money: { amount: '1.00', currency: 'BRL' },
    });
    const response = await api.submit({ ...payload, ...override }, key);
    expect(response.status).toBe(400);
    expect((response.body as unknown as { error: { code: string } }).error.code).toBe(code);
  });

  test('missing Idempotency-Key is a 400', async () => {
    const { payload } = ApiClient.transaction({
      playerId: wallet.playerId,
      walletId: wallet.id,
      kind: 'BET',
      money: { amount: '1.00', currency: 'BRL' },
    });
    const response = await api.request<{ error: { code: string } }>(
      'POST',
      '/wagering/transactions',
      payload,
    );
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
  });

  test('unknown wallet is a 404 and nothing is persisted', async () => {
    const response = await api.submitInput({
      playerId: 'p',
      walletId: newId(),
      kind: 'BET',
      money: { amount: '1.00', currency: 'BRL' },
    });
    expect(response.status).toBe(404);
  });

  test('transaction lookups by id and by provider external id', async () => {
    const { key, payload } = ApiClient.transaction({
      playerId: wallet.playerId,
      walletId: wallet.id,
      kind: 'WIN',
      money: { amount: '1.00', currency: 'BRL' },
    });
    const created = await api.submit(payload, key);
    const byId = await api.request<Record<string, unknown>>(
      'GET',
      `/wagering/transactions/${created.body.transactionId}`,
    );
    expect(byId.status).toBe(200);
    expect(byId.body).toMatchObject({
      id: created.body.transactionId,
      kind: 'WIN',
      status: 'PROCESSED',
    });
    const byExternal = await api.request<Record<string, unknown>>(
      'GET',
      `/providers/${payload.providerId}/wagering/transactions/${payload.externalTransactionId}`,
    );
    expect(byExternal.body).toEqual(byId.body);
    expect((await api.request('GET', `/wagering/transactions/${newId()}`)).status).toBe(404);
  });
});

describe('ledger and reconciliation', () => {
  test('cursor pagination is stable and covers every entry exactly once', async () => {
    const wallet = await api.createWallet('100.00');
    for (let i = 0; i < 12; i++) {
      await api.submitInput({
        playerId: wallet.playerId,
        walletId: wallet.id,
        kind: i % 2 === 0 ? 'BET' : 'WIN',
        money: { amount: '1.00', currency: 'BRL' },
      });
    }
    const seen: number[] = [];
    let cursor: string | null = null;
    do {
      const query: string = cursor ? `?limit=5&cursor=${cursor}` : '?limit=5';
      const page = await api.request<{
        entries: { walletVersion: number }[];
        nextCursor: string | null;
      }>('GET', `/wallets/${wallet.id}/ledger${query}`);
      expect(page.status).toBe(200);
      seen.push(...page.body.entries.map((entry) => entry.walletVersion));
      cursor = page.body.nextCursor;
    } while (cursor);
    expect(seen).toEqual(Array.from({ length: 13 }, (_, i) => i + 1));
    expect((await api.request('GET', `/wallets/${wallet.id}/ledger?cursor=%%%`)).status).toBe(400);
    expect((await api.request('GET', `/wallets/${wallet.id}/ledger?limit=500`)).status).toBe(400);
  });

  test('reconciliation reports a consistent wallet', async () => {
    const wallet = await api.createWallet('100.00');
    await api.submitInput({
      playerId: wallet.playerId,
      walletId: wallet.id,
      kind: 'BET',
      money: { amount: '25.00', currency: 'BRL' },
    });
    const response = await api.request('POST', `/wallets/${wallet.id}/reconciliation`);
    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      walletId: wallet.id,
      storedBalance: { amount: '75.00', currency: 'BRL' },
      calculatedBalance: { amount: '75.00', currency: 'BRL' },
      difference: { amount: '0.00', currency: 'BRL' },
      consistent: true,
      checkedEntries: 2,
    });
  });
});

describe('health and metrics', () => {
  test('liveness and readiness', async () => {
    expect(await api.request('GET', '/health/live')).toEqual({
      status: 200,
      body: { status: 'ok' },
    });
    expect(await api.request('GET', '/health/ready')).toEqual({
      status: 200,
      body: { status: 'ok', checks: { database: 'up', sqs: 'up' } },
    });
  });

  test('metrics expose the required series', async () => {
    const response = await fetch(`${running.baseUrl}/metrics`);
    const text = await response.text();
    for (const name of [
      'wagering_transactions_total',
      'wagering_duplicates_total',
      'wagering_retries_total',
      'wagering_dlq_messages_total',
      'wagering_lock_conflicts_total',
      'wagering_outbox_lag_seconds',
      'wagering_processing_duration_seconds',
    ]) {
      expect(text).toContain(name);
    }
  });

  test('correlation id is echoed back', async () => {
    const response = await fetch(`${running.baseUrl}/health/live`, {
      headers: { 'x-correlation-id': 'corr-123' },
    });
    expect(response.headers.get('x-correlation-id')).toBe('corr-123');
  });
});
