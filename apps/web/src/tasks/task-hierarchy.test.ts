import type { Task } from '@projectapp/shared-types';
import { describe, expect, it } from 'vitest';
import { buildChildCounts, descendantIds, wbsDepth } from './task-hierarchy.js';

const task = (id: string, parentId: string | null, wbsCode: string): Task =>
  ({
    id,
    projectId: 'p1',
    parentId,
    wbsCode,
    name: id,
    durationHours: 8,
    start: '2026-09-01T08:00:00.000Z',
    finish: '2026-09-01T16:00:00.000Z',
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
    createdAt: '2026-09-01T08:00:00.000Z',
    updatedAt: '2026-09-01T08:00:00.000Z',
    updatedBy: 'u1',
  }) as unknown as Task;

describe('wbsDepth', () => {
  it('is zero for a top-level code and grows with each dot segment', () => {
    expect(wbsDepth('1')).toBe(0);
    expect(wbsDepth('1.2')).toBe(1);
    expect(wbsDepth('1.2.3')).toBe(2);
  });
});

describe('buildChildCounts', () => {
  it('counts only direct children, keyed by parentId', () => {
    const tasks = [
      task('root', null, '1'),
      task('a', 'root', '1.1'),
      task('b', 'root', '1.2'),
      task('a1', 'a', '1.1.1'),
    ];
    const counts = buildChildCounts(tasks);
    expect(counts.get('root')).toBe(2);
    expect(counts.get('a')).toBe(1);
    expect(counts.get('b')).toBeUndefined();
    expect(counts.get('a1')).toBeUndefined();
  });
});

describe('descendantIds', () => {
  it('includes the task itself and every task below it, not siblings or ancestors', () => {
    const tasks = [
      task('root', null, '1'),
      task('a', 'root', '1.1'),
      task('b', 'root', '1.2'),
      task('a1', 'a', '1.1.1'),
      task('a1a', 'a1', '1.1.1.1'),
    ];
    const ids = descendantIds(tasks, 'a');
    expect(ids).toEqual(new Set(['a', 'a1', 'a1a']));
    expect(ids.has('b')).toBe(false);
    expect(ids.has('root')).toBe(false);
  });

  it('is just the task itself for a leaf', () => {
    const tasks = [task('root', null, '1'), task('leaf', 'root', '1.1')];
    expect(descendantIds(tasks, 'leaf')).toEqual(new Set(['leaf']));
  });
});
