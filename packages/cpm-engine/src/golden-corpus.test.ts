import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CPM_ERROR_DIAGNOSTIC_CODES,
  cpmScheduleInputSchema,
  cpmScheduleResultSchema,
} from '@projectapp/shared-types';
import type {
  CpmCalendar,
  CpmScheduleInput,
  CpmScheduledResult,
  TaskId,
} from '@projectapp/shared-types';
import { describe, expect, it } from 'vitest';
import { detectCycle } from './cycle.js';
import { buildGraph } from './graph.js';
import { topologicalOrder } from './topological-order.js';
import type { GoldenFixture } from './test-support/golden/index.js';
import { ESCALATIONS, F19_CYCLE_REJECTED, GOLDEN_FIXTURES } from './test-support/golden/index.js';

/**
 * The golden corpus's own test suite.
 *
 * There is no `computeSchedule` yet — W3-1 builds it against these fixtures — so this file cannot
 * assert that the engine agrees with them. What it *can* assert, and what would otherwise rot
 * silently between now and then, is that the corpus is **well-formed**: every fixture parses against
 * the contract schemas, every expectation is internally consistent with its own input, and the parts
 * that can be cross-checked against already-merged W1-1 code (cycle detection, topological depth)
 * are cross-checked rather than taken on trust.
 *
 * The distinction matters for what this suite proves. A fixture that has drifted out of contract
 * shape, or that claims a task is critical while reporting float 8, is worse than a missing fixture:
 * it will be "fixed" by whoever is trying to make W3-1 pass, and the fix will be to the expectation.
 */

const CORPUS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'test-support', 'golden');

/** ISO-8601 UTC strings in one fixed format compare chronologically under `<`. */
function maxIso(values: readonly string[]): string {
  return values.reduce((best, value) => (value > best ? value : best));
}

/**
 * Working hours between two instants on a given calendar — an **independent** re-derivation, used
 * only to check the corpus against itself.
 *
 * This is a second implementation of the arithmetic FR-SCH-07 asks the engine for, and that is the
 * point: it is written from the calendar fields directly, it never sees a fixture's `wh` derivation,
 * and it is what catches a mistyped date literal. A transposed digit in an `earlyFinish` is
 * otherwise invisible — every other assertion in this file would still pass, and the error would
 * surface as a W3-1 test failure that looks like an engine bug.
 *
 * It is emphatically *not* a schedule: durations come from the input and ES/EF/LS/LF come from the
 * hand derivations in the fixture files. All this does is confirm that `finish - start` on the
 * fixture's own calendar equals the duration the fixture claims.
 */
const MINUTES_PER_DAY = 1440;

function workingHoursBetween(startIso: string, finishIso: string, calendar: CpmCalendar): number {
  const start = Date.parse(startIso);
  const finish = Date.parse(finishIso);
  let total = 0;

  for (
    let dayMs = Date.parse(`${startIso.slice(0, 10)}T00:00:00.000Z`);
    dayMs <= finish;
    dayMs += MINUTES_PER_DAY * 60_000
  ) {
    const date = new Date(dayMs).toISOString().slice(0, 10);
    const exception = calendar.exceptions.find((e) => e.date === date);

    let openMinute: number;
    let closeMinute: number;
    if (exception !== undefined) {
      if (!exception.isWorking) continue;
      openMinute = exception.startMinuteOverride ?? calendar.workingHoursStartMinute;
      closeMinute = exception.endMinuteOverride ?? calendar.workingHoursEndMinute;
    } else {
      // ISO weekday, 1 = Monday, derived in UTC (ADR-011).
      const isoWeekday = new Date(dayMs).getUTCDay() === 0 ? 7 : new Date(dayMs).getUTCDay();
      if (!calendar.workingDays.includes(isoWeekday)) continue;
      openMinute = calendar.workingHoursStartMinute;
      closeMinute = calendar.workingHoursEndMinute;
    }

    const open = Math.max(start, dayMs + openMinute * 60_000);
    const close = Math.min(finish, dayMs + closeMinute * 60_000);
    if (close > open) total += (close - open) / 3_600_000;
  }

  return total;
}

function isScheduled(fixture: GoldenFixture): fixture is GoldenFixture & {
  expected: CpmScheduledResult;
} {
  return fixture.expected.status === 'scheduled';
}

const SCHEDULED = GOLDEN_FIXTURES.filter(isScheduled);

function taskById(input: CpmScheduleInput, id: TaskId) {
  return input.tasks.find((task) => task.id === id);
}

describe('the golden corpus is complete enough to be worth having', () => {
  it('has at least the 12 fixtures the charter asks for', () => {
    expect(GOLDEN_FIXTURES.length).toBeGreaterThanOrEqual(12);
  });

  it('gives every fixture a unique id, a claim, and at least one FR- id', () => {
    const ids = GOLDEN_FIXTURES.map((fixture) => fixture.id);
    expect(new Set(ids).size).toBe(ids.length);

    for (const fixture of GOLDEN_FIXTURES) {
      expect(fixture.id, 'fixture ids are quoted in bug reports').toMatch(/^F\d\d-[a-z0-9-]+$/);
      expect(fixture.proves.length, `${fixture.id} must say what it proves`).toBeGreaterThan(20);
      expect(fixture.requirements.length, `${fixture.id} must cite an FR- id`).toBeGreaterThan(0);
      for (const requirement of fixture.requirements) {
        expect(requirement).toMatch(/^FR-[A-Z]+-\d\d$/);
      }
    }
  });

  it('covers every dependency type (FR-SCH-01)', () => {
    const types = new Set(
      GOLDEN_FIXTURES.flatMap((fixture) => fixture.input.dependencies.map((d) => d.type)),
    );
    expect([...types].sort()).toEqual(['FF', 'FS', 'SF', 'SS']);
  });

  it('covers signed lag in both directions (FR-SCH-02)', () => {
    const lags = GOLDEN_FIXTURES.flatMap((fixture) =>
      fixture.input.dependencies.map((d) => d.lagHours),
    );
    expect(
      lags.some((lag) => lag > 0),
      'no positive lag anywhere',
    ).toBe(true);
    expect(
      lags.some((lag) => lag < 0),
      'no lead (negative lag) anywhere',
    ).toBe(true);
  });

  it('covers all eight constraint types (FR-TSK-06)', () => {
    const constraints = new Set(
      GOLDEN_FIXTURES.flatMap((fixture) => fixture.input.tasks.map((t) => t.constraintType)),
    );
    expect([...constraints].sort()).toEqual([
      'ALAP',
      'ASAP',
      'FNET',
      'FNLT',
      'MFO',
      'MSO',
      'SNET',
      'SNLT',
    ]);
  });

  it('covers manual scheduling, milestones, summaries, calendar exceptions and a rejection', () => {
    const tasks = GOLDEN_FIXTURES.flatMap((fixture) => fixture.input.tasks);

    expect(
      tasks.some((t) => t.scheduleMode === 'manual'),
      'FR-TSK-05',
    ).toBe(true);
    expect(
      tasks.some((t) => t.isMilestone),
      'FR-TSK-04',
    ).toBe(true);
    expect(
      tasks.some((t) => t.parentId !== null),
      'FR-TSK-02',
    ).toBe(true);
    expect(
      GOLDEN_FIXTURES.some((f) => f.input.calendars.some((c) => c.exceptions.length > 0)),
      'FR-CAL-02',
    ).toBe(true);
    expect(
      GOLDEN_FIXTURES.some((f) => f.expected.status === 'rejected'),
      'FR-SCH-03',
    ).toBe(true);
  });

  it('reaches four levels of WBS somewhere (FR-TSK-02)', () => {
    const deepest = Math.max(
      ...GOLDEN_FIXTURES.map((fixture) => {
        const parentOf = new Map(fixture.input.tasks.map((t) => [t.id, t.parentId]));
        return Math.max(
          ...fixture.input.tasks.map((task) => {
            let levels = 1;
            for (let p = task.parentId; p !== null; p = parentOf.get(p) ?? null) levels += 1;
            return levels;
          }),
        );
      }),
    );
    expect(deepest).toBeGreaterThanOrEqual(4);
  });

  it('covers zero, positive and negative float, and both diagnostic severities in a schedule', () => {
    const floats = SCHEDULED.flatMap((f) => f.expected.taskSchedules.map((s) => s.totalFloatHours));
    expect(floats.some((f) => f === 0)).toBe(true);
    expect(
      floats.some((f) => f > 0),
      'no fixture shows slack',
    ).toBe(true);
    expect(
      floats.some((f) => f < 0),
      'no fixture shows an over-constrained project',
    ).toBe(true);

    const codes = new Set(SCHEDULED.flatMap((f) => f.expected.diagnostics.map((d) => d.code)));
    expect(codes.has('manual_conflict'), 'FR-SCH-08').toBe(true);
    expect(codes.has('constraint_violation'), 'FR-TSK-06').toBe(true);
  });

  it('discriminates a manual task’s finish from its graph-implied earlyFinish (ESC-6)', () => {
    // The ruling is only pinned if some fixture would give a *different* answer under the other
    // reading. A manual task whose fixed dates coincide with the graph-implied ones — F07 — cannot
    // do that, so assert the discriminating shape exists rather than trusting F20's comment.
    const discriminating = SCHEDULED.some((fixture) =>
      fixture.input.dependencies.some((edge) => {
        const predecessor = taskById(fixture.input, edge.predecessorId);
        if (predecessor?.scheduleMode !== 'manual') return false;
        const row = fixture.expected.taskSchedules.find((r) => r.taskId === edge.predecessorId);
        const successor = fixture.expected.taskSchedules.find((r) => r.taskId === edge.successorId);
        if (row === undefined || successor === undefined) return false;
        return (
          edge.type === 'FS' &&
          edge.lagHours === 0 &&
          row.finish !== row.earlyFinish &&
          successor.earlyStart === row.finish
        );
      }),
    );
    expect(discriminating, 'no fixture separates the manual finish from the early finish').toBe(
      true,
    );
  });

  it('carries no unresolved semantics into W3-1', () => {
    // ESCALATIONS is the corpus's contract with the tech-lead. An entry still marked open here
    // means an implementation work item is about to guess at something that was escalated
    // precisely so it would not have to.
    expect(ESCALATIONS.length).toBeGreaterThanOrEqual(6);
    for (const escalation of ESCALATIONS) {
      expect(escalation.id, 'escalation id').toMatch(/^ESC-\d+$/);
      expect(
        ['ratified', 'overruled', 'ruled', 'resolved'],
        `${escalation.id} is not resolved`,
      ).toContain(escalation.status);
      expect(escalation.question.length, `${escalation.id} question`).toBeGreaterThan(20);
      expect(escalation.adopted.length, `${escalation.id} adopted`).toBeGreaterThan(20);
      expect(escalation.affects.length, `${escalation.id} affects`).toBeGreaterThan(5);
    }
    expect(new Set(ESCALATIONS.map((e) => e.id)).size).toBe(ESCALATIONS.length);
  });
});

describe('every fixture parses against the contract schemas (acceptance b)', () => {
  it.each(GOLDEN_FIXTURES.map((fixture) => [fixture.id, fixture] as const))(
    '%s — input parses as CpmScheduleInput',
    (_id, fixture) => {
      expect(() => cpmScheduleInputSchema.parse(fixture.input)).not.toThrow();
    },
  );

  it.each(GOLDEN_FIXTURES.map((fixture) => [fixture.id, fixture] as const))(
    '%s — expected parses as CpmScheduleResult',
    (_id, fixture) => {
      expect(() => cpmScheduleResultSchema.parse(fixture.expected)).not.toThrow();
    },
  );

  it('the schemas would actually have rejected a malformed fixture', () => {
    // Guard against a vacuous pass: if the schemas accepted anything, the 38 assertions above would
    // be decorative. Break one rule from each schema and require a throw.
    const first = GOLDEN_FIXTURES[0];
    expect(first).toBeDefined();
    if (first === undefined) return;

    expect(() =>
      cpmScheduleInputSchema.parse({ ...first.input, projectStart: 'not-an-instant' }),
    ).toThrow();
    expect(() => cpmScheduleResultSchema.parse({ ...first.expected, status: 'maybe' })).toThrow();
  });
});

describe('every fixture is internally consistent with its own input (acceptance a)', () => {
  it.each(GOLDEN_FIXTURES.map((fixture) => [fixture.id, fixture] as const))(
    '%s — the input graph is structurally sound',
    (_id, fixture) => {
      const ids = new Set(fixture.input.tasks.map((task) => task.id));
      expect(ids.size, 'duplicate task id').toBe(fixture.input.tasks.length);

      const dependencyIds = new Set(fixture.input.dependencies.map((d) => d.id));
      expect(dependencyIds.size, 'duplicate dependency id').toBe(fixture.input.dependencies.length);

      for (const dependency of fixture.input.dependencies) {
        expect(ids.has(dependency.predecessorId), `${dependency.id} predecessor missing`).toBe(
          true,
        );
        expect(ids.has(dependency.successorId), `${dependency.id} successor missing`).toBe(true);
        expect(dependency.predecessorId, 'self-link').not.toBe(dependency.successorId);
      }

      const calendarIds = new Set(fixture.input.calendars.map((calendar) => calendar.id));
      expect(calendarIds.has(fixture.input.defaultCalendarId)).toBe(true);
      for (const task of fixture.input.tasks) {
        if (task.calendarId !== null) expect(calendarIds.has(task.calendarId)).toBe(true);
      }
    },
  );

  it.each(GOLDEN_FIXTURES.map((fixture) => [fixture.id, fixture] as const))(
    '%s — the expected status matches whether the input actually contains a cycle',
    (_id, fixture) => {
      // Cross-check against W1-1 code that already exists. A fixture claiming `scheduled` over a
      // cyclic graph, or `rejected` over an acyclic one, is a fixture nobody can satisfy.
      const cycle = detectCycle(fixture.input.tasks, fixture.input.dependencies);
      expect(cycle === null).toBe(fixture.expected.status === 'scheduled');
    },
  );

  it.each(SCHEDULED.map((fixture) => [fixture.id, fixture] as const))(
    '%s — taskSchedules covers every task exactly once, ascending by taskId',
    (_id, fixture) => {
      const scheduledIds = fixture.expected.taskSchedules.map((s) => s.taskId);
      expect([...scheduledIds].sort(), 'not in canonical ascending order').toEqual(scheduledIds);
      expect(new Set(scheduledIds).size).toBe(scheduledIds.length);
      expect([...scheduledIds].sort()).toEqual([...fixture.input.tasks.map((t) => t.id)].sort());
    },
  );

  it.each(SCHEDULED.map((fixture) => [fixture.id, fixture] as const))(
    '%s — isCritical, projectFinish and start/finish agree with the rest of the row',
    (_id, fixture) => {
      for (const row of fixture.expected.taskSchedules) {
        // FR-SCH-05 (docs/FRS.md v1.2) and taskScheduleComputedSchema define isCritical as
        // float <= 0 — see ESC-4, where the corpus's original literal `=== 0` reading was
        // overruled. `taskSchedule()` derives the flag, so this assertion is what proves no
        // fixture reached past the helper and hand-set a contradicting one.
        expect(row.isCritical, `${row.taskId} isCritical`).toBe(row.totalFloatHours <= 0);
        expect(row.earlyStart <= row.earlyFinish, `${row.taskId} ES after EF`).toBe(true);
        expect(row.lateStart <= row.lateFinish, `${row.taskId} LS after LF`).toBe(true);
        expect(row.start <= row.finish, `${row.taskId} start after finish`).toBe(true);

        const task = taskById(fixture.input, row.taskId);
        expect(task, `${row.taskId} not in the input`).toBeDefined();
        if (task === undefined) continue;

        if (task.scheduleMode === 'manual') {
          // FR-TSK-05: the user's dates, unmoved.
          expect(row.start).toBe(task.manualStart);
          expect(row.finish).toBe(task.manualFinish);
        } else if (task.constraintType !== 'ALAP') {
          // cpm.ts: "For an `auto` task start === earlyStart and finish === earlyFinish." ALAP is
          // the documented exception (ESC-5) and F15 is where it is asserted instead.
          expect(row.start, `${row.taskId} start`).toBe(row.earlyStart);
          expect(row.finish, `${row.taskId} finish`).toBe(row.earlyFinish);
        }
      }

      expect(fixture.expected.projectFinish, 'projectFinish is max(earlyFinish)').toBe(
        maxIso(fixture.expected.taskSchedules.map((row) => row.earlyFinish)),
      );
    },
  );

  it.each(SCHEDULED.map((fixture) => [fixture.id, fixture] as const))(
    '%s — a leaf’s reported duration is its input duration',
    (_id, fixture) => {
      const parentIds = new Set(
        fixture.input.tasks.map((task) => task.parentId).filter((id) => id !== null),
      );
      for (const row of fixture.expected.taskSchedules) {
        if (parentIds.has(row.taskId)) continue; // summary: duration is derived, not carried over
        const task = taskById(fixture.input, row.taskId);
        expect(row.durationHours, `${row.taskId} duration`).toBe(task?.durationHours);
      }
    },
  );

  it.each(SCHEDULED.map((fixture) => [fixture.id, fixture] as const))(
    '%s — every date literal spans exactly its task’s duration in working hours',
    (_id, fixture) => {
      // The transcription check. Re-derives the span from the fixture's own calendar, independently
      // of the `wh` arithmetic in its comment block, and requires the two to agree.
      const calendar = fixture.input.calendars.find(
        (c) => c.id === fixture.input.defaultCalendarId,
      );
      expect(calendar).toBeDefined();
      if (calendar === undefined) return;
      // Every fixture uses one calendar for every task; a per-task override would need this lookup
      // to move inside the loop.
      expect(fixture.input.tasks.every((task) => task.calendarId === null)).toBe(true);

      for (const row of fixture.expected.taskSchedules) {
        const span = (from: string, to: string) => workingHoursBetween(from, to, calendar);

        expect(span(row.earlyStart, row.earlyFinish), `${row.taskId} ES..EF`).toBe(
          row.durationHours,
        );
        expect(span(row.start, row.finish), `${row.taskId} start..finish`).toBe(row.durationHours);
        // Summaries included. Under the corpus's original ESC-2 rule a summary's LS/LF were min/max
        // over children with different floats, so LF - LS was not its duration and this assertion
        // had to skip them. The corrected rule shifts ES and EF by the *same* float, so the late
        // span equals the early span for every task, summary or leaf — no exemption left to hide in.
        expect(span(row.lateStart, row.lateFinish), `${row.taskId} LS..LF`).toBe(row.durationHours);
      }
    },
  );

  it.each(SCHEDULED.map((fixture) => [fixture.id, fixture] as const))(
    '%s — every summary rolls up per FR-TSK-03 and ESC-2',
    (_id, fixture) => {
      // The check that keeps the corrected ESC-2 rule honest. It re-derives each summary's four
      // dates and its float from its DIRECT children, independently of the hand derivation in the
      // fixture's comment, and requires the two to agree. Bottom-up ordering is not needed: every
      // row already carries its own float, so a level-3 summary reads its level-2 child's float
      // straight off the expectation rather than recomputing it.
      const calendar = fixture.input.calendars.find(
        (c) => c.id === fixture.input.defaultCalendarId,
      );
      expect(calendar).toBeDefined();
      if (calendar === undefined) return;

      const rowOf = new Map(fixture.expected.taskSchedules.map((row) => [row.taskId, row]));
      const childrenOf = new Map<TaskId, TaskId[]>();
      for (const task of fixture.input.tasks) {
        if (task.parentId === null) continue;
        childrenOf.set(task.parentId, [...(childrenOf.get(task.parentId) ?? []), task.id]);
      }

      for (const [parentId, childIds] of childrenOf) {
        const parent = rowOf.get(parentId);
        expect(parent, `${parentId} has children but no schedule row`).toBeDefined();
        if (parent === undefined) continue;
        const children = childIds.map((id) => rowOf.get(id)).filter((row) => row !== undefined);
        expect(children.length).toBe(childIds.length);

        // FR-TSK-03, the early side.
        expect(parent.earlyStart, `${parentId} ES = min(child ES)`).toBe(
          children.map((c) => c.earlyStart).reduce((a, b) => (b < a ? b : a)),
        );
        expect(parent.earlyFinish, `${parentId} EF = max(child EF)`).toBe(
          maxIso(children.map((c) => c.earlyFinish)),
        );

        // ESC-2, the late side: float is the least slack among the direct children, and LS/LF are
        // ES/EF shifted by exactly that much in working time.
        const float = Math.min(...children.map((c) => c.totalFloatHours));
        expect(parent.totalFloatHours, `${parentId} float = min(child float)`).toBe(float);
        expect(
          workingHoursBetween(parent.earlyStart, parent.lateStart, calendar),
          `${parentId} LS - ES`,
        ).toBe(float);
        expect(
          workingHoursBetween(parent.earlyFinish, parent.lateFinish, calendar),
          `${parentId} LF - EF`,
        ).toBe(float);
        // The property the old rule failed: a summary spanning a critical child is itself critical.
        expect(parent.isCritical, `${parentId} critical iff a child is`).toBe(
          children.some((c) => c.isCritical),
        );
      }
    },
  );

  it('the span checker would have caught a mistyped literal', () => {
    // Guard against a vacuous pass: if `workingHoursBetween` returned the duration no matter what,
    // the assertions above would be decorative. Mon 08:00 -> Tue 16:00 on Mon-Fri 08:00-16:00 is 16
    // working hours, and the weekend in the middle of the second span is skipped.
    const calendar: CpmCalendar = {
      id: F19_CYCLE_REJECTED.input.defaultCalendarId,
      workingDays: [1, 2, 3, 4, 5],
      workingHoursStartMinute: 480,
      workingHoursEndMinute: 960,
      exceptions: [],
    };
    expect(
      workingHoursBetween('2026-09-07T08:00:00.000Z', '2026-09-08T16:00:00.000Z', calendar),
    ).toBe(16);
    expect(
      workingHoursBetween('2026-09-11T08:00:00.000Z', '2026-09-14T16:00:00.000Z', calendar),
    ).toBe(16);
    expect(
      workingHoursBetween('2026-09-07T08:00:00.000Z', '2026-09-07T08:00:00.000Z', calendar),
    ).toBe(0);
    // A one-hour typo must not go unnoticed.
    expect(
      workingHoursBetween('2026-09-07T08:00:00.000Z', '2026-09-08T15:00:00.000Z', calendar),
    ).toBe(15);
  });

  it.each(SCHEDULED.map((fixture) => [fixture.id, fixture] as const))(
    '%s — criticalDependencyIds are real edges between two critical tasks, ascending',
    (_id, fixture) => {
      const ids = fixture.expected.criticalDependencyIds;
      expect([...ids].sort(), 'not in canonical ascending order').toEqual([...ids]);
      expect(new Set(ids).size).toBe(ids.length);

      const critical = new Set(
        fixture.expected.taskSchedules.filter((row) => row.isCritical).map((row) => row.taskId),
      );
      for (const id of ids) {
        const edge = fixture.input.dependencies.find((d) => d.id === id);
        expect(edge, `${id} is not an edge in this fixture`).toBeDefined();
        if (edge === undefined) continue;
        expect(critical.has(edge.predecessorId), `${id}: predecessor not critical`).toBe(true);
        expect(critical.has(edge.successorId), `${id}: successor not critical`).toBe(true);
      }
    },
  );

  it.each(SCHEDULED.map((fixture) => [fixture.id, fixture] as const))(
    '%s — diagnostics are warnings only, and every flagged task has one',
    (_id, fixture) => {
      const flaggedByDiagnostic = new Set<string>();
      for (const diagnostic of fixture.expected.diagnostics) {
        // An error-severity diagnostic makes the result `rejected`; a `scheduled` result carrying
        // one would be self-contradictory.
        expect(diagnostic.severity, `${diagnostic.code} in a scheduled result`).toBe('warning');
        expect(CPM_ERROR_DIAGNOSTIC_CODES).not.toContain(diagnostic.code);
        if ('taskId' in diagnostic && diagnostic.taskId !== null) {
          flaggedByDiagnostic.add(diagnostic.taskId);
        }
      }

      const flaggedBySchedule = new Set(
        fixture.expected.taskSchedules
          .filter((row) => row.hasScheduleConflict)
          .map((row) => String(row.taskId)),
      );
      expect([...flaggedBySchedule].sort()).toEqual([...flaggedByDiagnostic].sort());
    },
  );

  it.each(SCHEDULED.map((fixture) => [fixture.id, fixture] as const))(
    '%s — metrics match the graph W1-1 builds from the same input',
    (_id, fixture) => {
      // tasksScheduled and topologicalDepth are checkable against merged code, so they are checked
      // rather than trusted — this is the assertion that catches an arithmetic slip in a hand
      // derivation's "depth" line. dependenciesTraversed is the corpus's own convention (ESC-1).
      const { graph } = buildGraph(fixture.input.tasks, fixture.input.dependencies);
      const topology = topologicalOrder(graph);
      expect(topology.status).toBe('ordered');
      if (topology.status !== 'ordered') return;

      expect(fixture.expected.metrics.tasksScheduled).toBe(fixture.input.tasks.length);
      expect(fixture.expected.metrics.topologicalDepth, 'hand-derived depth').toBe(
        topology.topologicalDepth,
      );
      expect(fixture.expected.metrics.dependenciesTraversed).toBe(graph.edges.length * 2);
    },
  );
});

describe('the rejected fixture (FR-SCH-03)', () => {
  it('names the cycle detectCycle finds, edge for edge', () => {
    // The one expectation in the corpus that has real code to check against. The hand trace in the
    // fixture's comment says *why* the loop is a loop; this says the loop is the one the engine
    // will report.
    const found = detectCycle(
      F19_CYCLE_REJECTED.input.tasks,
      F19_CYCLE_REJECTED.input.dependencies,
    );
    expect(found?.code).toBe('dependency_cycle');
    if (found?.code !== 'dependency_cycle') return;

    const expectedDiagnostic = F19_CYCLE_REJECTED.expected.diagnostics[0];
    expect(expectedDiagnostic?.code).toBe('dependency_cycle');
    if (expectedDiagnostic?.code !== 'dependency_cycle') return;

    expect(found.cyclePath).toEqual(expectedDiagnostic.cyclePath);
    expect(found.cycleDependencyIds).toEqual(expectedDiagnostic.cycleDependencyIds);
  });

  it('carries no schedule at all, so there is no partial state to half-apply', () => {
    expect(F19_CYCLE_REJECTED.expected.status).toBe('rejected');
    expect(Object.keys(F19_CYCLE_REJECTED.expected).sort()).toEqual([
      'diagnostics',
      'projectId',
      'status',
    ]);
    for (const diagnostic of F19_CYCLE_REJECTED.expected.diagnostics) {
      expect(diagnostic.severity).toBe('error');
      expect(CPM_ERROR_DIAGNOSTIC_CODES).toContain(diagnostic.code);
    }
  });
});

describe('no expectation in the corpus was captured from a running implementation (acceptance a)', () => {
  /**
   * The honesty check, made structural.
   *
   * Today it is trivially true — `computeSchedule` does not exist, so nothing could have been
   * captured from it. The value of this test is *after* W3-1 lands: it is what stops someone
   * regenerating a fixture from the engine to make a red test go green, which would turn the corpus
   * from an independent check into a snapshot of whatever the engine currently does.
   *
   * So it scans the corpus source rather than asserting on the engine's exports, and it stays true
   * and useful once the engine is complete.
   */
  function corpusSources(directory: string): string[] {
    return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return corpusSources(path);
      return entry.name.endsWith('.ts') ? [path] : [];
    });
  }

  const files = corpusSources(CORPUS_DIR);

  it('has corpus files to scan', () => {
    expect(files.length).toBeGreaterThanOrEqual(4);
  });

  it.each(['computeSchedule', 'recomputeSchedule'])(
    'no fixture file references %s in code',
    (symbol) => {
      const offenders = files.filter((file) => {
        const code = readFileSync(file, 'utf8')
          .replace(/\/\*[\s\S]*?\*\//g, '')
          .replace(/(^|[^:])\/\/.*$/gm, '$1');
        return code.includes(symbol);
      });
      expect(offenders.map((file) => relative(CORPUS_DIR, file))).toEqual([]);
    },
  );

  it('imports nothing from the engine’s public entry point', () => {
    const offenders = files.filter((file) =>
      /from\s*['"](?:\.\.\/)+index\.js['"]/.test(readFileSync(file, 'utf8')),
    );
    expect(offenders.map((file) => relative(CORPUS_DIR, file))).toEqual([]);
  });
});
