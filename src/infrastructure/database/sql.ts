import { type EntityManager } from '@mikro-orm/postgresql';
import { Money } from '../../domain/money';

export type SqlExecutor = EntityManager;

export type Row = Record<string, unknown>;

export async function query<T extends Row = Row>(
  em: SqlExecutor,
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  return em.execute<T[]>(sql, params);
}

export function str(row: Row, column: string): string {
  const value = row[column];
  if (typeof value !== 'string') {
    throw new Error(`Column ${column} expected text, received ${typeof value}`);
  }
  return value;
}

export function optionalStr(row: Row, column: string): string | undefined {
  const value = row[column];
  if (value === null || value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string') {
    throw new Error(`Column ${column} expected text, received ${typeof value}`);
  }
  return value;
}

export function int(row: Row, column: string): number {
  const value = Number(row[column]);
  if (!Number.isSafeInteger(value)) {
    throw new Error(`Column ${column} expected integer`);
  }
  return value;
}

export function date(row: Row, column: string): Date {
  const value = row[column];
  const parsed = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`Column ${column} expected timestamp`);
  }
  return parsed;
}

export function optionalDate(row: Row, column: string): Date | undefined {
  const value = row[column];
  return value === null || value === undefined ? undefined : date(row, column);
}

/** NUMERIC columns are selected as ::text so values never pass through a float. */
export function money(row: Row, amountColumn: string, currency: string): Money {
  return Money.from({ amount: str(row, amountColumn), currency });
}

export function optionalMoney(row: Row, amountColumn: string, currency: string): Money | undefined {
  return row[amountColumn] === null || row[amountColumn] === undefined
    ? undefined
    : money(row, amountColumn, currency);
}
