import type { AccessibleGanttRow, GanttViewModel } from '@projectapp/shared-types/gantt';

/**
 * Derives the accessible table representation from the same authoritative view model the canvas
 * renders (invariant 6, FR-VIEW-03, WCAG 2.1 AA).
 *
 * The critical design property is that this is a **pure function of `GanttViewModel`**, not of the
 * adapter. Consequences that are the whole point:
 *
 *  - It cannot drift from what sighted users see. There is no second data path to keep in sync,
 *    so "the table says one thing and the chart says another" is not a reachable state.
 *  - It survives the vendor swap (ADR-006). When Bryntum replaces the placeholder, this file does
 *    not change, because it never knew which renderer was drawing.
 *  - It is testable without a DOM, which is why the accessibility behaviour has real unit tests in
 *    P0 rather than a manual audit in P8. The risk register calls out that retrofitting
 *    accessibility onto a finished canvas UI is materially harder — this is the mechanism that
 *    avoids the retrofit.
 *
 * Labels are prose because a screen reader announcing "2026-09-01T08:00:00.000Z" is technically a
 * label and practically useless. Critical-path membership is announced in text, not conveyed by
 * colour alone (WCAG 1.4.1).
 */

export interface BuildAccessibleRowsOptions {
  /** Injected so output is deterministic and testable; defaults to the runtime locale. */
  readonly formatDate?: (isoDateTime: string) => string;
}

const defaultFormatDate = (isoDateTime: string): string =>
  new Date(isoDateTime).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });

function formatDuration(startIso: string, finishIso: string): string {
  const ms = new Date(finishIso).getTime() - new Date(startIso).getTime();
  const days = Math.max(0, Math.round(ms / (24 * 60 * 60 * 1000)));
  if (days === 0) return 'milestone';
  return days === 1 ? '1 day' : `${days} days`;
}

function formatFloat(totalFloatHours: number): string {
  if (totalFloatHours <= 0) return 'no float';
  const days = Math.round((totalFloatHours / 8) * 10) / 10;
  return days === 1 ? '1 day of float' : `${days} days of float`;
}

/**
 * FR-SCH-05/10 in words. A red bar communicates nothing to a screen reader, so criticality,
 * float and conflict state are all announced.
 */
function scheduleStatusLabel(task: {
  isCritical: boolean;
  totalFloatHours: number;
  hasScheduleConflict: boolean;
  isMilestone: boolean;
}): string {
  const parts: string[] = [];
  if (task.isMilestone) parts.push('milestone');
  parts.push(
    task.isCritical
      ? 'on critical path'
      : `not on critical path, ${formatFloat(task.totalFloatHours)}`,
  );
  if (task.hasScheduleConflict) parts.push('schedule conflict');
  return parts.join(', ');
}

export function buildAccessibleRows(
  model: GanttViewModel,
  options: BuildAccessibleRowsOptions = {},
): AccessibleGanttRow[] {
  const formatDate = options.formatDate ?? defaultFormatDate;

  const nameById = new Map(model.tasks.map((task) => [task.id, task.name]));
  const hasChildren = new Set(
    model.tasks.flatMap((task) => (task.parentId === null ? [] : [task.parentId])),
  );

  // Predecessor names, indexed by successor, so the arrows have a prose equivalent.
  const predecessorsBySuccessor = new Map<string, string[]>();
  for (const dependency of model.dependencies) {
    const label = `${nameById.get(dependency.predecessorId) ?? 'unknown task'} (${dependency.type})`;
    const existing = predecessorsBySuccessor.get(dependency.successorId);
    if (existing === undefined) predecessorsBySuccessor.set(dependency.successorId, [label]);
    else existing.push(label);
  }

  return model.tasks.map((task, index) => {
    const predecessors = predecessorsBySuccessor.get(task.id) ?? [];
    return {
      taskId: task.id,
      rowIndex: index + 1,
      level: task.depth + 1,
      wbsCode: task.wbsCode,
      name: task.name,
      startLabel: formatDate(task.start),
      finishLabel: formatDate(task.finish),
      durationLabel: task.isMilestone ? 'milestone' : formatDuration(task.start, task.finish),
      pctCompleteLabel: `${Math.round(task.pctComplete)}% complete`,
      scheduleStatusLabel: scheduleStatusLabel(task),
      dependencyLabel:
        predecessors.length === 0 ? 'no predecessors' : `after ${predecessors.join(', ')}`,
      isCritical: task.isCritical,
      hasScheduleConflict: task.hasScheduleConflict,
      isExpanded: hasChildren.has(task.id) ? !task.isCollapsed : undefined,
    };
  });
}
