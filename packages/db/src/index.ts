/**
 * `@projectapp/db` — Postgres schema, forward-only migrations, and (from P1) the query layer.
 *
 * Boundary: this package owns the snake_case world. Nothing outside it should see a column name.
 * The camelCase contracts in `@projectapp/shared-types` are what the rest of the repo reads.
 */

export { migrationsDirectory } from './paths.js';
export {
  MigrationChecksumError,
  applyMigrations,
  checksum,
  loadMigrationFiles,
} from './migrations.js';
export type { MigrationFile, SqlExecutor } from './migrations.js';
export { createPool, poolExecutor, readDbConfigFromEnv } from './client.js';
export type { DbConfig } from './client.js';
export { TABLE_BY_ENTITY } from './table-map.js';
