import type { GanttAdapter, GanttViewModel, GanttZoom } from '@projectapp/shared-types/gantt';
import { useEffect, useMemo, useRef } from 'react';
import { createGanttAdapter } from './adapter/index.js';
import { buildAccessibleRows } from './accessible/build-accessible-rows.js';

/**
 * Hosts the renderer and its accessible twin.
 *
 * The two are rendered by the same component, from the same model, on purpose: it is not possible
 * to add a Gantt to this app without also getting the accessible table, which is what invariant 6
 * ("built in, not retrofitted") means in practice. The canvas surface carries `aria-hidden` and
 * the table carries the semantics.
 *
 * `GanttView` — not the adapter — sets `aria-hidden="true"` on the container it owns, on the
 * container element itself (below), before any adapter ever touches it. This is deliberate: the
 * `GanttAdapter` contract (`packages/shared-types/src/gantt.ts`) does not, and should not, require
 * an implementation to hide itself from assistive technology, because a conforming adapter that
 * forgets to would silently reopen the "announced twice" defect the day the vendor adapter lands
 * (ADR-006). Putting it here means the guarantee survives the vendor swap structurally, not by an
 * implementer remembering to copy a line from the placeholder.
 */
export interface GanttViewProps {
  readonly model: GanttViewModel;
  readonly zoom: GanttZoom;
  readonly onSelectionChange?: (taskIds: readonly string[]) => void;
  /** Injected in tests; production uses the factory. */
  readonly adapterFactory?: () => GanttAdapter;
}

export function GanttView({
  model,
  zoom,
  onSelectionChange,
  adapterFactory = createGanttAdapter,
}: GanttViewProps): JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const adapterRef = useRef<GanttAdapter | null>(null);
  const rows = useMemo(() => buildAccessibleRows(model), [model]);

  useEffect(() => {
    const container = containerRef.current;
    if (container === null) return;

    const adapter = adapterFactory();
    adapterRef.current = adapter;
    adapter.mount(container, {
      initialZoom: zoom,
      rowHeightPx: 28,
      callbacks: {
        // Intents go to the server. The adapter never applies them locally (ADR-002).
        onIntent: () => {
          // Wired to the mutation transport in P2/P3; there is no local apply path by design.
        },
        onSelectionChange: (taskIds) => onSelectionChange?.(taskIds),
        onViewportChange: () => {},
        // P1 SEAM (not fixed here, flagged for whoever wires collapse): this is a no-op, and
        // collapse/expand state currently lives only inside the adapter (`GanttTaskView.isCollapsed`
        // on the model the adapter was last given). The accessible table's `aria-expanded` is
        // derived from that same `isCollapsed` field via `buildAccessibleRows`, so once a real
        // toggle is wired here it MUST cause a new `GanttViewModel` (with updated `isCollapsed`) to
        // flow back into `GanttView`'s `model` prop — not just tell the adapter to re-paint itself.
        // Otherwise the canvas and the accessible table will disagree about which rows are expanded,
        // and `aria-expanded` goes stale relative to what's visibly drawn.
        onToggleCollapse: () => {},
      },
    });

    return () => {
      adapter.destroy();
      adapterRef.current = null;
    };
    // Mount once; model and zoom are pushed by the effects below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [adapterFactory]);

  useEffect(() => {
    adapterRef.current?.render(model);
  }, [model]);

  useEffect(() => {
    adapterRef.current?.setZoom(zoom);
  }, [zoom]);

  return (
    <div className="gantt-view">
      {/*
        `aria-hidden` lives on this element, set by `GanttView`, not by whichever adapter is
        mounted into it. A screen reader must never announce the schedule from both the canvas and
        the table below; the table is the semantic source, so the canvas is unconditionally hidden
        regardless of what the mounted `GanttAdapter` implementation does or doesn't set itself.
      */}
      <div ref={containerRef} className="gantt-view__canvas" aria-hidden="true" />

      {/*
        FR-VIEW-03 / WCAG 2.1 AA. This is a real table, not a visually-hidden afterthought: it is
        the keyboard and screen-reader path to the same schedule. `aria-rowcount` and `aria-level`
        mirror the WBS so the hierarchy is navigable.
      */}
      <table
        className="gantt-view__accessible-table"
        aria-label="Project schedule"
        aria-rowcount={rows.length}
      >
        <caption>
          Schedule for project {model.projectId}. {rows.length} tasks.
        </caption>
        <thead>
          <tr>
            <th scope="col">WBS</th>
            <th scope="col">Task</th>
            <th scope="col">Start</th>
            <th scope="col">Finish</th>
            <th scope="col">Duration</th>
            <th scope="col">Progress</th>
            <th scope="col">Schedule status</th>
            <th scope="col">Predecessors</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={row.taskId}
              aria-rowindex={row.rowIndex}
              aria-level={row.level}
              aria-expanded={row.isExpanded}
              data-critical={row.isCritical ? 'true' : 'false'}
            >
              <td>{row.wbsCode}</td>
              <th scope="row">{row.name}</th>
              <td>{row.startLabel}</td>
              <td>{row.finishLabel}</td>
              <td>{row.durationLabel}</td>
              <td>{row.pctCompleteLabel}</td>
              <td>{row.scheduleStatusLabel}</td>
              <td>{row.dependencyLabel}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
