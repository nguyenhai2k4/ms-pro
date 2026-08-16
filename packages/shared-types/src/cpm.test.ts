import { describe, expect, it } from 'vitest';
import {
  CPM_ERROR_DIAGNOSTIC_CODES,
  cpmCalendarSchema,
  cpmDependencySchema,
  cpmDiagnosticSchema,
  cpmIncrementalResultSchema,
  cpmRecalcRequestSchema,
  cpmScheduleInputSchema,
  cpmScheduleResultSchema,
  cpmTaskSchema,
  cpmTaskScheduleSchema,
} from './cpm.js';
import {
  createDependencyIntentSchema,
  deleteDependencyIntentSchema,
  scheduleIntentSchema,
  updateDependencyIntentSchema,
} from './intents.js';
import { CONTRACT_VERSION } from './index.js';

const PROJECT_ID = '11111111-1111-1111-1111-111111111111';
const TASK_A = '22222222-2222-2222-2222-222222222222';
const TASK_B = '33333333-3333-3333-3333-333333333333';
const CAL_ID = '44444444-4444-4444-4444-444444444444';
const DEP_ID = '55555555-5555-5555-5555-555555555555';
const T0 = '2026-09-01T09:00:00.000Z';
const T1 = '2026-09-02T17:00:00.000Z';

const calendar = {
  id: CAL_ID,
  workingDays: [1, 2, 3, 4, 5],
  workingHoursStartMinute: 540,
  workingHoursEndMinute: 1020,
  exceptions: [],
};

const autoTask = {
  id: TASK_A,
  parentId: null,
  durationHours: 8,
  isMilestone: false,
  scheduleMode: 'auto',
  constraintType: 'ASAP',
  constraintDate: null,
  calendarId: null,
  manualStart: null,
  manualFinish: null,
};

const taskSchedule = {
  taskId: TASK_A,
  earlyStart: T0,
  earlyFinish: T1,
  lateStart: T0,
  lateFinish: T1,
  totalFloatHours: 0,
  isCritical: true,
  hasScheduleConflict: false,
  start: T0,
  finish: T1,
  durationHours: 8,
};

const scheduledResult = {
  status: 'scheduled',
  projectId: PROJECT_ID,
  taskSchedules: [taskSchedule],
  criticalDependencyIds: [],
  projectFinish: T1,
  diagnostics: [],
  metrics: { tasksScheduled: 1, dependenciesTraversed: 0, topologicalDepth: 1 },
};

describe('CpmScheduleInput (FR-SCH-04, FR-SCH-07)', () => {
  it('accepts a minimal single-task forward-scheduled project', () => {
    const result = cpmScheduleInputSchema.safeParse({
      projectId: PROJECT_ID,
      projectStart: T0,
      direction: 'forward',
      defaultCalendarId: CAL_ID,
      calendars: [calendar],
      tasks: [autoTask],
      dependencies: [],
    });
    expect(result.success).toBe(true);
  });

  it('rejects unknown input fields — the engine must not silently ignore a field a caller thinks it honours', () => {
    const result = cpmScheduleInputSchema.safeParse({
      projectId: PROJECT_ID,
      projectStart: T0,
      direction: 'forward',
      defaultCalendarId: CAL_ID,
      calendars: [calendar],
      tasks: [autoTask],
      dependencies: [],
      resourceAssignments: [],
    });
    expect(result.success).toBe(false);
  });

  it('FR-SCH-09: only forward scheduling is expressible; backward is not this phase', () => {
    const result = cpmScheduleInputSchema.safeParse({
      projectId: PROJECT_ID,
      projectStart: T0,
      direction: 'backward',
      defaultCalendarId: CAL_ID,
      calendars: [calendar],
      tasks: [autoTask],
      dependencies: [],
    });
    expect(result.success).toBe(false);
  });

  it('keeps the engine free of fields that must never affect a schedule (FR-VIEW-06)', () => {
    const withStatus = cpmTaskSchema.safeParse({ ...autoTask, status: 'in_progress' });
    const withPct = cpmTaskSchema.safeParse({ ...autoTask, pctComplete: 50 });
    expect(withStatus.success).toBe(false);
    expect(withPct.success).toBe(false);
  });
});

describe('CpmTask (FR-TSK-05, FR-TSK-06)', () => {
  it('requires fixed dates on a manually-scheduled task', () => {
    const result = cpmTaskSchema.safeParse({ ...autoTask, scheduleMode: 'manual' });
    expect(result.success).toBe(false);
  });

  it('accepts a manually-scheduled task that carries them', () => {
    const result = cpmTaskSchema.safeParse({
      ...autoTask,
      scheduleMode: 'manual',
      manualStart: T0,
      manualFinish: T1,
    });
    expect(result.success).toBe(true);
  });

  it('requires a constraintDate for every dated constraint type and forbids one for ASAP/ALAP', () => {
    for (const constraintType of ['MSO', 'MFO', 'SNET', 'SNLT', 'FNET', 'FNLT'] as const) {
      expect(cpmTaskSchema.safeParse({ ...autoTask, constraintType }).success).toBe(false);
      expect(
        cpmTaskSchema.safeParse({ ...autoTask, constraintType, constraintDate: T0 }).success,
      ).toBe(true);
    }
    expect(cpmTaskSchema.safeParse({ ...autoTask, constraintType: 'ALAP' }).success).toBe(true);
  });
});

describe('CpmCalendar (FR-CAL-01/02)', () => {
  it('accepts a calendar with no working days rather than throwing — it is a diagnosable input, not a crash', () => {
    const result = cpmCalendarSchema.safeParse({ ...calendar, workingDays: [] });
    expect(result.success).toBe(true);
  });

  it('accepts a half-day exception and a holiday', () => {
    const result = cpmCalendarSchema.safeParse({
      ...calendar,
      exceptions: [
        {
          date: '2026-12-25',
          isWorking: false,
          startMinuteOverride: null,
          endMinuteOverride: null,
        },
        { date: '2026-12-24', isWorking: true, startMinuteOverride: 540, endMinuteOverride: 780 },
      ],
    });
    expect(result.success).toBe(true);
  });
});

describe('CpmDependency (FR-SCH-01, FR-SCH-02)', () => {
  it('accepts all four types and a negative lag (lead)', () => {
    for (const type of ['FS', 'SS', 'FF', 'SF'] as const) {
      const result = cpmDependencySchema.safeParse({
        id: DEP_ID,
        predecessorId: TASK_A,
        successorId: TASK_B,
        type,
        lagHours: -16,
      });
      expect(result.success).toBe(true);
    }
  });
});

describe('CpmScheduleResult (FR-SCH-03, FR-SCH-05)', () => {
  it('accepts a scheduled result', () => {
    expect(cpmScheduleResultSchema.safeParse(scheduledResult).success).toBe(true);
  });

  it('FR-SCH-03: a rejected result carries a cycle path and no partial schedule', () => {
    const rejected = {
      status: 'rejected',
      projectId: PROJECT_ID,
      diagnostics: [
        {
          code: 'dependency_cycle',
          severity: 'error',
          cyclePath: [TASK_A, TASK_B, TASK_A],
          cycleDependencyIds: [DEP_ID],
        },
      ],
    };
    expect(cpmScheduleResultSchema.safeParse(rejected).success).toBe(true);
    expect(
      cpmScheduleResultSchema.safeParse({ ...rejected, taskSchedules: [taskSchedule] }).success,
    ).toBe(false);
  });

  it('a rejected result cannot be empty of diagnostics — "rejected, reason unknown" is not an answer', () => {
    const result = cpmScheduleResultSchema.safeParse({
      status: 'rejected',
      projectId: PROJECT_ID,
      diagnostics: [],
    });
    expect(result.success).toBe(false);
  });

  it('carries no timing field anywhere — timing the engine would require reading a clock', () => {
    expect(JSON.stringify(scheduledResult)).not.toMatch(/elapsed|durationMs|tookMs/i);
    const withTiming = cpmScheduleResultSchema.safeParse({
      ...scheduledResult,
      metrics: { ...scheduledResult.metrics, elapsedMs: 12 },
    });
    expect(withTiming.success).toBe(false);
  });

  it('every error-severity diagnostic code is listed in CPM_ERROR_DIAGNOSTIC_CODES', () => {
    const errorCodes = cpmDiagnosticSchema.options
      .filter((option) => option.shape.severity.value === 'error')
      .map((option) => option.shape.code.value)
      .sort();
    expect(errorCodes).toEqual([...CPM_ERROR_DIAGNOSTIC_CODES].sort());
  });

  it('FR-SCH-08: a manual conflict is a warning, not a rejection', () => {
    const diagnostic = cpmDiagnosticSchema.parse({
      code: 'manual_conflict',
      severity: 'warning',
      taskId: TASK_B,
      dependencyId: DEP_ID,
      predecessorId: TASK_A,
      earliestFeasibleStart: T1,
    });
    expect(diagnostic.severity).toBe('warning');
    expect(CPM_ERROR_DIAGNOSTIC_CODES).not.toContain(diagnostic.code);
  });
});

describe('CpmTaskSchedule (FR-SCH-05)', () => {
  it('carries both the persisted dates and the derived analysis', () => {
    const parsed = cpmTaskScheduleSchema.parse(taskSchedule);
    expect(parsed.start).toBe(parsed.earlyStart);
    expect(parsed.totalFloatHours).toBe(0);
    expect(parsed.isCritical).toBe(true);
  });

  it('does not admit a free-float field — FR-SCH-05 needs total float only, and P4 is not this phase', () => {
    const result = cpmTaskScheduleSchema.safeParse({ ...taskSchedule, freeFloatHours: 4 });
    expect(result.success).toBe(false);
  });
});

describe('Incremental recompute (FR-SCH-04, FR-SCH-06)', () => {
  const request = {
    input: {
      projectId: PROJECT_ID,
      projectStart: T0,
      direction: 'forward',
      defaultCalendarId: CAL_ID,
      calendars: [calendar],
      tasks: [autoTask],
      dependencies: [],
    },
    previous: scheduledResult,
    dirty: {
      taskIds: [TASK_A],
      dependencyIds: [],
      calendarIds: [],
      removedTaskIds: [],
      projectSettingsChanged: false,
    },
  };

  it('accepts a full post-mutation graph plus the previous result plus a dirty set', () => {
    expect(cpmRecalcRequestSchema.safeParse(request).success).toBe(true);
  });

  it('refuses a rejected result as `previous` — a rejected schedule was never persisted', () => {
    const result = cpmRecalcRequestSchema.safeParse({
      ...request,
      previous: { status: 'rejected', projectId: PROJECT_ID, diagnostics: [] },
    });
    expect(result.success).toBe(false);
  });

  it('returns a whole schedule plus what changed, so "incremental === full" is a deep equality', () => {
    const result = cpmIncrementalResultSchema.safeParse({
      result: scheduledResult,
      changedTaskIds: [TASK_A],
      visitedTaskCount: 1,
    });
    expect(result.success).toBe(true);
  });

  it('has no patch/delta field — the wire delta format is P3, not P2', () => {
    const result = cpmIncrementalResultSchema.safeParse({
      result: scheduledResult,
      changedTaskIds: [TASK_A],
      visitedTaskCount: 1,
      patch: [{ op: 'replace', path: '/start' }],
    });
    expect(result.success).toBe(false);
  });
});

describe('Dependency intents (FR-SCH-01..04)', () => {
  const create = {
    kind: 'createDependency',
    projectId: PROJECT_ID,
    predecessorId: TASK_A,
    successorId: TASK_B,
    type: 'FS',
    lagHours: 0,
  };

  it('accepts a well-formed create and rejects a self-link (FR-SCH-03)', () => {
    expect(createDependencyIntentSchema.safeParse(create).success).toBe(true);
    expect(createDependencyIntentSchema.safeParse({ ...create, successorId: TASK_A }).success).toBe(
      false,
    );
  });

  it('does not let an update move the link endpoints', () => {
    expect(
      updateDependencyIntentSchema.safeParse({
        kind: 'updateDependency',
        dependencyId: DEP_ID,
        predecessorId: TASK_A,
      }).success,
    ).toBe(false);
    expect(
      updateDependencyIntentSchema.safeParse({ kind: 'updateDependency', dependencyId: DEP_ID })
        .success,
    ).toBe(false);
    expect(
      updateDependencyIntentSchema.safeParse({
        kind: 'updateDependency',
        dependencyId: DEP_ID,
        lagHours: -8,
      }).success,
    ).toBe(true);
  });

  it('the P2 writer vocabulary covers task and dependency intents alike', () => {
    expect(scheduleIntentSchema.safeParse(create).success).toBe(true);
    expect(
      scheduleIntentSchema.safeParse({ kind: 'deleteDependency', dependencyId: DEP_ID }).success,
    ).toBe(true);
    expect(
      deleteDependencyIntentSchema.safeParse({ kind: 'deleteDependency', dependencyId: DEP_ID })
        .success,
    ).toBe(true);
  });
});

describe('contract version', () => {
  it('is bumped for the P2 additions', () => {
    expect(CONTRACT_VERSION).toBe('0.3.0');
  });
});
