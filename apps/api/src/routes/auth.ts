import type { SqlExecutor } from '@projectapp/db';
import {
  loginRequestSchema,
  passwordResetConfirmSchema,
  passwordResetRequestSchema,
  registerRequestSchema,
} from '@projectapp/shared-types';
import type { FastifyInstance } from 'fastify';
import { hashPassword, hashToken, issueSessionToken, verifyPassword } from '../auth/credentials.js';
import { resolveSession } from '../auth/context.js';
import { conflict, unauthenticated, validationFailed } from '../errors.js';
import type { AppDeps } from '../app.js';

interface UserRow {
  id: string;
  org_id: string;
  name: string;
  email: string;
  auth_provider: 'password' | 'google' | 'microsoft';
  created_at: Date | string;
}

interface OrgRow {
  id: string;
  name: string;
  plan_tier: 'free' | 'pro' | 'enterprise';
  created_at: Date | string;
}

const iso = (value: Date | string): string =>
  value instanceof Date ? value.toISOString() : new Date(value).toISOString();

const toUser = (row: UserRow) => ({
  id: row.id,
  orgId: row.org_id,
  name: row.name,
  email: row.email,
  authProvider: row.auth_provider,
  createdAt: iso(row.created_at),
});

const toOrganization = (row: OrgRow) => ({
  id: row.id,
  name: row.name,
  planTier: row.plan_tier,
  createdAt: iso(row.created_at),
});

async function createSession(
  exec: SqlExecutor,
  userId: string,
  ttlSeconds: number,
  now: Date,
): Promise<{ token: string; expiresAt: string }> {
  const { token, tokenHash } = issueSessionToken();
  const expiresAt = new Date(now.getTime() + ttlSeconds * 1000).toISOString();
  await exec.query(
    `INSERT INTO user_session (user_id, token_hash, expires_at) VALUES ($1, $2, $3)`,
    [userId, tokenHash, expiresAt],
  );
  return { token, expiresAt };
}

export function registerAuthRoutes(app: FastifyInstance, deps: AppDeps): void {
  const { exec, sessionTtlSeconds, now } = deps;

  /** FR-AUTH-01 + FR-PRJ-01: registration creates the user and their organization together. */
  app.post('/auth/register', async (request, reply) => {
    const parsed = registerRequestSchema.safeParse(request.body);
    if (!parsed.success) throw validationFailed(parsed.error.flatten());
    const body = parsed.data;

    const existing = await exec.query<{ id: string }>(
      `SELECT u.id FROM app_user u
        JOIN organization o ON o.id = u.org_id
       WHERE lower(u.email) = lower($1)`,
      [body.email],
    );
    if (existing.rows.length > 0) throw conflict('That email address is already registered');

    await exec.exec('BEGIN');
    let user: UserRow;
    let organization: OrgRow;
    try {
      const org = await exec.query<OrgRow>(
        `INSERT INTO organization (name) VALUES ($1) RETURNING id, name, plan_tier, created_at`,
        [body.organizationName],
      );
      organization = org.rows[0]!;

      const created = await exec.query<UserRow>(
        `INSERT INTO app_user (org_id, name, email, auth_provider)
         VALUES ($1, $2, $3, 'password')
         RETURNING id, org_id, name, email, auth_provider, created_at`,
        [organization.id, body.name, body.email],
      );
      user = created.rows[0]!;

      await exec.query(`INSERT INTO user_credential (user_id, password_hash) VALUES ($1, $2)`, [
        user.id,
        await hashPassword(body.password),
      ]);
      await exec.exec('COMMIT');
    } catch (error) {
      await exec.exec('ROLLBACK');
      throw error;
    }

    const session = await createSession(exec, user.id, sessionTtlSeconds, now());
    return reply.status(201).send({
      token: session.token,
      expiresAt: session.expiresAt,
      user: toUser(user),
      organization: toOrganization(organization),
    });
  });

  /** FR-AUTH-01/03. */
  app.post('/auth/login', async (request, reply) => {
    const parsed = loginRequestSchema.safeParse(request.body);
    if (!parsed.success) throw validationFailed(parsed.error.flatten());
    const body = parsed.data;

    const { rows } = await exec.query<UserRow & { password_hash: string | null }>(
      `SELECT u.id, u.org_id, u.name, u.email, u.auth_provider, u.created_at, c.password_hash
         FROM app_user u
         LEFT JOIN user_credential c ON c.user_id = u.id
        WHERE lower(u.email) = lower($1)`,
      [body.email],
    );
    const row = rows[0];

    // Same message and same work either way: a faster "no such user" path is a user enumerator.
    const stored = row?.password_hash ?? '';
    const ok = stored !== '' && (await verifyPassword(body.password, stored));
    if (row === undefined || !ok) throw unauthenticated('Email or password is incorrect');

    const orgResult = await exec.query<OrgRow>(
      `SELECT id, name, plan_tier, created_at FROM organization WHERE id = $1`,
      [row.org_id],
    );
    const session = await createSession(exec, row.id, sessionTtlSeconds, now());

    return reply.status(200).send({
      token: session.token,
      expiresAt: session.expiresAt,
      user: toUser(row),
      organization: toOrganization(orgResult.rows[0]!),
    });
  });

  /** FR-AUTH-03: server-side invalidation. Discarding the token client-side is not logout. */
  app.post('/auth/logout', async (request, reply) => {
    const header = request.headers.authorization;
    await resolveSession(exec, header, now());
    const token = (header ?? '').slice('Bearer '.length).trim();
    await exec.query(
      `UPDATE user_session SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL`,
      [hashToken(token)],
    );
    return reply.status(204).send();
  });

  app.get('/auth/me', async (request, reply) => {
    const user = await resolveSession(exec, request.headers.authorization, now());
    const result = await exec.query<UserRow>(
      `SELECT id, org_id, name, email, auth_provider, created_at FROM app_user WHERE id = $1`,
      [user.userId],
    );
    const org = await exec.query<OrgRow>(
      `SELECT id, name, plan_tier, created_at FROM organization WHERE id = $1`,
      [user.orgId],
    );
    return reply
      .status(200)
      .send({ user: toUser(result.rows[0]!), organization: toOrganization(org.rows[0]!) });
  });

  /**
   * FR-AUTH-05. Always 202, whether or not the address exists — a 404 here enumerates accounts.
   *
   * P0 limitation, recorded rather than hidden: the token is created but not delivered. Email
   * delivery is not wired in P0 (no provider configured), so this endpoint is complete on the
   * server side and unusable end-to-end until the mail transport lands with FR-COL-06.
   */
  app.post('/auth/password-reset', async (request, reply) => {
    const parsed = passwordResetRequestSchema.safeParse(request.body);
    if (!parsed.success) throw validationFailed(parsed.error.flatten());

    const { rows } = await exec.query<{ id: string }>(
      `SELECT id FROM app_user WHERE lower(email) = lower($1)`,
      [parsed.data.email],
    );
    const userId = rows[0]?.id;
    if (userId !== undefined) {
      const { token, tokenHash } = issueSessionToken();
      const expiresAt = new Date(now().getTime() + 60 * 60 * 1000).toISOString();
      await exec.query(
        `INSERT INTO password_reset_token (user_id, token_hash, expires_at) VALUES ($1, $2, $3)`,
        [userId, tokenHash, expiresAt],
      );
      deps.onPasswordResetToken?.(parsed.data.email, token);
    }
    return reply.status(202).send({ status: 'accepted' });
  });

  /** FR-AUTH-05: single-use, time-limited, and it invalidates every existing session. */
  app.post('/auth/password-reset/confirm', async (request, reply) => {
    const parsed = passwordResetConfirmSchema.safeParse(request.body);
    if (!parsed.success) throw validationFailed(parsed.error.flatten());

    const { rows } = await exec.query<{ id: string; user_id: string }>(
      `SELECT id, user_id FROM password_reset_token
        WHERE token_hash = $1 AND used_at IS NULL AND expires_at > $2`,
      [hashToken(parsed.data.token), now().toISOString()],
    );
    const row = rows[0];
    if (row === undefined) throw unauthenticated('That reset link is invalid or has expired');

    await exec.exec('BEGIN');
    try {
      await exec.query(
        `UPDATE user_credential SET password_hash = $1, updated_at = now() WHERE user_id = $2`,
        [await hashPassword(parsed.data.password), row.user_id],
      );
      await exec.query(`UPDATE password_reset_token SET used_at = now() WHERE id = $1`, [row.id]);
      // A password reset is also the remediation for a stolen session.
      await exec.query(
        `UPDATE user_session SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`,
        [row.user_id],
      );
      await exec.exec('COMMIT');
    } catch (error) {
      await exec.exec('ROLLBACK');
      throw error;
    }

    return reply.status(204).send();
  });
}
