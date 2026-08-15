import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Absolute path to the migrations directory, resolved relative to this package. */
export const migrationsDirectory = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'migrations',
);
