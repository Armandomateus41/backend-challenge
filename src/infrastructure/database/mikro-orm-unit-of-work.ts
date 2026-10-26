import { IsolationLevel } from '@mikro-orm/core';
import { type MikroORM } from '@mikro-orm/postgresql';
import { type RepositoryScope, type UnitOfWork } from '../../application/ports/persistence';
import { classifyDatabaseError } from './database-errors';
import { PgInboxRepository } from './repositories/inbox-repository';
import { PgLedgerRepository } from './repositories/ledger-repository';
import { PgOutboxRepository } from './repositories/outbox-repository';
import { PgWagerTransactionRepository } from './repositories/wager-transaction-repository';
import { PgWalletRepository } from './repositories/wallet-repository';
import { query, type SqlExecutor } from './sql';

function createScope(em: SqlExecutor): RepositoryScope {
  return {
    wallets: new PgWalletRepository(em),
    transactions: new PgWagerTransactionRepository(em),
    ledger: new PgLedgerRepository(em),
    inbox: new PgInboxRepository(em),
    outbox: new PgOutboxRepository(em),
  };
}

/**
 * Every call forks a fresh EntityManager, so concurrent requests never share an identity map or
 * a connection. Transactions run in READ COMMITTED: each statement after the wallet row lock sees
 * the latest committed state, which is what the idempotency re-check after locking relies on.
 */
export class MikroOrmUnitOfWork implements UnitOfWork {
  constructor(
    private readonly orm: MikroORM,
    private readonly lockTimeoutMs: number,
  ) {}

  async transaction<T>(work: (scope: RepositoryScope) => Promise<T>): Promise<T> {
    try {
      return await this.orm.em.fork().transactional(
        async (em) => {
          // Bounded lock waits turn a stuck wallet into a retryable error instead of a hang.
          await query(em, `SELECT set_config('lock_timeout', ?, true)`, [
            `${this.lockTimeoutMs}ms`,
          ]);
          return work(createScope(em));
        },
        { isolationLevel: IsolationLevel.READ_COMMITTED },
      );
    } catch (error) {
      throw classifyDatabaseError(error);
    }
  }

  async snapshot<T>(work: (scope: RepositoryScope) => Promise<T>): Promise<T> {
    try {
      return await this.orm.em.fork().transactional((em) => work(createScope(em)), {
        isolationLevel: IsolationLevel.REPEATABLE_READ,
        readOnly: true,
      });
    } catch (error) {
      throw classifyDatabaseError(error);
    }
  }

  async read<T>(work: (scope: RepositoryScope) => Promise<T>): Promise<T> {
    try {
      return await work(createScope(this.orm.em.fork()));
    } catch (error) {
      throw classifyDatabaseError(error);
    }
  }

  async ping(): Promise<void> {
    await this.read(async () => {
      await query(this.orm.em.fork(), 'SELECT 1');
    });
  }
}
