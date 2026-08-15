import type { GanttViewModel } from '@projectapp/shared-types/gantt';
import { describe, expect, it } from 'vitest';
import { buildAccessibleRows } from './build-accessible-rows.js';

/**
 * Invariant 6 has unit tests in P0 rather than a manual audit in P8. These assert the properties
 * that make the canvas usable without sight: every task appears, criticality is announced in text
 * rather than implied by colour, and dependency arrows have a prose equivalent.
 */

const model = (overrides: Partial<GanttViewModel> = {}): GanttViewModel =>
  ({
    projectId: 'p1',
    timeAxis: {
      zoom: 'week',
      rangeStart: '2026-09-01T00:00:00.000Z',
      rangeEnd: '2026-12-01T00:00:00.000Z',
    },
    tasks: [
      {
        id: 't1',
        parentId: null,
        wbsCode: '1',
        name: 'Phase one',
        start: '2026-09-01T08:00:00.000Z',
        finish: '2026-09-11T08:00:00.000Z',
        pctComplete: 40,
        isMilestone: false,
        isSummary: true,
        scheduleMode: 'auto',
        isCritical: true,
        totalFloatHours: 0,
        hasScheduleConflict: false,
        depth: 0,
        isCollapsed: false,
        baseline: null,
      },
      {
        id: 't2',
        parentId: 't1',
        wbsCode: '1.1',
        name: 'Excavate',
        start: '2026-09-01T08:00:00.000Z',
        finish: '2026-09-06T08:00:00.000Z',
        pctComplete: 100,
        isMilestone: false,
        isSummary: false,
        scheduleMode: 'auto',
        isCritical: true,
        totalFloatHours: 0,
        hasScheduleConflict: false,
        depth: 1,
        isCollapsed: false,
        baseline: null,
      },
      {
        id: 't3',
        parentId: 't1',
        wbsCode: '1.2',
        name: 'Pour foundations',
        start: '2026-09-06T08:00:00.000Z',
        finish: '2026-09-11T08:00:00.000Z',
        pctComplete: 0,
        isMilestone: false,
        isSummary: false,
        scheduleMode: 'manual',
        isCritical: false,
        totalFloatHours: 16,
        hasScheduleConflict: true,
        depth: 1,
        isCollapsed: false,
        baseline: null,
      },
      {
        id: 't4',
        parentId: null,
        wbsCode: '2',
        name: 'Handover',
        start: '2026-09-11T08:00:00.000Z',
        finish: '2026-09-11T08:00:00.000Z',
        pctComplete: 0,
        isMilestone: true,
        isSummary: false,
        scheduleMode: 'auto',
        isCritical: true,
        totalFloatHours: 0,
        hasScheduleConflict: false,
        depth: 0,
        isCollapsed: false,
        baseline: null,
      },
    ],
    dependencies: [
      {
        id: 'd1',
        predecessorId: 't2',
        successorId: 't3',
        type: 'FS',
        lagHours: 0,
        isCritical: false,
      },
    ],
    criticalPathTaskIds: ['t1', 't2', 't4'],
    version: 1,
    ...overrides,
  }) as GanttViewModel;

describe('buildAccessibleRows (invariant 6, FR-VIEW-03)', () => {
  it('emits exactly one row per task — nothing the canvas draws is missing', () => {
    const rows = buildAccessibleRows(model());
    expect(rows).toHaveLength(4);
    expect(rows.map((row) => row.name)).toEqual([
      'Phase one',
      'Excavate',
      'Pour foundations',
      'Handover',
    ]);
  });

  it('mirrors the WBS hierarchy in aria-level terms', () => {
    const rows = buildAccessibleRows(model());
    expect(rows.map((row) => row.level)).toEqual([1, 2, 2, 1]);
    expect(rows.map((row) => row.rowIndex)).toEqual([1, 2, 3, 4]);
  });

  it('announces critical-path membership in words, not by colour (WCAG 1.4.1)', () => {
    const rows = buildAccessibleRows(model());
    expect(rows[0]!.scheduleStatusLabel).toContain('on critical path');
    expect(rows[2]!.scheduleStatusLabel).toContain('not on critical path');
  });

  it('states available float for non-critical tasks (FR-SCH-05)', () => {
    const rows = buildAccessibleRows(model());
    expect(rows[2]!.scheduleStatusLabel).toContain('2 days of float');
  });

  it('announces a schedule conflict on a manual task (FR-SCH-08)', () => {
    const rows = buildAccessibleRows(model());
    expect(rows[2]!.scheduleStatusLabel).toContain('schedule conflict');
    expect(rows[2]!.hasScheduleConflict).toBe(true);
  });

  it('gives dependency arrows a prose equivalent', () => {
    const rows = buildAccessibleRows(model());
    expect(rows[2]!.dependencyLabel).toBe('after Excavate (FS)');
    expect(rows[1]!.dependencyLabel).toBe('no predecessors');
  });

  it('identifies milestones (FR-TSK-04)', () => {
    const rows = buildAccessibleRows(model());
    expect(rows[3]!.durationLabel).toBe('milestone');
    expect(rows[3]!.scheduleStatusLabel).toContain('milestone');
  });

  it('marks summary rows as expandable and leaves leaves undefined', () => {
    const rows = buildAccessibleRows(model());
    expect(rows[0]!.isExpanded).toBe(true);
    expect(rows[1]!.isExpanded).toBeUndefined();
  });

  it('reflects a collapsed summary row', () => {
    const source = model();
    const collapsed = {
      ...source,
      tasks: source.tasks.map((task) => (task.id === 't1' ? { ...task, isCollapsed: true } : task)),
    } as GanttViewModel;
    expect(buildAccessibleRows(collapsed)[0]!.isExpanded).toBe(false);
  });

  it('never announces a raw ISO timestamp', () => {
    const rows = buildAccessibleRows(model());
    for (const row of rows) {
      expect(row.startLabel).not.toMatch(/T\d{2}:\d{2}/);
      expect(row.finishLabel).not.toMatch(/T\d{2}:\d{2}/);
    }
  });

  it('is a pure function of the view model — same input, same output', () => {
    const source = model();
    expect(buildAccessibleRows(source)).toEqual(buildAccessibleRows(source));
  });

  it('accepts an injected date formatter so output is locale-deterministic', () => {
    const rows = buildAccessibleRows(model(), { formatDate: () => 'FORMATTED' });
    expect(rows[0]!.startLabel).toBe('FORMATTED');
  });
});
