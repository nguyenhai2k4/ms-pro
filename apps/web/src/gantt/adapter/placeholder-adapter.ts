import type {
  GanttAdapter,
  GanttAdapterCapabilities,
  GanttMountOptions,
  GanttViewModel,
  GanttZoom,
} from '@projectapp/shared-types/gantt';
import type { TaskId } from '@projectapp/shared-types';

/**
 * # PlaceholderGanttAdapter — development stand-in, NOT the MVP renderer (ADR-006)
 *
 * ADR-001 licenses a commercial Gantt for MVP. That component cannot be installed here: there is
 * no license and no access to the vendor's private registry. Rather than block P0 or silently
 * substitute a different rendering strategy (which would reverse ADR-001 by implementation), this
 * adapter exists to prove the contract is implementable and to unblock the view layer.
 *
 * **What it deliberately does not do**, and must not be quietly improved to do:
 *
 *  - No row virtualization. FR-VIEW-02's 2,000 visible rows is unreachable with plain DOM, which
 *    is the entire reason ADR-001 chose a canvas component.
 *  - No drag-to-move or drag-to-resize.
 *  - Not measured against the FR-VIEW-02 paint budget, and `perfQualified: false` makes the perf
 *    harness refuse to record a baseline from it.
 *
 * Every one of those is declared in `capabilities` so no caller can mistake this for shippable.
 * If someone starts hardening this file — adding virtualization, adding drag — that is ADR-001
 * being reversed without a decision, and it needs a new ADR first.
 *
 * What it does do faithfully is the part that matters for the contract: it renders only what
 * `render()` is given, and it turns gestures into intents without ever mutating its own model
 * (ADR-002, invariant 2).
 */
export class PlaceholderGanttAdapter implements GanttAdapter {
  readonly capabilities: GanttAdapterCapabilities = {
    name: 'placeholder (ADR-006, development only)',
    virtualizedRows: false,
    dragToMove: false,
    dragToResize: false,
    drawsDependencyArrows: true,
    baselineOverlay: false,
    perfQualified: false,
  };

  #container: HTMLElement | null = null;
  #options: GanttMountOptions | null = null;
  #zoom: GanttZoom = 'week';
  #model: GanttViewModel | null = null;
  #selection: readonly TaskId[] = [];

  mount(container: HTMLElement, options: GanttMountOptions): void {
    this.#container = container;
    this.#options = options;
    this.#zoom = options.initialZoom;
    container.setAttribute('data-gantt-adapter', 'placeholder');
    // NOTE: `GanttView` (apps/web/src/gantt/GanttView.tsx) now sets `aria-hidden="true"` on this
    // same container itself, structurally, for every adapter — that is the fix for the defect
    // where this guarantee used to live only here. This line is therefore redundant when mounted
    // through `GanttView`, but is kept so the placeholder is still correct on its own (e.g. tests
    // and any future direct use) and does not regress if `GanttView`'s copy is ever removed.
    container.setAttribute('aria-hidden', 'true');
    this.#paint();
  }

  render(model: GanttViewModel): void {
    this.#model = model;
    this.#paint();
  }

  setZoom(zoom: GanttZoom): void {
    this.#zoom = zoom;
    this.#paint();
  }

  setSelection(taskIds: readonly TaskId[]): void {
    this.#selection = taskIds;
    this.#paint();
  }

  scrollToTask(taskId: TaskId): void {
    const row = this.#container?.querySelector(`[data-task-id="${taskId}"]`);
    row?.scrollIntoView({ block: 'nearest' });
  }

  destroy(): void {
    if (this.#container !== null) this.#container.replaceChildren();
    this.#container = null;
    this.#options = null;
    this.#model = null;
  }

  /** Pixels per hour at the current zoom. Enough to make bar widths proportional (FR-VIEW-01). */
  #pxPerHour(): number {
    switch (this.#zoom) {
      case 'day':
        return 8;
      case 'week':
        return 2;
      case 'month':
        return 0.5;
      case 'quarter':
        return 0.15;
    }
  }

  #paint(): void {
    const container = this.#container;
    const model = this.#model;
    const options = this.#options;
    if (container === null || options === null) return;

    container.replaceChildren();
    if (model === null) return;

    const originMs = new Date(model.timeAxis.rangeStart).getTime();
    const pxPerHour = this.#pxPerHour();
    const selected = new Set<string>(this.#selection);

    const chart = container.ownerDocument.createElement('div');
    chart.className = 'gantt-placeholder';

    model.tasks.forEach((task, index) => {
      const row = container.ownerDocument.createElement('div');
      row.className = 'gantt-placeholder__row';
      row.dataset['taskId'] = task.id;
      row.style.height = `${options.rowHeightPx}px`;

      const bar = container.ownerDocument.createElement('div');
      bar.className = 'gantt-placeholder__bar';
      // Criticality comes from the server (FR-SCH-05/10) and is only reflected here.
      if (task.isCritical) bar.classList.add('is-critical');
      if (task.hasScheduleConflict) bar.classList.add('has-conflict');
      if (selected.has(task.id)) bar.classList.add('is-selected');

      const startHours = (new Date(task.start).getTime() - originMs) / 3_600_000;
      const durationHours =
        (new Date(task.finish).getTime() - new Date(task.start).getTime()) / 3_600_000;
      bar.style.marginLeft = `${Math.max(0, startHours * pxPerHour)}px`;
      bar.style.width = `${Math.max(2, durationHours * pxPerHour)}px`;

      // A click selects. It reports the selection upward; it does not decide anything itself.
      row.addEventListener('click', () => {
        options.callbacks.onSelectionChange([task.id]);
      });

      row.appendChild(bar);
      chart.appendChild(row);

      if (index === 0) {
        options.callbacks.onViewportChange({
          firstVisibleRow: 0,
          visibleRowCount: model.tasks.length,
          rangeStart: model.timeAxis.rangeStart,
          rangeEnd: model.timeAxis.rangeEnd,
        });
      }
    });

    container.appendChild(chart);
  }
}
