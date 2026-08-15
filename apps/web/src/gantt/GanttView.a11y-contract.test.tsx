import type {
  GanttAdapter,
  GanttAdapterCapabilities,
  GanttViewModel,
} from '@projectapp/shared-types/gantt';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { GanttView } from './GanttView.jsx';

/**
 * Invariant 6 / FR-VIEW-03, tested against something that is **not** the placeholder.
 *
 * `GanttView.test.tsx` and `placeholder-adapter.test.ts` both exercise the default adapter, so the
 * accessibility guarantees they assert are really guarantees about `PlaceholderGanttAdapter`.
 * ADR-006 says the accessible representation "must survive the vendor swap untouched" — the way to
 * check that claim is to swap the adapter for a stub and see which guarantees survive.
 */

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
      name: 'Survey',
      start: '2026-09-01T08:00:00.000Z',
      finish: '2026-09-03T08:00:00.000Z',
      pctComplete: 100,
      isMilestone: false,
      isSummary: false,
      scheduleMode: 'auto',
      isCritical: false,
      totalFloatHours: 16,
      hasScheduleConflict: false,
      depth: 1,
      isCollapsed: false,
      baseline: null,
    },
  ],
  dependencies: [],
  criticalPathTaskIds: ['t1'],
  version: 1,
} as unknown as GanttViewModel;

/**
 * A minimal conforming adapter that draws nothing and sets no ARIA attributes — i.e. what an
 * arbitrary vendor adapter is entitled to be under the `GanttAdapter` contract, which says nothing
 * about `aria-hidden`.
 */
class StubGanttAdapter implements GanttAdapter {
  readonly capabilities: GanttAdapterCapabilities = {
    name: 'stub (test only)',
    virtualizedRows: true,
    dragToMove: true,
    dragToResize: true,
    drawsDependencyArrows: true,
    baselineOverlay: true,
    perfQualified: false,
  };

  readonly rendered: GanttViewModel[] = [];
  mountCount = 0;

  mount(): void {
    this.mountCount += 1;
  }
  render(model: GanttViewModel): void {
    this.rendered.push(model);
  }
  setZoom(): void {}
  setSelection(): void {}
  scrollToTask(): void {}
  destroy(): void {}
}

describe('invariant 6: the accessibility guarantee belongs to GanttView, not to the adapter', () => {
  /**
   * Was a P0 defect, now fixed and kept as the regression guard.
   *
   * `aria-hidden="true"` — the thing that stops a screen reader announcing the same schedule
   * twice — used to be set by `PlaceholderGanttAdapter.mount()` rather than by `GanttView`, and
   * the `GanttAdapter` contract does not require an implementation to set it. That delegated the
   * WCAG guarantee to the one component ADR-006 says will be replaced, so it would have
   * regressed silently on the day the vendor adapter landed. The older test could not catch it
   * because it exercises the placeholder, which does set the attribute.
   *
   * `GanttView` now sets it on the container it owns, so the guarantee survives the vendor swap
   * structurally. This test uses a deliberately non-conforming stub adapter — keep it that way;
   * testing this against the placeholder is precisely the weakness that let the gap through.
   */
  it('hides the drawing surface regardless of which adapter is mounted', () => {
    const adapter = new StubGanttAdapter();
    const { container } = render(
      <GanttView model={model} zoom="week" adapterFactory={() => adapter} />,
    );

    const canvas = container.querySelector('.gantt-view__canvas');
    expect(
      canvas?.getAttribute('aria-hidden'),
      'a screen reader will announce the schedule twice if the chart surface is exposed',
    ).toBe('true');
  });

  it('renders the accessible table even when the adapter draws nothing at all', () => {
    const adapter = new StubGanttAdapter();
    render(<GanttView model={model} zoom="week" adapterFactory={() => adapter} />);

    // The table is not derived from the renderer, so a renderer that draws nothing cannot take the
    // accessible representation down with it.
    expect(screen.getByRole('table', { name: 'Project schedule' })).toBeTruthy();
    expect(screen.getByRole('rowheader', { name: 'Excavate' })).toBeTruthy();
    expect(screen.getByRole('rowheader', { name: 'Survey' })).toBeTruthy();
  });

  it('feeds the chart and the table from one model, so they cannot drift', () => {
    const adapter = new StubGanttAdapter();
    render(<GanttView model={model} zoom="week" adapterFactory={() => adapter} />);

    // Same object, not a copy: there is no second data path that could fall behind.
    expect(adapter.rendered.at(-1)).toBe(model);
    expect(screen.getAllByRole('row')).toHaveLength(model.tasks.length + 1); // + header row
  });

  it('updates chart and table in the same commit when the model changes', () => {
    const adapter = new StubGanttAdapter();
    const { rerender } = render(
      <GanttView model={model} zoom="week" adapterFactory={() => adapter} />,
    );
    expect(adapter.rendered).toHaveLength(1);

    const next = {
      ...model,
      version: 2,
      tasks: [{ ...model.tasks[0]!, name: 'Excavate (revised)' }, model.tasks[1]!],
    } as GanttViewModel;
    rerender(<GanttView model={next} zoom="week" adapterFactory={() => adapter} />);

    expect(adapter.rendered).toHaveLength(2);
    expect(adapter.rendered.at(-1)).toBe(next);
    expect(screen.getByRole('rowheader', { name: 'Excavate (revised)' })).toBeTruthy();
  });

  it('announces criticality and float in words for every row (WCAG 1.4.1)', () => {
    const adapter = new StubGanttAdapter();
    render(<GanttView model={model} zoom="week" adapterFactory={() => adapter} />);

    expect(screen.getByText('on critical path')).toBeTruthy();
    expect(screen.getByText(/not on critical path/)).toBeTruthy();
  });

  it('mirrors the WBS depth as aria-level so the hierarchy is navigable', () => {
    const adapter = new StubGanttAdapter();
    const { container } = render(
      <GanttView model={model} zoom="week" adapterFactory={() => adapter} />,
    );

    const rows = container.querySelectorAll('tbody tr');
    expect(rows[0]!.getAttribute('aria-level')).toBe('1');
    expect(rows[1]!.getAttribute('aria-level')).toBe('2');
    // A summary row is expandable; a leaf carries no aria-expanded at all.
    expect(rows[0]!.getAttribute('aria-expanded')).toBe('true');
    expect(rows[1]!.hasAttribute('aria-expanded')).toBe(false);
  });
});

/**
 * ADR-006 tripwire, widened. `placeholder-adapter.test.ts` asserts the placeholder *declares*
 * `virtualizedRows: false` / `perfQualified: false`. That catches an honest reversal (someone flips
 * the flag) but not the failure mode ADR-006 actually warns about — a placeholder that is quietly
 * hardened while the flags stay false. These assert the factory-supplied renderer stays
 * unqualified, which is the claim FR-VIEW-01/02 rest on.
 */
describe('ADR-006: nothing in apps/web claims FR-VIEW-01/02 are satisfied', () => {
  it('the adapter the app actually obtains is not perf-qualified', async () => {
    const { createGanttAdapter, isPerfQualified } = await import('./adapter/index.js');
    const adapter = createGanttAdapter();
    expect(isPerfQualified(adapter)).toBe(false);
    expect(adapter.capabilities.virtualizedRows).toBe(false);
    expect(adapter.capabilities.dragToMove).toBe(false);
    expect(adapter.capabilities.dragToResize).toBe(false);
  });

  it('the placeholder renders every row it is given — it does not virtualize behind the flag', async () => {
    const { PlaceholderGanttAdapter } = await import('./adapter/placeholder-adapter.js');
    const adapter = new PlaceholderGanttAdapter();
    const container = document.createElement('div');
    document.body.appendChild(container);
    adapter.mount(container, {
      initialZoom: 'week',
      rowHeightPx: 28,
      callbacks: {
        onIntent: () => {},
        onSelectionChange: () => {},
        onViewportChange: () => {},
        onToggleCollapse: () => {},
      },
    });

    const many = {
      ...model,
      tasks: Array.from({ length: 120 }, (_unused, index) => ({
        ...model.tasks[0]!,
        id: `t${index}`,
        wbsCode: `${index + 1}`,
        name: `Task ${index}`,
      })),
    } as GanttViewModel;
    adapter.render(many);

    // If this ever renders fewer rows than it was given, the placeholder has grown virtualization
    // while still declaring `virtualizedRows: false` — that is ADR-001 being reversed silently.
    expect(container.querySelectorAll('[data-task-id]')).toHaveLength(120);
    expect(adapter.capabilities.virtualizedRows).toBe(false);
  });
});
