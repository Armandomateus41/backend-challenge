import { Migrator } from '@mikro-orm/migrations';
import { MikroORM } from '@mikro-orm/postgresql';
import { Migration20261026000000InitialSchema } from './migrations/Migration20261026000000InitialSchema';

export const MIGRATIONS = [Migration20261026000000InitialSchema];

export interface OrmOptions {
  url: string;
  poolMax: number;
}

/**
 * MikroORM is used for connection management, `EntityManager.transactional()` and versioned
 * migrations. Repositories issue explicit parameterized SQL through the transactional
 * EntityManager so that every lock and conditional write is visible in code review.
 */
export async function createOrm(options: OrmOptions): Promise<MikroORM> {
  return MikroORM.init({
    clientUrl: options.url,
    entities: [],
    discovery: { warnWhenNoEntities: false },
    extensions: [Migrator],
    pool: { min: 0, max: options.poolMax, idleTimeoutMillis: 30000 },
    migrations: {
      migrationsList: MIGRATIONS,
      tableName: 'schema_migrations',
      transactional: true,
      allOrNothing: true,
      snapshot: false,
      silent: true,
    },
    debug: false,
  });
}
