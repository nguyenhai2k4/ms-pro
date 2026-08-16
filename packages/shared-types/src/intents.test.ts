import { describe, expect, it } from 'vitest';
import { createTaskRequestSchema, updateTaskRequestSchema } from './api.js';
import { taskStatusSchema } from './enums.js';
import {
  createTaskIntentSchema,
  deleteTaskIntentSchema,
  mutationIntentEnvelopeSchema,
  reparentTaskIntentSchema,
  taskIntentSchema,
  updateTaskIntentSchema,
} from './intents.js';
import { CONTRIBUTOR_WRITABLE_TASK_FIELDS } from './rbac.js';

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

  /**
   * `status` was documented as travelling through this intent but was missing from the schema
   * (Wave 1a's escalation, resolved by widening the contract because `status` is explicitly not
   * schedule-affecting). Both halves are pinned here: that it parses, and that it is drawn from
   * `taskStatusSchema` rather than a re-listed set of literals that could drift from the database
   * enum without failing anything.
   */
  it('carries `status`, and only the four values the vocabulary defines', () => {
    for (const status of taskStatusSchema.options) {
      const result = updateTaskIntentSchema.safeParse({
        kind: 'updateTask',
        taskId: TASK_ID,
        status,
      });
      expect(result.success, status).toBe(true);
    }

    const bogus = updateTaskIntentSchema.safeParse({
      kind: 'updateTask',
      taskId: TASK_ID,
      status: 'in-progress',
    });
    expect(bogus.success).toBe(false);
  });

  it('accepts the whole non-scheduling field set in one update', () => {
    // These five are exactly `CONTRIBUTOR_WRITABLE_TASK_FIELDS`. They ride this intent so there
    // stays one write path (invariant 2); the *role* check that gates them is the handler's.
    const result = updateTaskIntentSchema.safeParse({
      kind: 'updateTask',
      taskId: TASK_ID,
      pctComplete: 40,
      actualStart: NOW,
      actualFinish: null,
      notes: 'on track',
      status: 'in_progress',
    });
    expect(result.success).toBe(true);
    expect(CONTRIBUTOR_WRITABLE_TASK_FIELDS.every((field) => field in (result.data ?? {}))).toBe(
      true,
    );
  });

  it('rejects an unknown field, so a client cannot smuggle a rollup-derived one in', () => {
    // `finish` and `wbsCode` are server-owned; `.strict()` is what keeps them unsettable rather
    // than silently ignored, which would let a caller believe they had set them.
    for (const smuggled of [{ finish: NOW }, { wbsCode: '1.2' }, { projectId: PROJECT_ID }]) {
      const result = updateTaskIntentSchema.safeParse({
        kind: 'updateTask',
        taskId: TASK_ID,
        name: 'Renamed',
        ...smuggled,
      });
      expect(result.success, Object.keys(smuggled)[0]).toBe(false);
    }
  });
});

describe('the request DTOs and the intents agree on their shared vocabularies', () => {
  /**
   * `updateTaskRequestSchema` is what the HTTP layer parses; `updateTaskIntentSchema` is what the
   * scheduler receives. Every field that survives the first has to be accepted by the second, or
   * `buildEnvelope` turns a valid request into a 422 at the boundary — a failure that only shows
   * up for whichever field drifted, on whichever endpoint happens to send it.
   */
  it('every field of the update DTO is accepted by the update intent', () => {
    const fullBody = {
      name: 'Renamed',
      durationHours: 12,
      start: NOW,
      isMilestone: false,
      scheduleMode: 'manual',
      constraintType: 'SNET',
      constraintDate: NOW,
      calendarId: PARENT_ID,
      priority: 100,
      pctComplete: 25,
      actualStart: NOW,
      actualFinish: null,
      notes: 'note',
      status: 'blocked',
    };
    expect(updateTaskRequestSchema.safeParse(fullBody).success).toBe(true);

    const asIntent = updateTaskIntentSchema.safeParse({
      kind: 'updateTask',
      taskId: TASK_ID,
      ...fullBody,
    });
    expect(asIntent.success, JSON.stringify(asIntent.error?.flatten())).toBe(true);
  });

  it('every field of the create DTO is accepted by the create intent', () => {
    // The smallest body the DTO accepts: everything else has a default. `durationHours` has none
    // on purpose — there is no defensible default duration for a task.
    const parsed = createTaskRequestSchema.safeParse({
      parentId: null,
      name: 'x',
      durationHours: 8,
      start: null,
    });
    expect(parsed.success, JSON.stringify(parsed.error?.flatten())).toBe(true);

    const asIntent = createTaskIntentSchema.safeParse({
      kind: 'createTask',
      projectId: PROJECT_ID,
      ...parsed.data,
    });
    // The DTO's defaults have to satisfy the intent's required fields — otherwise the minimum
    // valid request is one the scheduler refuses.
    expect(asIntent.success, JSON.stringify(asIntent.error?.flatten())).toBe(true);
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
