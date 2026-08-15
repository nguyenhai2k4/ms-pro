import { randomUUID } from 'node:crypto';
import type { SqlExecutor } from '@projectapp/db';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { ApiException } from './errors.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerCalendarRoutes } from './routes/calendars.js';
import { registerProjectRoutes } from './routes/projects.js';

/**
 * The API is built around an injected `SqlExecutor` and an injected clock rather than reaching for
 * module-level globals. That is what lets the whole surface be tested against an in-process
 * Postgres with `app.inject()` — no server, no ports, no fixtures directory — which in turn is
 * what makes RBAC negative-path tests (FR-ACL) cheap enough that they actually get written.
 */
export interface AppDeps {
  readonly exec: SqlExecutor;
  readonly sessionTtlSeconds: number;
  readonly now: () => Date;
  /**
   * FR-AUTH-05: called with a freshly minted reset token. In production this is the mail
   * transport; email delivery is not wired in P0, so the default does nothing and the limitation
   * is visible here rather than discovered by a user who never receives the message.
   */
  readonly onPasswordResetToken?: (email: string, token: string) => void;
}

export function buildApp(deps: AppDeps): FastifyInstance {
  const app = Fastify({
    logger: false,
    genReqId: () => randomUUID(),
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ApiException) {
      return reply.status(error.status).send({
        code: error.code,
        message: error.message,
        details: error.details,
        requestId: request.id,
      });
    }

    // Anything unrecognised is a bug, and its message may contain SQL or internals — log it,
    // return an opaque envelope.
    request.log.error({ err: error }, 'unhandled error');
    return reply.status(500).send({
      code: 'internal',
      message: 'Something went wrong',
      requestId: request.id,
    });
  });

  app.get('/health', async () => ({ status: 'ok' }));

  registerAuthRoutes(app, deps);
  registerProjectRoutes(app, deps);
  registerCalendarRoutes(app, deps);

  return app;
}
