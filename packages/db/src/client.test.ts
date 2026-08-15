import type { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import { poolExecutor, readDbConfigFromEnv } from './client.js';

/**
 * `poolExecutor` is the executor the production API actually runs on (`apps/api/src/main.ts`).
 * Every transaction in the codebase — `applyMigrations`, `auditedMutation` (invariant 4),
 * registration, project create and project delete — is expressed as
 * `exec.exec('BEGIN') … exec.query(…) … exec.exec('COMMIT')` through this interface.
 *
 * Every test that verifies those transactions runs against PGlite, which is a **single in-process
 * session**. A single session makes the pattern work by accident. `pg`'s `Pool.query()` does not
 * behave that way: it checks a client out of the pool, runs exactly one statement, and releases it
 * (see `pg-pool/index.js` — `query()` calls `this.connect()`, then `client.release()` in the
 * callback). Statements issued through `poolExecutor` therefore have no guaranteed session
 * affinity, so `BEGIN` and the statements that follow it can land on different connections.
 *
 * The fake pool below models exactly that: `query()` takes the next client, runs one statement, and
 * releases it. Two clients stand in for "any moment when a second request is in flight" — under
 * strictly serial load `pg` happens to hand back the most recently released client (`_idle.pop()`),
 * which is why this defect hides in development and appears under concurrency.
 */

interface FakeClient {
  readonly id: number;
  inTransaction: boolean;
  pending: string[];
}

class FakeServer {
  /** Statements that durably landed, i.e. survived a commit or ran under autocommit. */
  readonly committed: string[] = [];
  readonly clients: FakeClient[];
  private nextClient = 0;
  connectCalls = 0;

  constructor(clientCount: number) {
    this.clients = Array.from({ length: clientCount }, (_unused, id) => ({
      id,
      inTransaction: false,
      pending: [],
    }));
  }

  /** Mirrors `pg` Pool.query(): check out a client, run one statement, release it. */
  runOnCheckedOutClient(sql: string): void {
    const client = this.clients[this.nextClient % this.clients.length]!;
    this.nextClient += 1;
    this.connectCalls += 1;

    const verb = sql.trim().split(/\s+/)[0]?.toUpperCase();
    if (verb === 'BEGIN') {
      client.inTransaction = true;
      return;
    }
    if (verb === 'COMMIT') {
      // Postgres answers COMMIT outside a transaction with a warning, not an error.
      this.committed.push(...client.pending);
      client.pending = [];
      client.inTransaction = false;
      return;
    }
    if (verb === 'ROLLBACK') {
      client.pending = [];
      client.inTransaction = false;
      return;
    }
    if (client.inTransaction) client.pending.push(sql);
    else this.committed.push(sql); // autocommit
  }

  asPool(): Pool {
    return {
      query: async (text: string): Promise<{ rows: unknown[] }> => {
        this.runOnCheckedOutClient(text);
        return { rows: [] };
      },
      connect: async (): Promise<never> => {
        throw new Error('poolExecutor did not pin a client for the transaction');
      },
    } as unknown as Pool;
  }
}

describe('readDbConfigFromEnv', () => {
  it('refuses to start without DATABASE_URL rather than defaulting to something', () => {
    expect(() => readDbConfigFromEnv({})).toThrow(/DATABASE_URL/);
  });

  it('reads the connection string from the environment only', () => {
    const config = readDbConfigFromEnv({ DATABASE_URL: 'postgres://localhost:5432/app' });
    expect(config.connectionString).toBe('postgres://localhost:5432/app');
  });
});

/**
 * DEFECT (P0, open — blocking for invariant 4 in production).
 *
 * These two tests state the requirement that `auditedMutation`'s guarantee rests on: a mutation
 * and its audit row are one transaction, so an unauditable change cannot commit. They fail today.
 *
 * Minimal reproduction, no database needed: issue `BEGIN`, one `UPDATE`, then `ROLLBACK` through
 * `poolExecutor` against a pool with more than one connection in play. The `UPDATE` is durable.
 *
 * This was also reproduced against a real PostgreSQL 16 server with `pg.Pool` during the P0 QA
 * pass, in two forms: (a) a `ROLLBACK`ed `UPDATE` persisted, and (b) `auditedMutation` with a
 * failing audit insert left the project renamed with zero audit rows — an unaudited mutation, the
 * exact outcome invariant 4 exists to forbid. Overlap of a single concurrent request is enough;
 * serial load hides it because `pg` hands back the most recently released client.
 *
 * Consequences in production, none of which any current test can see:
 *  - invariant 4: if the audit insert fails, the mutation has already committed. The api.test.ts
 *    case "rolls the mutation back if the audit write fails" is green only because PGlite is one
 *    session; it does not hold against `pg`.
 *  - `applyMigrations`' "each migration is one transaction, so a failure leaves no partial schema"
 *    does not hold either.
 *  - the connection that ran `BEGIN` returns to the pool idle-in-transaction, holding locks, and
 *    the next unrelated request checked out onto it silently joins that transaction.
 *
 * The fix is an interface change — a `transaction()` method on `SqlExecutor` implemented with
 * `pool.connect()` — which is a contract change in `packages/db` and an escalation under
 * CLAUDE.md invariant 7, not something to settle inside a QA pass.
 */
describe('SqlExecutor transactions are atomic on a pooled connection', () => {
  it.fails('KNOWN DEFECT: a rolled-back statement does not durably commit', async () => {
    const server = new FakeServer(2);
    const exec = poolExecutor(server.asPool());

    await exec.exec('BEGIN');
    await exec.query('UPDATE project SET name = $1 WHERE id = $2', ['renamed', 'p1']);
    await exec.exec('ROLLBACK');

    expect(
      server.committed,
      'a statement issued inside a transaction must not survive its rollback',
    ).toHaveLength(0);
  });

  it.fails('KNOWN DEFECT: no pooled connection is left idle inside a transaction', async () => {
    const server = new FakeServer(2);
    const exec = poolExecutor(server.asPool());

    // The shape every handler uses: BEGIN, then the mutate callback throws, then ROLLBACK.
    await exec.exec('BEGIN');
    await exec.exec('ROLLBACK');

    const stranded = server.clients.filter((client) => client.inTransaction);
    expect(
      stranded.map((client) => client.id),
      'a client returned to the pool mid-transaction holds locks and poisons the next request',
    ).toHaveLength(0);
  });

  it('documents the current behaviour: every statement gets its own checkout', async () => {
    const server = new FakeServer(2);
    const exec = poolExecutor(server.asPool());

    await exec.exec('BEGIN');
    await exec.query('INSERT INTO audit_log_entry DEFAULT VALUES');
    await exec.exec('COMMIT');

    // Three statements, three independent checkouts. When the defect above is fixed this becomes
    // one checkout for the whole transaction and this expectation changes with it.
    expect(server.connectCalls).toBe(3);
  });
});
