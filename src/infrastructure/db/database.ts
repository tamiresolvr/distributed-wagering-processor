import { Inject, Injectable, OnApplicationShutdown } from '@nestjs/common';
import { MikroORM } from '@mikro-orm/core';
import { Migrator } from '@mikro-orm/migrations';
import { PostgreSqlDriver } from '@mikro-orm/postgresql';
import type { AppConfig } from '../../config';
import { Migration20260101000000InitialSchema } from './migrations/Migration20260101000000InitialSchema';

export type Row = Record<string, any>;

/** Minimal query port used by repositories — works inside or outside a transaction. */
export interface Queryable {
  query<T = Row>(sql: string, params?: unknown[]): Promise<T[]>;
}

export const ORM = 'MIKRO_ORM';

export async function createOrm(cfg: AppConfig): Promise<MikroORM<PostgreSqlDriver>> {
  return MikroORM.init<PostgreSqlDriver>({
    driver: PostgreSqlDriver,
    clientUrl: cfg.databaseUrl,
    entities: [],
    discovery: { warnWhenNoEntities: false },
    allowGlobalContext: true,
    pool: { min: 2, max: cfg.dbPoolMax },
    extensions: [Migrator],
    migrations: {
      transactional: true,
      allOrNothing: true,
      snapshot: false,
      migrationsList: [
        { name: 'Migration20260101000000InitialSchema', class: Migration20260101000000InitialSchema },
      ],
    },
  });
}

/**
 * Thin wrapper over MikroORM's EntityManager: owns transaction boundaries and
 * executes parameterised SQL on the transaction's connection.
 */
@Injectable()
export class Database implements OnApplicationShutdown {
  constructor(@Inject(ORM) readonly orm: MikroORM<PostgreSqlDriver>) {}

  query<T = Row>(sql: string, params: unknown[] = []): Promise<T[]> {
    return this.orm.em.getConnection().execute(sql, params as any[]) as Promise<T[]>;
  }

  /** Runs `fn` in a single SQL transaction (READ COMMITTED); rolls back on throw. */
  transaction<T>(fn: (q: Queryable) => Promise<T>): Promise<T> {
    return this.orm.em.transactional(async (tem) => {
      const ctx = tem.getTransactionContext();
      const conn = tem.getConnection();
      const q: Queryable = {
        query: <R = Row>(sql: string, params: unknown[] = []) =>
          conn.execute(sql, params as any[], 'all', ctx) as Promise<R[]>,
      };
      return fn(q);
    });
  }

  async ping(): Promise<void> {
    await this.query('SELECT 1');
  }

  async onApplicationShutdown(): Promise<void> {
    await this.orm.close(true);
  }
}

/** Errors worth retrying (infrastructure or concurrency), as opposed to business/permanent ones. */
export function isTransientDbError(e: unknown): boolean {
  const err = e as { code?: string; message?: string } | undefined;
  const code = err?.code ?? '';
  const transient = new Set([
    '40001', '40P01', '55P03', '57P01', '57P03', '53300', '08000', '08001', '08003', '08004', '08006',
    'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE',
  ]);
  if (transient.has(code)) return true;
  const msg = err?.message ?? '';
  return /Connection terminated|connection.*(refused|reset|closed)|timeout|ECONN/i.test(msg);
}
