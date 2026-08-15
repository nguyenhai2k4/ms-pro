import { describe, expect, it } from 'vitest';
import type {
  GanttAdapter,
  GanttAdapterCapabilities,
  GanttIntent,
  GanttViewModel,
  GanttZoom,
} from './gantt.js';
import { ganttViewModelSchema, ganttZoomSchema } from './gantt.js';
import type { TaskId } from './primitives.js';

const UUID_P = '44444444-4444-4444-8444-444444444444';
const UUID_T1 = '55555555-5555-4555-8555-555555555555';
const UUID_T2 = '66666666-6666-4666-8666-666666666666';
const UUID_D1 = '77777777-7777-4777-8777-777777777777';

function viewModelFixture(): unknown {
  return {
    projectId: UUID_P,
    timeAxis: {
      zoom: 'week',
      rangeStart: '2026-09-01T00:00:00.000Z',
      rangeEnd: '2026-12-01T00:00:00.000Z',
    },
    tasks: [
      {
        id: UUID_T1,
        parentId: null,
        wbsCode: '1',
        name: 'Design',
        start: '2026-09-01T08:00:00.000Z',
        finish: '2026-09-10T17:00:00.000Z',
        pctComplete: 25,
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
        id: UUID_T2,
        parentId: null,
        wbsCode: '2',
        name: 'Build',
        start: '2026-09-11T08:00:00.000Z',
        finish: '2026-10-01T17:00:00.000Z',
        pctComplete: 0,
        isMilestone: false,
        isSummary: false,
        scheduleMode: 'auto',
        isCritical: true,
        totalFloatHours: 0,
        hasScheduleConflict: false,
        depth: 0,
        isCollapsed: false,
        baseline: { start: '2026-09-11T08:00:00.000Z', finish: '2026-09-25T17:00:00.000Z' },
      },
    ],
    dependencies: [
      {
        id: UUID_D1,
        predecessorId: UUID_T1,
        successorId: UUID_T2,
        type: 'FS',
        lagHours: 0,
        isCritical: true,
      },
    ],
    criticalPathTaskIds: [UUID_T1, UUID_T2],
    version: 7,
  };
}

describe('GanttViewModel', () => {
  it('parses a well-formed model', () => {
    const result = ganttViewModelSchema.safeParse(viewModelFixture());
    expect(result.success).toBe(true);
  });

  it('supports all four zoom levels required by FR-VIEW-01', () => {
    expect([...ganttZoomSchema.options].sort()).toEqual(['day', 'month', 'quarter', 'week']);
  });

  it('rejects a model whose instants are not UTC', () => {
    const model = viewModelFixture() as { tasks: Array<{ start: string }> };
    model.tasks[0]!.start = '2026-09-01T08:00:00+02:00';
    expect(ganttViewModelSchema.safeParse(model).success).toBe(false);
  });

  it('carries a monotonic version so out-of-order deltas are detectable', () => {
    const parsed = ganttViewModelSchema.parse(viewModelFixture());
    expect(parsed.version).toBe(7);
  });
});

/**
 * A compile-time proof that the contract is implementable without reaching for `any` and without
 * a vendor type. If a future edit to `GanttAdapter` cannot be satisfied by a plain object, this
 * test stops compiling — which is the signal that the interface has grown a vendor assumption.
 */
describe('GanttAdapter is implementable in isolation', () => {
  it('accepts a minimal conforming implementation and routes gestures as intents', () => {
    const intents: GanttIntent[] = [];
    let rendered: GanttViewModel | null = null;
    let zoom: GanttZoom = 'week';

    const capabilities: GanttAdapterCapabilities = {
      name: 'test-double',
      virtualizedRows: false,
      dragToMove: true,
      dragToResize: false,
      drawsDependencyArrows: false,
      baselineOverlay: false,
      perfQualified: false,
    };

    const adapter: GanttAdapter = {
      capabilities,
      mount(_container, options) {
        // Simulate a drag gesture: the adapter emits an intent and changes nothing itself.
        options.callbacks.onIntent({
          kind: 'task:move',
          taskId: UUID_T1 as TaskId,
          newStart: '2026-09-02T08:00:00.000Z',
        });
      },
      render(model) {
        rendered = model;
      },
      setZoom(next) {
        zoom = next;
      },
      setSelection() {},
      scrollToTask() {},
      destroy() {},
    };

    adapter.mount(null as unknown as HTMLElement, {
      callbacks: {
        onIntent: (intent) => intents.push(intent),
        onSelectionChange: () => {},
        onViewportChange: () => {},
        onToggleCollapse: () => {},
      },
      initialZoom: 'week',
      rowHeightPx: 28,
    });

    expect(intents).toHaveLength(1);
    expect(intents[0]?.kind).toBe('task:move');

    // The gesture did NOT change what is rendered — only a server round-trip and a subsequent
    // render() may do that (ADR-002, invariant 2).
    expect(rendered).toBeNull();

    adapter.render(ganttViewModelSchema.parse(viewModelFixture()));
    expect(rendered).not.toBeNull();

    adapter.setZoom('day');
    expect(zoom).toBe('day');
  });

  it('lets an implementation declare honestly that it is not perf-qualified (ADR-006)', () => {
    const placeholderish: GanttAdapterCapabilities = {
      name: 'placeholder',
      virtualizedRows: false,
      dragToMove: false,
      dragToResize: false,
      drawsDependencyArrows: true,
      baselineOverlay: false,
      perfQualified: false,
    };
    expect(placeholderish.perfQualified).toBe(false);
    expect(placeholderish.virtualizedRows).toBe(false);
  });
});
