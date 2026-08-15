import { Pool } from 'pg';
import type { PoolConfig } from 'pg';
import type { SqlExecutor } from './migrations.js';

/**
 * Postgres connection. The only place in the repo that reads database credentials — every other
 * module receives an executor.
 */

export interface DbConfig {
  connectionString: string;
  maxConnections?: number;
}

export function readDbConfigFromEnv(env: NodeJS.ProcessEnv = process.env): DbConfig {
  const connectionString = env['DATABASE_URL'];
  if (connectionString === undefined || connectionString === '') {
    throw new Error('DATABASE_URL is not set. See .env.example.');
  }
  return { connectionString };
}

export function createPool(config: DbConfig): Pool {
  const poolConfig: PoolConfig = {
    connectionString: config.connectionString,
    max: config.maxConnections ?? 10,
  };
  return new Pool(poolConfig);
}

/**
 * Adapts a `pg` pool to the executor the migration runner and query layer speak. The narrow
 * interface is what lets the schema be tested against an in-process Postgres without a server.
 */
export function poolExecutor(pool: Pool): SqlExecutor {
  return {
    async exec(sql: string): Promise<void> {
      await pool.query(sql);
    },
    async query<T>(text: string, params?: unknown[]): Promise<{ rows: T[] }> {
      const result = await pool.query(text, params as unknown[] | undefined);
      return { rows: result.rows as T[] };
    },
  };
}
