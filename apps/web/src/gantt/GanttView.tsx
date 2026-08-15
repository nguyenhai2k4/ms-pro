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
      <div ref={containerRef} className="gantt-view__canvas" />

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
