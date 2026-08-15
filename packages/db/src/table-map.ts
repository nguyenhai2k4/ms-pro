import type { EntityName } from '@projectapp/shared-types';

/**
 * The one place that maps a contract entity to its table. Two names differ from the entity for
 * SQL reasons and nothing else: `user` and `comment` are awkward identifiers in Postgres.
 *
 * `schema.test.ts` asserts every entity here exists as a table in the applied schema, so an
 * entity added to the contract without a table — or a table renamed without updating this map —
 * fails the build rather than failing the first query that touches it.
 */
export const TABLE_BY_ENTITY: Readonly<Record<EntityName, string>> = Object.freeze({
  Organization: 'organization',
  User: 'app_user',
  Project: 'project',
  ProjectMember: 'project_member',
  Task: 'task',
  Dependency: 'dependency',
  Resource: 'resource',
  Assignment: 'assignment',
  Calendar: 'calendar',
  CalendarException: 'calendar_exception',
  Baseline: 'baseline',
  Comment: 'task_comment',
  Mention: 'mention',
  Notification: 'notification',
  AuditLogEntry: 'audit_log_entry',
  ExportJob: 'export_job',
});
