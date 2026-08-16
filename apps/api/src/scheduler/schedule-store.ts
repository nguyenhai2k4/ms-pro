import type { SqlExecutor } from '@projectapp/db';
import type { CpmTaskSchedule } from '@projectapp/shared-types';

/**
 * Writes `packages/cpm-engine`'s per-task result to `task_schedule` (migration 0003, ADR-010
 * point 6) — the engine-owned table that holds ES/EF/LS/LF/total float/critical/conflict, never
 * `task` columns.
 *
 * ## One query, not one per row
 *
 * A full recompute over 5,000 tasks that wrote one `UPDATE`/`INSERT` per row would spend its
 * entire FR-SCH-06 budget on round trips before the first byte of savings from the CPM algorithm
 * itself. This function instead builds a single `INSERT ... SELECT ... FROM unnest(...) ON
 * CONFLICT (task_id) DO UPDATE` from column-shaped arrays — the same "batch by set, not by row"
 * fix `graph.ts` applies to the read side, applied here to the write side.
 *
 * `computedAt` is a single scalar, not a per-row array: every row in one call is written by the
 * same recompute, so it gets the same timestamp, supplied by the caller's clock the same way
 * `MutationIntentEnvelope.issuedAt` is (`apps/api/src/scheduler/rollup.ts`) — never read from
 * inside this function, and never from inside the pure engine (CLAUDE.md invariant 1).
 *
 * ## What this is NOT
 *
 * This is a storage primitive, not the write path. It does not call the engine, does not decide
 * *which* tasks to recompute, and is not wired into any route yet — that is W5-2, dispatched after
 * the calendar kernel and CPM passes exist. It also never touches `task.start` / `task.finish` /
 * `task.duration_hours`; those stay `applyTaskIntent`'s (ADR-007) responsibility.
 */
export async function bulkUpsertTaskSchedules(
  exec: SqlExecutor,
  computedAt: string,
  schedules: readonly CpmTaskSchedule[],
): Promise<void> {
  if (schedules.length === 0) return;

  const taskIds: string[] = [];
  const earlyStarts: string[] = [];
  const earlyFinishes: string[] = [];
  const lateStarts: string[] = [];
  const lateFinishes: string[] = [];
  const totalFloatHours: number[] = [];
  const isCritical: boolean[] = [];
  const hasScheduleConflict: boolean[] = [];

  for (const schedule of schedules) {
    taskIds.push(schedule.taskId);
    earlyStarts.push(schedule.earlyStart);
    earlyFinishes.push(schedule.earlyFinish);
    lateStarts.push(schedule.lateStart);
    lateFinishes.push(schedule.lateFinish);
    totalFloatHours.push(schedule.totalFloatHours);
    isCritical.push(schedule.isCritical);
    hasScheduleConflict.push(schedule.hasScheduleConflict);
  }

  await exec.query(
    `INSERT INTO task_schedule
       (task_id, early_start, early_finish, late_start, late_finish, total_float_hours,
        is_critical, has_schedule_conflict, computed_at)
     SELECT u.task_id, u.early_start, u.early_finish, u.late_start, u.late_finish,
            u.total_float_hours, u.is_critical, u.has_schedule_conflict, $9::timestamptz
       FROM unnest(
              $1::uuid[], $2::timestamptz[], $3::timestamptz[], $4::timestamptz[],
              $5::timestamptz[], $6::double precision[], $7::boolean[], $8::boolean[]
            ) AS u(task_id, early_start, early_finish, late_start, late_finish,
                    total_float_hours, is_critical, has_schedule_conflict)
     ON CONFLICT (task_id) DO UPDATE SET
       early_start = EXCLUDED.early_start,
       early_finish = EXCLUDED.early_finish,
       late_start = EXCLUDED.late_start,
       late_finish = EXCLUDED.late_finish,
       total_float_hours = EXCLUDED.total_float_hours,
       is_critical = EXCLUDED.is_critical,
       has_schedule_conflict = EXCLUDED.has_schedule_conflict,
       computed_at = EXCLUDED.computed_at`,
    [
      taskIds,
      earlyStarts,
      earlyFinishes,
      lateStarts,
      lateFinishes,
      totalFloatHours,
      isCritical,
      hasScheduleConflict,
      computedAt,
    ],
  );
}
