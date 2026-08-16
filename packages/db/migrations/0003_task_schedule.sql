-- 0003_task_schedule.sql — P2 entry: the CPM engine's derived schedule values get their own table.
--
-- ADR-010 point 6: `task.start`, `task.finish` and `task.duration_hours` stay task columns with
-- their existing write path (P1's `apps/api/src/scheduler/rollup.ts`, retired in a later P2 work
-- item, not this one). Early/late start/finish, total float, criticality and the manual-conflict
-- flag are a different kind of value: they are *derived* from the whole graph by
-- `packages/cpm-engine` and never user-editable. `schedule.ts` already said why a task column would
-- be wrong — "float that can be set by hand is not float" — and this migration is what makes that
-- structural rather than a comment: there is no PATCH endpoint for this table, and there never will
-- be one that writes to it directly.
--
-- One row per task **that has been through a CPM computation**. A task that has never been
-- recomputed (just created, or the project has never run a full pass) has no row here — not a row
-- of zeros/false. `total_float_hours = 0` is a real computed answer (the task is on the critical
-- path); a fabricated `0` for a task nobody has scheduled yet is indistinguishable from that at the
-- SQL level, which is exactly the ambiguity a nullable-with-a-default would introduce. Absence is
-- therefore the only honest way to represent "not computed", so every column below is NOT NULL and
-- the row simply does not exist until `packages/cpm-engine` produces one.
--
-- Source of truth for the shape: `packages/shared-types/src/cpm.ts`'s `cpmTaskScheduleSchema`
-- (`taskScheduleComputedSchema` extended with `start`/`finish`/`durationHours`, which are the three
-- fields this table deliberately excludes). `computed_at` has no equivalent in the contract — it is
-- a persistence-layer fact ("when this row was written"), stamped by the caller's own clock the
-- same way `MutationIntentEnvelope.issuedAt` is (`apps/api/src/scheduler/rollup.ts`), not read by
-- the pure engine itself (CLAUDE.md invariant 1: no clock reads inside `packages/cpm-engine`).
--
-- `task_schedule` is deliberately absent from `packages/db/src/table-map.ts`'s `TABLE_BY_ENTITY`:
-- it is not a `packages/shared-types/src/entities.ts` "stored entity" in the ENTITY_SCHEMAS sense,
-- it is CPM-internal and contracted by `cpm.ts` instead. See the accompanying work-item report for
-- the consequence this has for `entities.test.ts`'s ERD-coverage assertion.
--
-- Implements: FR-SCH-04, FR-SCH-05.

CREATE TABLE task_schedule (
  task_id                 uuid PRIMARY KEY REFERENCES task (id) ON DELETE CASCADE,

  -- FR-SCH-04 forward pass.
  early_start             timestamptz NOT NULL,
  early_finish            timestamptz NOT NULL,
  -- FR-SCH-04 backward pass.
  late_start              timestamptz NOT NULL,
  late_finish             timestamptz NOT NULL,

  -- FR-SCH-05: Total Float = LS - ES, in hours. May be negative on an over-constrained project —
  -- unlike task.duration_hours there is no `>= 0` check here, because a negative float is a real
  -- and meaningful answer (FR-SCH-08), not an input error.
  total_float_hours       double precision NOT NULL,
  -- FR-SCH-05: float === 0. Rendered red in the Gantt and filterable in the grid (FR-SCH-10).
  is_critical             boolean NOT NULL,
  -- FR-SCH-08: a manually-scheduled task whose fixed dates conflict with its predecessors, or a
  -- hard constraint (FR-TSK-06) the graph could not satisfy. The task still has a row here — it was
  -- still scheduled — it is just flagged.
  has_schedule_conflict   boolean NOT NULL,

  -- When this row was (re)computed. Stamped by the caller's clock at write time, not derived from
  -- any column above — two different projects recomputed in the same request still get their own
  -- timestamp because this is a per-row write, not a per-request one.
  computed_at             timestamptz NOT NULL
);

-- No separate index on task_id: it is the primary key. No project_id column and therefore no
-- project-scoped index either — a project's full schedule is loaded by joining through `task`,
-- which is already indexed on `(project_id, parent_id)` (0001_init.sql), and adding a denormalised
-- project_id here would be a second place that same fact could drift from `task.project_id`.
