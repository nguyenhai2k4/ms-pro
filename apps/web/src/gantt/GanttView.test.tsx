import type { GanttViewModel } from '@projectapp/shared-types/gantt';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { GanttView } from './GanttView.jsx';

const model = {
  projectId: 'p1',
  timeAxis: {
    zoom: 'week',
    rangeStart: '2026-09-01T00:00:00.000Z',
    rangeEnd: '2026-10-01T00:00:00.000Z',
  },
  tasks: [
    {
      id: 't1',
      parentId: null,
      wbsCode: '1',
      name: 'Excavate',
      start: '2026-09-01T08:00:00.000Z',
      finish: '2026-09-06T08:00:00.000Z',
      pctComplete: 50,
      isMilestone: false,
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
  dependencies: [],
  criticalPathTaskIds: ['t1'],
  version: 1,
} as unknown as GanttViewModel;

/**
 * Invariant 6 as a structural guarantee: the component that renders the chart also renders the
 * accessible table, from the same model. There is no way to mount one without the other, which is
 * what "built in, not retrofitted" has to mean if it is going to survive contact with a deadline.
 */
describe('GanttView', () => {
  it('renders the accessible table alongside the drawing surface', () => {
    render(<GanttView model={model} zoom="week" />);

    const table = screen.getByRole('table', { name: 'Project schedule' });
    expect(table).toBeTruthy();
    expect(screen.getByRole('rowheader', { name: 'Excavate' })).toBeTruthy();
    expect(screen.getByText('on critical path')).toBeTruthy();
  });

  it('hides the drawing surface from assistive technology so data is not announced twice', () => {
    const { container } = render(<GanttView model={model} zoom="week" />);
    const canvas = container.querySelector('.gantt-view__canvas');
    expect(canvas?.getAttribute('aria-hidden')).toBe('true');
  });

  it('keeps the table in sync when the model changes', () => {
    const { rerender } = render(<GanttView model={model} zoom="week" />);
    const renamed = {
      ...model,
      tasks: [{ ...model.tasks[0]!, name: 'Excavate (revised)' }],
    } as GanttViewModel;

    rerender(<GanttView model={renamed} zoom="week" />);
    expect(screen.getByRole('rowheader', { name: 'Excavate (revised)' })).toBeTruthy();
  });
});
