import { describe, expect, it } from 'vitest';
import { ENTITY_SCHEMAS, dependencySchema, taskInvariantsSchema, taskSchema } from './entities.js';
import { isoDateTimeSchema, prioritySchema } from './primitives.js';

const UUID_A = '11111111-1111-4111-8111-111111111111';
const UUID_B = '22222222-2222-4222-8222-222222222222';
const UUID_C = '33333333-3333-4333-8333-333333333333';
const NOW = '2026-09-01T08:00:00.000Z';

function validTask(overrides: Record<string, unknown> = {}) {
  return {
    id: UUID_A,
    projectId: UUID_B,
    parentId: null,
    wbsCode: '1.1',
    name: 'Pour foundations',
    durationHours: 40,
    start: NOW,
    finish: '2026-09-08T17:00:00.000Z',
    pctComplete: 0,
    isMilestone: false,
    scheduleMode: 'auto',
    constraintType: 'ASAP',
    constraintDate: null,
    calendarId: null,
    priority: 500,
    status: 'not_started',
    actualStart: null,
    actualFinish: null,
    notes: '',
    createdAt: NOW,
    updatedAt: NOW,
    updatedBy: UUID_C,
    ...overrides,
  };
}

describe('FRS §6 coverage', () => {
  // The ERD in docs/FRS.md §6. A table added to the schema without a contract fails here.
  const ERD_ENTITIES = [
    'Organization',
    'User',
    'Project',
    'ProjectMember',
    'Task',
    'Dependency',
    'Resource',
    'Assignment',
    'Calendar',
    'CalendarException',
    'Baseline',
    'Comment',
    'Mention',
    'Notification',
    'AuditLogEntry',
    'ExportJob',
  ];

  it('has a schema for every entity in the ERD', () => {
    expect(Object.keys(ENTITY_SCHEMAS).sort()).toEqual([...ERD_ENTITIES].sort());
  });

  it('exposes no schema that is not in the ERD', () => {
    for (const name of Object.keys(ENTITY_SCHEMAS)) {
      expect(ERD_ENTITIES).toContain(name);
    }
  });
});

describe('instants are UTC ISO-8601 (primitives contract 2)', () => {
  it('accepts a Z-suffixed instant', () => {
    expect(isoDateTimeSchema.safeParse(NOW).success).toBe(true);
  });

  it('rejects an offset-bearing instant, so timezone never becomes ambiguous at a boundary', () => {
    expect(isoDateTimeSchema.safeParse('2026-09-01T08:00:00.000+02:00').success).toBe(false);
  });

  it('rejects a date-only string where an instant is required', () => {
    expect(isoDateTimeSchema.safeParse('2026-09-01').success).toBe(false);
  });
});

describe('Task (FR-TSK-01..07)', () => {
  it('parses a well-formed task', () => {
    expect(taskSchema.safeParse(validTask()).success).toBe(true);
  });

  it('rejects an out-of-range pctComplete', () => {
    expect(taskSchema.safeParse(validTask({ pctComplete: 101 })).success).toBe(false);
  });

  it('rejects a negative duration', () => {
    expect(taskSchema.safeParse(validTask({ durationHours: -1 })).success).toBe(false);
  });

  it('accepts every constraint type in FR-TSK-06', () => {
    for (const constraintType of ['ASAP', 'ALAP', 'MSO', 'MFO', 'SNET', 'SNLT', 'FNET', 'FNLT']) {
      const needsDate = constraintType !== 'ASAP' && constraintType !== 'ALAP';
      const result = taskInvariantsSchema.safeParse(
        validTask({ constraintType, constraintDate: needsDate ? NOW : null }),
      );
      expect(result.success, `${constraintType} should parse`).toBe(true);
    }
  });

  it('FR-TSK-04: rejects a milestone with non-zero duration', () => {
    const result = taskInvariantsSchema.safeParse(
      validTask({ isMilestone: true, durationHours: 8 }),
    );
    expect(result.success).toBe(false);
  });

  it('FR-TSK-04: accepts a milestone with zero duration', () => {
    const result = taskInvariantsSchema.safeParse(
      validTask({ isMilestone: true, durationHours: 0 }),
    );
    expect(result.success).toBe(true);
  });

  it('FR-TSK-06: rejects a dated constraint with no constraintDate', () => {
    const result = taskInvariantsSchema.safeParse(validTask({ constraintType: 'MSO' }));
    expect(result.success).toBe(false);
  });

  it('FR-TSK-02: rejects a task parented to itself', () => {
    const result = taskInvariantsSchema.safeParse(validTask({ parentId: UUID_A }));
    expect(result.success).toBe(false);
  });
});

describe('Dependency (FR-SCH-01..03)', () => {
  function validDependency(overrides: Record<string, unknown> = {}) {
    return {
      id: UUID_A,
      projectId: UUID_B,
      predecessorId: UUID_B,
      successorId: UUID_C,
      type: 'FS',
      lagHours: 0,
      createdAt: NOW,
      ...overrides,
    };
  }

  it('accepts all four dependency types (FR-SCH-01)', () => {
    for (const type of ['FS', 'SS', 'FF', 'SF']) {
      expect(dependencySchema.safeParse(validDependency({ type })).success).toBe(true);
    }
  });

  it('FR-SCH-02: accepts negative lag (lead)', () => {
    expect(dependencySchema.safeParse(validDependency({ lagHours: -16 })).success).toBe(true);
  });

  it('FR-SCH-03: rejects a self-dependency at the contract boundary', () => {
    const result = dependencySchema.safeParse(
      validDependency({ predecessorId: UUID_B, successorId: UUID_B }),
    );
    expect(result.success).toBe(false);
  });
});

describe('priority (FR-RES-06 leveling order)', () => {
  it('accepts the documented range', () => {
    expect(prioritySchema.safeParse(0).success).toBe(true);
    expect(prioritySchema.safeParse(1000).success).toBe(true);
  });

  it('rejects out-of-range and fractional values', () => {
    expect(prioritySchema.safeParse(1001).success).toBe(false);
    expect(prioritySchema.safeParse(-1).success).toBe(false);
    expect(prioritySchema.safeParse(1.5).success).toBe(false);
  });
});
