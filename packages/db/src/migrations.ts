import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Forward-only migration runner.
 *
 * `CLAUDE.md`: migrations are forward-only and never edited after merge. "Never edited" is
 * enforced here rather than remembered — every applied file's checksum is recorded, and a
 * changed checksum aborts the run. Without that, an edited migration produces environments that
 * disagree about the schema while every one of them reports "up to date", which is the kind of
 * drift you discover from a production query plan rather than from CI.
 */

export interface SqlExecutor {
  /** Multi-statement DDL. Uses the simple query protocol; no parameters. */
  exec(sql: string): Promise<void>;
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

export interface MigrationFile {
  readonly name: string;
  readonly sql: string;
  readonly checksum: string;
}

export function checksum(sql: string): string {
  // Normalise line endings only. Whitespace is deliberately significant: a reformatted migration
  // is still an edited migration.
  return createHash('sha256').update(sql.replace(/\r\n/g, '\n'), 'utf8').digest('hex');
}

export function loadMigrationFiles(directory: string): MigrationFile[] {
  return readdirSync(directory)
    .filter((name) => name.endsWith('.sql'))
    .sort() // Lexicographic order over zero-padded numeric prefixes is apply order.
    .map((name) => {
      const sql = readFileSync(join(directory, name), 'utf8');
      return { name, sql, checksum: checksum(sql) };
    });
}

const MIGRATION_TABLE_DDL = `
CREATE TABLE IF NOT EXISTS schema_migration (
  name       text PRIMARY KEY,
  checksum   text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now()
);`;

export class MigrationChecksumError extends Error {
  constructor(name: string) {
    super(
      `Migration "${name}" was modified after it was applied. Migrations are forward-only and ` +
        `are never edited after merge — add a new migration instead.`,
    );
    this.name = 'MigrationChecksumError';
  }
}

/**
 * Applies any migration not yet recorded, in filename order. Returns the names applied by this
 * call, so a caller can tell "nothing to do" from "applied three".
 */
export async function applyMigrations(
  exec: SqlExecutor,
  files: readonly MigrationFile[],
): Promise<string[]> {
  await exec.exec(MIGRATION_TABLE_DDL);

  const { rows } = await exec.query<{ name: string; checksum: string }>(
    'SELECT name, checksum FROM schema_migration',
  );
  const applied = new Map(rows.map((row) => [row.name, row.checksum]));

  const appliedNow: string[] = [];
  for (const file of files) {
    const previous = applied.get(file.name);
    if (previous !== undefined) {
      if (previous !== file.checksum) throw new MigrationChecksumError(file.name);
      continue;
    }

    // Each migration is one transaction: a failure half-way leaves no partial schema.
    await exec.exec('BEGIN');
    try {
      await exec.exec(file.sql);
      await exec.query('INSERT INTO schema_migration (name, checksum) VALUES ($1, $2)', [
        file.name,
        file.checksum,
      ]);
      await exec.exec('COMMIT');
    } catch (error) {
      await exec.exec('ROLLBACK');
      throw error;
    }
    appliedNow.push(file.name);
  }

  return appliedNow;
}
