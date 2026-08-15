/**
 * Applies pending migrations. Run automatically per environment by the deploy pipeline —
 * migrations are never applied by hand (devops-engineer P0 deliverable).
 *
 *   pnpm --filter @projectapp/db migrate
 */
import { createPool, poolExecutor, readDbConfigFromEnv } from '../client.js';
import { applyMigrations, loadMigrationFiles } from '../migrations.js';
import { migrationsDirectory } from '../paths.js';

async function main(): Promise<void> {
  const pool = createPool(readDbConfigFromEnv());
  try {
    const files = loadMigrationFiles(migrationsDirectory);
    const applied = await applyMigrations(poolExecutor(pool), files);
    if (applied.length === 0) {
      console.warn(`No pending migrations (${files.length} already applied).`);
    } else {
      for (const name of applied) console.warn(`applied ${name}`);
    }
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
