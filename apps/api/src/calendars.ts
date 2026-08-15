import type { SqlExecutor } from '@projectapp/db';
import type { CalendarTemplate } from '@projectapp/shared-types';

/**
 * FR-CAL-04: a small set of calendar templates selectable at project creation.
 *
 * P0 scope is the weekly working pattern only. Date-specific exceptions (FR-CAL-02) — the US
 * holiday set that makes the `us` template differ from `mon_fri` in practice — land with the
 * calendar work in P1. The template is recorded now so projects created in P0 do not need
 * migrating later; today the two templates share a weekly pattern and that is stated, not hidden.
 */

interface CalendarTemplateDefinition {
  readonly name: string;
  readonly workingDays: readonly number[];
  readonly startMinute: number;
  readonly endMinute: number;
}

export const CALENDAR_TEMPLATES: Readonly<Record<CalendarTemplate, CalendarTemplateDefinition>> =
  Object.freeze({
    mon_fri: {
      name: 'Standard (Mon-Fri, 09:00-17:00)',
      workingDays: [1, 2, 3, 4, 5],
      startMinute: 9 * 60,
      endMinute: 17 * 60,
    },
    us: {
      name: 'United States (Mon-Fri, 09:00-17:00)',
      workingDays: [1, 2, 3, 4, 5],
      startMinute: 9 * 60,
      endMinute: 17 * 60,
    },
  });

/** UC-1 error flow: an unrecognised template falls back to Mon-Fri rather than failing creation. */
export function resolveTemplate(template: string | undefined): CalendarTemplate {
  return template === 'us' ? 'us' : 'mon_fri';
}

export async function createProjectCalendar(
  exec: SqlExecutor,
  template: CalendarTemplate,
): Promise<string> {
  const definition = CALENDAR_TEMPLATES[template];
  const { rows } = await exec.query<{ id: string }>(
    `INSERT INTO calendar (project_id, name, working_days, working_hours_start_minute,
                           working_hours_end_minute, is_default)
     VALUES (NULL, $1, $2, $3, $4, true)
     RETURNING id`,
    [
      definition.name,
      `{${definition.workingDays.join(',')}}`,
      definition.startMinute,
      definition.endMinute,
    ],
  );
  return rows[0]!.id;
}
