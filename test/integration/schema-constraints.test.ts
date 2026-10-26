import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { ProcessWagerTransaction } from '../../src/application/use-cases/process-wager-transaction';
import { CreateWallet } from '../../src/application/use-cases/wallets';
import { WagerTransactionKind } from '../../src/domain/wager-transaction';
import { MikroOrmUnitOfWork } from '../../src/infrastructure/database/mikro-orm-unit-of-work';
import { newId } from '../../src/shared/ids';
import { TestDatabase } from '../support/environment';

let db: TestDatabase;
let createWallet: CreateWallet;
let processWager: ProcessWagerTransaction;

beforeAll(async () => {
  db = await TestDatabase.connect();
  const uow = new MikroOrmUnitOfWork(db.orm, 5000);
  createWallet = new CreateWallet(uow, ['BRL']);
  processWager = new ProcessWagerTransaction(uow, { baseDelayMs: 100, maxDelayMs: 400 });
});

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  await db.reset();
});

/** Runs statements in one SQL transaction and returns the SQLSTATE it failed with, if any. */
async function failureOf(statements: [string, unknown[]?][]): Promise<string | undefined> {
  try {
    await db.orm.em.fork().transactional(async (em) => {
      for (const [sql, params] of statements) {
        await em.execute(sql, params ?? []);
      }
    });
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code;
  }
}

async function walletWithBet() {
  const playerId = `player-${newId()}`;
  const wallet = await createWallet.execute(
    { playerId, initialBalance: { amount: '100.00', currency: 'BRL' } },
    'test',
  );
  const externalTransactionId = `bet-${newId()}`;
  const outcome = await processWager.execute(
    {
      idempotencyKey: `p:${externalTransactionId}`,
      providerId: 'p',
      externalTransactionId,
      playerId,
      walletId: wallet.id,
      roundId: 'r1',
      gameId: 'g1',
      kind: WagerTransactionKind.Bet,
      money: { amount: '10.00', currency: 'BRL' },
    },
    { source: 'http', correlationId: 'test' },
  );
  if (outcome.kind !== 'settled') throw new Error('unexpected');
  return { wallet, playerId, betId: outcome.result.transactionId, externalTransactionId };
}

describe('migrations', () => {
  test('are reversible: down then up restores the schema', async () => {
    const reverted = await db.orm.migrator.down({ to: 0 });
    expect(reverted.length).toBeGreaterThan(0);
    const tables = await db.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'wallets'`,
    );
    expect(tables).toHaveLength(0);
    const applied = await db.orm.migrator.up();
    expect(applied.map((m) => m.name)).toEqual(reverted.map((m) => m.name).reverse());
    expect(await db.orm.migrator.getPending()).toHaveLength(0);
  });
});

describe('schema invariants', () => {
  test('balance can never be negative', async () => {
    const { wallet } = await walletWithBet();
    expect(
      await failureOf([[`UPDATE wallets SET balance = -0.01 WHERE id = ?`, [wallet.id]]]),
    ).toBe('23514');
  });

  test('one wallet per player and currency', async () => {
    const { wallet, playerId } = await walletWithBet();
    expect(
      await failureOf([
        [`INSERT INTO wallets VALUES (?, ?, 'BRL', 0, 1, now(), now())`, [newId(), playerId]],
      ]),
    ).toBe('23505');
    expect(wallet.id).toBeDefined();
  });

  test('ledger is append-only', async () => {
    const { wallet } = await walletWithBet();
    expect(
      await failureOf([
        [`UPDATE wallet_ledger_entries SET amount = 1 WHERE wallet_id = ?`, [wallet.id]],
      ]),
    ).toBe('23001');
    expect(
      await failureOf([[`DELETE FROM wallet_ledger_entries WHERE wallet_id = ?`, [wallet.id]]]),
    ).toBe('23001');
  });

  test('balance change without a matching ledger entry fails at commit', async () => {
    const { wallet } = await walletWithBet();
    expect(
      await failureOf([
        [
          `UPDATE wallets SET balance = balance + 1, version = version + 1 WHERE id = ?`,
          [wallet.id],
        ],
      ]),
    ).toBe('23514');
    const state = await db.walletState(wallet.id);
    expect(state.balance).toBe('90.00');
  });

  test('ledger arithmetic and chain are enforced', async () => {
    const { wallet, playerId } = await walletWithBet();
    const txId = newId();
    const insertTx = [
      `INSERT INTO wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash,
         wallet_id, player_id, round_id, game_id, kind, amount, currency, status, observed_balance,
         created_at, updated_at, processed_at)
       VALUES (?, 'p', ?, ?, ?, ?, ?, 'r', 'g', 'WIN', 5, 'BRL', 'PROCESSED', 95, now(), now(), now())`,
      [txId, txId, txId, 'f'.repeat(64), wallet.id, playerId],
    ] as [string, unknown[]];
    const entry = (before: string, after: string, version: number): [string, unknown[]] => [
      `INSERT INTO wallet_ledger_entries VALUES (?, ?, ?, 'CREDIT', 5, 'BRL', ?, ?, ?, now())`,
      [newId(), wallet.id, txId, before, after, version],
    ];
    const updateWallet: [string, unknown[]] = [
      `UPDATE wallets SET balance = 95, version = 3 WHERE id = ?`,
      [wallet.id],
    ];
    // Wrong arithmetic.
    expect(await failureOf([insertTx, entry('90.00', '96.00', 3), updateWallet])).toBe('23514');
    // Breaks the chain: balance_before differs from the previous balance_after.
    expect(await failureOf([insertTx, entry('91.00', '96.00', 3), updateWallet])).toBe('23514');
    // Consistent movement is accepted.
    expect(await failureOf([insertTx, entry('90.00', '95.00', 3), updateWallet])).toBeUndefined();
  });

  test('ledger entries require a processed balance-moving transaction', async () => {
    const { wallet, playerId } = await walletWithBet();
    const txId = newId();
    expect(
      await failureOf([
        [
          `INSERT INTO wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash,
             wallet_id, player_id, round_id, game_id, kind, amount, currency, status, observed_balance,
             created_at, updated_at, processed_at)
           VALUES (?, 'p', ?, ?, ?, ?, ?, 'r', 'g', 'LOSS', 5, 'BRL', 'PROCESSED', 90, now(), now(), now())`,
          [txId, txId, txId, 'f'.repeat(64), wallet.id, playerId],
        ],
        [
          `INSERT INTO wallet_ledger_entries VALUES (?, ?, ?, 'DEBIT', 5, 'BRL', 90, 85, 3, now())`,
          [newId(), wallet.id, txId],
        ],
      ]),
    ).toBe('23514');
  });

  test('terminal transactions cannot change and transactions cannot be deleted', async () => {
    const { betId } = await walletWithBet();
    expect(
      await failureOf([
        [
          `UPDATE wager_transactions SET status = 'REJECTED', failure_code = 'X' WHERE id = ?`,
          [betId],
        ],
      ]),
    ).toBe('23001');
    expect(await failureOf([[`DELETE FROM wager_transactions WHERE id = ?`, [betId]]])).toBe(
      '23001',
    );
  });

  test('idempotency key and provider external id are unique', async () => {
    const { wallet, playerId, externalTransactionId } = await walletWithBet();
    const id = newId();
    const insert = (key: string, external: string): [string, unknown[]] => [
      `INSERT INTO wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash,
         wallet_id, player_id, round_id, game_id, kind, amount, currency, status, failure_code, observed_balance,
         created_at, updated_at)
       VALUES (?, 'p', ?, ?, ?, ?, ?, 'r', 'g', 'BET', 1, 'BRL', 'REJECTED', 'X', 0, now(), now())`,
      [id, external, key, 'f'.repeat(64), wallet.id, playerId],
    ];
    expect(await failureOf([insert(`p:${externalTransactionId}`, 'another')])).toBe('23505');
    expect(await failureOf([insert('another-key', externalTransactionId)])).toBe('23505');
  });

  test('a transaction can be reversed at most once', async () => {
    const { wallet, playerId, betId } = await walletWithBet();
    const reversal = (kind: string, version: number, before: string, after: string) => {
      const id = newId();
      return [
        [
          `INSERT INTO wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash,
             wallet_id, player_id, round_id, game_id, kind, amount, currency, reference_external_transaction_id,
             reference_transaction_id, status, observed_balance, created_at, updated_at, processed_at)
           VALUES (?, 'p', ?, ?, ?, ?, ?, 'r1', 'g1', ?, 10, 'BRL', 'x', ?, 'PROCESSED', ?, now(), now(), now())`,
          [id, id, id, 'f'.repeat(64), wallet.id, playerId, kind, betId, after],
        ],
        [
          `INSERT INTO wallet_ledger_entries VALUES (?, ?, ?, 'CREDIT', 10, 'BRL', ?, ?, ?, now())`,
          [newId(), wallet.id, id, before, after, version],
        ],
        [`UPDATE wallets SET balance = ?, version = ? WHERE id = ?`, [after, version, wallet.id]],
      ] as [string, unknown[]][];
    };
    expect(await failureOf(reversal('REFUND', 3, '90.00', '100.00'))).toBeUndefined();
    expect(await failureOf(reversal('ROLLBACK', 4, '100.00', '110.00'))).toBe('23505');
    const state = await db.walletState(wallet.id);
    expect(state.balance).toBe('100.00');
  });
});
