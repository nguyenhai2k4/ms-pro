import type { GanttAdapter } from '@projectapp/shared-types/gantt';
import { PlaceholderGanttAdapter } from './placeholder-adapter.js';

/**
 * The single place the app obtains a renderer (ADR-001, ADR-006).
 *
 * When the vendor component is licensed, the vendor adapter is added under `./vendor/` and this
 * factory chooses it. Nothing else in `apps/web` changes — that is the compliance check in
 * ADR-006, and this file is where it is verifiable at a glance.
 */
export function createGanttAdapter(): GanttAdapter {
  return new PlaceholderGanttAdapter();
}

/**
 * True when the active renderer has been measured against FR-VIEW-02. The perf harness refuses to
 * record a baseline when this is false, so a number produced by the placeholder can never be
 * mistaken for evidence that the paint budget is met.
 */
export function isPerfQualified(adapter: GanttAdapter): boolean {
  return adapter.capabilities.perfQualified;
}

export { PlaceholderGanttAdapter };
