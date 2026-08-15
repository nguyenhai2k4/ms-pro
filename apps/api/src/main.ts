import { createPool, poolExecutor, readDbConfigFromEnv } from '@projectapp/db';
import { buildApp } from './app.js';

/** Process entry point. Configuration comes from the environment only — see `.env.example`. */
async function main(): Promise<void> {
  const pool = createPool(readDbConfigFromEnv());
  const app = buildApp({
    exec: poolExecutor(pool),
    sessionTtlSeconds: Number(process.env['AUTH_SESSION_TTL_SECONDS'] ?? 86_400),
    now: () => new Date(),
  });

  const port = Number(process.env['API_PORT'] ?? 3001);
  const host = process.env['API_HOST'] ?? '0.0.0.0';
  await app.listen({ port, host });
  console.warn(`api listening on ${host}:${port}`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
