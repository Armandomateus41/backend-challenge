import { describe, expect, test } from 'bun:test';
import { IdempotencyConflictError } from '../../src/application/errors';
import { canonicalJson, hashCanonical } from '../../src/application/idempotency/payload-hash';
import { type RepositoryScope, type UnitOfWork } from '../../src/application/ports/persistence';
import { ProcessWagerTransaction } from '../../src/application/use-cases/process-wager-transaction';
import {
  normalizeWagerCommand,
  type SubmitWagerTransactionCommand,
} from '../../src/application/wager-transaction-command';
import { type WagerTransaction, WagerTransactionKind } from '../../src/domain/wager-transaction';
import { type Wallet } from '../../src/domain/wallet';
import { rejectionOf } from '../support/assertions';
import { walletWith } from '../support/builders';

describe('canonical JSON', () => {
  test('sorts keys at every depth and drops undefined members', () => {
    expect(canonicalJson({ b: 1, a: { d: undefined, c: 'x', a: [3, { z: 1, y: 2 }] } })).toBe(
      '{"a":{"a":[3,{"y":2,"z":1}],"c":"x"},"b":1}',
    );
  });

  test('is insensitive to key order', () => {
    expect(hashCanonical({ a: 1, b: 2 })).toBe(hashCanonical({ b: 2, a: 1 }));
  });

  test('rejects non-JSON values', () => {
    expect(() => canonicalJson({ a: Number.NaN })).toThrow(TypeError);
    expect(() => canonicalJson({ a: () => 1 })).toThrow(TypeError);
  });
});

const baseCommand: SubmitWagerTransactionCommand = {
  idempotencyKey: 'provider-a:tx-1',
  providerId: 'provider-a',
  externalTransactionId: 'tx-1',
  playerId: 'player-1',
  walletId: '00000000-0000-7000-8000-000000000001',
  roundId: 'round-1',
  gameId: 'game-1',
  kind: WagerTransactionKind.Bet,
  money: { amount: '25.00', currency: 'BRL' },
};

describe('payload hash', () => {
  test('ignores the idempotency key and normalizes the amount scale', () => {
    const a = normalizeWagerCommand(baseCommand).payloadHash;
    const b = normalizeWagerCommand({
      ...baseCommand,
      idempotencyKey: 'another-key',
      money: { amount: '25', currency: 'BRL' },
    }).payloadHash;
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  test.each([
    ['amount', { money: { amount: '25.01', currency: 'BRL' } }],
    ['kind', { kind: WagerTransactionKind.Win }],
    ['round', { roundId: 'round-2' }],
    ['player', { playerId: 'player-2' }],
    ['reference', { referenceExternalTransactionId: 'tx-0' }],
  ])('changes when the %s changes', (_field, override) => {
    expect(normalizeWagerCommand({ ...baseCommand, ...override }).payloadHash).not.toBe(
      normalizeWagerCommand(baseCommand).payloadHash,
    );
  });
});

/** Minimal in-memory scope: enough to exercise the use case's idempotency branches. */
function inMemoryUow(wallet: Wallet): { uow: UnitOfWork; stored: WagerTransaction[] } {
  const stored: WagerTransaction[] = [];
  const scope = {
    wallets: {
      findById: () => Promise.resolve(wallet),
      lockById: () => Promise.resolve(wallet),
      insert: () => Promise.resolve(),
      saveMovement: () => Promise.resolve(),
    },
    transactions: {
      findByIdempotencyKey: (key: string) =>
        Promise.resolve(stored.find((tx) => tx.idempotencyKey === key)),
      findByExternalId: (provider: string, external: string) =>
        Promise.resolve(
          stored.find((tx) => tx.providerId === provider && tx.externalTransactionId === external),
        ),
      hasProcessedReversal: () => Promise.resolve(false),
      insert: (tx: WagerTransaction) => {
        stored.push(tx);
        return Promise.resolve();
      },
      wakeDependents: () => Promise.resolve(0),
    },
    ledger: { insert: () => Promise.resolve() },
    outbox: { enqueue: () => Promise.resolve() },
    inbox: {},
  } as unknown as RepositoryScope;
  const uow = {
    transaction: <T>(work: (s: RepositoryScope) => Promise<T>) => work(scope),
  } as unknown as UnitOfWork;
  return { uow, stored };
}

describe('ProcessWagerTransaction idempotency', () => {
  const backoff = { baseDelayMs: 1000, maxDelayMs: 10000 };

  test('identical request is a replay with the original result', async () => {
    const wallet = walletWith('100.00', baseCommand.playerId);
    const { uow, stored } = inMemoryUow(wallet);
    const useCase = new ProcessWagerTransaction(uow, backoff);
    const command = { ...baseCommand, walletId: wallet.id };

    const first = await useCase.execute(command, { source: 'http', correlationId: 'c1' });
    const second = await useCase.execute(command, { source: 'http', correlationId: 'c2' });

    expect(first.kind).toBe('settled');
    expect(second.kind).toBe('settled');
    if (first.kind !== 'settled' || second.kind !== 'settled') return;
    expect(first.result.idempotentReplay).toBe(false);
    expect(second.result).toEqual({ ...first.result, idempotentReplay: true });
    expect(second.result.balance).toEqual({ amount: '75.00', currency: 'BRL' });
    expect(stored).toHaveLength(1);
    expect(wallet.balance.toString()).toBe('75.00');
  });

  test('same key with a different payload is a conflict, not a replay', async () => {
    const wallet = walletWith('100.00', baseCommand.playerId);
    const { uow, stored } = inMemoryUow(wallet);
    const useCase = new ProcessWagerTransaction(uow, backoff);
    const command = { ...baseCommand, walletId: wallet.id };

    await useCase.execute(command, { source: 'http', correlationId: 'c1' });
    const divergent = { ...command, money: { amount: '30.00', currency: 'BRL' } };
    expect(
      await rejectionOf(useCase.execute(divergent, { source: 'http', correlationId: 'c2' })),
    ).toBeInstanceOf(IdempotencyConflictError);
    expect(stored).toHaveLength(1);
    expect(wallet.balance.toString()).toBe('75.00');
  });

  test('rejects OPENING before touching persistence', async () => {
    const wallet = walletWith('100.00', baseCommand.playerId);
    const { uow, stored } = inMemoryUow(wallet);
    const useCase = new ProcessWagerTransaction(uow, backoff);
    expect(
      await rejectionOf(
        useCase.execute(
          { ...baseCommand, walletId: wallet.id, kind: WagerTransactionKind.Opening },
          { source: 'http', correlationId: 'c1' },
        ),
      ),
    ).toMatchObject({ code: 'KIND_NOT_ALLOWED' });
    expect(stored).toHaveLength(0);
  });
});
