import type { GanttIntent, GanttViewModel } from '@projectapp/shared-types/gantt';
import { beforeEach, describe, expect, it } from 'vitest';
import { PlaceholderGanttAdapter } from './placeholder-adapter.js';
import { createGanttAdapter, isPerfQualified } from './index.js';

const model: GanttViewModel = {
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
      start: '2026-09-01T00:00:00.000Z',
      finish: '2026-09-06T00:00:00.000Z',
      pctComplete: 0,
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
    {
      id: 't2',
      parentId: null,
      wbsCode: '2',
      name: 'Pour',
      start: '2026-09-06T00:00:00.000Z',
      finish: '2026-09-11T00:00:00.000Z',
      pctComplete: 0,
      isMilestone: false,
      isSummary: false,
      scheduleMode: 'auto',
      isCritical: false,
      totalFloatHours: 24,
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

let container: HTMLElement;
let intents: GanttIntent[];
let selections: readonly string[][];

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  intents = [];
  selections = [];
});

function mount(adapter: PlaceholderGanttAdapter): void {
  adapter.mount(container, {
    initialZoom: 'week',
    rowHeightPx: 28,
    callbacks: {
      onIntent: (intent) => intents.push(intent),
      onSelectionChange: (ids) => {
        selections = [...selections, [...ids]];
      },
      onViewportChange: () => {},
      onToggleCollapse: () => {},
    },
  });
}

describe('PlaceholderGanttAdapter (ADR-006)', () => {
  it('declares honestly that it is not shippable', () => {
    const adapter = new PlaceholderGanttAdapter();
    // If either of these ever flips to true, ADR-001 is being reversed by implementation and a
    // new ADR is required first. This test is the tripwire.
    expect(adapter.capabilities.virtualizedRows).toBe(false);
    expect(adapter.capabilities.perfQualified).toBe(false);
    expect(isPerfQualified(adapter)).toBe(false);
  });

  it('renders nothing until it is given a model', () => {
    const adapter = new PlaceholderGanttAdapter();
    mount(adapter);
    expect(container.querySelectorAll('[data-task-id]')).toHaveLength(0);
  });

  it('draws one row per task with bar widths proportional to duration (FR-VIEW-01)', () => {
    const adapter = new PlaceholderGanttAdapter();
    mount(adapter);
    adapter.render(model);

    const rows = container.querySelectorAll<HTMLElement>('[data-task-id]');
    expect(rows).toHaveLength(2);

    const first = rows[0]!.querySelector<HTMLElement>('.gantt-placeholder__bar')!;
    const second = rows[1]!.querySelector<HTMLElement>('.gantt-placeholder__bar')!;
    // Both tasks span 5 days, so the bars match; the second starts 5 days later.
    expect(first.style.width).toBe(second.style.width);
    expect(parseFloat(second.style.marginLeft)).toBeGreaterThan(parseFloat(first.style.marginLeft));
  });

  it('reflects server-computed criticality and never decides it (FR-SCH-05/10)', () => {
    const adapter = new PlaceholderGanttAdapter();
    mount(adapter);
    adapter.render(model);

    const bars = container.querySelectorAll('.gantt-placeholder__bar');
    expect(bars[0]!.classList.contains('is-critical')).toBe(true);
    expect(bars[1]!.classList.contains('is-critical')).toBe(false);
  });

  it('render() is idempotent — the same model twice produces the same DOM', () => {
    const adapter = new PlaceholderGanttAdapter();
    mount(adapter);
    adapter.render(model);
    const once = container.innerHTML;
    adapter.render(model);
    expect(container.innerHTML).toBe(once);
  });

  it('hides the drawing surface from assistive technology (invariant 6)', () => {
    const adapter = new PlaceholderGanttAdapter();
    mount(adapter);
    // The accessible table alongside carries the data; announcing both would duplicate it.
    expect(container.getAttribute('aria-hidden')).toBe('true');
  });

  it('reports a gesture upward without changing its own model (ADR-002, invariant 2)', () => {
    const adapter = new PlaceholderGanttAdapter();
    mount(adapter);
    adapter.render(model);

    const before = container.innerHTML;
    container.querySelector<HTMLElement>('[data-task-id="t1"]')!.click();

    expect(selections).toEqual([['t1']]);
    // The click told the host what happened. It did not apply anything locally.
    expect(container.innerHTML).toBe(before);
    expect(intents).toEqual([]);
  });

  it('changes bar geometry with zoom', () => {
    const adapter = new PlaceholderGanttAdapter();
    mount(adapter);
    adapter.render(model);
    const atWeek = container.querySelector<HTMLElement>('.gantt-placeholder__bar')!.style.width;

    adapter.setZoom('day');
    const atDay = container.querySelector<HTMLElement>('.gantt-placeholder__bar')!.style.width;

    expect(parseFloat(atDay)).toBeGreaterThan(parseFloat(atWeek));
  });

  it('destroy() clears the container and is safe to call twice', () => {
    const adapter = new PlaceholderGanttAdapter();
    mount(adapter);
    adapter.render(model);
    adapter.destroy();
    expect(container.childElementCount).toBe(0);
    expect(() => {
      adapter.destroy();
    }).not.toThrow();
  });

  it('the factory returns an adapter that satisfies the contract', () => {
    const adapter = createGanttAdapter();
    expect(typeof adapter.mount).toBe('function');
    expect(typeof adapter.render).toBe('function');
    expect(typeof adapter.destroy).toBe('function');
    expect(adapter.capabilities.name).toContain('placeholder');
  });
});
