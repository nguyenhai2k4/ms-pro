import {
  calendarExceptionIdParamSchema,
  createCalendarExceptionRequestSchema,
  createCalendarRequestSchema,
  updateCalendarRequestSchema,
} from '@projectapp/shared-types';
import type { Calendar, CalendarException } from '@projectapp/shared-types';
import type { FastifyInstance } from 'fastify';
import { auditedMutation } from '../audit/audit-writer.js';
import { resolveSession, requirePermission } from '../auth/context.js';
import { conflict, notFound, validationFailed } from '../errors.js';
import type { AppDeps } from '../app.js';

/**
 * FR-CAL-01..03: calendar CRUD scoped to a project, plus date-specific exceptions.
 *
 * Every route here follows the same cross-org-safety pattern as `routes/projects.ts`
 * (FR-AUTH-04): a calendar or exception that exists but belongs to a different project is
 * `not_found`, never `forbidden` — an endpoint must not become an oracle for which calendar or
 * exception ids exist in a project the caller cannot see.
 */

interface CalendarRow {
  id: string;
  project_id: string | null;
  name: string;
  working_days: number[];
  working_hours_start_minute: number;
  working_hours_end_minute: number;
  is_default: boolean;
}

interface CalendarExceptionRow {
  id: string;
  calendar_id: string;
  // The `pg`/PGlite driver parses a Postgres `date` column into a JS `Date` at UTC midnight;
  // `toException` below normalises either shape down to `YYYY-MM-DD` (`isoDateSchema`).
  date: Date | string;
  is_working: boolean;
  working_hours_start_minute_override: number | null;
  working_hours_end_minute_override: number | null;
}

const toIsoDate = (value: Date | string): string =>
  value instanceof Date ? value.toISOString().slice(0, 10) : value.slice(0, 10);

const toCalendar = (row: CalendarRow): Calendar => ({
  id: row.id as Calendar['id'],
  projectId: row.project_id as Calendar['projectId'],
  name: row.name,
  workingDays: row.working_days,
  workingHoursStartMinute: row.working_hours_start_minute,
  workingHoursEndMinute: row.working_hours_end_minute,
  isDefault: row.is_default,
});

const toException = (row: CalendarExceptionRow): CalendarException => ({
  id: row.id as CalendarException['id'],
  calendarId: row.calendar_id as CalendarException['calendarId'],
  date: toIsoDate(row.date),
  isWorking: row.is_working,
  workingHoursStartMinuteOverride: row.working_hours_start_minute_override,
  workingHoursEndMinuteOverride: row.working_hours_end_minute_override,
});

/** True for a Postgres unique-violation (SQLSTATE 23505) from either `pg` or PGlite. */
const isUniqueViolation = (error: unknown): boolean =>
  typeof error === 'object' &&
  error !== null &&
  'code' in error &&
  (error as { code?: unknown }).code === '23505';

export function registerCalendarRoutes(app: FastifyInstance, deps: AppDeps): void {
  const { exec, now } = deps;

  /** Loads a calendar, scoped to the project id in the URL (FR-AUTH-04). */
  async function loadCalendar(projectId: string, calendarId: string): Promise<CalendarRow> {
    const { rows } = await exec.query<CalendarRow>(
      `SELECT id, project_id, name, working_days, working_hours_start_minute,
              working_hours_end_minute, is_default
         FROM calendar
        WHERE id = $1 AND project_id = $2`,
      [calendarId, projectId],
    );
    const row = rows[0];
    if (row === undefined) throw notFound('Calendar not found');
    return row;
  }

  async function loadExceptions(calendarId: string): Promise<CalendarExceptionRow[]> {
    const { rows } = await exec.query<CalendarExceptionRow>(
      `SELECT id, calendar_id, date, is_working, working_hours_start_minute_override,
              working_hours_end_minute_override
         FROM calendar_exception
        WHERE calendar_id = $1
        ORDER BY date`,
      [calendarId],
    );
    return rows;
  }

  /** FR-CAL-03: every calendar in the project, including the default. Open to every role. */
  app.get<{ Params: { projectId: string } }>(
    '/projects/:projectId/calendars',
    async (request, reply) => {
      const user = await resolveSession(exec, request.headers.authorization, now());
      const { projectId } = request.params;
      await requirePermission(exec, user, projectId, 'project:read');

      const { rows } = await exec.query<CalendarRow>(
        `SELECT id, project_id, name, working_days, working_hours_start_minute,
                working_hours_end_minute, is_default
           FROM calendar
          WHERE project_id = $1
          ORDER BY is_default DESC, name`,
        [projectId],
      );

      return reply.status(200).send({ calendars: rows.map(toCalendar) });
    },
  );

  /** One calendar plus its exceptions. Open to every role. */
  app.get<{ Params: { projectId: string; calendarId: string } }>(
    '/projects/:projectId/calendars/:calendarId',
    async (request, reply) => {
      const user = await resolveSession(exec, request.headers.authorization, now());
      const { projectId, calendarId } = request.params;
      await requirePermission(exec, user, projectId, 'project:read');

      const calendar = await loadCalendar(projectId, calendarId);
      const exceptions = await loadExceptions(calendarId);

      return reply
        .status(200)
        .send({ calendar: toCalendar(calendar), exceptions: exceptions.map(toException) });
    },
  );

  /** FR-CAL-03: an additional named calendar (e.g. one resource's PTO). Admin only. */
  app.post<{ Params: { projectId: string } }>(
    '/projects/:projectId/calendars',
    async (request, reply) => {
      const user = await resolveSession(exec, request.headers.authorization, now());
      const { projectId } = request.params;
      await requirePermission(exec, user, projectId, 'calendar:manage');

      const parsed = createCalendarRequestSchema.safeParse(request.body);
      if (!parsed.success) throw validationFailed(parsed.error.flatten());
      const body = parsed.data;

      // The DB has the same CHECK constraint as a backstop; this surfaces a clean 422 first.
      if (body.workingHoursEndMinute <= body.workingHoursStartMinute) {
        throw validationFailed({
          fieldErrors: { workingHoursEndMinute: ['must be greater than workingHoursStartMinute'] },
        });
      }

      const created = await auditedMutation(
        exec,
        { projectId, actorUserId: user.userId },
        async () => {
          const result = await exec.query<CalendarRow>(
            `INSERT INTO calendar (project_id, name, working_days, working_hours_start_minute,
                                   working_hours_end_minute, is_default)
             VALUES ($1, $2, $3, $4, $5, false)
             RETURNING id, project_id, name, working_days, working_hours_start_minute,
                       working_hours_end_minute, is_default`,
            [
              projectId,
              body.name,
              `{${body.workingDays.join(',')}}`,
              body.workingHoursStartMinute,
              body.workingHoursEndMinute,
            ],
          );
          const after = result.rows[0]!;
          return {
            result: after,
            audit: {
              entityType: 'calendar' as const,
              entityId: after.id,
              action: 'create' as const,
              after: toCalendar(after),
            },
          };
        },
      );

      return reply.status(201).send({ calendar: toCalendar(created), exceptions: [] });
    },
  );

  /** FR-CAL-01: edit any calendar in the project, including the project's own default. Admin only. */
  app.patch<{ Params: { projectId: string; calendarId: string } }>(
    '/projects/:projectId/calendars/:calendarId',
    async (request, reply) => {
      const user = await resolveSession(exec, request.headers.authorization, now());
      const { projectId, calendarId } = request.params;
      await requirePermission(exec, user, projectId, 'calendar:manage');

      const parsed = updateCalendarRequestSchema.safeParse(request.body);
      if (!parsed.success) throw validationFailed(parsed.error.flatten());
      const body = parsed.data;

      const before = await loadCalendar(projectId, calendarId);

      const effectiveStart = body.workingHoursStartMinute ?? before.working_hours_start_minute;
      const effectiveEnd = body.workingHoursEndMinute ?? before.working_hours_end_minute;
      if (effectiveEnd <= effectiveStart) {
        throw validationFailed({
          fieldErrors: { workingHoursEndMinute: ['must be greater than workingHoursStartMinute'] },
        });
      }

      const updated = await auditedMutation(
        exec,
        { projectId, actorUserId: user.userId },
        async () => {
          const result = await exec.query<CalendarRow>(
            `UPDATE calendar
                SET name = COALESCE($3, name),
                    working_days = COALESCE($4, working_days),
                    working_hours_start_minute = COALESCE($5, working_hours_start_minute),
                    working_hours_end_minute = COALESCE($6, working_hours_end_minute)
              WHERE id = $1 AND project_id = $2
          RETURNING id, project_id, name, working_days, working_hours_start_minute,
                    working_hours_end_minute, is_default`,
            [
              calendarId,
              projectId,
              body.name ?? null,
              body.workingDays === undefined ? null : `{${body.workingDays.join(',')}}`,
              body.workingHoursStartMinute ?? null,
              body.workingHoursEndMinute ?? null,
            ],
          );
          const after = result.rows[0]!;
          return {
            result: after,
            audit: {
              entityType: 'calendar' as const,
              entityId: calendarId,
              action: 'update' as const,
              before: toCalendar(before),
              after: toCalendar(after),
            },
          };
        },
      );

      const exceptions = await loadExceptions(calendarId);
      return reply
        .status(200)
        .send({ calendar: toCalendar(updated), exceptions: exceptions.map(toException) });
    },
  );

  /** FR-CAL-02: a date-specific override (holiday or half-day). Admin only. */
  app.post<{ Params: { projectId: string; calendarId: string } }>(
    '/projects/:projectId/calendars/:calendarId/exceptions',
    async (request, reply) => {
      const user = await resolveSession(exec, request.headers.authorization, now());
      const { projectId, calendarId } = request.params;
      await requirePermission(exec, user, projectId, 'calendar:manage');

      const parsed = createCalendarExceptionRequestSchema.safeParse(request.body);
      if (!parsed.success) throw validationFailed(parsed.error.flatten());
      const body = parsed.data;

      // Confirms the calendar belongs to this project before mutating (FR-AUTH-04).
      await loadCalendar(projectId, calendarId);

      let created: CalendarExceptionRow;
      try {
        created = await auditedMutation(exec, { projectId, actorUserId: user.userId }, async () => {
          const result = await exec.query<CalendarExceptionRow>(
            `INSERT INTO calendar_exception (calendar_id, date, is_working,
                                                working_hours_start_minute_override,
                                                working_hours_end_minute_override)
               VALUES ($1, $2, $3, $4, $5)
               RETURNING id, calendar_id, date, is_working, working_hours_start_minute_override,
                         working_hours_end_minute_override`,
            [
              calendarId,
              body.date,
              body.isWorking,
              body.workingHoursStartMinuteOverride,
              body.workingHoursEndMinuteOverride,
            ],
          );
          const after = result.rows[0]!;
          return {
            result: after,
            audit: {
              entityType: 'calendar' as const,
              entityId: calendarId,
              action: 'update' as const,
              before: { exceptionAdded: false },
              after: { exceptionAdded: true, exception: toException(after) },
            },
          };
        });
      } catch (error) {
        // UNIQUE (calendar_id, date): surface a clean 409, not the raw constraint violation.
        if (isUniqueViolation(error)) {
          throw conflict('An exception already exists for this calendar on that date');
        }
        throw error;
      }

      return reply.status(201).send({ exception: toException(created) });
    },
  );

  /** Remove a date-specific exception. Admin only. */
  app.delete<{ Params: { projectId: string; calendarId: string; exceptionId: string } }>(
    '/projects/:projectId/calendars/:calendarId/exceptions/:exceptionId',
    async (request, reply) => {
      const user = await resolveSession(exec, request.headers.authorization, now());
      const { projectId, calendarId } = request.params;
      await requirePermission(exec, user, projectId, 'calendar:manage');

      // A malformed exception id cannot match any row, so it is not_found the same as a
      // well-formed but absent one (FR-AUTH-04: no id shape leaks information).
      const paramsParsed = calendarExceptionIdParamSchema.safeParse(request.params);
      if (!paramsParsed.success) throw notFound('Calendar exception not found');
      const { exceptionId } = paramsParsed.data;

      // Confirms the calendar belongs to this project before touching the exception.
      await loadCalendar(projectId, calendarId);

      const existing = await exec.query<CalendarExceptionRow>(
        `SELECT id, calendar_id, date, is_working, working_hours_start_minute_override,
                working_hours_end_minute_override
           FROM calendar_exception
          WHERE id = $1 AND calendar_id = $2`,
        [exceptionId, calendarId],
      );
      const before = existing.rows[0];
      if (before === undefined) throw notFound('Calendar exception not found');

      await auditedMutation(exec, { projectId, actorUserId: user.userId }, async () => {
        await exec.query(`DELETE FROM calendar_exception WHERE id = $1`, [exceptionId]);
        return {
          result: null,
          audit: {
            entityType: 'calendar' as const,
            entityId: calendarId,
            action: 'update' as const,
            before: { exceptionRemoved: false, exception: toException(before) },
            after: { exceptionRemoved: true },
          },
        };
      });

      return reply.status(204).send();
    },
  );
}
