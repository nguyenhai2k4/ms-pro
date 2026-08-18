import type {
  CalendarId,
  CpmDependency,
  CpmTask,
  DependencyId,
  ProjectId,
  TaskId,
} from '@projectapp/shared-types';

/**
 * Graph fixtures for the test suite.
 *
 * Ids are generated from an integer so that **numeric order matches lexicographic order**: task 1
 * sorts before task 2 sorts before task 10. Every canonical-ordering assertion in these tests reads
 * as `[task(1), task(2), task(3)]`, which is only legible because of that property.
 *
 * The ids are well-formed v4-shaped UUIDs, so a fixture would survive `cpmTaskSchema.parse` if a
 * later test wants to validate one. The brand is applied with a cast rather than by parsing,
 * because branding is compile-time only and parsing here would make `zod` a dependency of this
 * package for no runtime benefit — see `diagnostics.ts` for the same reasoning.
 */

function uuid(kind: string, n: number): string {
  return `${kind}-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
}

export function taskId(n: number): TaskId {
  return uuid('00000001', n) as TaskId;
}

export function dependencyId(n: number): DependencyId {
  return uuid('00000002', n) as DependencyId;
}

/** Same scheme, third namespace — the golden corpus needs calendars a fixture can name (FR-TSK-07). */
export function calendarId(n: number): CalendarId {
  return uuid('00000003', n) as CalendarId;
}

/** Same scheme, fourth namespace. `CpmScheduleInput.projectId` is echoed back in every result. */
export function projectId(n: number): ProjectId {
  return uuid('00000004', n) as ProjectId;
}

/** An auto-scheduled, unconstrained 8-hour leaf. Overrides are for the field under test only. */
export function makeTask(n: number, overrides: Partial<CpmTask> = {}): CpmTask {
  return {
    id: taskId(n),
    parentId: null,
    durationHours: 8,
    isMilestone: false,
    scheduleMode: 'auto',
    constraintType: 'ASAP',
    constraintDate: null,
    calendarId: null,
    manualStart: null,
    manualFinish: null,
    ...overrides,
  };
}

/** A zero-lag finish-to-start edge from task `from` to task `to`. */
export function makeDependency(
  n: number,
  from: number,
  to: number,
  overrides: Partial<CpmDependency> = {},
): CpmDependency {
  return {
    id: dependencyId(n),
    predecessorId: taskId(from),
    successorId: taskId(to),
    type: 'FS',
    lagHours: 0,
    ...overrides,
  };
}

/** `makeTask` for each number given. */
export function makeTasks(numbers: readonly number[]): CpmTask[] {
  return numbers.map((n) => makeTask(n));
}

/**
 * One dependency per `[from, to]` pair, numbered from 1 in the order listed. Numbering follows the
 * argument order so a test can name `dependencyId(2)` for the second pair it wrote.
 */
export function makeDependencies(pairs: readonly (readonly [number, number])[]): CpmDependency[] {
  return pairs.map(([from, to], i) => makeDependency(i + 1, from, to));
}
