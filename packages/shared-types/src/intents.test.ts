import { describe, expect, it } from 'vitest';
import {
  createTaskIntentSchema,
  deleteTaskIntentSchema,
  mutationIntentEnvelopeSchema,
  reparentTaskIntentSchema,
  taskIntentSchema,
  updateTaskIntentSchema,
} from './intents.js';

const PROJECT_ID = '11111111-1111-1111-1111-111111111111';
const TASK_ID = '22222222-2222-2222-2222-222222222222';
const PARENT_ID = '33333333-3333-3333-3333-333333333333';
const USER_ID = '44444444-4444-4444-4444-444444444444';
const NOW = '2026-08-15T00:00:00.000Z';

describe('FR-TSK-01/02/04: createTask intent', () => {
  it('accepts a top-level auto-scheduled task', () => {
    const result = createTaskIntentSchema.safeParse({
      kind: 'createTask',
      projectId: PROJECT_ID,
      parentId: null,
      name: 'Design review',
      durationHours: 8,
      start: null,
      isMilestone: false,
      scheduleMode: 'auto',
      constraintType: 'ASAP',
      constraintDate: null,
      calendarId: null,
      priority: 500,
    });
    expect(result.success).toBe(true);
  });

  it('rejects an unknown field (strict — envelope shape is load-bearing, not lenient)', () => {
    const result = createTaskIntentSchema.safeParse({
      kind: 'createTask',
      projectId: PROJECT_ID,
      parentId: null,
      name: 'x',
      durationHours: 1,
      start: null,
      isMilestone: false,
      scheduleMode: 'auto',
      constraintType: 'ASAP',
      constraintDate: null,
      calendarId: null,
      priority: 500,
      totalFloatHours: 0,
    });
    expect(result.success).toBe(false);
  });
});

describe('FR-TSK-01/05/06/07, FR-TRK-04: updateTask intent', () => {
  it('accepts a partial update touching one field', () => {
    const result = updateTaskIntentSchema.safeParse({
      kind: 'updateTask',
      taskId: TASK_ID,
      pctComplete: 50,
    });
    expect(result.success).toBe(true);
  });

  it('rejects an update with no fields to change (checked at the union level, not per-member)', () => {
    const result = taskIntentSchema.safeParse({ kind: 'updateTask', taskId: TASK_ID });
    expect(result.success).toBe(false);
  });
});

describe('FR-TSK-02: reparentTask intent', () => {
  it('accepts moving a task to top level', () => {
    const result = reparentTaskIntentSchema.safeParse({
      kind: 'reparentTask',
      taskId: TASK_ID,
      newParentId: null,
    });
    expect(result.success).toBe(true);
  });

  it('accepts moving a task under a new parent at a position', () => {
    const result = reparentTaskIntentSchema.safeParse({
      kind: 'reparentTask',
      taskId: TASK_ID,
      newParentId: PARENT_ID,
      newIndex: 2,
    });
    expect(result.success).toBe(true);
  });
});

describe('FR-TSK-08/09: deleteTask intent', () => {
  it('accepts a delete with no policy (valid for a childless task)', () => {
    const result = deleteTaskIntentSchema.safeParse({ kind: 'deleteTask', taskId: TASK_ID });
    expect(result.success).toBe(true);
  });

  it('accepts a delete with an explicit child policy', () => {
    const result = deleteTaskIntentSchema.safeParse({
      kind: 'deleteTask',
      taskId: TASK_ID,
      childPolicy: 'cascade',
    });
    expect(result.success).toBe(true);
  });

  it('rejects an unrecognised child policy', () => {
    const result = deleteTaskIntentSchema.safeParse({
      kind: 'deleteTask',
      taskId: TASK_ID,
      childPolicy: 'delete-em-all',
    });
    expect(result.success).toBe(false);
  });
});

describe('the discriminated union routes on `kind`', () => {
  it('parses each intent kind through the union', () => {
    const create = taskIntentSchema.safeParse({
      kind: 'createTask',
      projectId: PROJECT_ID,
      parentId: null,
      name: 'x',
      durationHours: 1,
      start: null,
      isMilestone: false,
      scheduleMode: 'auto',
      constraintType: 'ASAP',
      constraintDate: null,
      calendarId: null,
      priority: 500,
    });
    const del = taskIntentSchema.safeParse({ kind: 'deleteTask', taskId: TASK_ID });
    expect(create.success).toBe(true);
    expect(del.success).toBe(true);
  });

  it('rejects an unknown kind', () => {
    const result = taskIntentSchema.safeParse({ kind: 'launchTheMissiles', taskId: TASK_ID });
    expect(result.success).toBe(false);
  });
});

describe('ADR-002/ADR-007: the mutation-intent envelope', () => {
  it('wraps a task intent with actor, project and server-issued timestamp', () => {
    const result = mutationIntentEnvelopeSchema.safeParse({
      intent: { kind: 'deleteTask', taskId: TASK_ID },
      projectId: PROJECT_ID,
      actorUserId: USER_ID,
      issuedAt: NOW,
    });
    expect(result.success).toBe(true);
  });
});
